using System.Diagnostics;

namespace MediaLauncher.LinuxAgent;

internal sealed record ProcessResult(int ExitCode, string StandardOutput, string StandardError)
{
    public bool Success => ExitCode == 0;
}

internal static class ProcessRunner
{
    public static string? FindExecutable(params string[] names)
    {
        foreach (var name in names)
        {
            if (Path.IsPathFullyQualified(name) && File.Exists(name)) return Path.GetFullPath(name);
            foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "")
                .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                try
                {
                    var candidate = Path.Combine(directory, name);
                    if (File.Exists(candidate)) return Path.GetFullPath(candidate);
                }
                catch { /* Ignore malformed PATH entries. */ }
            }
        }
        return null;
    }

    public static Process Start(
        string executable,
        IEnumerable<string> arguments,
        string? workingDirectory = null)
    {
        var info = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            WorkingDirectory = string.IsNullOrWhiteSpace(workingDirectory)
                ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
                : workingDirectory,
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        var process = new Process { StartInfo = info };
        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException($"{Path.GetFileName(executable)} did not start.");
        }
        return process;
    }

    public static async Task<ProcessResult> RunAsync(
        string executable,
        IEnumerable<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var info = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = info };
        if (!process.Start()) throw new InvalidOperationException($"{Path.GetFileName(executable)} did not start.");
        var stdout = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderr = process.StandardError.ReadToEndAsync(cancellationToken);
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);
        try
        {
            await process.WaitForExitAsync(timeoutSource.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            try { process.Kill(entireProcessTree: true); } catch { /* best effort */ }
            throw new TimeoutException($"{Path.GetFileName(executable)} timed out.");
        }
        return new ProcessResult(process.ExitCode, await stdout, await stderr);
    }
}
