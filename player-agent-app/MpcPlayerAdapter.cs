namespace MediaLauncherPlayerAgent;

public sealed class MpcPlayerAdapter(string? executableOverride) : IPlayerAdapter
{
    public const string PlayerId = "mpc-hc";

    public PlayerDescriptor Descriptor { get; } = new(
        PlayerId,
        "mpc-hc",
        "MPC-HC",
        "detected",
        true,
        [
            PlayerCapabilities.PlayFile,
            PlayerCapabilities.Fullscreen,
            PlayerCapabilities.StatusState,
            PlayerCapabilities.StatusPosition,
            PlayerCapabilities.StatusDuration,
            PlayerCapabilities.ControlStop,
        ]);

    public event EventHandler? PlaybackExited;
    private readonly object _processLock = new();
    private System.Diagnostics.Process? _process;

    public async Task LaunchAsync(PlayerLaunchRequest request, IReadOnlyCollection<string> allowedMediaRoots)
    {
        var process = await MpcLauncher.PlayAsync(
            request.MediaPath,
            executableOverride,
            allowedMediaRoots,
            request.StartPositionMs,
            request.Fullscreen);
        lock (_processLock) _process = process;
        process.Exited += HandleProcessExited;
        process.EnableRaisingEvents = true;
    }

    public async Task StopAsync()
    {
        System.Diagnostics.Process? process;
        lock (_processLock)
        {
            process = _process;
        }
        if (process is null) return;
        process.Exited -= HandleProcessExited;
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            // The exit callback won the race; the process is already gone.
        }
        catch
        {
            try { process.Exited += HandleProcessExited; } catch { /* Preserve the original error. */ }
            throw;
        }
        lock (_processLock)
        {
            if (ReferenceEquals(_process, process)) _process = null;
        }
        process.Dispose();
    }

    private void HandleProcessExited(object? sender, EventArgs args)
    {
        if (sender is not System.Diagnostics.Process process) return;
        var wasOwned = false;
        lock (_processLock)
        {
            if (ReferenceEquals(_process, process))
            {
                _process = null;
                wasOwned = true;
            }
        }
        process.Exited -= HandleProcessExited;
        if (wasOwned)
        {
            PlaybackExited?.Invoke(this, EventArgs.Empty);
            process.Dispose();
        }
    }

    public async Task<PlayerStatus> GetStatusAsync()
    {
        var status = await MpcStatusReader.GetStatusAsync();
        return new PlayerStatus(
            status.File,
            status.State == 2 ? "playing" : status.State == 1 ? "paused" : "stopped",
            status.Position,
            status.Duration);
    }
}
