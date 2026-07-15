using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;

namespace MediaLauncherPlayerAgent;

public sealed class CommandPlayerAdapter(
    PlayerDescriptor descriptor,
    string executablePath,
    IReadOnlyList<string> argumentTemplates,
    string? workingDirectory = null,
    string? fullscreenArgument = null,
    bool requireExclusiveInstance = false) : IPlayerAdapter
{
    private static readonly HashSet<string> BlockedExecutables = new(StringComparer.OrdinalIgnoreCase)
    {
        "cmd.exe", "powershell.exe", "pwsh.exe", "wscript.exe", "cscript.exe", "mshta.exe", "rundll32.exe",
    };

    public PlayerDescriptor Descriptor { get; } = descriptor;
    public event EventHandler? PlaybackExited;
    private readonly object _processLock = new();
    private Process? _process;
    private static readonly Regex PlaceholderPattern = new(
        "\\{(media_path|title|start_seconds)\\}",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public async Task LaunchAsync(PlayerLaunchRequest request, IReadOnlyCollection<string> allowedMediaRoots)
    {
        MediaPathValidator.ValidateWindowsPath(request.MediaPath, allowedMediaRoots);
        ValidateExecutable(executablePath);
        if (requireExclusiveInstance)
            ProcessOwnershipGuard.ThrowIfProcessNameIsRunning(executablePath, Descriptor.DisplayName);

        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            WorkingDirectory = string.IsNullOrWhiteSpace(workingDirectory)
                ? Path.GetDirectoryName(executablePath) ?? ""
                : workingDirectory,
            UseShellExecute = false,
        };

        var usedMediaPath = false;
        if (request.Fullscreen && !string.IsNullOrWhiteSpace(fullscreenArgument))
            startInfo.ArgumentList.Add(fullscreenArgument);
        foreach (var template in argumentTemplates)
        {
            usedMediaPath |= template.Contains("{media_path}", StringComparison.Ordinal);
            startInfo.ArgumentList.Add(Expand(template, request));
        }
        if (!usedMediaPath) startInfo.ArgumentList.Add(request.MediaPath);

        var process = new Process { StartInfo = startInfo };
        lock (_processLock) _process = process;
        try
        {
            if (!process.Start()) throw new InvalidOperationException("The player process did not start.");
            Logger.Log($"CommandPlayerAdapter: started '{executablePath}' as '{Descriptor.Id}' (pid {process.Id})");
            process.Exited += HandleProcessExited;
            process.EnableRaisingEvents = true;
        }
        catch
        {
            lock (_processLock)
            {
                if (ReferenceEquals(_process, process)) _process = null;
            }
            process.Exited -= HandleProcessExited;
            process.Dispose();
            throw;
        }
        await Task.CompletedTask;
    }

    public Task<PlayerStatus> GetStatusAsync() =>
        throw new NotSupportedException($"{Descriptor.DisplayName} does not provide playback status.");

    public async Task StopAsync()
    {
        Process? process;
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
        if (sender is not Process process) return;
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

    public static void ValidateExecutable(string value)
    {
        if (!Path.IsPathFullyQualified(value) || !File.Exists(value))
            throw new FileNotFoundException("The configured player executable was not found.", value);
        if (!string.Equals(Path.GetExtension(value), ".exe", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A custom player must point to a Windows .exe file.");
        if (BlockedExecutables.Contains(Path.GetFileName(value)))
            throw new ArgumentException("Shells and script hosts cannot be configured as media players.");
    }

    private static string Expand(string template, PlayerLaunchRequest request) =>
        PlaceholderPattern.Replace(template, match => match.Groups[1].Value switch
        {
            "media_path" => request.MediaPath,
            "title" => request.Title,
            "start_seconds" => Math.Max(0, request.StartPositionMs / 1000)
                .ToString(CultureInfo.InvariantCulture),
            _ => match.Value,
        });

}
