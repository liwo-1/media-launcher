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

public static class PlayServer
{
    private static AppConfig _config = new();

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
            if (context.Request.Path == "/health" || IsAuthorized(context.Request, _config.SharedSecret))
            {
                await next();
                return;
            }

            Logger.Log($"{context.Request.Path}: rejected unauthorized request from {context.Connection.RemoteIpAddress}");
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await context.Response.WriteAsJsonAsync(new { error = "Missing or incorrect bearer token" });
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

        app.MapGet("/health", () => Results.Json(new { ok = true }));
        await app.StartAsync();
        return app;
    }

    public static bool IsAuthorized(HttpRequest request, string expectedSecret)
    {
        if (string.IsNullOrEmpty(expectedSecret)) return true;
        var header = request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return false;
        var supplied = header[7..];
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(expectedSecret));
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
        return CryptographicOperations.FixedTimeEquals(expectedHash, suppliedHash);
    }
}
