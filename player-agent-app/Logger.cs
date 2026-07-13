namespace MediaLauncherPlayerAgent;

public static class Logger
{
    public static string LogPath => AppPaths.LogPath;
    private static readonly object Lock = new();
    private static bool _migrationAttempted;

    public static void Log(string message)
    {
        lock (Lock)
        {
            try
            {
                AppPaths.EnsureDataDirectory();
                MigrateLegacyLogIfNeeded();
                File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
            catch
            {
                // Logging must never itself crash the app.
            }
        }
    }

    private static void MigrateLegacyLogIfNeeded()
    {
        if (_migrationAttempted) return;
        _migrationAttempted = true;
        if (!File.Exists(LogPath) && File.Exists(AppPaths.LegacyLogPath))
            File.Copy(AppPaths.LegacyLogPath, LogPath);
    }
}
