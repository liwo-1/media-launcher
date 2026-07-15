using System.Security.Cryptography;
using System.Text.Json;

namespace MediaLauncher.LinuxAgent;

public sealed class LinuxCustomPlayerProfile
{
    public string Id { get; set; } = $"custom-{Guid.NewGuid():N}";
    public string Name { get; set; } = "Custom player";
    public string ExecutablePath { get; set; } = "";
    public string WorkingDirectory { get; set; } = "";
    public List<string> Arguments { get; set; } = ["{media_path}"];
    public string MprisPlayer { get; set; } = "";
}

public sealed class LinuxAgentConfig
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };
    private static readonly SemaphoreSlim SaveLock = new(1, 1);

    public string HomeAssistantUrl { get; set; } = "";
    public int Port { get; set; } = 7777;
    public string DisplayName { get; set; } = Environment.MachineName;
    public string DefaultPlayerId { get; set; } = "";
    public List<string> AllowedMediaRoots { get; set; } = [];
    public List<LinuxCustomPlayerProfile> CustomPlayers { get; set; } = [];
    public string InstanceId { get; set; } = Guid.NewGuid().ToString("N");
    public string SharedSecret { get; set; } = "";
    public string RegistrationSecret { get; set; } = "";

    public bool IsComplete =>
        TryNormalizeServerUrl(HomeAssistantUrl, out _) &&
        Port is >= 1024 and <= 65535 &&
        AllowedMediaRoots.Count > 0;

    public static LinuxAgentConfig Load(string path)
    {
        LinuxAgentConfig config;
        if (!File.Exists(path)) config = new LinuxAgentConfig();
        else
        {
            try
            {
                config = JsonSerializer.Deserialize<LinuxAgentConfig>(File.ReadAllText(path), JsonOptions) ??
                    throw new InvalidDataException("Configuration is empty.");
            }
            catch (JsonException ex)
            {
                throw new InvalidDataException($"Linux agent configuration is invalid: {ex.Message}", ex);
            }
        }
        config.Normalize();
        config.ApplyEnvironmentOverrides();
        config.Normalize();
        return config;
    }

    public async Task SaveAsync(string path, CancellationToken cancellationToken = default)
    {
        Normalize();
        Validate();
        await SaveLock.WaitAsync(cancellationToken);
        try
        {
            var directory = Path.GetDirectoryName(Path.GetFullPath(path))!;
            AgentPaths.EnsurePrivateDirectory(directory);
            var temp = Path.Combine(directory, $".{Path.GetFileName(path)}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");
            try
            {
                await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(this, JsonOptions), cancellationToken);
                if (!OperatingSystem.IsWindows())
                {
                    File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                }
                File.Move(temp, path, overwrite: true);
            }
            finally
            {
                try { File.Delete(temp); } catch { /* best effort */ }
            }
        }
        finally
        {
            SaveLock.Release();
        }
    }

    public void Validate()
    {
        if (!TryNormalizeServerUrl(HomeAssistantUrl, out var normalized))
            throw new InvalidDataException("Home Assistant URL must be an http:// or https:// URL without credentials, query, or fragment.");
        HomeAssistantUrl = normalized;
        if (Port is < 1024 or > 65535) throw new InvalidDataException("Port must be between 1024 and 65535.");
        if (AllowedMediaRoots.Count == 0) throw new InvalidDataException("At least one allowed media root is required.");
        foreach (var root in AllowedMediaRoots)
        {
            if (!Path.IsPathFullyQualified(root))
                throw new InvalidDataException($"Allowed media root must be absolute: {root}");
        }
        foreach (var profile in CustomPlayers)
        {
            var errors = CustomPlayerValidation.Errors(profile, requireExistingExecutable: false);
            if (errors.Count > 0)
                throw new InvalidDataException($"Custom player '{profile.Name}' is invalid: {string.Join(" ", errors)}");
        }
    }

    public string EnsureRegistrationCredential()
    {
        if (!string.IsNullOrEmpty(SharedSecret)) return SharedSecret;
        if (!string.IsNullOrEmpty(RegistrationSecret)) return RegistrationSecret;
        RegistrationSecret = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        return RegistrationSecret;
    }

    public void ResetPairingIdentity()
    {
        InstanceId = Guid.NewGuid().ToString("N");
        SharedSecret = "";
        RegistrationSecret = "";
    }

    private void Normalize()
    {
        HomeAssistantUrl = HomeAssistantUrl?.Trim().TrimEnd('/') ?? "";
        DisplayName = string.IsNullOrWhiteSpace(DisplayName)
            ? Environment.MachineName
            : DisplayName.Trim()[..Math.Min(DisplayName.Trim().Length, 80)];
        InstanceId = Guid.TryParseExact(InstanceId, "N", out _) ? InstanceId.ToLowerInvariant() : Guid.NewGuid().ToString("N");
        SharedSecret = NormalizeSecret(SharedSecret);
        RegistrationSecret = NormalizeSecret(RegistrationSecret);
        AllowedMediaRoots = (AllowedMediaRoots ?? [])
            .Where(root => !string.IsNullOrWhiteSpace(root))
            .Select(root => Path.TrimEndingDirectorySeparator(Path.GetFullPath(root.Trim())))
            .Distinct(StringComparer.Ordinal)
            .Take(64)
            .ToList();
        CustomPlayers ??= [];
    }

    private void ApplyEnvironmentOverrides()
    {
        var url = Environment.GetEnvironmentVariable("MEDIA_LAUNCHER_HA_URL");
        if (!string.IsNullOrWhiteSpace(url)) HomeAssistantUrl = url.Trim().TrimEnd('/');
        if (int.TryParse(Environment.GetEnvironmentVariable("MEDIA_LAUNCHER_PORT"), out var port)) Port = port;
        var roots = Environment.GetEnvironmentVariable("MEDIA_LAUNCHER_ALLOWED_ROOTS");
        if (!string.IsNullOrWhiteSpace(roots))
        {
            AllowedMediaRoots = roots.Split(Path.PathSeparator,
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        }
    }

    private static string NormalizeSecret(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant() ?? "";
        return normalized.Length == 48 && normalized.All(Uri.IsHexDigit) ? normalized : "";
    }

    private static bool TryNormalizeServerUrl(string? value, out string normalized)
    {
        normalized = "";
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") ||
            !string.IsNullOrEmpty(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment)) return false;
        normalized = uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        return true;
    }
}
