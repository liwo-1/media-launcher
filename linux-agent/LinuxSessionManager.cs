using MediaLauncher.Agent.Core;
using System.Collections.Concurrent;

namespace MediaLauncher.LinuxAgent;

internal sealed record LinuxPlaybackSession(
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

internal static class LinuxSessionManager
{
    private static readonly SemaphoreSlim SessionLock = new(1, 1);
    private static readonly BoundedRequestCache<LinuxPlaybackSession> RecentRequests =
        new(128, TimeSpan.FromMinutes(5));
    private static readonly ConcurrentDictionary<string, LinuxPlaybackSession> Sessions =
        new(StringComparer.Ordinal);
    private static readonly TimeSpan SessionRetention = TimeSpan.FromMinutes(5);
    private const int MaxSessions = 128;
    private static LinuxPlaybackSession? _current;

    public static LinuxPlaybackSession? Current => _current;

    public static async Task<LinuxPlaybackSession> CreateAsync(
        string? requestId,
        string? playerId,
        string mediaPath,
        LinuxAgentConfig config,
        string title = "",
        long startPositionMs = 0,
        bool fullscreen = true)
    {
        await SessionLock.WaitAsync();
        try
        {
            var now = DateTimeOffset.UtcNow;
            if (!string.IsNullOrWhiteSpace(requestId) &&
                RecentRequests.TryGet(requestId, now, out var previous) && previous is not null)
                return previous;
            if (startPositionMs is < 0 or > SessionControlLimits.MaxSeekPositionMs)
                throw new ArgumentException("startPositionMs must be between 0 and seven days.");

            IPlayerAdapter? adapter = null;
            try
            {
                adapter = LinuxPlayerCatalog.GetAdapter(playerId, config);
                _ = MediaPathPolicy.ValidateLinuxFile(mediaPath, config.AllowedMediaRoots);
                await StopCurrentLockedAsync(SessionEndReasons.Replaced);
                adapter.PlaybackExited += HandlePlaybackExited;
                await adapter.LaunchAsync(
                    new PlayerLaunchRequest(mediaPath, title, startPositionMs, fullscreen),
                    config.AllowedMediaRoots);
                _current = new LinuxPlaybackSession(
                    Guid.NewGuid().ToString("N"),
                    adapter.Descriptor.Id,
                    requestId ?? "",
                    adapter,
                    mediaPath,
                    now);
                Sessions[_current.SessionId] = _current;
                PruneSessions(now);
                if (!string.IsNullOrWhiteSpace(requestId)) RecentRequests.Set(requestId, _current, now);
                return _current;
            }
            catch
            {
                if (adapter is not null)
                {
                    adapter.PlaybackExited -= HandlePlaybackExited;
                    try { await adapter.StopAsync(); } catch { /* preserve launch error */ }
                }
                throw;
            }
        }
        finally
        {
            SessionLock.Release();
        }
    }

    public static LinuxPlaybackSession? Find(string sessionId)
        => Sessions.TryGetValue(sessionId, out var session) ? session : null;

    public static async Task<PlayerStatus> GetStatusAsync(string sessionId)
    {
        var session = Find(sessionId) ?? throw new KeyNotFoundException("Playback session was not found.");
        if (session.EndReason is not null) return EndedStatus(session);
        try
        {
            var status = await session.Adapter.GetStatusAsync();
            if (session.EndReason is not null) return EndedStatus(session, status);
            session.LastStatus = status;
            return status;
        }
        catch when (session.EndReason is not null)
        {
            return EndedStatus(session);
        }
    }

    public static async Task<LinuxPlaybackSession> ControlAsync(
        string sessionId,
        string action,
        long? positionMs)
    {
        await SessionLock.WaitAsync();
        try
        {
            var session = Find(sessionId) ?? throw new KeyNotFoundException("Playback session was not found.");
            if (session.EndReason is not null || !ReferenceEquals(_current, session))
                throw new NotSupportedException("The playback session has already ended.");
            var capabilities = session.Adapter.Descriptor.Capabilities;
            switch (action)
            {
                case "pause":
                    RequireCapability(capabilities, AgentCapabilities.ControlPause);
                    await session.Adapter.SetPausedAsync(true);
                    break;
                case "resume":
                    RequireCapability(capabilities, AgentCapabilities.ControlPause);
                    await session.Adapter.SetPausedAsync(false);
                    break;
                case "seek":
                    RequireCapability(capabilities, AgentCapabilities.ControlSeek);
                    if (positionMs is null or < 0 or > 7 * 24 * 60 * 60 * 1000L)
                        throw new ArgumentException("positionMs must be between 0 and seven days.");
                    await session.Adapter.SeekAsync(positionMs.Value);
                    break;
                case "stop":
                    RequireCapability(capabilities, AgentCapabilities.ControlStop);
                    await session.Adapter.StopAsync();
                    session.Adapter.PlaybackExited -= HandlePlaybackExited;
                    if (ReferenceEquals(_current, session)) _current = null;
                    MarkEnded(session, SessionEndReasons.StoppedByRequest);
                    break;
                default:
                    throw new ArgumentException("action must be pause, resume, seek, or stop.");
            }
            return session;
        }
        finally
        {
            SessionLock.Release();
        }
    }

    private static async Task StopCurrentLockedAsync(string endReason)
    {
        var previous = _current;
        if (previous is null) return;
        await previous.Adapter.StopAsync();
        previous.Adapter.PlaybackExited -= HandlePlaybackExited;
        if (ReferenceEquals(_current, previous)) _current = null;
        MarkEnded(previous, endReason);
    }

    private static void RequireCapability(IEnumerable<string> capabilities, string required)
    {
        if (!capabilities.Contains(required, StringComparer.Ordinal))
            throw new NotSupportedException("The selected player does not support this control.");
    }

    private static void HandlePlaybackExited(object? sender, EventArgs args)
    {
        if (sender is IPlayerAdapter adapter) _ = CompleteExitedAsync(adapter);
    }

    private static async Task CompleteExitedAsync(IPlayerAdapter adapter)
    {
        await SessionLock.WaitAsync();
        try
        {
            if (_current is not null && ReferenceEquals(_current.Adapter, adapter))
            {
                var ended = _current;
                _current = null;
                adapter.PlaybackExited -= HandlePlaybackExited;
                MarkEnded(ended, SessionEndReasons.PlayerExited);
            }
        }
        finally
        {
            SessionLock.Release();
        }
    }

    private static PlayerStatus EndedStatus(
        LinuxPlaybackSession session,
        PlayerStatus? fallback = null)
    {
        var last = session.LastStatus ?? fallback;
        return new PlayerStatus(
            last?.File ?? session.MediaPath,
            "stopped",
            last?.PositionMs ?? 0,
            last?.DurationMs ?? 0);
    }

    private static void MarkEnded(LinuxPlaybackSession session, string reason)
    {
        if (session.EndReason is not null) return;
        session.EndReason = reason;
        session.EndedAt = DateTimeOffset.UtcNow;
    }

    private static void PruneSessions(DateTimeOffset now)
    {
        foreach (var session in Sessions.Values
            .Where(value => value.EndedAt is not null && value.EndedAt < now - SessionRetention)
            .ToArray())
        {
            Sessions.TryRemove(session.SessionId, out _);
        }
        foreach (var session in Sessions.Values
            .Where(value => value.EndReason is not null)
            .OrderBy(value => value.EndedAt)
            .Take(Math.Max(0, Sessions.Count - MaxSessions))
            .ToArray())
        {
            Sessions.TryRemove(session.SessionId, out _);
        }
    }

    internal static async Task ResetForTestsAsync()
    {
        await SessionLock.WaitAsync();
        try
        {
            if (_current is not null)
            {
                _current.Adapter.PlaybackExited -= HandlePlaybackExited;
                try { await _current.Adapter.StopAsync(); } catch { }
            }
            _current = null;
            Sessions.Clear();
            RecentRequests.Clear();
        }
        finally { SessionLock.Release(); }
    }

    internal static void AdoptForTests(LinuxPlaybackSession session)
    {
        session.Adapter.PlaybackExited += HandlePlaybackExited;
        _current = session;
        Sessions[session.SessionId] = session;
    }

    internal static Task CompleteExitedForTestsAsync(IPlayerAdapter adapter) =>
        CompleteExitedAsync(adapter);
}
