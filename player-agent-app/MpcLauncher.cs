using System.Diagnostics;

namespace MediaLauncherPlayerAgent;

public static class MpcLauncher
{
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ts", ".webm", ".wmv",
    };

    public static async Task PlayAsync(string filePath, string? mpcPathOverride, IReadOnlyCollection<string> allowedMediaRoots)
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
        MainForm.Instance?.MinimizeForPlayback();

        var startInfo = new ProcessStartInfo
        {
            FileName = mpcPath,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(filePath);
        startInfo.ArgumentList.Add("/fullscreen");
        startInfo.ArgumentList.Add("/play");

        var mpcProcess = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        mpcProcess.Exited += (_, _) => MainForm.Instance?.RestoreFromPlayback();

        try
        {
            mpcProcess.Start();
            Logger.Log($"MpcLauncher: started '{mpcPath}' \"{filePath}\" /fullscreen /play (pid {mpcProcess.Id})");
        }
        catch (Exception ex)
        {
            Logger.Log($"MpcLauncher: Process.Start failed: {ex}");
            MainForm.Instance?.RestoreFromPlayback();
            throw new Exception($"Failed to launch MPC-HC: {ex.Message}", ex);
        }
    }

    public static void ValidateMediaPath(string filePath, IReadOnlyCollection<string> allowedMediaRoots)
    {
        if (string.IsNullOrWhiteSpace(filePath))
            throw new ArgumentException("Media path is required.");
        if (Uri.TryCreate(filePath, UriKind.Absolute, out var uri) && !uri.IsUnc)
            throw new ArgumentException("URL and local media paths are not allowed.");
        if (!filePath.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Only UNC media paths are allowed.");

        var extension = Path.GetExtension(filePath);
        if (!AllowedExtensions.Contains(extension))
            throw new ArgumentException($"The media extension '{extension}' is not allowed.");

        string normalizedPath;
        try { normalizedPath = Path.GetFullPath(filePath).TrimEnd('\\'); }
        catch (Exception ex) { throw new ArgumentException("Media path is invalid.", ex); }

        var allowed = allowedMediaRoots.Any(root =>
        {
            if (string.IsNullOrWhiteSpace(root) || !root.StartsWith(@"\\", StringComparison.Ordinal)) return false;
            string normalizedRoot;
            try { normalizedRoot = Path.GetFullPath(root).TrimEnd('\\'); }
            catch { return false; }
            return normalizedPath.Equals(normalizedRoot, StringComparison.OrdinalIgnoreCase) ||
                (normalizedPath.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase) &&
                 normalizedPath.Length > normalizedRoot.Length &&
                 normalizedPath[normalizedRoot.Length] == '\\');
        });

        if (!allowed)
            throw new UnauthorizedAccessException("Media path is outside the configured allowed UNC roots.");
    }
}
