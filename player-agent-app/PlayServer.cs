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

public static class PlayServer
{
    private static AppConfig _config = new();
    private static readonly SemaphoreSlim PairingLock = new(1, 1);

    public static void UpdateConfig(AppConfig config) => _config = config;

    public static async Task<WebApplication> StartAsync(AppConfig config)
    {
        UpdateConfig(config);
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls($"http://0.0.0.0:{config.Port}/");
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

            await PairingLock.WaitAsync();
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

                activeConfig.SharedSecret = secret;
                try
                {
                    activeConfig.Save();
                }
                catch
                {
                    activeConfig.SharedSecret = "";
                    throw;
                }

                Logger.Log($"/pair: paired with Home Assistant at {ctx.Connection.RemoteIpAddress}");
                return Results.Json(new { paired = true });
            }
            catch (Exception ex)
            {
                Logger.Log($"/pair: failed to save pairing: {ex}");
                return Results.Json(new { error = "Could not save pairing on the player agent" }, statusCode: 500);
            }
            finally
            {
                PairingLock.Release();
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
                await MpcLauncher.PlayAsync(filePath, activeConfig.MpcPathOverride, activeConfig.AllowedMediaRoots);
                Logger.Log($"/play: launched MPC-HC for '{filePath}'");
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

        app.MapGet("/health", () => Results.Json(new { ok = true, paired = !string.IsNullOrEmpty(_config.SharedSecret) }));
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
