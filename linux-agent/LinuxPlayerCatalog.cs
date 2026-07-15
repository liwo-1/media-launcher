using MediaLauncher.Agent.Core;

namespace MediaLauncher.LinuxAgent;

internal sealed record LinuxPlayerDefinition(
    PlayerDescriptor Descriptor,
    Func<IPlayerAdapter> CreateAdapter);

internal static class LinuxPlayerCatalog
{
    public static IReadOnlyList<LinuxPlayerDefinition> GetDefinitions(LinuxAgentConfig config)
    {
        var definitions = new List<LinuxPlayerDefinition>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var playerctl = ProcessRunner.FindExecutable("playerctl");

        var nativeMpv = ProcessRunner.FindExecutable("mpv");
        if (nativeMpv is not null)
        {
            Add(new LinuxPlayerDefinition(
                Descriptor("mpv", "mpv", "mpv", "path", true,
                    AgentCapabilities.PlayFile, AgentCapabilities.Fullscreen,
                    AgentCapabilities.StatusState, AgentCapabilities.StatusPosition,
                    AgentCapabilities.StatusDuration, AgentCapabilities.ControlPause,
                    AgentCapabilities.ControlSeek, AgentCapabilities.ControlStop),
                () => new MpvPlayerAdapter("mpv", "mpv", nativeMpv, [])));
        }

        var nativeVlc = ProcessRunner.FindExecutable("vlc", "cvlc");
        if (nativeVlc is not null)
        {
            Add(CreateVlc("vlc", "VLC media player", nativeVlc, [], "path", playerctl));
        }

        foreach (var entry in DesktopEntryDiscovery.FindKnownPlayers())
        {
            var executableName = Path.GetFileNameWithoutExtension(entry.Executable);
            if (executableName.Equals("mpv", StringComparison.OrdinalIgnoreCase))
            {
                Add(new LinuxPlayerDefinition(
                    Descriptor("mpv-desktop", "mpv", entry.Name, entry.Source, true,
                        AgentCapabilities.PlayFile, AgentCapabilities.Fullscreen,
                        AgentCapabilities.StatusState, AgentCapabilities.StatusPosition,
                        AgentCapabilities.StatusDuration, AgentCapabilities.ControlPause,
                        AgentCapabilities.ControlSeek, AgentCapabilities.ControlStop),
                    () => new MpvPlayerAdapter("mpv-desktop", entry.Name, entry.Executable, entry.PrefixArguments)));
            }
            else if (executableName is "vlc" or "cvlc")
            {
                Add(CreateVlc("vlc-desktop", entry.Name, entry.Executable, entry.PrefixArguments, entry.Source, playerctl));
            }
            else if (executableName.Equals("celluloid", StringComparison.OrdinalIgnoreCase))
            {
                Add(CreateMprisCommand(
                    "celluloid", "celluloid", entry.Name, entry.Executable,
                    entry.PrefixArguments, entry.Source, "io.github.celluloid_player.Celluloid", playerctl));
            }
        }

        AddFlatpakProfiles(definitions, seen, playerctl);
        AddSnapProfiles(definitions, seen, playerctl);

        foreach (var profile in config.CustomPlayers)
        {
            var errors = CustomPlayerValidation.Errors(profile, requireExistingExecutable: true);
            var available = errors.Count == 0;
            var capabilities = new List<string> { AgentCapabilities.PlayFile };
            if (available && !string.IsNullOrWhiteSpace(profile.MprisPlayer) && playerctl is not null)
            {
                capabilities.AddRange([
                    AgentCapabilities.StatusState, AgentCapabilities.StatusPosition,
                    AgentCapabilities.StatusDuration, AgentCapabilities.ControlPause,
                    AgentCapabilities.ControlSeek, AgentCapabilities.ControlStop,
                ]);
            }
            var descriptor = new PlayerDescriptor(
                profile.Id,
                "custom",
                profile.Name,
                "custom",
                available,
                capabilities.ToArray())
            {
                Diagnostics = [available
                    ? new PlayerDiagnostic("custom.ready", "info", "Custom profile passed local validation.")
                    : new PlayerDiagnostic("custom.invalid", "error", string.Join(" ", errors))],
            };
            Add(new LinuxPlayerDefinition(descriptor, () =>
                string.IsNullOrWhiteSpace(profile.MprisPlayer) || playerctl is null
                    ? new CommandPlayerAdapter(descriptor, profile.ExecutablePath, profile.Arguments,
                        profile.WorkingDirectory)
                    : new MprisPlayerAdapter(descriptor, profile.ExecutablePath, profile.Arguments,
                        profile.WorkingDirectory, playerctl, profile.MprisPlayer)));
        }

        return definitions;

        void Add(LinuxPlayerDefinition definition)
        {
            if (seen.Add(definition.Descriptor.Id)) definitions.Add(definition);
        }
    }

