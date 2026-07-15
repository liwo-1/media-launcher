using Microsoft.Win32;

namespace MediaLauncherPlayerAgent;

public static class WindowsPlayerLocator
{
    public static string? FindVlc(string? overridePath) => Find(
        overridePath,
        "vlc.exe",
        [
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "VideoLAN", "VLC", "vlc.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "VideoLAN", "VLC", "vlc.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "VideoLAN", "VLC", "vlc.exe"),
        ]);

    public static string ValidateVlcOverride(string value) =>
        ValidateOverride(value, ["vlc.exe"], "VLC");

    public static string? FindPotPlayer(string? overridePath) => Find(
        overridePath,
        "PotPlayerMini64.exe",
        [
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DAUM", "PotPlayer", "PotPlayerMini64.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "DAUM", "PotPlayer", "PotPlayerMini.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DAUM", "PotPlayer", "PotPlayerMini64.exe"),
        ],
        ["PotPlayerMini.exe"]);

    public static string ValidatePotPlayerOverride(string value) =>
        ValidateOverride(value, ["PotPlayerMini64.exe", "PotPlayerMini.exe"], "PotPlayer");

    private static string? Find(
        string? overridePath,
        string executableName,
        IReadOnlyCollection<string> defaultPaths,
        IReadOnlyCollection<string>? alternateNames = null)
    {
        var names = new[] { executableName }.Concat(alternateNames ?? []).ToArray();
        if (!string.IsNullOrWhiteSpace(overridePath))
        {
            try { return ValidateOverride(overridePath, names, executableName); }
            catch (ArgumentException) { return null; }
        }

        foreach (var name in names)
        {
            foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            {
                foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                {
                    try
                    {
                        using var baseKey = RegistryKey.OpenBaseKey(hive, view);
                        using var key = baseKey.OpenSubKey(
                            $@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{name}");
                        if (key?.GetValue(null) is string value && TryValidate(value, names, out var found))
                            return found;
                    }
                    catch { /* An inaccessible registry view is simply not a detected installation. */ }
                }
            }

            var onPath = FindOnPath(name);
            if (onPath is not null) return onPath;
        }

        foreach (var candidate in defaultPaths)
        {
            if (TryValidate(candidate, names, out var found)) return found;
        }
        return null;
    }

    private static string ValidateOverride(
        string value,
        IReadOnlyCollection<string> executableNames,
        string displayName)
    {
        if (!TryValidate(value, executableNames, out var path))
            throw new ArgumentException(
                $"The {displayName} override must be an existing absolute path to {string.Join(" or ", executableNames)}.");
        return path;
    }

    private static bool TryValidate(
        string value,
        IReadOnlyCollection<string> executableNames,
        out string path)
    {
        path = "";
        try
        {
            var candidate = value.Trim().Trim('"');
            if (!Path.IsPathFullyQualified(candidate) ||
                !executableNames.Contains(Path.GetFileName(candidate), StringComparer.OrdinalIgnoreCase) ||
                !File.Exists(candidate)) return false;
            path = Path.GetFullPath(candidate);
            return true;
        }
        catch { return false; }
    }

    internal static string? FindOnPath(string executableName)
    {
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(directory, executableName);
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
            catch { /* Ignore malformed PATH entries. */ }
        }
        return null;
    }
}
