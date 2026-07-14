using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace MediaLauncherPlayerAgent;

public class PlayRequest
{
    [JsonPropertyName("path")]
    public string? Path { get; set; }
}

public class PairRequest
{
    [JsonPropertyName("secret")]
    public string? Secret { get; set; }
}

public class SessionMediaRequest
{
    [JsonPropertyName("sourceType")]
    public string? SourceType { get; set; }

    [JsonPropertyName("path")]
    public string? Path { get; set; }

    [JsonPropertyName("title")]
    public string? Title { get; set; }
}

public class CreateSessionRequest
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

public class SessionOptionsRequest
{
    [JsonPropertyName("fullscreen")]
    public bool Fullscreen { get; set; } = true;

    [JsonPropertyName("startPositionMs")]
    public long StartPositionMs { get; set; }
}

public static class PlayServer
{
    private static AppConfig _config = new();

    public static void UpdateConfig(AppConfig config) => _config = config;

    public static async Task<WebApplication> StartAsync(AppConfig config)
    {
        UpdateConfig(config);
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.ConfigureKestrel(options => options.ListenAnyIP(config.Port));
        builder.Logging.ClearProviders();

        var app = builder.Build();
        app.Use(async (context, next) =>
        {
            if (context.Request.Path == "/health" || context.Request.Path == "/pair")
            {
                await next();
                return;
            }

            if (string.IsNullOrEmpty(_config.SharedSecret))
            {
                context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                await context.Response.WriteAsJsonAsync(new { error = "Player agent is not paired yet" });
                return;
            }

            if (IsAuthorized(context.Request, _config.SharedSecret))
            {
                await next();
                return;
            }

            Logger.Log($"{context.Request.Path}: rejected unauthorized request from {context.Connection.RemoteIpAddress}");
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = "Missing or incorrect bearer token" });
        });

        app.MapPost("/pair", async (HttpContext ctx) =>
        {
            PairRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<PairRequest>();
            }
            catch (JsonException)
            {
                return Results.Json(new { error = "Invalid JSON request body" }, statusCode: 400);
            }

            var secret = body?.Secret?.Trim();
            if (secret is null || secret.Length != 48 || secret.Any(c => !Uri.IsHexDigit(c)))
                return Results.Json(new { error = "Pairing secret must be 48 hexadecimal characters" }, statusCode: 400);

            await PairingState.MutationLock.WaitAsync();
            try
            {
                var activeConfig = _config;
                if (!string.IsNullOrEmpty(activeConfig.SharedSecret))
                {
                    Logger.Log($"/pair: rejected re-pairing request from {ctx.Connection.RemoteIpAddress}");
                    return Results.Json(
                        new { error = "Player agent is already paired; reset pairing locally before pairing again" },
                        statusCode: 409);
                }

                var previousRegistrationSecret = activeConfig.RegistrationSecret;
                activeConfig.SharedSecret = secret;
                activeConfig.RegistrationSecret = "";
                try
                {
                    activeConfig.Save();
                }
                catch
                {
                    activeConfig.SharedSecret = "";
                    activeConfig.RegistrationSecret = previousRegistrationSecret;
                    throw;
                }

                Logger.Log($"/pair: paired with Home Assistant at {ctx.Connection.RemoteIpAddress}");
                return Results.Json(new { paired = true, instanceId = activeConfig.InstanceId });
            }
            catch (Exception ex)
            {
                Logger.Log($"/pair: failed to save pairing: {ex}");
                return Results.Json(new { error = "Could not save pairing on the player agent" }, statusCode: 500);
            }
            finally
            {
                PairingState.MutationLock.Release();
            }
        });

        app.MapPost("/play", async (HttpContext ctx) =>
        {
            PlayRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<PlayRequest>();
            }
            catch (JsonException ex)
            {
                Logger.Log($"/play: invalid JSON: {ex.Message}");
                return Results.Json(new { error = "Invalid JSON request body" }, statusCode: 400);
            }

            var filePath = body?.Path;
            if (string.IsNullOrWhiteSpace(filePath))
                return Results.Json(new { error = "missing \"path\" in request body" }, statusCode: 400);

            Logger.Log($"/play: request for '{filePath}'");
            try
            {
                var activeConfig = _config;
                await PlayerSessionManager.CreateAsync(null, null, filePath, activeConfig);
                Logger.Log($"/play: launched the default player for '{filePath}'");
                return Results.Json(new { ok = true });
            }
            catch (Exception ex)
            {
                Logger.Log($"/play: failed for '{filePath}': {ex}");
                var status = ex is ArgumentException or UnauthorizedAccessException ? 400 : 500;
                return Results.Json(new { error = ex.Message }, statusCode: status);
            }
        });

        app.MapGet("/status", async () =>
        {
            try
            {
                var status = await MpcStatusReader.GetStatusAsync();
                return Results.Json(status);
            }
            catch (Exception ex)
            {
                Logger.Log($"/status: failed: {ex.Message}");
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        });

        app.MapGet("/v2/info", () =>
        {
            var activeConfig = _config;
            return Results.Json(new
            {
                agent = new
                {
                    instanceId = activeConfig.InstanceId,
                    displayName = Environment.MachineName,
                    version = AgentIdentity.Version,
                    platform = "windows",
                    architecture = AgentIdentity.Architecture,
                },
                capabilities = new[] { "players.list", "sessions.create", "sessions.status" },
                acceptedPathKinds = new[] { "windows-unc" },
                maxConcurrentSessions = 1,
                defaultPlayerId = PlayerCatalog.GetDefaultPlayerId(activeConfig),
                players = PlayerCatalog.GetDescriptors(activeConfig),
            });
        });

        app.MapPost("/v2/sessions", async (HttpContext ctx) =>
        {
            CreateSessionRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<CreateSessionRequest>();
            }
            catch (JsonException)
            {
                return Results.Json(new { error = "Invalid JSON request body" }, statusCode: 400);
            }

            var media = body?.Media;
            if (media is null || !string.Equals(media.SourceType, "file", StringComparison.OrdinalIgnoreCase))
                return Results.Json(new { error = "Only file playback is supported" }, statusCode: 400);
            var request = body!;
            if (string.IsNullOrWhiteSpace(media.Path))
                return Results.Json(new { error = "media.path is required" }, statusCode: 400);
            if (!string.IsNullOrWhiteSpace(request.RequestId) &&
                !Guid.TryParse(request.RequestId, out _))
                return Results.Json(new { error = "requestId must be a UUID" }, statusCode: 400);

            try
            {
                var session = await PlayerSessionManager.CreateAsync(
                    request.RequestId,
                    request.PlayerId,
                    media.Path,
                    _config,
                    media.Title ?? "",
                    Math.Max(0, request.Options?.StartPositionMs ?? 0),
                    request.Options?.Fullscreen ?? true);
                Logger.Log($"/v2/sessions: launched '{session.PlayerId}' for '{media.Path}'");
                return Results.Json(new
                {
                    sessionId = session.SessionId,
                    playerId = session.PlayerId,
                    state = "starting",
                });
            }
            catch (Exception ex)
            {
                Logger.Log($"/v2/sessions: failed for '{media.Path}': {ex}");
                var status = ex is ArgumentException or UnauthorizedAccessException ? 400 : 500;
                return Results.Json(new { error = ex.Message }, statusCode: status);
            }
        });

        app.MapGet("/v2/sessions/{sessionId}", async (string sessionId) =>
        {
            var session = PlayerSessionManager.Find(sessionId);
            if (session is null)
                return Results.Json(new { error = "Playback session was not found" }, statusCode: 404);
            try
            {
                var status = await session.Adapter.GetStatusAsync();
                return Results.Json(new
                {
                    sessionId = session.SessionId,
                    playerId = session.PlayerId,
                    file = status.File,
                    state = status.State,
                    positionMs = status.PositionMs,
                    durationMs = status.DurationMs,
                });
            }
            catch (Exception ex)
            {
                Logger.Log($"/v2/sessions/{sessionId}: status failed: {ex.Message}");
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        });

        app.MapGet("/health", () => Results.Json(new
        {
            ok = true,
            paired = !string.IsNullOrEmpty(_config.SharedSecret),
            protocolVersion = 1,
            supportedProtocolVersions = new[] { 1, 2 },
        }));
        await app.StartAsync();
        return app;
    }

    public static bool IsAuthorized(HttpRequest request, string expectedSecret)
    {
        if (string.IsNullOrEmpty(expectedSecret)) return false;
        var header = request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return false;
        var supplied = header[7..];
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(expectedSecret));
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
        return CryptographicOperations.FixedTimeEquals(expectedHash, suppliedHash);
    }
}
