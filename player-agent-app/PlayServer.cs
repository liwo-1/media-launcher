using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace MediaLauncherPlayerAgent;

public class SeekSessionRequest
{
    [JsonPropertyName("positionMs")]
    public long? PositionMs { get; set; }
}

public static class PlayServer
{
    private static readonly long UnauthorizedLogIntervalTicks = TimeSpan.FromSeconds(30).Ticks;
    private static AppConfig _config = new();
    private static long _lastUnauthorizedLogUtcTicks;

    public static void UpdateConfig(AppConfig config) => _config = config;

    public static async Task<WebApplication> StartAsync(AppConfig config)
    {
        UpdateConfig(config);
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.ListenAnyIP(config.Port);
            options.Limits.MaxRequestBodySize = 32 * 1024;
            options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
        });
        builder.Logging.ClearProviders();

        var app = builder.Build();
        app.Use(async (context, next) =>
        {
            context.Response.Headers.XContentTypeOptions = "nosniff";
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

            LogUnauthorizedRequest(context);
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = "Missing or incorrect bearer token" });
        });

        app.MapPost("/pair", async (HttpContext ctx) =>
        {
            PairRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<PairRequest>(ctx.RequestAborted);
            }
            catch (JsonException)
            {
                return Results.Json(new { error = "Invalid JSON request body" }, statusCode: 400);
            }

            var secret = body?.Secret?.Trim();
            if (!BearerAuthentication.IsPairingSecret(secret))
                return Results.Json(new { error = "Pairing secret must be 48 hexadecimal characters" }, statusCode: 400);

            await PairingState.MutationLock.WaitAsync(ctx.RequestAborted);
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
                if (string.IsNullOrEmpty(activeConfig.RegistrationSecret) ||
                    !BearerAuthentication.IsAuthorized($"Bearer {secret}", activeConfig.RegistrationSecret))
                {
                    Logger.Log($"/pair: rejected invalid enrollment proof from {ctx.Connection.RemoteIpAddress}");
                    return Results.Json(
                        new { error = "Pairing requires the agent's current enrollment credential" },
                        statusCode: 403);
                }

                var previousRegistrationSecret = activeConfig.RegistrationSecret;
                activeConfig.SharedSecret = secret!;
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
            LegacyPlayRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<LegacyPlayRequest>(ctx.RequestAborted);
            }
            catch (JsonException ex)
            {
                Logger.Log($"/play: invalid JSON: {ex.Message}");
                return Results.Json(new { error = "Invalid JSON request body" }, statusCode: 400);
            }

            var filePath = body?.Path;
            if (string.IsNullOrWhiteSpace(filePath))
                return Results.Json(new { error = "missing \"path\" in request body" }, statusCode: 400);

            try
            {
                var activeConfig = _config;
                await PlayerSessionManager.CreateAsync(null, null, filePath, activeConfig);
                Logger.Log("/play: launched the default player.");
                return Results.Json(new { ok = true });
            }
            catch (Exception ex)
            {
                Logger.Log($"/play: failed: {ex}");
                var status = ex is ArgumentException or UnauthorizedAccessException ? 400 : 500;
                return Results.Json(new { error = ex.Message }, statusCode: status);
            }
        });

        app.MapGet("/status", async () =>
        {
            var session = PlayerSessionManager.Current;
            if (session is null || session.EndReason is not null)
            {
                return Results.Json(new MpcStatusResult
                {
                    State = 0,
                    Position = 0,
                    Duration = 0,
                });
            }
            if (!PlayerCapabilities.Supports(session.Adapter.Descriptor, PlayerCapabilities.StatusState))
            {
                return Results.Json(
                    new { error = $"{session.Adapter.Descriptor.DisplayName} does not provide playback status" },
                    statusCode: 502);
            }
            try
            {
                var status = await session.Adapter.GetStatusAsync();
                PlayerSessionManager.RememberStatus(session, status);
                if (session.EndReason is not null)
                {
                    return Results.Json(new MpcStatusResult
                    {
                        File = status.File,
                        State = 0,
                        Position = status.PositionMs,
                        Duration = status.DurationMs,
                    });
                }
                return Results.Json(new MpcStatusResult
                {
                    File = status.File,
                    State = status.State switch
                    {
                        "playing" => 2,
                        "paused" => 1,
                        _ => 0,
                    },
                    Position = status.PositionMs,
                    Duration = status.DurationMs,
                });
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
                capabilities = new[]
                {
                    AgentCapabilities.PlayersList,
                    AgentCapabilities.SessionsCreate,
                    AgentCapabilities.SessionsStatus,
                    AgentCapabilities.SessionsControl,
                    AgentCapabilities.SessionsEndReasons,
                },
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
                body = await ctx.Request.ReadFromJsonAsync<CreateSessionRequest>(ctx.RequestAborted);
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
            if (request.Options?.StartPositionMs is < 0 or > SessionControlLimits.MaxSeekPositionMs)
                return Results.Json(
                    new { error = "options.startPositionMs must be between 0 and seven days" },
                    statusCode: 400);

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
                Logger.Log($"/v2/sessions: launched player '{session.PlayerId}'.");
                return Results.Json(new
                {
                    sessionId = session.SessionId,
                    playerId = session.PlayerId,
                    state = session.EndReason is null ? "starting" : "stopped",
                    endReason = session.EndReason,
                    capabilities = session.Adapter.Descriptor.Capabilities,
                });
            }
            catch (Exception ex)
            {
                Logger.Log($"/v2/sessions: failed: {ex}");
                var status = ex is ArgumentException or UnauthorizedAccessException ? 400 : 500;
                return Results.Json(new { error = ex.Message }, statusCode: status);
            }
        });

        app.MapGet("/v2/sessions/{sessionId}", async (string sessionId) =>
        {
            var session = PlayerSessionManager.Find(sessionId);
            if (session is null)
                return SessionNotFound();
            if (session.EndReason is not null) return EndedSessionStatus(session);
            if (!PlayerCapabilities.Supports(session.Adapter.Descriptor, PlayerCapabilities.StatusState))
            {
                return CapabilityNotSupported(session, PlayerCapabilities.StatusState);
            }
            try
            {
                var status = await session.Adapter.GetStatusAsync();
                PlayerSessionManager.RememberStatus(session, status);
                if (session.EndReason is not null) return EndedSessionStatus(session);
                return Results.Json(new
                {
                    sessionId = session.SessionId,
                    playerId = session.PlayerId,
                    file = status.File,
                    state = status.State,
                    positionMs = status.PositionMs,
                    durationMs = status.DurationMs,
                    endReason = (string?)null,
                });
            }
            catch (Exception ex)
            {
                if (session.EndReason is not null) return EndedSessionStatus(session);
                Logger.Log($"/v2/sessions/{sessionId}: status failed: {ex.Message}");
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        });

        app.MapPost("/v2/sessions/{sessionId}/control", async (string sessionId, HttpContext ctx) =>
        {
            SessionControlRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<SessionControlRequest>(ctx.RequestAborted);
            }
            catch (JsonException)
            {
                return Results.Json(new { error = "Invalid JSON request body" }, statusCode: 400);
            }

            var action = body?.Action?.Trim().ToLowerInvariant();
            if (action is not ("pause" or "resume" or "seek" or "stop"))
            {
                return Results.Json(
                    new { error = "action must be pause, resume, seek, or stop" },
                    statusCode: 400);
            }
            if (action == "seek" && (body?.PositionMs is null ||
                                     body.PositionMs < 0 ||
                                     body.PositionMs > SessionControlLimits.MaxSeekPositionMs))
            {
                return Results.Json(
                    new { error = "positionMs must be between 0 and seven days for seek" },
                    statusCode: 400);
            }

            try
            {
                AgentPlaybackSession? session;
                string state;
                switch (action)
                {
                    case "pause":
                        session = await PlayerSessionManager.SetPausedAsync(sessionId, paused: true);
                        state = "paused";
                        break;
                    case "resume":
                        session = await PlayerSessionManager.SetPausedAsync(sessionId, paused: false);
                        state = "playing";
                        break;
                    case "seek":
                        session = await PlayerSessionManager.SeekAsync(sessionId, body!.PositionMs!.Value);
                        state = "seeking";
                        break;
                    default:
                        session = await PlayerSessionManager.StopAsync(sessionId);
                        state = "stopped";
                        break;
                }
                return session is null
                    ? SessionNotFound()
                    : Results.Json(new
                    {
                        sessionId,
                        action,
                        state,
                        positionMs = action == "seek" ? body!.PositionMs : null,
                        endReason = session.EndReason,
                    });
            }
            catch (PlayerSessionControlException ex)
            {
                return SessionControlError(ex);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Json(
                    new { error = ex.Message, code = "control_rejected" },
                    statusCode: 409);
            }
            catch (Exception ex)
            {
                Logger.Log($"/v2/sessions/{sessionId}/control: failed: {ex.Message}");
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        });

        app.MapPost("/v2/sessions/{sessionId}/pause", async (string sessionId) =>
        {
            try
            {
                var session = await PlayerSessionManager.PauseAsync(sessionId);
                return session is null
                    ? SessionNotFound()
                    : Results.Json(new { sessionId, state = "paused" });
            }
            catch (PlayerSessionControlException ex)
            {
                return SessionControlError(ex);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Json(
                    new { error = ex.Message, code = "control_rejected" },
                    statusCode: 409);
            }
            catch (Exception ex)
            {
                Logger.Log($"/v2/sessions/{sessionId}/pause: failed: {ex.Message}");
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        });

        app.MapPost("/v2/sessions/{sessionId}/resume", async (string sessionId) =>
        {
            try
            {
                var session = await PlayerSessionManager.ResumeAsync(sessionId);
                return session is null
                    ? SessionNotFound()
                    : Results.Json(new { sessionId, state = "playing" });
            }
            catch (PlayerSessionControlException ex)
            {
                return SessionControlError(ex);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Json(
                    new { error = ex.Message, code = "control_rejected" },
                    statusCode: 409);
            }
            catch (Exception ex)
            {
                Logger.Log($"/v2/sessions/{sessionId}/resume: failed: {ex.Message}");
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        });

        app.MapPost("/v2/sessions/{sessionId}/seek", async (string sessionId, HttpContext ctx) =>
        {
            SeekSessionRequest? body;
            try
            {
                body = await ctx.Request.ReadFromJsonAsync<SeekSessionRequest>(ctx.RequestAborted);
            }
            catch (JsonException)
            {
                return Results.Json(new { error = "Invalid JSON request body" }, statusCode: 400);
            }
            if (body?.PositionMs is null ||
                body.PositionMs < 0 ||
                body.PositionMs > SessionControlLimits.MaxSeekPositionMs)
            {
                return Results.Json(
                    new { error = "positionMs must be between 0 and seven days" },
                    statusCode: 400);
            }

            try
            {
                var session = await PlayerSessionManager.SeekAsync(sessionId, body.PositionMs.Value);
                return session is null
                    ? SessionNotFound()
                    : Results.Json(new
                    {
                        sessionId,
                        state = "seeking",
                        positionMs = body.PositionMs.Value,
                    });
            }
            catch (PlayerSessionControlException ex)
            {
                return SessionControlError(ex);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Json(
                    new { error = ex.Message, code = "control_rejected" },
                    statusCode: 409);
            }
            catch (Exception ex)
            {
                Logger.Log($"/v2/sessions/{sessionId}/seek: failed: {ex.Message}");
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        });

        app.MapPost("/v2/sessions/{sessionId}/stop", async (string sessionId) =>
        {
            try
            {
                var session = await PlayerSessionManager.StopAsync(sessionId);
                return session is null
                    ? SessionNotFound()
                    : Results.Json(new
                    {
                        sessionId,
                        state = "stopped",
                        endReason = session.EndReason,
                    });
            }
            catch (PlayerSessionControlException ex)
            {
                return SessionControlError(ex);
            }
            catch (Exception ex)
            {
                Logger.Log($"/v2/sessions/{sessionId}/stop: failed: {ex.Message}");
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        });

        app.MapGet("/health", () => Results.Json(new
        {
            ok = true,
            paired = !string.IsNullOrEmpty(_config.SharedSecret),
            protocolVersion = AgentProtocol.LegacyVersion,
            supportedProtocolVersions = AgentProtocol.SupportedVersions,
        }));
        await app.StartAsync();
        return app;
    }

    private static void LogUnauthorizedRequest(HttpContext context)
    {
        if (!ShouldLogUnauthorizedRequest(DateTimeOffset.UtcNow.UtcTicks)) return;
        Logger.Log($"Rejected an unauthorized agent request from {context.Connection.RemoteIpAddress}.");
    }

    internal static bool ShouldLogUnauthorizedRequest(long nowUtcTicks)
    {
        var previous = Interlocked.Read(ref _lastUnauthorizedLogUtcTicks);
        if (previous != 0 && nowUtcTicks - previous < UnauthorizedLogIntervalTicks) return false;
        return Interlocked.CompareExchange(ref _lastUnauthorizedLogUtcTicks, nowUtcTicks, previous) == previous;
    }

    internal static void ResetUnauthorizedLogLimiterForTests() =>
        Interlocked.Exchange(ref _lastUnauthorizedLogUtcTicks, 0);

    public static bool IsAuthorized(HttpRequest request, string expectedSecret)
    {
        return BearerAuthentication.IsAuthorized(
            request.Headers.Authorization.ToString(),
            expectedSecret);
    }

    private static IResult SessionNotFound() =>
        Results.Json(new { error = "Playback session was not found" }, statusCode: 404);

    private static IResult CapabilityNotSupported(AgentPlaybackSession session, string capability) =>
        Results.Json(new
        {
            error = $"{session.Adapter.Descriptor.DisplayName} does not support '{capability}'.",
            code = "capability_not_supported",
            capability,
        }, statusCode: 409);

    private static IResult SessionControlError(PlayerSessionControlException exception) =>
        Results.Json(new
        {
            error = exception.Message,
            code = exception.Code,
            capability = exception.Capability,
        }, statusCode: 409);

    private static IResult EndedSessionStatus(AgentPlaybackSession session)
    {
        var lastStatus = session.LastStatus;
        return Results.Json(new
        {
            sessionId = session.SessionId,
            playerId = session.PlayerId,
            file = lastStatus?.File ?? session.MediaPath,
            state = "stopped",
            positionMs = lastStatus?.PositionMs ?? 0,
            durationMs = lastStatus?.DurationMs ?? 0,
            endReason = session.EndReason,
            endedAt = session.EndedAt,
        });
    }
}
