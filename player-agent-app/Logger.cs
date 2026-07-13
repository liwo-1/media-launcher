namespace MediaLauncherPlayerAgent;

// Plain text log file next to the exe - this is a GUI app with no console attached, so without
// this there is nowhere at all to see what went wrong when something fails.
public static class Logger
{
    public static readonly string LogPath = Path.Combine(AppContext.BaseDirectory, "player-agent.log");
    private static readonly object Lock = new();

    public static void Log(string message)
    {
        lock (Lock)
        {
            try
            {
                File.AppendAllText(LogPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
            catch
            {
                // Logging must never itself crash the app.
            }
        }
    }
}
