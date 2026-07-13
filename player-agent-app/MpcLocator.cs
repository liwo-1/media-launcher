using Microsoft.Win32;

namespace MediaLauncherPlayerAgent;

public static class MpcLocator
{
    private static readonly string[] RegistryKeys =
    {
        @"SOFTWARE\MPC-HC\MPC-HC",
        @"SOFTWARE\WOW6432Node\MPC-HC\MPC-HC",
    };

    private static readonly string[] DefaultPaths =
    {
        @"C:\Program Files\MPC-HC\mpc-hc64.exe",
        @"C:\Program Files (x86)\MPC-HC\mpc-hc.exe",
    };

    public static string Find(string? overridePath)
    {
        if (!string.IsNullOrWhiteSpace(overridePath) && File.Exists(overridePath))
            return overridePath;

        foreach (var key in RegistryKeys)
        {
            using var regKey = Registry.LocalMachine.OpenSubKey(key);
            if (regKey?.GetValue("ExePath") is string exePath && File.Exists(exePath))
                return exePath;
        }

        foreach (var path in DefaultPaths)
        {
            if (File.Exists(path)) return path;
        }

        throw new FileNotFoundException(
            "Could not locate MPC-HC. Set an MPC-HC path override in Settings, or confirm MPC-HC is installed.");
    }
}
