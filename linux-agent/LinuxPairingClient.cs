using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using MediaLauncher.Agent.Core;

namespace MediaLauncher.LinuxAgent;

internal static class LinuxPairingClient
{
    private const string Product = "media-launcher-player-agent";

    public static async Task RunAsync(
        LinuxAgentConfig config,
        string configPath,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var retry = TimeSpan.FromSeconds(15);
            try
            {
                var attempt = await RegisterAsync(config, configPath, cancellationToken);
                if (attempt.Conflict)
                {
                    AgentLogger.Log("Automatic pairing stopped after Home Assistant rejected this identity. Run reset-pairing locally after removing the old device.");
                    return;
                }
                retry = attempt.NextAttempt;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception error)
            {
                AgentLogger.Log($"Automatic pairing attempt failed: {error.Message}");
            }

            try { await Task.Delay(retry, cancellationToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    internal static async Task<RegistrationAttempt> RegisterAsync(
        LinuxAgentConfig config,
        string configPath,
        CancellationToken cancellationToken,
        HttpMessageHandler? handler = null)
    {
        await PairingState.MutationLock.WaitAsync(cancellationToken);
        try
        {
            var credential = config.EnsureRegistrationCredential();
            await config.SaveAsync(configPath, cancellationToken);
            var baseUri = new Uri(config.HomeAssistantUrl.TrimEnd('/') + "/");
            var endpoint = new Uri(baseUri, "api/player-agent/register");
            using var client = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
            client.Timeout = TimeSpan.FromSeconds(10);
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
            {
                Content = JsonContent.Create(new
                {
                    product = Product,
                    protocolVersion = AgentProtocol.LegacyVersion,
                    supportedProtocolVersions = AgentProtocol.SupportedVersions,
                    instanceId = config.InstanceId,
                    port = config.Port,
                    agentVersion = AgentIdentity.Version,
                    displayName = config.DisplayName,
                    platform = "linux",
                    architecture = AgentIdentity.Architecture,
                    players = LinuxPlayerCatalog.GetDescriptors(config).Select(player => new
                    {
                        id = player.Id,
                        kind = player.Kind,
                        name = player.DisplayName,
                        available = player.Available,
                        capabilities = player.Capabilities,
                    }),
                }),
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
            using var response = await client.SendAsync(request, cancellationToken);
            if (response.StatusCode is HttpStatusCode.Conflict or HttpStatusCode.Forbidden)
            {
                AgentLogger.Log($"Automatic pairing was rejected: {await ReadErrorAsync(response, cancellationToken)}");
                return new RegistrationAttempt(true, TimeSpan.Zero);
            }
            if (!response.IsSuccessStatusCode)
            {
                AgentLogger.Log($"Automatic pairing returned {(int)response.StatusCode}: {await ReadErrorAsync(response, cancellationToken)}");
                return new RegistrationAttempt(false,
                    response.StatusCode == HttpStatusCode.TooManyRequests
                        ? TimeSpan.FromMinutes(5)
                        : TimeSpan.FromSeconds(15));
            }

            var body = await response.Content.ReadFromJsonAsync<AgentRegistrationResponse>(
                cancellationToken: cancellationToken);
            var secret = body?.Secret?.Trim().ToLowerInvariant();
            if (!BearerAuthentication.IsPairingSecret(secret))
                throw new InvalidDataException("The add-on returned an invalid pairing secret.");

            if (!string.Equals(config.SharedSecret, secret, StringComparison.Ordinal) ||
                !string.IsNullOrEmpty(config.RegistrationSecret))
            {
                config.SharedSecret = secret!;
                config.RegistrationSecret = "";
                await config.SaveAsync(configPath, cancellationToken);
            }
            AgentLogger.Log("Automatically paired with the configured Home Assistant add-on.");
            var refreshSeconds = body?.RegistrationRefreshSeconds is > 0
                ? Math.Clamp(body.RegistrationRefreshSeconds.Value, 30, 24 * 60 * 60)
                : 30 * 60;
            return new RegistrationAttempt(false, TimeSpan.FromSeconds(refreshSeconds));
        }
        finally
        {
            PairingState.MutationLock.Release();
        }
    }

    private static async Task<string> ReadErrorAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
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

    internal sealed record RegistrationAttempt(bool Conflict, TimeSpan NextAttempt);
}
