using System.Collections.Concurrent;

namespace MediaLauncherPlayerAgent;

public sealed record AgentPlaybackSession(
    string SessionId,
    string PlayerId,
    string RequestId,
    IPlayerAdapter Adapter,
    string MediaPath,
    DateTimeOffset StartedAt)
{
    public string? EndReason { get; internal set; }
    public DateTimeOffset? EndedAt { get; internal set; }
    public PlayerStatus? LastStatus { get; internal set; }
}

public sealed class PlayerSessionControlException(
    string message,
    string code,
    string? capability = null) : InvalidOperationException(message)
{
    public string Code { get; } = code;
    public string? Capability { get; } = capability;
}

public static class PlayerSessionManager
{
    private static readonly SemaphoreSlim SessionLock = new(1, 1);
    private static readonly Dictionary<string, AgentPlaybackSession> RecentRequests = new(
        StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, AgentPlaybackSession> Sessions = new(
        StringComparer.Ordinal);
    private static readonly TimeSpan RequestRetention = TimeSpan.FromMinutes(5);
    private const int MaxRecentRequests = 128;
    private const int MaxSessions = 128;
    private static AgentPlaybackSession? _current;

    public static Task<AgentPlaybackSession> CreateAsync(
        string? requestId,
        string? playerId,
        string mediaPath,
        AppConfig config,
        string title = "",
        long startPositionMs = 0,
        bool fullscreen = true) =>
        CreateAsyncCore(
            requestId,
            playerId,
            mediaPath,
            config,
            title,
            startPositionMs,
            fullscreen,
            PlayerCatalog.GetAdapter);

    internal static Task<AgentPlaybackSession> CreateWithAdapterAsync(
        string? requestId,
        string mediaPath,
        AppConfig config,
        IPlayerAdapter adapter) =>
        CreateAsyncCore(
            requestId,
            adapter.Descriptor.Id,
            mediaPath,
            config,
            "",
            0,
            true,
            (_, _) => adapter);

    internal static async Task ResetForTestsAsync()
    {
        await SessionLock.WaitAsync();
        try
        {
            if (_current is not null)
            {
                _current.Adapter.PlaybackExited -= HandlePlaybackExited;
                try { await _current.Adapter.StopAsync(); }
                catch { /* Tests are resetting isolated fake state. */ }
            }
            _current = null;
            RecentRequests.Clear();
            Sessions.Clear();
        }
        finally
        {
            SessionLock.Release();
        }
    }

    private static async Task<AgentPlaybackSession> CreateAsyncCore(
        string? requestId,
        string? playerId,
        string mediaPath,
        AppConfig config,
        string title,
        long startPositionMs,
        bool fullscreen,
        Func<string?, AppConfig, IPlayerAdapter> adapterFactory)
    {
        await SessionLock.WaitAsync();
        try
        {
            PruneRecentRequests();
            if (!string.IsNullOrWhiteSpace(requestId) &&
                RecentRequests.TryGetValue(requestId, out var previousRequest))
                return previousRequest;

            IPlayerAdapter? adapter = null;
            try
            {
                adapter = adapterFactory(playerId, config);
                MediaPathPolicy.ValidateWindowsUnc(mediaPath, config.AllowedMediaRoots);
                await StopCurrentLockedAsync(SessionEndReasons.Replaced);
                adapter.PlaybackExited += HandlePlaybackExited;
                MainForm.Instance?.MinimizeForPlayback();
                await adapter.LaunchAsync(
                    new PlayerLaunchRequest(mediaPath, title, startPositionMs, fullscreen),
                    config.AllowedMediaRoots);
                _current = new AgentPlaybackSession(
                    Guid.NewGuid().ToString("N"),
                    adapter.Descriptor.Id,
                    requestId ?? "",
                    adapter,
                    mediaPath,
                    DateTimeOffset.UtcNow);
                Sessions[_current.SessionId] = _current;
                PruneSessions();
                if (!string.IsNullOrWhiteSpace(requestId))
                {
                    if (RecentRequests.Count >= MaxRecentRequests)
                    {
                        var oldest = RecentRequests.MinBy(entry => entry.Value.StartedAt).Key;
                        RecentRequests.Remove(oldest);
                    }
                    RecentRequests[requestId] = _current;
                }
                return _current;
            }
            catch
            {
                try
                {
                    if (adapter is not null)
                    {
                        adapter.PlaybackExited -= HandlePlaybackExited;
                        await adapter.StopAsync();
                    }
                }
                catch (Exception cleanupError)
                {
                    Logger.Log($"Could not clean up a failed player launch: {cleanupError.Message}");
                }
                finally
                {
                    try
                    {
                        MainForm.Instance?.RestoreFromPlayback();
                    }
                    catch (Exception restoreError)
                    {
                        Logger.Log($"Could not restore the agent window after a failed launch: {restoreError.Message}");
                    }
                }
                throw;
            }
        }
        finally
        {
            SessionLock.Release();
        }
    }

    public static AgentPlaybackSession? Find(string sessionId) =>
        Sessions.TryGetValue(sessionId, out var session) ? session : null;

    internal static AgentPlaybackSession? Current => Volatile.Read(ref _current);

    public static void RememberStatus(AgentPlaybackSession session, PlayerStatus status)
    {
        if (session.EndReason is null) session.LastStatus = status;
    }

    public static Task<AgentPlaybackSession?> PauseAsync(string sessionId) =>
        SetPausedAsync(sessionId, paused: true);

    public static Task<AgentPlaybackSession?> ResumeAsync(string sessionId) =>
        SetPausedAsync(sessionId, paused: false);

    public static Task<AgentPlaybackSession?> SetPausedAsync(string sessionId, bool paused) =>
        ControlAsync(
            sessionId,
            PlayerCapabilities.ControlPause,
            adapter => adapter.SetPausedAsync(paused));

    public static Task<AgentPlaybackSession?> SeekAsync(string sessionId, long positionMs) =>
        positionMs is < 0 or > SessionControlLimits.MaxSeekPositionMs
            ? Task.FromException<AgentPlaybackSession?>(new ArgumentException(
                "positionMs must be between 0 and seven days.",
                nameof(positionMs)))
            : ControlAsync(sessionId, PlayerCapabilities.ControlSeek, adapter => adapter.SeekAsync(positionMs));

    public static async Task<AgentPlaybackSession?> StopAsync(string sessionId)
    {
        var restoreWindow = false;
        await SessionLock.WaitAsync();
        try
        {
            if (!Sessions.TryGetValue(sessionId, out var session)) return null;
            if (session.EndReason is not null) return session;
            EnsureCurrentSession(session);
            EnsureCapability(session, PlayerCapabilities.ControlStop);
            await StopCurrentLockedAsync(SessionEndReasons.StoppedByRequest);
            restoreWindow = true;
            return session;
        }
        finally
        {
            SessionLock.Release();
            if (restoreWindow) MainForm.Instance?.RestoreFromPlayback();
        }
    }

    private static async Task StopCurrentLockedAsync(string endReason)
    {
        var previous = _current;
        if (previous is null) return;
        previous.Adapter.PlaybackExited -= HandlePlaybackExited;
        try
        {
            await previous.Adapter.StopAsync();
            _current = null;
            MarkEnded(previous, endReason);
        }
        catch (Exception ex)
        {
            Logger.Log($"Could not stop previous player session: {ex.Message}");
            previous.Adapter.PlaybackExited += HandlePlaybackExited;
            throw new InvalidOperationException(
                "The active media player could not be stopped safely.", ex);
        }
    }

    private static void PruneRecentRequests()
    {
        var cutoff = DateTimeOffset.UtcNow - RequestRetention;
        foreach (var requestId in RecentRequests
            .Where(entry => entry.Value.StartedAt < cutoff)
            .Select(entry => entry.Key)
            .ToArray())
        {
            RecentRequests.Remove(requestId);
        }
    }

    private static void PruneSessions()
    {
        var cutoff = DateTimeOffset.UtcNow - RequestRetention;
        foreach (var session in Sessions.Values
            .Where(session => session.EndedAt < cutoff)
            .OrderBy(session => session.EndedAt)
            .ToArray())
        {
            Sessions.TryRemove(session.SessionId, out _);
        }
        foreach (var session in Sessions.Values
            .Where(session => session.EndReason is not null)
            .OrderBy(session => session.EndedAt)
            .Take(Math.Max(0, Sessions.Count - MaxSessions))
            .ToArray())
        {
            Sessions.TryRemove(session.SessionId, out _);
        }
    }

    private static void HandlePlaybackExited(object? sender, EventArgs args)
    {
        if (sender is IPlayerAdapter adapter) _ = CompleteExitedSessionAsync(adapter);
    }

    private static async Task CompleteExitedSessionAsync(IPlayerAdapter adapter)
    {
        var restoreWindow = false;
        await SessionLock.WaitAsync();
        try
        {
            if (_current is not null && ReferenceEquals(_current.Adapter, adapter))
            {
                var ended = _current;
                _current = null;
                adapter.PlaybackExited -= HandlePlaybackExited;
                MarkEnded(ended, SessionEndReasons.PlayerExited);
                restoreWindow = true;
            }
        }
        finally
        {
            SessionLock.Release();
        }
        if (restoreWindow) MainForm.Instance?.RestoreFromPlayback();
    }

    private static async Task<AgentPlaybackSession?> ControlAsync(
        string sessionId,
        string capability,
        Func<IPlayerAdapter, Task> command)
    {
        await SessionLock.WaitAsync();
        try
        {
            if (!Sessions.TryGetValue(sessionId, out var session)) return null;
            EnsureCurrentSession(session);
            EnsureCapability(session, capability);
            await command(session.Adapter);
            return session;
        }
        finally
        {
            SessionLock.Release();
        }
    }

    private static void EnsureCurrentSession(AgentPlaybackSession session)
    {
        if (session.EndReason is not null || !ReferenceEquals(_current, session))
        {
            throw new PlayerSessionControlException(
                "The playback session has already ended.",
                "session_ended");
        }
    }

    private static void EnsureCapability(AgentPlaybackSession session, string capability)
    {
        if (!PlayerCapabilities.Supports(session.Adapter.Descriptor, capability))
        {
            throw new PlayerSessionControlException(
                $"{session.Adapter.Descriptor.DisplayName} does not support '{capability}'.",
                "capability_not_supported",
                capability);
        }
    }

    private static void MarkEnded(AgentPlaybackSession session, string reason)
    {
        if (session.EndReason is not null) return;
        session.EndReason = reason;
        session.EndedAt = DateTimeOffset.UtcNow;
    }
}
