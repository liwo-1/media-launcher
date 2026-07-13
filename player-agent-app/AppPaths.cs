namespace MediaLauncherPlayerAgent;

public static class AppPaths
{
    public static readonly string DataDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MediaLauncherPlayerAgent");

    public static string ConfigPath => Path.Combine(DataDirectory, "config.json");
    public static string LogPath => Path.Combine(DataDirectory, "player-agent.log");
    public static string LegacyConfigPath => Path.Combine(AppContext.BaseDirectory, "config.json");
    public static string LegacyLogPath => Path.Combine(AppContext.BaseDirectory, "player-agent.log");

    public static void EnsureDataDirectory() => Directory.CreateDirectory(DataDirectory);
}
