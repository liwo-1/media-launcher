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

        var vlcPath = WindowsPlayerLocator.FindVlc(config.VlcPathOverride);
        if (vlcPath is not null) players.Add(new VlcPlayerAdapter(vlcPath).Descriptor);

        if (WindowsPlayerLocator.FindPotPlayer(config.PotPlayerPathOverride) is not null)
            players.Add(CreatePotPlayerDescriptor());

        foreach (var group in (config.CustomPlayers ?? []).GroupBy(
                     profile => profile.Id ?? "",
                     StringComparer.OrdinalIgnoreCase))
        {
            var profile = group.First();
            var validation = CustomPlayerProfileValidator.Validate(profile, requireExistingPaths: true);
            var diagnostics = validation.Diagnostics.ToList();
            if (group.Count() > 1)
            {
                diagnostics.Add(new PlayerDiagnostic(
                    "custom.duplicate_id",
                    "error",
                    "More than one local custom profile uses this ID. Edit or remove the duplicate profiles."));
            }
            players.Add(new PlayerDescriptor(
                profile.Id,
                "custom",
                profile.Name,
                "custom",
                validation.IsValid && group.Count() == 1,
                [PlayerCapabilities.PlayFile])
            {
                Diagnostics = [.. diagnostics],
            });
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
            return new VlcPlayerAdapter(path);
        }

        if (string.Equals(selected, PotPlayerId, StringComparison.OrdinalIgnoreCase))
        {
            var path = WindowsPlayerLocator.FindPotPlayer(config.PotPlayerPathOverride) ??
                throw new FileNotFoundException("PotPlayer is no longer installed at the detected location.");
            return new CommandPlayerAdapter(
                CreatePotPlayerDescriptor(),
                path,
                ["{media_path}"],
                requireExclusiveInstance: true);
        }

        var matchingCustomProfiles = (config.CustomPlayers ?? []).Where(
            profile => string.Equals(profile.Id, selected, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matchingCustomProfiles.Length != 1)
            throw new ArgumentException($"Unknown or unavailable player profile '{selected}'.");
        var custom = matchingCustomProfiles[0];
        var validation = CustomPlayerProfileValidator.Validate(custom, requireExistingPaths: true);
        if (!validation.IsValid)
        {
            var detail = string.Join(" ", validation.Diagnostics
                .Where(diagnostic => diagnostic.Severity == "error")
                .Select(diagnostic => diagnostic.Message));
            throw new ArgumentException($"Custom player profile '{custom.Name}' is unavailable. {detail}");
        }
        return new CommandPlayerAdapter(
            new PlayerDescriptor(
                custom.Id,
                "custom",
                custom.Name,
                "custom",
                true,
                [PlayerCapabilities.PlayFile])
            {
                Diagnostics = validation.Diagnostics,
            },
            custom.ExecutablePath,
            custom.Arguments ?? [],
            custom.WorkingDirectory);
    }

    public static string? GetDefaultPlayerId(AppConfig config) =>
        GetDescriptors(config).FirstOrDefault(
            player => player.Available && PlayerCapabilities.Supports(player, PlayerCapabilities.PlayFile))?.Id;

    public static bool IsValidProfile(CustomPlayerProfile profile, bool requireExistingExecutable)
        => CustomPlayerProfileValidator.Validate(profile, requireExistingExecutable).IsValid;

    internal static PlayerDescriptor CreatePotPlayerDescriptor() => new(
        PotPlayerId,
        "potplayer",
        "PotPlayer",
        "detected",
        true,
        [PlayerCapabilities.PlayFile, PlayerCapabilities.ControlStop])
    {
        // PotPlayer has no documented, authenticated status surface that is stable enough for this
        // protocol. Process lifetime cannot distinguish playing, paused, seeking, or a different file.
        Diagnostics =
        [
            new PlayerDiagnostic(
                "potplayer.status_unsupported",
                "info",
                "PotPlayer is launch-and-stop only because no reliable supported status interface is available."),
        ],
    };
}
