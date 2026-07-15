using System.Globalization;
using MediaLauncher.Agent.Core;

namespace MediaLauncher.LinuxAgent;

internal sealed class MprisPlayerAdapter(
    PlayerDescriptor descriptor,
    string executable,
    IReadOnlyList<string> arguments,
    string? workingDirectory,
    string playerctl,
    string mprisPlayer,
    string? fullscreenArgument = null) : OwnedProcessAdapter(descriptor)
{
    private string _activeMprisPlayer = "";

    public override async Task LaunchAsync(
        PlayerLaunchRequest request,
        IReadOnlyCollection<string> allowedMediaRoots)
    {
        var mediaPath = MediaPathPolicy.ValidateLinuxFile(request.MediaPath, allowedMediaRoots);
        var normalized = request with { MediaPath = mediaPath };
        var expanded = arguments.Select(argument => ExpandArgument(argument, normalized)).ToList();
        if (request.Fullscreen && !string.IsNullOrWhiteSpace(fullscreenArgument))
            expanded.Insert(0, fullscreenArgument);
        string[] playersBeforeLaunch;
        try
        {
            using var discoveryTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            playersBeforeLaunch = await ListPlayersAsync(discoveryTimeout.Token);
        }
        catch (Exception error) when (error is OperationCanceledException or TimeoutException)
        {
            throw new TimeoutException(
                "Could not establish the MPRIS player baseline before launch.", error);
        }
        var process = ProcessRunner.Start(executable, expanded, workingDirectory);
        Own(process);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(6));
        try
        {
            while (true)
            {
                timeout.Token.ThrowIfCancellationRequested();
                var candidate = SelectNewMprisPlayer(
                    playersBeforeLaunch,
                    await ListPlayersAsync(timeout.Token),
                    mprisPlayer);
                if (candidate is not null)
                {
                    var status = await PlayerctlForAsync(
                        candidate, ["status"], throwOnFailure: false, timeout.Token);
                    var metadata = await PlayerctlForAsync(
                        candidate, ["metadata", "--format", "{{xesam:url}}"],
                        throwOnFailure: false, timeout.Token);
                    var reportedFile = FileFromUri(metadata.StandardOutput);
                    if (status.Success && metadata.Success &&
                        IsSameLinuxFile(mediaPath, reportedFile) && !HasExited(process))
                    {
                        _activeMprisPlayer = candidate;
                        return;
                    }
                }
                if (HasExited(process))
                    throw new InvalidOperationException("The player exited before its owned MPRIS interface became ready.");
                await Task.Delay(100, timeout.Token);
            }
        }
        catch (Exception error) when (
            error is TimeoutException || error is OperationCanceledException && timeout.IsCancellationRequested)
        {
            await StopAsync();
            throw new TimeoutException(
                "The player did not expose an owned MPRIS interface for the requested media in time.", error);
        }
        catch
        {
            await StopAsync();
            throw;
        }
    }

    public override async Task<PlayerStatus> GetStatusAsync()
    {
        if (OwnedProcess is not { HasExited: false }) return new PlayerStatus(null, "stopped", 0, 0);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var statusResult = await PlayerctlAsync(["status"], throwOnFailure: false, timeout.Token);
        if (!statusResult.Success) return new PlayerStatus(null, "stopped", 0, 0);
        var state = statusResult.StandardOutput.Trim().ToLowerInvariant() switch
        {
            "playing" => "playing",
            "paused" => "paused",
            _ => "stopped",
        };
        var positionResult = await PlayerctlAsync(["position"], throwOnFailure: false, timeout.Token);
        var metadata = await PlayerctlAsync([
            "metadata", "--format", "{{xesam:url}}\n{{mpris:length}}",
        ], throwOnFailure: false, timeout.Token);
        var lines = metadata.StandardOutput.Replace("\r", "").Split('\n');
        var file = FileFromUri(lines.ElementAtOrDefault(0));
        var duration = long.TryParse(lines.ElementAtOrDefault(1), out var microseconds) && microseconds >= 0
            ? microseconds / 1000
            : 0;
        var position = double.TryParse(positionResult.StandardOutput.Trim(),
            NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) && seconds >= 0
            ? checked((long)Math.Round(seconds * 1000))
            : 0;
        return new PlayerStatus(file, state, position, duration);
    }

    public override async Task SetPausedAsync(bool paused)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await PlayerctlAsync([paused ? "pause" : "play"], throwOnFailure: true, timeout.Token);
    }

    public override async Task SeekAsync(long positionMs)
    {
        if (positionMs < 0) throw new ArgumentOutOfRangeException(nameof(positionMs));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await PlayerctlAsync([
            "position",
            (positionMs / 1000d).ToString("0.###", CultureInfo.InvariantCulture),
        ], throwOnFailure: true, timeout.Token);
    }

    public override async Task StopAsync()
    {
        if (OwnedProcess is { HasExited: false })
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await PlayerctlAsync(["stop"], throwOnFailure: false, timeout.Token);
                await Task.Delay(100, timeout.Token);
            }
            catch { /* Process termination below is authoritative. */ }
        }
        await base.StopAsync();
        _activeMprisPlayer = "";
    }

    private async Task<ProcessResult> PlayerctlAsync(
        IReadOnlyList<string> arguments,
        bool throwOnFailure,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(_activeMprisPlayer))
            throw new InvalidOperationException("The owned MPRIS player is not ready.");
        return await PlayerctlForAsync(
            _activeMprisPlayer, arguments, throwOnFailure, cancellationToken);
    }

    private async Task<ProcessResult> PlayerctlForAsync(
        string selectedPlayer,
        IReadOnlyList<string> arguments,
        bool throwOnFailure,
        CancellationToken cancellationToken)
    {
        var allArguments = new List<string> { $"--player={selectedPlayer}" };
        allArguments.AddRange(arguments);
        var result = await ProcessRunner.RunAsync(
            playerctl,
            allArguments,
            TimeSpan.FromSeconds(2),
            cancellationToken);
        if (throwOnFailure && !result.Success)
            throw new InvalidOperationException($"MPRIS command failed: {result.StandardError.Trim()}");
        return result;
    }

    private async Task<string[]> ListPlayersAsync(CancellationToken cancellationToken)
    {
        var result = await ProcessRunner.RunAsync(
            playerctl,
            ["--list-all"],
            TimeSpan.FromSeconds(2),
            cancellationToken);
        if (!result.Success)
            throw new InvalidOperationException("playerctl could not enumerate MPRIS players.");
        return result.StandardOutput.Replace("\r", "")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    internal static string? SelectNewMprisPlayer(
        IReadOnlyCollection<string> playersBeforeLaunch,
        IReadOnlyCollection<string> currentPlayers,
        string requestedPlayer)
    {
        var candidates = currentPlayers
            .Where(value =>
                string.Equals(value, requestedPlayer, StringComparison.Ordinal) ||
                value.StartsWith(requestedPlayer + ".", StringComparison.Ordinal))
            .Where(player => !playersBeforeLaunch.Contains(player, StringComparer.Ordinal))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return candidates.Length switch
        {
            0 => null,
            1 => candidates[0],
            _ => throw new InvalidOperationException(
                "More than one new matching MPRIS player appeared; refusing to control the wrong process."),
        };
    }

    private static bool HasExited(System.Diagnostics.Process process)
    {
        try { return process.HasExited; }
        catch (ObjectDisposedException) { return true; }
        catch (InvalidOperationException) { return true; }
    }

    private static bool IsSameLinuxFile(string expected, string? reported)
    {
        if (string.IsNullOrWhiteSpace(reported) || !Path.IsPathFullyQualified(reported)) return false;
        try
        {
            return string.Equals(
                Path.GetFullPath(expected),
                Path.GetFullPath(reported),
                StringComparison.Ordinal);
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException)
        {
            return false;
        }
    }

    private static string? FileFromUri(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) && uri.IsFile)
            return Uri.UnescapeDataString(uri.LocalPath);
        return value.Trim();
    }
}
