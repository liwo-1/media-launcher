using System.Text;

namespace MediaLauncher.LinuxAgent;

internal sealed record DesktopPlayerEntry(
    string DesktopId,
    string Name,
    string Executable,
    IReadOnlyList<string> PrefixArguments,
    string Source);

internal static class DesktopEntryDiscovery
{
    private static readonly HashSet<string> KnownPlayers = new(StringComparer.OrdinalIgnoreCase)
    {
        "celluloid", "mpv", "vlc",
    };

    public static IReadOnlyList<DesktopPlayerEntry> FindKnownPlayers()
    {
        var roots = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share", "applications"),
            "/usr/local/share/applications",
            "/usr/share/applications",
        };
        var entries = new List<DesktopPlayerEntry>();
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            foreach (var file in Directory.EnumerateFiles(root, "*.desktop", SearchOption.TopDirectoryOnly))
            {
                try
                {
                    var entry = Parse(file);
                    if (entry is not null) entries.Add(entry);
                }
                catch { /* A malformed desktop entry is not a supported player. */ }
            }
        }
        return entries
            .GroupBy(entry => entry.DesktopId, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToArray();
    }

    internal static DesktopPlayerEntry? Parse(string file)
    {
        string? name = null;
        string? exec = null;
        var inDesktopEntry = false;
        foreach (var rawLine in File.ReadLines(file))
        {
            var line = rawLine.Trim();
            if (line.StartsWith('['))
            {
                inDesktopEntry = string.Equals(line, "[Desktop Entry]", StringComparison.Ordinal);
                continue;
            }
            if (!inDesktopEntry || line.StartsWith('#')) continue;
            var separator = line.IndexOf('=');
            if (separator <= 0) continue;
            var key = line[..separator];
            var value = line[(separator + 1)..];
            if (key == "Name") name = value;
            else if (key == "Exec") exec = value;
        }
        if (string.IsNullOrWhiteSpace(exec)) return null;
        var tokens = SplitExec(exec);
        if (tokens.Count == 0) return null;
        var executableName = Path.GetFileNameWithoutExtension(tokens[0]);
        if (!KnownPlayers.Contains(executableName)) return null;
        var executable = ProcessRunner.FindExecutable(tokens[0]);
        if (executable is null) return null;
        var prefix = tokens.Skip(1).Where(token => !token.StartsWith('%')).ToArray();
        return new DesktopPlayerEntry(
            Path.GetFileNameWithoutExtension(file),
            string.IsNullOrWhiteSpace(name) ? executableName : name,
            executable,
            prefix,
            $"desktop:{Path.GetFileName(file)}");
    }

    internal static IReadOnlyList<string> SplitExec(string value)
    {
        var tokens = new List<string>();
        var current = new StringBuilder();
        var quoted = false;
        var escaped = false;
        foreach (var character in value)
        {
            if (escaped)
            {
                current.Append(character);
                escaped = false;
            }
            else if (character == '\\') escaped = true;
            else if (character == '"') quoted = !quoted;
            else if (char.IsWhiteSpace(character) && !quoted)
            {
                if (current.Length > 0)
                {
                    tokens.Add(current.ToString());
                    current.Clear();
                }
            }
            else current.Append(character);
        }
        if (escaped) current.Append('\\');
        if (quoted) return [];
        if (current.Length > 0) tokens.Add(current.ToString());
        return tokens;
    }
}
