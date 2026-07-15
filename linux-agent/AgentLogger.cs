namespace MediaLauncher.LinuxAgent;

internal static class AgentLogger
{
    private const long MaxLogBytes = 2 * 1024 * 1024;
    private static readonly object Sync = new();

    public static void Log(string message)
    {
        var line = $"{DateTimeOffset.Now:O} {message}";
        lock (Sync)
        {
            Console.Error.WriteLine(line);
            try
            {
                AgentPaths.EnsurePrivateDirectory(Path.GetDirectoryName(AgentPaths.LogPath)!);
                if (File.Exists(AgentPaths.LogPath) && new FileInfo(AgentPaths.LogPath).Length >= MaxLogBytes)
                {
                    var previous = AgentPaths.LogPath + ".1";
                    File.Move(AgentPaths.LogPath, previous, overwrite: true);
                }
                File.AppendAllText(AgentPaths.LogPath, line + Environment.NewLine);
                if (!OperatingSystem.IsWindows())
                {
                    File.SetUnixFileMode(AgentPaths.LogPath,
                        UnixFileMode.UserRead | UnixFileMode.UserWrite);
                }
            }
            catch
            {
                // Logging must never terminate the player service.
            }
        }
    }
}
