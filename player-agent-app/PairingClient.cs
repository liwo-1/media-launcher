using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace MediaLauncherPlayerAgent;

public static class PairingClient
{
    private const string Product = "media-launcher-player-agent";
    private static readonly object Sync = new();
    private static CancellationTokenSource? _activeLoop;

    public static void Start(AppConfig config, CancellationToken shutdownToken)
    {
        CancellationTokenSource loop;
        lock (Sync)
        {
            _activeLoop?.Cancel();
            _activeLoop?.Dispose();
            _activeLoop = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
            loop = _activeLoop;
        }

        _ = Task.Run(() => RunAsync(config, loop.Token));
    }

    private static async Task RunAsync(AppConfig config, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var result = await RegisterAsync(config, cancellationToken);
                if (result == RegistrationResult.Paired) return;
                if (result == RegistrationResult.Conflict)
                {
                    Logger.Log("Automatic pairing stopped because the add-on is bound to a different player agent.");
                    return;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                Logger.Log($"Automatic pairing attempt failed: {ex.Message}");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(15), cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private static async Task<RegistrationResult> RegisterAsync(
        AppConfig config,
        CancellationToken cancellationToken)
    {
        var baseUri = new Uri(config.HomeAssistantUrl.TrimEnd('/') + "/");
        var endpoint = new Uri(baseUri, "api/player-agent/register");
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = JsonContent.Create(new
            {
                product = Product,
                protocolVersion = 1,
                instanceId = config.InstanceId,
                port = config.Port,
            }),
        };
        if (!string.IsNullOrEmpty(config.SharedSecret))
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.SharedSecret);

        using var response = await client.SendAsync(request, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Conflict)
        {
            var error = await ReadErrorAsync(response, cancellationToken);
            Logger.Log($"Automatic pairing was rejected: {error}");
            return RegistrationResult.Conflict;
        }
        if (!response.IsSuccessStatusCode)
        {
            var error = await ReadErrorAsync(response, cancellationToken);
            Logger.Log($"Automatic pairing returned {(int)response.StatusCode}: {error}");
            return RegistrationResult.Retry;
        }

        var body = await response.Content.ReadFromJsonAsync<RegistrationResponse>(cancellationToken: cancellationToken);
        var secret = body?.Secret?.Trim().ToLowerInvariant();
        if (secret is null || secret.Length != 48 || secret.Any(c => !Uri.IsHexDigit(c)))
            throw new InvalidDataException("The add-on returned an invalid pairing secret.");

        if (!string.Equals(config.SharedSecret, secret, StringComparison.Ordinal))
        {
            config.SharedSecret = secret;
            config.Save();
            PlayServer.UpdateConfig(config);
        }
        Logger.Log("Automatically paired with the configured Home Assistant add-on.");
        return RegistrationResult.Paired;
    }

    private static async Task<string> ReadErrorAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            using var json = await JsonDocument.ParseAsync(
                await response.Content.ReadAsStreamAsync(cancellationToken),
                cancellationToken: cancellationToken);
            return json.RootElement.TryGetProperty("error", out var error)
                ? error.GetString() ?? response.ReasonPhrase ?? "request failed"
                : response.ReasonPhrase ?? "request failed";
        }
        catch (JsonException)
        {
            return response.ReasonPhrase ?? "request failed";
        }
    }

    private sealed class RegistrationResponse
    {
        public string? Secret { get; set; }
    }

    private enum RegistrationResult
    {
        Paired,
        Retry,
        Conflict,
    }
}
