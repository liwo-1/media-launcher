namespace MediaLauncher.LinuxAgent;

internal static class AgentPaths
{
    public static string ConfigDirectory
    {
        get
        {
            var configured = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
            var root = string.IsNullOrWhiteSpace(configured)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config")
                : configured;
            return Path.Combine(root, "media-launcher-agent");
        }
    }

    public static string DefaultConfigPath => Path.Combine(ConfigDirectory, "config.json");
    public static string LogPath => Path.Combine(ConfigDirectory, "agent.log");

    public static string RuntimeDirectory
    {
        get
        {
            var configured = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR");
            return string.IsNullOrWhiteSpace(configured)
                ? Path.Combine(ConfigDirectory, "runtime")
                : Path.Combine(configured, "media-launcher-agent");
        }
    }

    public static void EnsurePrivateDirectory(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
    }
}
