using System.Diagnostics;
using MediaLauncher.Agent.Core;

namespace MediaLauncher.LinuxAgent;

internal abstract class OwnedProcessAdapter(PlayerDescriptor descriptor) : IPlayerAdapter
{
    private readonly object _processLock = new();
    private Process? _process;

    public PlayerDescriptor Descriptor { get; } = descriptor;
    public event EventHandler? PlaybackExited;

    protected Process? OwnedProcess
    {
        get { lock (_processLock) return _process; }
    }

    public abstract Task LaunchAsync(
        PlayerLaunchRequest request,
        IReadOnlyCollection<string> allowedMediaRoots);

    protected void Own(Process process)
    {
        lock (_processLock)
        {
            if (_process is not null) throw new InvalidOperationException("This adapter already owns a process.");
            _process = process;
        }
        process.Exited += HandleExited;
        process.EnableRaisingEvents = true;
        if (process.HasExited) HandleExited(process, EventArgs.Empty);
    }

    public virtual async Task StopAsync()
    {
        Process? process;
        lock (_processLock) process = _process;
        if (process is null) return;
        process.Exited -= HandleExited;
        try
        {
            if (!HasExited(process))
            {
                await TerminateOwnedProcessAsync(process);
                if (Owns(process) && !HasExited(process))
                    throw new IOException("The owned player process did not exit after termination.");
            }
        }
        catch (Exception) when (!Owns(process) || HasExited(process))
        {
            // Natural process exit won the termination race; the requested outcome was reached.
        }
        catch
        {
            RestoreExitTracking(process);
            throw;
        }
        ReleaseOwnership(process);
    }

    protected virtual async Task TerminateOwnedProcessAsync(Process process)
    {
        process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync();
    }

    public virtual Task<PlayerStatus> GetStatusAsync()
    {
        var process = OwnedProcess;
        var state = process is null || HasExited(process) ? "stopped" : "playing";
        return Task.FromResult(new PlayerStatus(null, state, 0, 0));
    }

    public virtual Task SetPausedAsync(bool paused) =>
        Task.FromException(new NotSupportedException("This player does not support pause control."));

    public virtual Task SeekAsync(long positionMs) =>
        Task.FromException(new NotSupportedException("This player does not support seek control."));

    protected static string ExpandArgument(string value, PlayerLaunchRequest request) =>
        value.Replace("{media_path}", request.MediaPath, StringComparison.Ordinal)
            .Replace("{title}", request.Title ?? "", StringComparison.Ordinal)
            .Replace("{start_seconds}", (request.StartPositionMs / 1000d)
                .ToString("0.###", System.Globalization.CultureInfo.InvariantCulture), StringComparison.Ordinal);

    private static bool HasExited(Process process)
    {
        try { return process.HasExited; }
        catch { return false; }
    }

    private bool Owns(Process process)
    {
        lock (_processLock) return ReferenceEquals(_process, process);
    }

    private void RestoreExitTracking(Process process)
    {
        if (!Owns(process)) return;
        try
        {
            process.Exited += HandleExited;
            if (HasExited(process)) HandleExited(process, EventArgs.Empty);
        }
        catch
        {
            // Keep the process reference even if event tracking itself cannot be restored. A later
            // status or stop attempt must never target an unrelated process or forget this one.
        }
    }

    private void ReleaseOwnership(Process process)
    {
        lock (_processLock)
        {
            if (!ReferenceEquals(_process, process)) return;
            _process = null;
        }
        process.Exited -= HandleExited;
        process.Dispose();
    }

    private void HandleExited(object? sender, EventArgs args)
    {
        if (sender is not Process process) return;
        var owned = false;
        lock (_processLock)
        {
            if (ReferenceEquals(_process, process))
            {
                _process = null;
                owned = true;
            }
        }
        process.Exited -= HandleExited;
        if (!owned) return;
        try { process.Dispose(); } catch { /* best effort */ }
        PlaybackExited?.Invoke(this, EventArgs.Empty);
    }
}