    public static IReadOnlyList<PlayerDescriptor> GetDescriptors(LinuxAgentConfig config) =>
        GetDefinitions(config).Select(definition => definition.Descriptor).ToArray();

    public static IPlayerAdapter GetAdapter(string? playerId, LinuxAgentConfig config)
    {
        var definitions = GetDefinitions(config);
        var selected = string.IsNullOrWhiteSpace(playerId)
            ? GetDefaultPlayerId(config, definitions)
            : playerId;
        var definition = definitions.SingleOrDefault(item =>
            string.Equals(item.Descriptor.Id, selected, StringComparison.OrdinalIgnoreCase));
        if (definition is null || !definition.Descriptor.Available)
            throw new ArgumentException($"Unknown or unavailable player profile '{selected}'.");
        return definition.CreateAdapter();
    }

    public static string? GetDefaultPlayerId(LinuxAgentConfig config) =>
        GetDefaultPlayerId(config, GetDefinitions(config));

    internal static string? GetDefaultPlayerId(
        LinuxAgentConfig config,
        IReadOnlyList<LinuxPlayerDefinition> definitions)
    {
        if (!string.IsNullOrWhiteSpace(config.DefaultPlayerId) && definitions.Any(item =>
            item.Descriptor.Available &&
            string.Equals(item.Descriptor.Id, config.DefaultPlayerId, StringComparison.OrdinalIgnoreCase)))
        {
            return definitions.First(item =>
                string.Equals(item.Descriptor.Id, config.DefaultPlayerId, StringComparison.OrdinalIgnoreCase))
                .Descriptor.Id;
        }
        return definitions.FirstOrDefault(item => item.Descriptor.Available)?.Descriptor.Id;
    }

    private static LinuxPlayerDefinition CreateVlc(
        string id,
        string name,
        string executable,
        IReadOnlyList<string> prefix,
        string source,
        string? playerctl)
    {
        var args = prefix.Concat(["--no-one-instance", "--play-and-exit", "--start-time={start_seconds}", "{media_path}"]).ToArray();
        return playerctl is null
            ? new LinuxPlayerDefinition(
                Descriptor(id, "vlc", name, source, true,
                    new PlayerDiagnostic("vlc.launch_only", "info", "Install playerctl to enable VLC status and controls."),
                    AgentCapabilities.PlayFile, AgentCapabilities.Fullscreen),
                () => new CommandPlayerAdapter(
                    Descriptor(id, "vlc", name, source, true, AgentCapabilities.PlayFile, AgentCapabilities.Fullscreen),
                    executable, args, fullscreenArgument: "--fullscreen"))
            : CreateMprisCommand(id, "vlc", name, executable, args, source, "vlc", playerctl,
                fullscreenArgument: "--fullscreen");
    }

    private static LinuxPlayerDefinition CreateMprisCommand(
        string id,
        string kind,
        string name,
        string executable,
        IReadOnlyList<string> args,
        string source,
        string mprisName,
        string? playerctl,
        string? fullscreenArgument = null)
    {
        if (playerctl is null)
        {
            var descriptor = Descriptor(id, kind, name, source, true,
                new PlayerDiagnostic("mpris.launch_only", "info", "Install playerctl to enable MPRIS status and controls."),
                AgentCapabilities.PlayFile);
            return new LinuxPlayerDefinition(descriptor,
                () => new CommandPlayerAdapter(descriptor, executable, args, fullscreenArgument: fullscreenArgument));
        }
        var capabilities = new List<string>
        {
            AgentCapabilities.PlayFile,
            AgentCapabilities.StatusState,
            AgentCapabilities.StatusPosition,
            AgentCapabilities.StatusDuration,
            AgentCapabilities.ControlPause,
            AgentCapabilities.ControlSeek,
            AgentCapabilities.ControlStop,
        };
        if (!string.IsNullOrWhiteSpace(fullscreenArgument))
            capabilities.Insert(1, AgentCapabilities.Fullscreen);
        var controlled = Descriptor(id, kind, name, source, true, capabilities.ToArray());
        return new LinuxPlayerDefinition(controlled,
            () => new MprisPlayerAdapter(controlled, executable, args, "", playerctl, mprisName,
                fullscreenArgument));
    }

