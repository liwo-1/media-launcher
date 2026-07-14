namespace MediaLauncherPlayerAgent;

public sealed record PlayerDescriptor(
    string Id,
    string Kind,
    string DisplayName,
    string Source,
    bool Available,
    string[] Capabilities);

public sealed record PlayerStatus(
    string? File,
    string State,
    long PositionMs,
    long DurationMs);

public sealed record PlayerLaunchRequest(
    string MediaPath,
    string Title,
    long StartPositionMs,
    bool Fullscreen);

public interface IPlayerAdapter
{
    PlayerDescriptor Descriptor { get; }
    event EventHandler? PlaybackExited;
    Task LaunchAsync(PlayerLaunchRequest request, IReadOnlyCollection<string> allowedMediaRoots);
    Task StopAsync();
    Task<PlayerStatus> GetStatusAsync();
}
