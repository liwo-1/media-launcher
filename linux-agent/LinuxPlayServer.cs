using System.Text.Json;
using MediaLauncher.Agent.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace MediaLauncher.LinuxAgent;

internal static class LinuxPlayServer
{
    private static long _lastUnauthorizedLogUtcTicks;

    public static async Task<WebApplication> StartAsync(
        LinuxAgentConfig config,
        string configPath,
        CancellationToken cancellationToken)
    {
        var builder = WebApplication.CreateSlimBuilder();
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
            if (string.IsNullOrEmpty(config.SharedSecret))
            {
                context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                await context.Response.WriteAsJsonAsync(new { error = "Player agent is not paired yet" });
                return;
            }
            if (!BearerAuthentication.IsAuthorized(
                context.Request.Headers.Authorization.ToString(),
                config.SharedSecret))
            {
                LogUnauthorizedRequest(context);
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await context.Response.WriteAsJsonAsync(new { error = "Missing or incorrect bearer token" });
                return;
            }
            await next();
        });

        app.MapPost("/pair", async (HttpContext context) =>
        {
            PairRequest? body;
            try { body = await context.Request.ReadFromJsonAsync<PairRequest>(context.RequestAborted); }
            catch (JsonException) { return JsonError("Invalid JSON request body", 400); }
            var secret = body?.Secret?.Trim().ToLowerInvariant();
            if (!BearerAuthentication.IsPairingSecret(secret))
                return JsonError("Pairing secret must be 48 hexadecimal characters", 400);

            await PairingState.MutationLock.WaitAsync(context.RequestAborted);
            try
            {
                if (!string.IsNullOrEmpty(config.SharedSecret))
                    return JsonError("Player agent is already paired; reset pairing locally before pairing again", 409);
                if (string.IsNullOrEmpty(config.RegistrationSecret) ||
                    !BearerAuthentication.IsAuthorized($"Bearer {secret}", config.RegistrationSecret))
                {
                    AgentLogger.Log($"/pair: rejected invalid enrollment proof from {context.Connection.RemoteIpAddress}");
                    return JsonError("Pairing requires the agent's current enrollment credential", 403);
                }
                var previousRegistration = config.RegistrationSecret;
                config.SharedSecret = secret!;
                config.RegistrationSecret = "";
                try { await config.SaveAsync(configPath, context.RequestAborted); }
                catch
                {
                    config.SharedSecret = "";
                    config.RegistrationSecret = previousRegistration;
                    throw;
                }
                return Results.Json(new { paired = true, instanceId = config.InstanceId });
            }
            catch (Exception error)
            {
                AgentLogger.Log($"/pair: failed to save pairing ({error.GetType().Name}).");
                return JsonError("Could not save pairing on the player agent", 500);
            }
            finally { PairingState.MutationLock.Release(); }
        });

        app.MapPost("/play", async (HttpContext context) =>
        {
            LegacyPlayRequest? body;
            try { body = await context.Request.ReadFromJsonAsync<LegacyPlayRequest>(context.RequestAborted); }
            catch (JsonException) { return JsonError("Invalid JSON request body", 400); }
            if (string.IsNullOrWhiteSpace(body?.Path)) return JsonError("missing path in request body", 400);
            try
            {
                await LinuxSessionManager.CreateAsync(null, null, body.Path, config);
                return Results.Json(new { ok = true });
            }
            catch (Exception error) { return SafeFailure("/play", error); }
        });

        app.MapGet("/status", async () =>
        {
            var current = LinuxSessionManager.Current;
            if (current is null || current.EndReason is not null)
                return Results.Json(LegacyPlayerStatusResponse.Stopped());
            if (!PlayerCapabilities.Supports(
                current.Adapter.Descriptor,
                PlayerCapabilities.StatusState))
            {
                return JsonError(
                    $"{current.Adapter.Descriptor.DisplayName} does not provide playback status",
                    502);
            }
            try
            {
                var status = await LinuxSessionManager.GetStatusAsync(current.SessionId);
                return Results.Json(LegacyPlayerStatusResponse.From(status));
            }
            catch (Exception error) { return SafeFailure("/status", error, 502); }
        });

        app.MapGet("/v2/info", () => Results.Json(new
        {
            agent = new
            {
                instanceId = config.InstanceId,
                displayName = config.DisplayName,
                version = AgentIdentity.Version,
                platform = "linux",
                architecture = AgentIdentity.Architecture,
            },
            capabilities = AgentCapabilities.ProtocolV2,
            acceptedPathKinds = new[] { "linux-absolute" },
            maxConcurrentSessions = 1,
            defaultPlayerId = DefaultPlayerId(config),
            players = LinuxPlayerCatalog.GetDescriptors(config),
        }));

        app.MapPost("/v2/sessions", async (HttpContext context) =>
        {
            CreateSessionRequest? body;
            try { body = await context.Request.ReadFromJsonAsync<CreateSessionRequest>(context.RequestAborted); }
            catch (JsonException) { return JsonError("Invalid JSON request body", 400); }
            if (body?.Media is null || !string.Equals(body.Media.SourceType, "file", StringComparison.OrdinalIgnoreCase))
                return JsonError("Only file playback is supported", 400);
            if (string.IsNullOrWhiteSpace(body.Media.Path)) return JsonError("media.path is required", 400);
            if (!string.IsNullOrWhiteSpace(body.RequestId) && !Guid.TryParse(body.RequestId, out _))
                return JsonError("requestId must be a UUID", 400);
            if (body.Options?.StartPositionMs is < 0 or > SessionControlLimits.MaxSeekPositionMs)
                return JsonError("options.startPositionMs must be between 0 and seven days", 400);
            try
            {
                var session = await LinuxSessionManager.CreateAsync(
                    body.RequestId,
                    body.PlayerId,
                    body.Media.Path,
                    config,
                    body.Media.Title ?? "",
                    body.Options?.StartPositionMs ?? 0,
                    body.Options?.Fullscreen ?? true);
                return Results.Json(new
                {
                    sessionId = session.SessionId,
                    playerId = session.PlayerId,
                    state = "starting",
                });
            }
            catch (Exception error) { return SafeFailure("/v2/sessions", error); }
        });

        app.MapGet("/v2/sessions/{sessionId}", async (string sessionId) =>
        {
            var session = LinuxSessionManager.Find(sessionId);
            if (session is null) return JsonError("Playback session was not found", 404);
            try
            {
                var status = await LinuxSessionManager.GetStatusAsync(sessionId);
                return Results.Json(new
                {
                    sessionId = session.SessionId,
                    playerId = session.PlayerId,
                    file = status.File,
                    state = status.State,
                    positionMs = status.PositionMs,
                    durationMs = status.DurationMs,
                    endReason = session.EndReason,
                });
            }
            catch (Exception error) { return SafeFailure("/v2/sessions/status", error, 502); }
        });

        app.MapPost("/v2/sessions/{sessionId}/control", async (string sessionId, HttpContext context) =>
        {
            SessionControlRequest? body;
            try { body = await context.Request.ReadFromJsonAsync<SessionControlRequest>(context.RequestAborted); }
            catch (JsonException) { return JsonError("Invalid JSON request body", 400); }
            var action = body?.Action?.Trim().ToLowerInvariant() ?? "";
            try
            {
                var session = await LinuxSessionManager.ControlAsync(sessionId, action, body?.PositionMs);
                return Results.Json(new
                {
                    ok = true,
                    sessionId,
                    action,
                    endReason = session.EndReason,
                });
            }
            catch (Exception error) { return SafeFailure("/v2/sessions/control", error); }
        });

        app.MapGet("/health", () => Results.Json(new
        {
            ok = true,
            paired = !string.IsNullOrEmpty(config.SharedSecret),
            protocolVersion = AgentProtocol.LegacyVersion,
            supportedProtocolVersions = AgentProtocol.SupportedVersions,
        }));

        await app.StartAsync(cancellationToken);
        return app;
    }

    private static string? DefaultPlayerId(LinuxAgentConfig config) =>
        LinuxPlayerCatalog.GetDefaultPlayerId(config);

    private static void LogUnauthorizedRequest(HttpContext context)
    {
        var now = DateTimeOffset.UtcNow.UtcTicks;
        var previous = Interlocked.Read(ref _lastUnauthorizedLogUtcTicks);
        if (now - previous < TimeSpan.FromSeconds(30).Ticks) return;
        if (Interlocked.CompareExchange(ref _lastUnauthorizedLogUtcTicks, now, previous) != previous) return;
        AgentLogger.Log($"Rejected an unauthorized agent request from {context.Connection.RemoteIpAddress}.");
    }

    private static IResult SafeFailure(string operation, Exception error, int? forcedStatus = null)
    {
        var status = forcedStatus ?? error switch
        {
            KeyNotFoundException => 404,
            NotSupportedException => 409,
            ArgumentException or InvalidDataException or UnauthorizedAccessException => 400,
            FileNotFoundException => 422,
            _ => 500,
        };
        AgentLogger.Log($"{operation} failed ({error.GetType().Name}, HTTP {status}).");
        var message = status >= 500 ? "The player operation failed." : error.Message;
        return JsonError(message, status);
    }

    private static IResult JsonError(string message, int status) =>
        Results.Json(new { error = message }, statusCode: status);
}
