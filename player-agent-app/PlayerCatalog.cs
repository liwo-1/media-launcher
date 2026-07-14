namespace MediaLauncherPlayerAgent;

public static class PlayerCatalog
{
    public const string VlcPlayerId = "vlc";
    public const string PotPlayerId = "potplayer";

    public static IReadOnlyList<PlayerDescriptor> GetDescriptors(AppConfig config)
    {
        var players = new List<PlayerDescriptor>();
        if (MpcLocator.TryFind(config.MpcPathOverride, out _))
            players.Add(new MpcPlayerAdapter(config.MpcPathOverride).Descriptor);

        if (WindowsPlayerLocator.FindVlc(config.VlcPathOverride) is not null)
        {
            players.Add(new PlayerDescriptor(
                VlcPlayerId,
                "vlc",
                "VLC media player",
                "detected",
                true,
                ["play.file", "fullscreen"]));
        }

        if (WindowsPlayerLocator.FindPotPlayer(config.PotPlayerPathOverride) is not null)
        {
            players.Add(new PlayerDescriptor(
                PotPlayerId,
                "potplayer",
                "PotPlayer",
                "detected",
                true,
                ["play.file"]));
        }

        foreach (var profile in config.CustomPlayers ?? [])
        {
            if (!IsValidProfile(profile, requireExistingExecutable: false)) continue;
            players.Add(new PlayerDescriptor(
                profile.Id,
                "custom",
                profile.Name,
                "custom",
                File.Exists(profile.ExecutablePath),
                ["play.file"]));
        }
        return players;
    }

    public static IPlayerAdapter GetAdapter(string? playerId, AppConfig config)
    {
        var selected = string.IsNullOrWhiteSpace(playerId)
            ? GetDefaultPlayerId(config) ?? throw new InvalidOperationException(
                "No available media player was detected. Configure one in Settings first.")
            : playerId;
        if (string.Equals(selected, MpcPlayerAdapter.PlayerId, StringComparison.OrdinalIgnoreCase))
        {
            _ = MpcLocator.Find(config.MpcPathOverride);
            return new MpcPlayerAdapter(config.MpcPathOverride);
        }

        if (string.Equals(selected, VlcPlayerId, StringComparison.OrdinalIgnoreCase))
        {
            var path = WindowsPlayerLocator.FindVlc(config.VlcPathOverride) ??
                throw new FileNotFoundException("VLC is no longer installed at the detected location.");
            return new CommandPlayerAdapter(
                GetDescriptors(config).Single(player => player.Id == VlcPlayerId),
                path,
                ["--no-one-instance", "--play-and-exit", "--start-time={start_seconds}", "{media_path}"],
                fullscreenArgument: "--fullscreen");
        }

        if (string.Equals(selected, PotPlayerId, StringComparison.OrdinalIgnoreCase))
        {
            var path = WindowsPlayerLocator.FindPotPlayer(config.PotPlayerPathOverride) ??
                throw new FileNotFoundException("PotPlayer is no longer installed at the detected location.");
            return new CommandPlayerAdapter(
                GetDescriptors(config).Single(player => player.Id == PotPlayerId),
                path,
                ["{media_path}"],
                terminateExistingInstances: true);
        }

        var custom = (config.CustomPlayers ?? []).SingleOrDefault(
            profile => string.Equals(profile.Id, selected, StringComparison.OrdinalIgnoreCase));
        if (custom is null || !IsValidProfile(custom, requireExistingExecutable: true))
            throw new ArgumentException($"Unknown or unavailable player profile '{selected}'.");
        return new CommandPlayerAdapter(
            new PlayerDescriptor(custom.Id, "custom", custom.Name, "custom", true, ["play.file"]),
            custom.ExecutablePath,
            custom.Arguments ?? [],
            custom.WorkingDirectory);
    }

    public static string? GetDefaultPlayerId(AppConfig config) =>
        GetDescriptors(config).FirstOrDefault(
            player => player.Available && player.Capabilities.Contains("play.file"))?.Id;

    public static bool IsValidProfile(CustomPlayerProfile profile, bool requireExistingExecutable)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(profile.Id ?? "", "^custom-[a-f0-9]{32}$")) return false;
        if (string.IsNullOrWhiteSpace(profile.Name) || profile.Name.Length > 80) return false;
        if (!Path.IsPathFullyQualified(profile.ExecutablePath)) return false;
        if (requireExistingExecutable && !File.Exists(profile.ExecutablePath)) return false;
        if ((profile.Arguments ?? []).Any(argument => argument is null || argument.Contains('\0'))) return false;
        return true;
    }
}