    private static void AddFlatpakProfiles(
        List<LinuxPlayerDefinition> definitions,
        HashSet<string> seen,
        string? playerctl)
    {
        var flatpak = ProcessRunner.FindExecutable("flatpak");
        if (flatpak is null) return;
        foreach (var (id, appId, kind, name, mpris) in new[]
        {
            ("flatpak-mpv", "io.mpv.Mpv", "mpv", "mpv (Flatpak)", ""),
            ("flatpak-vlc", "org.videolan.VLC", "vlc", "VLC media player (Flatpak)", "vlc"),
        })
        {
            if (!FlatpakInstalled(flatpak, appId)) continue;
            var args = new[] { "run", appId, "{media_path}" };
            var descriptor = Descriptor(id, kind, name, "flatpak", true,
                new PlayerDiagnostic("flatpak.ready", "info", mpris.Length > 0 && playerctl is not null
                    ? "Flatpak profile with MPRIS controls."
                    : "Flatpak profile is launch-only."),
                AgentCapabilities.PlayFile);
            LinuxPlayerDefinition definition;
            if (mpris.Length > 0 && playerctl is not null)
            {
                descriptor = descriptor with { Capabilities = [
                    AgentCapabilities.PlayFile, AgentCapabilities.StatusState,
                    AgentCapabilities.StatusPosition, AgentCapabilities.StatusDuration,
                    AgentCapabilities.ControlPause, AgentCapabilities.ControlSeek,
                    AgentCapabilities.ControlStop,
                ] };
                definition = new LinuxPlayerDefinition(descriptor,
                    () => new MprisPlayerAdapter(descriptor, flatpak, args, "", playerctl, mpris));
            }
            else definition = new LinuxPlayerDefinition(descriptor,
                () => new CommandPlayerAdapter(descriptor, flatpak, args));
            if (seen.Add(id)) definitions.Add(definition);
        }
    }

    private static void AddSnapProfiles(
        List<LinuxPlayerDefinition> definitions,
        HashSet<string> seen,
        string? playerctl)
    {
        foreach (var (id, path, kind, name, mpris) in new[]
        {
            ("snap-mpv", "/snap/bin/mpv", "mpv", "mpv (Snap)", ""),
            ("snap-vlc", "/snap/bin/vlc", "vlc", "VLC media player (Snap)", "vlc"),
        })
        {
            if (!File.Exists(path) || !seen.Add(id)) continue;
            var args = new[] { "{media_path}" };
            var definition = mpris.Length > 0
                ? CreateMprisCommand(id, kind, name, path, args, "snap", mpris, playerctl)
                : new LinuxPlayerDefinition(
                    Descriptor(id, kind, name, "snap", true,
                        new PlayerDiagnostic("snap.launch_only", "info", "Snap mpv is sandboxed, so private JSON IPC is not enabled."),
                        AgentCapabilities.PlayFile),
                    () => new CommandPlayerAdapter(
                        Descriptor(id, kind, name, "snap", true, AgentCapabilities.PlayFile), path, args));
            definitions.Add(definition);
        }
    }

    private static bool FlatpakInstalled(string flatpak, string appId)
    {
        try
        {
            return ProcessRunner.RunAsync(flatpak, ["info", appId], TimeSpan.FromSeconds(2))
                .GetAwaiter().GetResult().Success;
        }
        catch { return false; }
    }

    private static PlayerDescriptor Descriptor(
        string id,
        string kind,
        string name,
        string source,
        bool available,
        params string[] capabilities) =>
        new(id, kind, name, source, available, capabilities);

    private static PlayerDescriptor Descriptor(
        string id,
        string kind,
        string name,
        string source,
        bool available,
        PlayerDiagnostic diagnostic,
        params string[] capabilities) =>
        new(id, kind, name, source, available, capabilities) { Diagnostics = [diagnostic] };
}
