using System.Diagnostics;

namespace MediaLauncherPlayerAgent;

internal static class ProcessOwnershipGuard
{
    public static void ThrowIfProcessNameIsRunning(string executablePath, string displayName) =>
        ThrowIfProcessNameIsRunning(
            Path.GetFileNameWithoutExtension(executablePath),
            displayName,
            Process.GetProcessesByName);

    internal static void ThrowIfProcessNameIsRunning(
        string processName,
        string displayName,
        Func<string, Process[]> processFinder)
    {
        var existing = processFinder(processName);
        try
        {
            if (existing.Any(process => !HasExited(process)))
            {
                throw new InvalidOperationException(
                    $"{displayName} is already running outside Media Launcher. " +
                    "Close it manually before starting playback so the agent cannot control or stop a process it does not own.");
            }
        }
        finally
        {
            foreach (var process in existing) process.Dispose();
        }
    }

    private static bool HasExited(Process process)
    {
        try { return process.HasExited; }
        catch (InvalidOperationException) { return true; }
    }
}
