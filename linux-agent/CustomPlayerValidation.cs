using System.Text.RegularExpressions;

namespace MediaLauncher.LinuxAgent;

internal static partial class CustomPlayerValidation
{
    private static readonly HashSet<string> BlockedExecutables = new(StringComparer.OrdinalIgnoreCase)
    {
        "bash", "dash", "env", "fish", "node", "perl", "php", "python", "python3", "ruby", "sh", "zsh",
    };
    private static readonly HashSet<string> Placeholders = new(StringComparer.Ordinal)
    {
        "media_path", "title", "start_seconds",
    };

    public static List<string> Errors(LinuxCustomPlayerProfile profile, bool requireExistingExecutable)
    {
        var errors = new List<string>();
        if (!CustomIdPattern().IsMatch(profile.Id ?? "")) errors.Add("ID must be custom- plus 32 lowercase hexadecimal characters.");
        if (string.IsNullOrWhiteSpace(profile.Name) || profile.Name.Length > 80) errors.Add("Name must contain 1 to 80 characters.");
        if (!Path.IsPathFullyQualified(profile.ExecutablePath)) errors.Add("Executable path must be absolute.");
        else
        {
            var fileName = Path.GetFileNameWithoutExtension(profile.ExecutablePath);
            if (BlockedExecutables.Contains(fileName)) errors.Add("Shells and script hosts cannot be custom players.");
            if (requireExistingExecutable && !File.Exists(profile.ExecutablePath)) errors.Add("Executable does not exist.");
        }
        if (!string.IsNullOrWhiteSpace(profile.WorkingDirectory) && !Path.IsPathFullyQualified(profile.WorkingDirectory))
            errors.Add("Working directory must be absolute.");
        if ((profile.Arguments ?? []).Count > 64) errors.Add("At most 64 argument tokens are allowed.");
        foreach (var argument in profile.Arguments ?? [])
        {
            if (argument is null || argument.Length > 4096 || argument.Contains('\0'))
            {
                errors.Add("Arguments must be bounded strings without NUL characters.");
                continue;
            }
            foreach (Match match in PlaceholderPattern().Matches(argument))
            {
                if (!Placeholders.Contains(match.Groups[1].Value))
                    errors.Add($"Unknown argument placeholder {{{match.Groups[1].Value}}}.");
            }
        }
        if (!string.IsNullOrWhiteSpace(profile.MprisPlayer) && !MprisPattern().IsMatch(profile.MprisPlayer))
            errors.Add("MPRIS player name contains unsupported characters.");
        return errors.Distinct(StringComparer.Ordinal).ToList();
    }

    [GeneratedRegex("^custom-[a-f0-9]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex CustomIdPattern();

    [GeneratedRegex("\\{([^{}]+)\\}", RegexOptions.CultureInvariant)]
    private static partial Regex PlaceholderPattern();

    [GeneratedRegex("^[A-Za-z0-9_.-]{1,128}$", RegexOptions.CultureInvariant)]
    private static partial Regex MprisPattern();
}
