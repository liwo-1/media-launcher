using MediaLauncher.Agent.Core;

namespace MediaLauncher.LinuxAgent;

internal sealed class CommandPlayerAdapter(
    PlayerDescriptor descriptor,
    string executable,
    IReadOnlyList<string> arguments,
    string? workingDirectory = null,
    string? fullscreenArgument = null) : OwnedProcessAdapter(descriptor)
{
    public override Task LaunchAsync(
        PlayerLaunchRequest request,
        IReadOnlyCollection<string> allowedMediaRoots)
    {
        var mediaPath = MediaPathPolicy.ValidateLinuxFile(request.MediaPath, allowedMediaRoots);
        var normalized = request with { MediaPath = mediaPath };
        var expanded = arguments.Select(argument => ExpandArgument(argument, normalized)).ToList();
        if (request.Fullscreen && !string.IsNullOrWhiteSpace(fullscreenArgument))
            expanded.Insert(0, fullscreenArgument);
        var process = ProcessRunner.Start(executable, expanded, workingDirectory);
        Own(process);
        return Task.CompletedTask;
    }
}
