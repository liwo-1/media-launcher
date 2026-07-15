using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using MediaLauncher.Agent.Core;

namespace MediaLauncher.LinuxAgent;

internal sealed class MpvPlayerAdapter(
    string id,
    string name,
    string executable,
    IReadOnlyList<string> prefixArguments) : OwnedProcessAdapter(new PlayerDescriptor(
        id,
        "mpv",
        name,
        "detected",
        true,
        [
            AgentCapabilities.PlayFile, AgentCapabilities.Fullscreen,
            AgentCapabilities.StatusState, AgentCapabilities.StatusPosition,
            AgentCapabilities.StatusDuration, AgentCapabilities.ControlPause,
            AgentCapabilities.ControlSeek, AgentCapabilities.ControlStop,
        ]))
{
    private string _socketPath = "";

    public override async Task LaunchAsync(
        PlayerLaunchRequest request,
        IReadOnlyCollection<string> allowedMediaRoots)
    {
        var mediaPath = MediaPathPolicy.ValidateLinuxFile(request.MediaPath, allowedMediaRoots);
        AgentPaths.EnsurePrivateDirectory(AgentPaths.RuntimeDirectory);
        _socketPath = Path.Combine(AgentPaths.RuntimeDirectory, $"mpv-{Guid.NewGuid():N}.sock");
        if (Encoding.UTF8.GetByteCount(_socketPath) >= 100)
            throw new InvalidOperationException("The private mpv IPC socket path is too long. Set XDG_RUNTIME_DIR to a shorter path.");

        var arguments = new List<string>(prefixArguments)
        {
            "--no-config",
            "--no-terminal",
            "--really-quiet",
            "--force-window=yes",
            $"--input-ipc-server={_socketPath}",
        };
        if (request.Fullscreen) arguments.Add("--fs=yes");
        if (request.StartPositionMs > 0)
        {
            arguments.Add($"--start={(request.StartPositionMs / 1000d)
                .ToString("0.###", System.Globalization.CultureInfo.InvariantCulture)}");
        }
        arguments.Add("--");
        arguments.Add(mediaPath);
        var process = ProcessRunner.Start(executable, arguments);
        Own(process);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (!File.Exists(_socketPath))
            {
                if (process.HasExited) throw new InvalidOperationException("mpv exited before its private control socket was ready.");
                await Task.Delay(50, timeout.Token);
            }
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(_socketPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            _ = await GetPropertyAsync("path", timeout.Token);
        }
        catch
        {
            await StopAsync();
            throw;
        }
    }

    public override async Task<PlayerStatus> GetStatusAsync()
    {
        if (OwnedProcess is not { HasExited: false }) return new PlayerStatus(null, "stopped", 0, 0);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var path = JsonString(await GetPropertyAsync("path", timeout.Token));
        var paused = JsonBoolean(await GetPropertyAsync("pause", timeout.Token));
        var position = JsonSeconds(await GetPropertyAsync("time-pos", timeout.Token));
        var duration = JsonSeconds(await GetPropertyAsync("duration", timeout.Token));
        return new PlayerStatus(path, paused ? "paused" : "playing", position, duration);
    }

    public override async Task SetPausedAsync(bool paused)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await SendCommandAsync(["set_property", "pause", paused], timeout.Token);
    }

    public override async Task SeekAsync(long positionMs)
    {
        if (positionMs < 0) throw new ArgumentOutOfRangeException(nameof(positionMs));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await SendCommandAsync([
            "seek",
            positionMs / 1000d,
            "absolute+exact",
        ], timeout.Token);
    }

    public override async Task StopAsync()
    {
        if (!string.IsNullOrEmpty(_socketPath) && File.Exists(_socketPath))
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await SendCommandAsync(["quit"], timeout.Token);
                await Task.Delay(100, timeout.Token);
            }
            catch { /* Process termination below is authoritative. */ }
        }
        await base.StopAsync();
        if (!string.IsNullOrEmpty(_socketPath))
        {
            try { File.Delete(_socketPath); } catch { /* best effort */ }
            _socketPath = "";
        }
    }

    private Task<JsonElement> GetPropertyAsync(string property, CancellationToken cancellationToken) =>
        SendCommandAsync(["get_property", property], cancellationToken);

    private async Task<JsonElement> SendCommandAsync(object[] command, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(_socketPath)) throw new InvalidOperationException("mpv is not running.");
        using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        await socket.ConnectAsync(new UnixDomainSocketEndPoint(_socketPath), cancellationToken);
        await using var stream = new NetworkStream(socket, ownsSocket: false);
        var requestId = Random.Shared.Next(1, int.MaxValue);
        var json = JsonSerializer.Serialize(new { command, request_id = requestId }) + "\n";
        await stream.WriteAsync(Encoding.UTF8.GetBytes(json), cancellationToken);
        await stream.FlushAsync(cancellationToken);
        using var reader = new StreamReader(stream, Encoding.UTF8, leaveOpen: true);
        while (true)
        {
            var line = await reader.ReadLineAsync(cancellationToken) ??
                throw new IOException("mpv closed its IPC socket without a response.");
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            if (!root.TryGetProperty("request_id", out var idElement) || idElement.GetInt32() != requestId)
                continue;
            var error = root.TryGetProperty("error", out var errorElement)
                ? errorElement.GetString()
                : "invalid response";
            if (!string.Equals(error, "success", StringComparison.Ordinal))
                throw new InvalidOperationException($"mpv rejected a control command: {error}");
            return root.TryGetProperty("data", out var data) ? data.Clone() : default;
        }
    }

    private static string? JsonString(JsonElement value) =>
        value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool JsonBoolean(JsonElement value) =>
        value.ValueKind is JsonValueKind.True or JsonValueKind.False && value.GetBoolean();

    private static long JsonSeconds(JsonElement value) =>
        value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var seconds) && seconds >= 0
            ? checked((long)Math.Round(seconds * 1000))
            : 0;
}
