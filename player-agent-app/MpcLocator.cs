using Microsoft.Win32;

namespace MediaLauncherPlayerAgent;

public static class MpcLocator
{
    private const string MpcRegistryPath = @"SOFTWARE\MPC-HC\MPC-HC";
    private static readonly HashSet<string> AllowedExecutableNames = new(
        ["mpc-hc.exe", "mpc-hc64.exe"],
        StringComparer.OrdinalIgnoreCase);

    private static readonly string[] DefaultPaths =
    {
        @"C:\Program Files\MPC-HC\mpc-hc64.exe",
        @"C:\Program Files (x86)\MPC-HC\mpc-hc.exe",
    };

    public static string Find(string? overridePath)
    {
        if (!string.IsNullOrWhiteSpace(overridePath)) return ValidateOverride(overridePath);

        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        {
            foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                try
                {
                    using var baseKey = Microsoft.Win32.RegistryKey.OpenBaseKey(hive, view);
                    using var regKey = baseKey.OpenSubKey(MpcRegistryPath);
                    if (regKey?.GetValue("ExePath") is string configured && TryValidate(configured, out var found))
                        return found;
                }
                catch { /* An inaccessible registry view is not a fatal discovery error. */ }

                foreach (var executable in AllowedExecutableNames)
                {
                    try
                    {
                        using var baseKey = Microsoft.Win32.RegistryKey.OpenBaseKey(hive, view);
                        using var appPath = baseKey.OpenSubKey(
                            $@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{executable}");
                        if (appPath?.GetValue(null) is string configured && TryValidate(configured, out var found))
                            return found;
                    }
                    catch { /* Continue with the other probes. */ }
                }
            }
        }

        foreach (var path in DefaultPaths)
        {
            if (TryValidate(path, out var found)) return found;
        }

        throw new FileNotFoundException(
            "Could not locate MPC-HC. Set an MPC-HC path override in Settings, or confirm MPC-HC is installed.");
    }

    public static string ValidateOverride(string value)
    {
        if (!TryValidate(value, out var path))
            throw new ArgumentException(
                "The MPC-HC override must be an existing absolute path to mpc-hc.exe or mpc-hc64.exe.");
        return path;
    }

    private static bool TryValidate(string value, out string path)
    {
        path = "";
        try
        {
            var candidate = value.Trim().Trim('"');
            if (!Path.IsPathFullyQualified(candidate) ||
                !AllowedExecutableNames.Contains(Path.GetFileName(candidate)) ||
                !File.Exists(candidate)) return false;
            path = Path.GetFullPath(candidate);
            return true;
        }
        catch { return false; }
    }

    public static bool TryFind(string? overridePath, out string path)
    {
        try
        {
            path = Find(overridePath);
            return true;
        }
        catch (Exception ex) when (ex is FileNotFoundException or ArgumentException)
        {
            path = "";
            return false;
        }
    }
}
