using System.Text.Json.Serialization;

namespace MediaLauncher.Agent.Core;

public static class PlayerCapabilities
{
    public const string PlayFile = AgentCapabilities.PlayFile;
    public const string Fullscreen = AgentCapabilities.Fullscreen;
    public const string StatusState = AgentCapabilities.StatusState;
    public const string StatusPosition = AgentCapabilities.StatusPosition;
    public const string StatusDuration = AgentCapabilities.StatusDuration;
    public const string ControlPause = AgentCapabilities.ControlPause;
    public const string ControlSeek = AgentCapabilities.ControlSeek;
    public const string ControlStop = AgentCapabilities.ControlStop;

    public static bool Supports(PlayerDescriptor descriptor, string capability) =>
        descriptor.Capabilities.Contains(capability, StringComparer.Ordinal);
}

public static class SessionEndReasons
{
    public const string PlayerExited = "player-exited";
    public const string Replaced = "replaced";
    public const string StoppedByRequest = "stopped-by-request";
}

public static class SessionControlLimits
{
    public const long MaxSeekPositionMs = 7 * 24 * 60 * 60 * 1000L;
}

public sealed record PlayerDiagnostic(
    string Code,
    string Severity,
    string Message);

public sealed record PlayerDescriptor(
    string Id,
    string Kind,
    [property: JsonPropertyName("name")]
    string DisplayName,
    [property: JsonIgnore]
    string Source,
    bool Available,
    string[] Capabilities)
{
    public PlayerDiagnostic[] Diagnostics { get; init; } = [];
}

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

    Task SetPausedAsync(bool paused) =>
        Task.FromException(new NotSupportedException("This player does not support pause control."));

    Task SeekAsync(long positionMs) =>
        Task.FromException(new NotSupportedException("This player does not support seek control."));
}
