using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace MediaLauncherPlayerAgent;

internal sealed class VlcControlClient : IDisposable
{
    private readonly HttpClient _httpClient;

    public VlcControlClient(int port, string password)
        : this(new Uri($"http://127.0.0.1:{port}/"), password, null)
    {
    }

    internal VlcControlClient(Uri endpoint, string password, HttpMessageHandler? handler)
    {
        ValidateLoopbackEndpoint(endpoint);
        if (string.IsNullOrEmpty(password))
            throw new ArgumentException("A VLC HTTP password is required.", nameof(password));

        handler ??= new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
        };
        _httpClient = new HttpClient(handler, disposeHandler: true)
        {
            BaseAddress = endpoint,
            Timeout = TimeSpan.FromSeconds(2),
        };
        var basicToken = Convert.ToBase64String(Encoding.UTF8.GetBytes($":{password}"));
        _httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", basicToken);
    }

    public async Task<PlayerStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        using var response = await SendAsync("requests/status.json", cancellationToken);
        var json = await response.Content.ReadAsStringAsync(cancellationToken);
        return ParseStatusJson(json);
    }

    public async Task SetPausedAsync(bool paused, CancellationToken cancellationToken = default)
    {
        var status = await GetStatusAsync(cancellationToken);
        if ((paused && status.State == "paused") || (!paused && status.State == "playing")) return;
        if (status.State is not ("playing" or "paused"))
            throw new InvalidOperationException("VLC cannot change pause state because playback is not active.");
        using var response = await SendCommandAsync("pl_pause", null, cancellationToken);
    }

    public async Task SeekAsync(long positionMs, CancellationToken cancellationToken = default)
    {
        if (positionMs is < 0 or > SessionControlLimits.MaxSeekPositionMs)
            throw new ArgumentOutOfRangeException(nameof(positionMs));
        var seconds = (positionMs / 1000d).ToString("0.###", CultureInfo.InvariantCulture);
        using var response = await SendCommandAsync("seek", seconds, cancellationToken);
    }

    public async Task StopPlaybackAsync(CancellationToken cancellationToken = default)
    {
        using var response = await SendCommandAsync("pl_stop", null, cancellationToken);
    }

    internal static PlayerStatus ParseStatusJson(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var rawState = ReadString(root, "state");
            var state = rawState?.ToLowerInvariant() switch
            {
                "playing" or "opening" or "buffering" => "playing",
                "paused" => "paused",
                _ => "stopped",
            };
            var positionMs = SecondsToMilliseconds(ReadNumber(root, "time"));
            var durationMs = SecondsToMilliseconds(ReadNumber(root, "length"));
            return new PlayerStatus(ReadCurrentFile(root), state, positionMs, durationMs);
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("VLC returned malformed status JSON.", ex);
        }
    }

    internal static void ValidateLoopbackEndpoint(Uri endpoint)
    {
        if (!endpoint.IsAbsoluteUri || endpoint.Scheme != Uri.UriSchemeHttp ||
            !IPAddress.TryParse(endpoint.Host, out var address) || !IPAddress.IsLoopback(address) ||
            endpoint.Port is < 1 or > 65535 || !string.IsNullOrEmpty(endpoint.UserInfo))
        {
            throw new ArgumentException(
                "The VLC control endpoint must be an unauthenticated HTTP URI on a numeric loopback address.",
                nameof(endpoint));
        }
    }

    public void Dispose() => _httpClient.Dispose();

    private Task<HttpResponseMessage> SendCommandAsync(
        string command,
        string? value,
        CancellationToken cancellationToken)
    {
        var path = $"requests/status.json?command={Uri.EscapeDataString(command)}";
        if (value is not null) path += $"&val={Uri.EscapeDataString(value)}";
        return SendAsync(path, cancellationToken);
    }

    private async Task<HttpResponseMessage> SendAsync(string path, CancellationToken cancellationToken)
    {
        var response = await _httpClient.GetAsync(path, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            response.Dispose();
            throw new InvalidOperationException("VLC rejected its private control password.");
        }
        if ((int)response.StatusCode is >= 300 and < 400)
        {
            response.Dispose();
            throw new InvalidOperationException("VLC returned an unexpected redirect from its local control interface.");
        }
        if (!response.IsSuccessStatusCode)
        {
            var statusCode = (int)response.StatusCode;
            response.Dispose();
            throw new HttpRequestException(
                $"VLC control returned HTTP {statusCode}.",
                null,
                (HttpStatusCode)statusCode);
        }
        return response;
    }

    private static string? ReadCurrentFile(JsonElement root)
    {
        if (!TryGetProperty(root, "information", out var information) ||
            !TryGetProperty(information, "category", out var category) ||
            !TryGetProperty(category, "meta", out var meta)) return null;

        // VLC's filename is often only a basename. Prefer its URL/URI so session identity remains
        // tied to the actual media path when the interface provides both forms.
        var file = ReadString(meta, "url") ?? ReadString(meta, "uri") ?? ReadString(meta, "filename");
        if (file is null) return null;
        if (Uri.TryCreate(file, UriKind.Absolute, out var uri) && uri.IsFile) return uri.LocalPath;
        return file;
    }

    private static long SecondsToMilliseconds(double seconds)
    {
        if (!double.IsFinite(seconds) || seconds <= 0) return 0;
        var milliseconds = seconds * 1000d;
        return milliseconds >= long.MaxValue ? long.MaxValue : (long)Math.Round(milliseconds);
    }

    private static double ReadNumber(JsonElement parent, string name)
    {
        if (!TryGetProperty(parent, name, out var value)) return 0;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number)) return number;
        return value.ValueKind == JsonValueKind.String &&
               double.TryParse(value.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number)
            ? number
            : 0;
    }

    private static string? ReadString(JsonElement parent, string name) =>
        TryGetProperty(parent, name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool TryGetProperty(JsonElement parent, string name, out JsonElement value)
    {
        if (parent.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in parent.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    value = property.Value;
                    return true;
                }
            }
        }
        value = default;
        return false;
    }
}
