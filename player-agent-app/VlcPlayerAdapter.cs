using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;

namespace MediaLauncherPlayerAgent;

public sealed class VlcPlayerAdapter(string executablePath) : IPlayerAdapter
{
    private static readonly string[] SupportedCapabilities =
    [
        PlayerCapabilities.PlayFile,
        PlayerCapabilities.Fullscreen,
        PlayerCapabilities.StatusState,
        PlayerCapabilities.StatusPosition,
        PlayerCapabilities.StatusDuration,
        PlayerCapabilities.ControlPause,
        PlayerCapabilities.ControlSeek,
        PlayerCapabilities.ControlStop,
    ];

    public PlayerDescriptor Descriptor { get; } = new(
        PlayerCatalog.VlcPlayerId,
        "vlc",
        "VLC media player",
        "detected",
        true,
        [.. SupportedCapabilities]);

    public event EventHandler? PlaybackExited;

    private readonly object _processLock = new();
    private Process? _process;
    private VlcControlClient? _control;
    private string? _mediaPath;

    public async Task LaunchAsync(PlayerLaunchRequest request, IReadOnlyCollection<string> allowedMediaRoots)
    {
        MediaPathValidator.ValidateWindowsPath(request.MediaPath, allowedMediaRoots);
        CommandPlayerAdapter.ValidateExecutable(executablePath);

        var port = ReserveLoopbackPort();
        var password = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var control = new VlcControlClient(port, password);
        var process = new Process
        {
            StartInfo = CreateStartInfo(executablePath, request, port, password),
        };

        lock (_processLock)
        {
            if (_process is not null) throw new InvalidOperationException("This VLC adapter is already in use.");
            _process = process;
            _control = control;
            _mediaPath = request.MediaPath;
        }

        try
        {
            if (!process.Start()) throw new InvalidOperationException("VLC did not start.");
            process.Exited += HandleProcessExited;
            process.EnableRaisingEvents = true;
            Logger.Log($"VLC: started private loopback control on 127.0.0.1:{port} (pid {process.Id})");
            await WaitUntilReadyAsync(process, control);
        }
        catch
        {
            await StopAsync();
            throw;
        }
    }

    public async Task<PlayerStatus> GetStatusAsync()
    {
        var (control, mediaPath) = GetActiveControl();
        var status = await control.GetStatusAsync();
        return string.IsNullOrWhiteSpace(status.File)
            ? status with { File = mediaPath }
            : status;
    }

    public Task SetPausedAsync(bool paused)
    {
        var (control, _) = GetActiveControl();
        return control.SetPausedAsync(paused);
    }

    public Task SeekAsync(long positionMs)
    {
        var (control, _) = GetActiveControl();
        return control.SeekAsync(positionMs);
    }

    public async Task StopAsync()
    {
        Process? process;
        VlcControlClient? control;
        lock (_processLock)
        {
            process = _process;
            control = _control;
        }
        if (process is null)
        {
            control?.Dispose();
            return;
        }

        process.Exited -= HandleProcessExited;
        try
        {
            if (!process.HasExited)
            {
                try
                {
                    if (control is not null) await control.StopPlaybackAsync();
                }
                catch (Exception ex)
                {
                    Logger.Log($"VLC: graceful stop failed; terminating the owned process: {ex.Message}");
                }

                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try
                {
                    await process.WaitForExitAsync(timeout.Token);
                }
                catch (OperationCanceledException)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync();
                }
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            // The process exited while the stop request was in flight.
        }
        finally
        {
            lock (_processLock)
            {
                if (ReferenceEquals(_process, process))
                {
                    _process = null;
                    _control = null;
                    _mediaPath = null;
                }
            }
            control?.Dispose();
            process.Dispose();
        }
    }

    internal static ProcessStartInfo CreateStartInfo(
        string path,
        PlayerLaunchRequest request,
        int port,
        string password)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = path,
            WorkingDirectory = Path.GetDirectoryName(path) ?? "",
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add("--no-one-instance");
        startInfo.ArgumentList.Add("--play-and-exit");
        startInfo.ArgumentList.Add("--extraintf=http");
        startInfo.ArgumentList.Add("--http-host=127.0.0.1");
        startInfo.ArgumentList.Add($"--http-port={port.ToString(CultureInfo.InvariantCulture)}");
        startInfo.ArgumentList.Add($"--http-password={password}");
        if (request.Fullscreen) startInfo.ArgumentList.Add("--fullscreen");
        if (request.StartPositionMs > 0)
        {
            var seconds = (request.StartPositionMs / 1000d).ToString("0.###", CultureInfo.InvariantCulture);
            startInfo.ArgumentList.Add($"--start-time={seconds}");
        }
        startInfo.ArgumentList.Add(request.MediaPath);
        return startInfo;
    }

    private static int ReserveLoopbackPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            return ((IPEndPoint)listener.LocalEndpoint).Port;
        }
        finally
        {
            listener.Stop();
        }
    }

    private static async Task WaitUntilReadyAsync(Process process, VlcControlClient control)
    {
        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(5);
        Exception? lastError = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (process.HasExited)
                throw new InvalidOperationException("VLC exited before its private control interface became ready.");
            try
            {
                await control.GetStatusAsync();
                return;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
            {
                lastError = ex;
                await Task.Delay(100);
            }
        }
        throw new TimeoutException(
            "VLC started, but its authenticated localhost control interface did not become ready.",
            lastError);
    }

    private (VlcControlClient Control, string MediaPath) GetActiveControl()
    {
        lock (_processLock)
        {
            if (_process is null || _control is null || _process.HasExited)
                throw new InvalidOperationException("The VLC playback session has ended.");
            return (_control, _mediaPath ?? "");
        }
    }

    private void HandleProcessExited(object? sender, EventArgs args)
    {
        if (sender is not Process process) return;
        VlcControlClient? control = null;
        var wasOwned = false;
        lock (_processLock)
        {
            if (ReferenceEquals(_process, process))
            {
                _process = null;
                control = _control;
                _control = null;
                _mediaPath = null;
                wasOwned = true;
            }
        }
        process.Exited -= HandleProcessExited;
        if (!wasOwned) return;
        control?.Dispose();
        PlaybackExited?.Invoke(this, EventArgs.Empty);
        process.Dispose();
    }
}
