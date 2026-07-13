using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace MediaLauncherPlayerAgent;

public class PlayRequest
{
    // System.Text.Json matches property names case-sensitively by default - the addon sends
    // {"path": "..."} (lowercase), which won't bind to a plain "Path" property without this.
    [JsonPropertyName("path")]
    public string? Path { get; set; }
}

public static class PlayServer
{
    public static async Task<WebApplication> StartAsync(AppConfig config)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseUrls($"http://0.0.0.0:{config.Port}/");
        builder.Logging.ClearProviders(); // this is a GUI app with no console attached

        var app = builder.Build();

        app.MapPost("/play", async (HttpContext ctx) =>
        {
            string? filePath = null;
            string rawBody = "";
            try
            {
                using var reader = new StreamReader(ctx.Request.Body);
                rawBody = await reader.ReadToEndAsync();
                var body = JsonSerializer.Deserialize<PlayRequest>(rawBody);
                filePath = body?.Path;
            }
            catch (JsonException ex)
            {
                Logger.Log($"/play: failed to parse request body '{rawBody}': {ex.Message}");
            }

            if (string.IsNullOrWhiteSpace(filePath))
            {
                Logger.Log($"/play: missing \"path\" in request body (raw body: '{rawBody}')");
                return Results.Json(new { error = "missing \"path\" in request body" }, statusCode: 400);
            }

            Logger.Log($"/play: request for '{filePath}'");
            try
            {
                await MpcLauncher.PlayAsync(filePath, config.MpcPathOverride);
                Logger.Log($"/play: launched MPC-HC for '{filePath}'");
                return Results.Json(new { ok = true });
            }
            catch (Exception ex)
            {
                Logger.Log($"/play: failed for '{filePath}': {ex}");
                return Results.Json(new { error = ex.Message }, statusCode: 500);
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
}
