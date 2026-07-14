using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;

namespace MediaLauncherPlayerAgent;

public static class PairingClient
{
    private const string Product = "media-launcher-player-agent";
    private static readonly object Sync = new();
    private static CancellationTokenSource? _activeLoop;
    private static Task? _activeTask;

    public static void Start(AppConfig config, CancellationToken shutdownToken)
    {
        CancellationTokenSource loop;
        CancellationTokenSource? previousLoop;
        Task? previousTask;
        lock (Sync)
        {
            previousLoop = _activeLoop;
            previousTask = _activeTask;
            previousLoop?.Cancel();
            _activeLoop = CancellationTokenSource.CreateLinkedTokenSource(shutdownToken);
            loop = _activeLoop;
            _activeTask = Task.Run(() => RunAsync(config, loop.Token));
        }
        if (previousLoop is not null)
        {
            _ = (previousTask ?? Task.CompletedTask).ContinueWith(
                _ => previousLoop.Dispose(),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }

    public static async Task StopAsync()
    {
        CancellationTokenSource? loop;
        Task? task;
        lock (Sync)
        {
            loop = _activeLoop;
            task = _activeTask;
            _activeLoop = null;
            _activeTask = null;
        }
        if (loop is null) return;
        loop.Cancel();
        try
        {
            if (task is not null) await task;
        }
        catch (OperationCanceledException) { /* Expected while stopping. */ }
        finally
        {
            loop.Dispose();
        }
    }

    private static async Task RunAsync(AppConfig config, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var retryDelay = TimeSpan.FromSeconds(15);
            try
            {
                var result = await RegisterAsync(config, cancellationToken);
                if (result.State == RegistrationState.Conflict)
                {
                    Logger.Log("Automatic pairing stopped. Remove the device in Home Assistant and reset pairing locally before enrolling it again.");
                    return;
                }
                if (result.State == RegistrationState.Paired)
                    retryDelay = result.NextAttempt;
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
                await Task.Delay(retryDelay, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private static async Task<RegistrationAttempt> RegisterAsync(
        AppConfig config,
        CancellationToken cancellationToken)
    {
        await PairingState.MutationLock.WaitAsync(cancellationToken);
        try
        {
            var registrationCredential = EnsureRegistrationCredential(config);
            var baseUri = new Uri(config.HomeAssistantUrl.TrimEnd('/') + "/");
            var endpoint = new Uri(baseUri, "api/player-agent/register");
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
            {
                Content = JsonContent.Create(new
                {
                    product = Product,
                    protocolVersion = 1,
                    supportedProtocolVersions = new[] { 1, 2 },
                    instanceId = config.InstanceId,
                    port = config.Port,
                    agentVersion = AgentIdentity.Version,
                    displayName = Environment.MachineName,
                    platform = "windows",
                    architecture = AgentIdentity.Architecture,
                    players = PlayerCatalog.GetDescriptors(config).Select(player => new
                    {
                        id = player.Id,
                        kind = player.Kind,
                        name = player.DisplayName,
                        available = player.Available,
                        capabilities = player.Capabilities,
                    }),
                }),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", registrationCredential);

            using var response = await client.SendAsync(request, cancellationToken);
            if (response.StatusCode is HttpStatusCode.Conflict or HttpStatusCode.Forbidden)
            {
                var error = await ReadErrorAsync(response, cancellationToken);
                Logger.Log($"Automatic pairing was rejected: {error}");
                return new RegistrationAttempt(RegistrationState.Conflict, TimeSpan.Zero);
            }
            if (!response.IsSuccessStatusCode)
            {
                var error = await ReadErrorAsync(response, cancellationToken);
                Logger.Log($"Automatic pairing returned {(int)response.StatusCode}: {error}");
                var retry = response.StatusCode == HttpStatusCode.TooManyRequests
                    ? TimeSpan.FromMinutes(5)
                    : TimeSpan.FromSeconds(15);
                return new RegistrationAttempt(RegistrationState.Retry, retry);
            }

            var body = await response.Content.ReadFromJsonAsync<RegistrationResponse>(
                cancellationToken: cancellationToken);
            var secret = body?.Secret?.Trim().ToLowerInvariant();
            if (secret is null || secret.Length != 48 || secret.Any(c => !Uri.IsHexDigit(c)))
                throw new InvalidDataException("The add-on returned an invalid pairing secret.");

            if (!string.Equals(config.SharedSecret, secret, StringComparison.Ordinal) ||
                !string.IsNullOrEmpty(config.RegistrationSecret))
            {
                var previousSharedSecret = config.SharedSecret;
                var previousRegistrationSecret = config.RegistrationSecret;
                config.SharedSecret = secret;
                config.RegistrationSecret = "";
                try
                {
                    config.Save();
                }
                catch
                {
                    config.SharedSecret = previousSharedSecret;
                    config.RegistrationSecret = previousRegistrationSecret;
                    throw;
                }
                PlayServer.UpdateConfig(config);
            }
            Logger.Log("Automatically paired with the configured Home Assistant add-on.");
            var refreshSeconds = body?.RegistrationRefreshSeconds is > 0
                ? Math.Clamp(body.RegistrationRefreshSeconds.Value, 30, 24 * 60 * 60)
                : 30 * 60;
            return new RegistrationAttempt(RegistrationState.Paired, TimeSpan.FromSeconds(refreshSeconds));
        }
        finally
        {
            PairingState.MutationLock.Release();
        }
    }

    private static string EnsureRegistrationCredential(AppConfig config)
    {
        if (!string.IsNullOrEmpty(config.SharedSecret)) return config.SharedSecret;
        if (!string.IsNullOrEmpty(config.RegistrationSecret)) return config.RegistrationSecret;

        var credential = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var previous = config.RegistrationSecret;
        config.RegistrationSecret = credential;
        try
        {
            config.Save();
            return credential;
        }
        catch
        {
            config.RegistrationSecret = previous;
            throw;
        }
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
        public int? RegistrationRefreshSeconds { get; set; }
    }

    private sealed record RegistrationAttempt(RegistrationState State, TimeSpan NextAttempt);

    private enum RegistrationState
    {
        Paired,
        Retry,
        Conflict,
    }
}
