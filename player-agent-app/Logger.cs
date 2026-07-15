using System.Text;

namespace MediaLauncherPlayerAgent;

public static class Logger
{
    internal const long MaxLogBytes = 2 * 1024 * 1024;
    private const int MaxMessageCharacters = 16 * 1024;
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
                AppendBoundedLine(LogPath, FormatLine(message), MaxLogBytes);
            }
            catch
            {
                // Logging must never itself crash the app.
            }
        }
    }

    internal static void AppendBoundedLine(string path, string line, long maxLogBytes)
    {
        if (maxLogBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maxLogBytes));
        var directory = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(directory);
        var encodedLength = Encoding.UTF8.GetByteCount(line + Environment.NewLine);
        if (encodedLength > maxLogBytes)
            throw new ArgumentException("A single log line cannot exceed the log-size limit.", nameof(line));

        if (File.Exists(path) && new FileInfo(path).Length > maxLogBytes - encodedLength)
            File.Move(path, path + ".1", overwrite: true);
        File.AppendAllText(path, line + Environment.NewLine);
    }

    private static string FormatLine(string message)
    {
        var bounded = message ?? "";
        if (bounded.Length > MaxMessageCharacters)
            bounded = bounded[..MaxMessageCharacters] + "... [truncated]";
        return $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {bounded}";
    }

    private static void MigrateLegacyLogIfNeeded()
    {
        if (_migrationAttempted) return;
        _migrationAttempted = true;
        if (!File.Exists(LogPath) && File.Exists(AppPaths.LegacyLogPath))
            File.Copy(AppPaths.LegacyLogPath, LogPath);
    }
}
