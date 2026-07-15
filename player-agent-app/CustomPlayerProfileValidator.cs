namespace MediaLauncherPlayerAgent;

public sealed record CustomPlayerValidationResult(PlayerDiagnostic[] Diagnostics)
{
    public bool IsValid => Diagnostics.All(diagnostic => diagnostic.Severity != "error");
}

public static class CustomPlayerProfileValidator
{
    private const int MaxNameLength = 80;
    private const int MaxArguments = 100;
    private const int MaxArgumentLength = 1000;

    public static CustomPlayerValidationResult Validate(
        CustomPlayerProfile profile,
        bool requireExistingPaths)
    {
        var diagnostics = new List<PlayerDiagnostic>();
        if (!System.Text.RegularExpressions.Regex.IsMatch(
                profile.Id ?? "",
                "^custom-[a-f0-9]{32}$",
                System.Text.RegularExpressions.RegexOptions.CultureInvariant))
        {
            diagnostics.Add(Error(
                "custom.invalid_id",
                "The custom profile ID is invalid. Save Settings to generate a new local ID."));
        }

        var name = profile.Name ?? "";
        if (string.IsNullOrWhiteSpace(name) || name.Length > MaxNameLength)
        {
            diagnostics.Add(Error(
                "custom.invalid_name",
                $"The player name must contain 1 to {MaxNameLength} characters."));
        }

        var executablePath = profile.ExecutablePath ?? "";
        if (!Path.IsPathFullyQualified(executablePath))
        {
            diagnostics.Add(Error(
                "custom.executable_not_absolute",
                "The executable path must be an absolute local Windows path."));
        }
        else if (executablePath.StartsWith(@"\\", StringComparison.Ordinal))
        {
            diagnostics.Add(Error(
                "custom.executable_not_local",
                "Custom player executables must be installed locally; network executables are not allowed."));
        }
        else if (!string.Equals(Path.GetExtension(executablePath), ".exe", StringComparison.OrdinalIgnoreCase))
        {
            diagnostics.Add(Error(
                "custom.executable_not_windows_binary",
                "The custom player must point directly to a Windows .exe file."));
        }
        else if (requireExistingPaths && !File.Exists(executablePath))
        {
            diagnostics.Add(Error(
                "custom.executable_missing",
                $"The configured executable was not found: {executablePath}"));
        }
        else
        {
            try
            {
                if (File.Exists(executablePath)) CommandPlayerAdapter.ValidateExecutable(executablePath);
            }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
            {
                diagnostics.Add(Error("custom.executable_rejected", ex.Message));
            }
        }

        var workingDirectory = profile.WorkingDirectory;
        if (!string.IsNullOrWhiteSpace(workingDirectory))
        {
            if (!Path.IsPathFullyQualified(workingDirectory))
            {
                diagnostics.Add(Error(
                    "custom.working_directory_not_absolute",
                    "The working directory must be an absolute local Windows path."));
            }
            else if (workingDirectory.StartsWith(@"\\", StringComparison.Ordinal))
            {
                diagnostics.Add(Error(
                    "custom.working_directory_not_local",
                    "The custom player's working directory must be local."));
            }
            else if (requireExistingPaths && !Directory.Exists(workingDirectory))
            {
                diagnostics.Add(Error(
                    "custom.working_directory_missing",
                    $"The configured working directory was not found: {workingDirectory}"));
            }
        }

        var arguments = profile.Arguments ?? [];
        if (arguments.Length > MaxArguments)
        {
            diagnostics.Add(Error(
                "custom.too_many_arguments",
                $"A custom profile can contain at most {MaxArguments} argument tokens."));
        }
        if (arguments.Any(argument => argument is null || argument.Contains('\0')))
        {
            diagnostics.Add(Error(
                "custom.invalid_argument",
                "Custom argument tokens cannot be null or contain a NUL character."));
        }
        if (arguments.OfType<string>().Any(argument => argument.Length > MaxArgumentLength))
        {
            diagnostics.Add(Error(
                "custom.argument_too_long",
                $"Each custom argument token must be at most {MaxArgumentLength} characters."));
        }
        if (!arguments.OfType<string>().Any(
                argument => argument.Contains("{media_path}", StringComparison.Ordinal)))
        {
            diagnostics.Add(new PlayerDiagnostic(
                "custom.media_path_appended",
                "info",
                "The media path placeholder is omitted, so the agent will append the path as the final argument."));
        }

        return new CustomPlayerValidationResult([.. diagnostics]);
    }

    private static PlayerDiagnostic Error(string code, string message) =>
        new(code, "error", message);
}
