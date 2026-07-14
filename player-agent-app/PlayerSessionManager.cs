namespace MediaLauncherPlayerAgent;

public sealed record AgentPlaybackSession(
    string SessionId,
    string PlayerId,
    string RequestId,
    IPlayerAdapter Adapter,
    string MediaPath,
    DateTimeOffset StartedAt);

public static class PlayerSessionManager
{
    private static readonly SemaphoreSlim SessionLock = new(1, 1);
    private static readonly Dictionary<string, AgentPlaybackSession> RecentRequests = new(
        StringComparer.Ordinal);
    private static readonly TimeSpan RequestRetention = TimeSpan.FromMinutes(5);
    private const int MaxRecentRequests = 128;
    private static AgentPlaybackSession? _current;

    public static async Task<AgentPlaybackSession> CreateAsync(
        string? requestId,
        string? playerId,
        string mediaPath,
        AppConfig config,
        string title = "",
        long startPositionMs = 0,
        bool fullscreen = true)
    {
        await SessionLock.WaitAsync();
        try
        {
            PruneRecentRequests();
            if (!string.IsNullOrWhiteSpace(requestId) &&
                RecentRequests.TryGetValue(requestId, out var previousRequest))
                return previousRequest;

            await StopCurrentLockedAsync();
            IPlayerAdapter? adapter = null;
            try
            {
                adapter = PlayerCatalog.GetAdapter(playerId, config);
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
        _current is not null && string.Equals(_current.SessionId, sessionId, StringComparison.Ordinal)
            ? _current
            : null;

    private static async Task StopCurrentLockedAsync()
    {
        var previous = _current;
        if (previous is null) return;
        previous.Adapter.PlaybackExited -= HandlePlaybackExited;
        try
        {
            await previous.Adapter.StopAsync();
            _current = null;
        }
        catch (Exception ex)
        {
            Logger.Log($"Could not stop previous player session: {ex.Message}");
            previous.Adapter.PlaybackExited += HandlePlaybackExited;
            throw new InvalidOperationException(
                "The previous media player could not be stopped, so a replacement was not launched.", ex);
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
                _current = null;
                adapter.PlaybackExited -= HandlePlaybackExited;
                restoreWindow = true;
            }
        }
        finally
        {
            SessionLock.Release();
        }
        if (restoreWindow) MainForm.Instance?.RestoreFromPlayback();
    }
}
