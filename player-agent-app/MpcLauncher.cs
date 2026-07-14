using System.Diagnostics;

namespace MediaLauncherPlayerAgent;

public static class MpcLauncher
{
    public static async Task<Process> PlayAsync(
        string filePath,
        string? mpcPathOverride,
        IReadOnlyCollection<string> allowedMediaRoots,
        bool fullscreen)
    {
        ValidateMediaPath(filePath, allowedMediaRoots);
        var mpcPath = MpcLocator.Find(mpcPathOverride);
        Logger.Log($"MpcLauncher: using MPC-HC at '{mpcPath}'");
        var processName = Path.GetFileNameWithoutExtension(mpcPath);

        // Always force-close any existing MPC-HC instance before launching a fresh one, rather than
        // relying on its single-instance-reuse behavior. That reuse can get stuck if a previous
        // attempt left MPC-HC in an error state (e.g. a failed network path) - starting clean every
        // time means pressing Play again always works, at the cost of a brief flicker if a window
        // was already open.
        var existing = Process.GetProcessesByName(processName);
        if (existing.Length > 0) Logger.Log($"MpcLauncher: closing {existing.Length} existing '{processName}' process(es)");
        foreach (var proc in existing)
        {
            try { proc.Kill(); } catch { /* already exiting - fine */ }
        }
        await Task.Delay(400);

        // Get out of the way ourselves rather than relying on MPC-HC successfully stealing focus:
        // it's launched from a background HTTP request, not direct user input, and Windows'
        // foreground-lock routinely blocks exactly that from bringing a new window to the front.
        var startInfo = new ProcessStartInfo
        {
            FileName = mpcPath,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(filePath);
        if (fullscreen) startInfo.ArgumentList.Add("/fullscreen");
        startInfo.ArgumentList.Add("/play");

        var mpcProcess = new Process { StartInfo = startInfo };

        try
        {
            if (!mpcProcess.Start()) throw new InvalidOperationException("MPC-HC did not start.");
            Logger.Log($"MpcLauncher: started '{mpcPath}' for '{filePath}' (pid {mpcProcess.Id})");
            return mpcProcess;
        }
        catch (Exception ex)
        {
            Logger.Log($"MpcLauncher: Process.Start failed: {ex}");
            mpcProcess.Dispose();
            throw new Exception($"Failed to launch MPC-HC: {ex.Message}", ex);
        }
    }

    public static void ValidateMediaPath(string filePath, IReadOnlyCollection<string> allowedMediaRoots)
        => MediaPathValidator.ValidateWindowsPath(filePath, allowedMediaRoots);
}
