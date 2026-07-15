using System.Text.Json.Serialization;

namespace MediaLauncher.Agent.Core;

public sealed class LegacyPlayRequest
{
    [JsonPropertyName("path")]
    public string? Path { get; set; }
}

public sealed class PairRequest
{
    [JsonPropertyName("secret")]
    public string? Secret { get; set; }
}

public sealed class SessionMediaRequest
{
    [JsonPropertyName("sourceType")]
    public string? SourceType { get; set; }

    [JsonPropertyName("path")]
    public string? Path { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }
}

public sealed class SessionOptionsRequest
{
    [JsonPropertyName("fullscreen")]
    public bool Fullscreen { get; set; } = true;

    [JsonPropertyName("startPositionMs")]
    public long StartPositionMs { get; set; }
}

public sealed class CreateSessionRequest
{
    [JsonPropertyName("requestId")]
    public string? RequestId { get; set; }

    [JsonPropertyName("playerId")]
    public string? PlayerId { get; set; }

    [JsonPropertyName("media")]
    public SessionMediaRequest? Media { get; set; }

    [JsonPropertyName("options")]
    public SessionOptionsRequest? Options { get; set; }
}

public sealed class SessionControlRequest
{
    [JsonPropertyName("action")]
    public string? Action { get; set; }

    [JsonPropertyName("positionMs")]
    public long? PositionMs { get; set; }
}

public sealed class AgentRegistrationResponse
{
    [JsonPropertyName("secret")]
    public string? Secret { get; set; }

    [JsonPropertyName("registrationRefreshSeconds")]
    public int? RegistrationRefreshSeconds { get; set; }
}

public sealed record LegacyPlayerStatusResponse(
    [property: JsonPropertyName("file")]
    string? File,
    [property: JsonPropertyName("state")]
    int State,
    [property: JsonPropertyName("position")]
    long Position,
    [property: JsonPropertyName("duration")]
    long Duration)
{
    public static LegacyPlayerStatusResponse From(PlayerStatus status) => new(
        status.File,
        status.State.Equals("playing", StringComparison.OrdinalIgnoreCase) ? 2 :
            status.State.Equals("paused", StringComparison.OrdinalIgnoreCase) ? 1 : 0,
        status.PositionMs,
        status.DurationMs);

    public static LegacyPlayerStatusResponse Stopped() => new(null, 0, 0, 0);
}
