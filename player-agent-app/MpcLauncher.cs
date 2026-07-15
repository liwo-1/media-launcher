using System.Diagnostics;
using System.Globalization;

namespace MediaLauncherPlayerAgent;

public static class MpcLauncher
{
    public static Task<Process> PlayAsync(
        string filePath,
        string? mpcPathOverride,
        IReadOnlyCollection<string> allowedMediaRoots,
        long startPositionMs,
        bool fullscreen)
    {
        ValidateMediaPath(filePath, allowedMediaRoots);
        var mpcPath = MpcLocator.Find(mpcPathOverride);
        Logger.Log($"MpcLauncher: using MPC-HC at '{mpcPath}'");
        ProcessOwnershipGuard.ThrowIfProcessNameIsRunning(mpcPath, "MPC-HC");

        // Get out of the way ourselves rather than relying on MPC-HC successfully stealing focus:
        // it's launched from a background HTTP request, not direct user input, and Windows'
        // foreground-lock routinely blocks exactly that from bringing a new window to the front.
        var startInfo = CreateStartInfo(mpcPath, filePath, startPositionMs, fullscreen);

        var mpcProcess = new Process { StartInfo = startInfo };

        try
        {
            if (!mpcProcess.Start()) throw new InvalidOperationException("MPC-HC did not start.");
            Logger.Log($"MpcLauncher: started '{mpcPath}' for '{filePath}' (pid {mpcProcess.Id})");
            return Task.FromResult(mpcProcess);
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

    internal static ProcessStartInfo CreateStartInfo(
        string mpcPath,
        string filePath,
        long startPositionMs,
        bool fullscreen)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = mpcPath,
            UseShellExecute = false,
        };
        // /new prevents MPC-HC's single-instance setting from handing this request to a process
        // the agent did not start. The pre-launch conflict check remains the primary ownership guard.
        startInfo.ArgumentList.Add("/new");
        if (startPositionMs > 0)
        {
            // MPC-HC's /start switch accepts an integer millisecond position.
            startInfo.ArgumentList.Add("/start");
            startInfo.ArgumentList.Add(startPositionMs.ToString(CultureInfo.InvariantCulture));
        }
        startInfo.ArgumentList.Add(filePath);
        if (fullscreen) startInfo.ArgumentList.Add("/fullscreen");
        startInfo.ArgumentList.Add("/play");
        return startInfo;
    }
}
