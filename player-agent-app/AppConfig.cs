using System.Text.Json;
using System.Security.Cryptography;

namespace MediaLauncherPlayerAgent;

public class AppConfig
{
    private static readonly object SaveLock = new();

    public string HomeAssistantUrl { get; set; } = "";
    public int Port { get; set; } = 7777;
    public string? MpcPathOverride { get; set; }
    public string? VlcPathOverride { get; set; }
    public string? PotPlayerPathOverride { get; set; }
    public List<CustomPlayerProfile> CustomPlayers { get; set; } = [];
    public bool StartWithWindows { get; set; } = false;
    public string InstanceId { get; set; } = Guid.NewGuid().ToString("N");
    public string SharedSecret { get; set; } = "";
    public string RegistrationSecret { get; set; } = "";
    public string[] AllowedMediaRoots { get; set; } = [];

    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsComplete =>
        IsHttpUrl(HomeAssistantUrl) &&
        (AllowedMediaRoots?.Length ?? 0) > 0;

    public static bool IsHttpUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps) &&
        string.IsNullOrEmpty(uri.UserInfo) &&
        string.IsNullOrEmpty(uri.Query) &&
        string.IsNullOrEmpty(uri.Fragment);

    public static AppConfig Load()
    {
        AppPaths.EnsureDataDirectory();
        MigrateLegacyConfigIfNeeded();
        if (!File.Exists(AppPaths.ConfigPath)) return new AppConfig();

        try
        {
            var json = File.ReadAllText(AppPaths.ConfigPath);
            var config = JsonSerializer.Deserialize<AppConfig>(json) ??
                throw new InvalidDataException("The configuration file contained no settings.");
            return config.Normalize();
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or InvalidDataException)
        {
            Logger.Log($"Could not load config '{AppPaths.ConfigPath}': {ex}");
            var backupPath = $"{AppPaths.ConfigPath}.corrupt-{DateTime.Now:yyyyMMdd-HHmmss}";
            try { File.Move(AppPaths.ConfigPath, backupPath, overwrite: true); }
            catch (Exception moveEx) { Logger.Log($"Could not preserve corrupt config: {moveEx.Message}"); }
            throw new InvalidDataException(
                $"The saved configuration was unreadable and has been preserved as:\n{backupPath}", ex);
        }
    }

    public void Save()
    {
        lock (SaveLock)
        {
            Normalize();
            AppPaths.EnsureDataDirectory();
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            var tempPath = $"{AppPaths.ConfigPath}.{Environment.ProcessId}.tmp";
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, AppPaths.ConfigPath, overwrite: true);
        }
    }

    public string EnsureRegistrationCredential()
    {
        if (!string.IsNullOrEmpty(SharedSecret)) return SharedSecret;
        if (!string.IsNullOrEmpty(RegistrationSecret)) return RegistrationSecret;
        RegistrationSecret = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        return RegistrationSecret;
    }

    public AppConfig Normalize()
    {
        HomeAssistantUrl = (HomeAssistantUrl ?? "").Trim();
        Port = Port is >= 1 and <= 65535 ? Port : 7777;
        MpcPathOverride = CleanOptionalPath(MpcPathOverride);
        VlcPathOverride = CleanOptionalPath(VlcPathOverride);
        PotPlayerPathOverride = CleanOptionalPath(PotPlayerPathOverride);
        InstanceId = Guid.TryParseExact(InstanceId, "N", out var instanceId)
            ? instanceId.ToString("N")
            : Guid.NewGuid().ToString("N");
        SharedSecret = NormalizeSecret(SharedSecret);
        RegistrationSecret = NormalizeSecret(RegistrationSecret);
        AllowedMediaRoots = (AllowedMediaRoots ?? [])
            .OfType<string>()
            .Select(root => root.Trim())
            .Where(root => root.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        CustomPlayers = (CustomPlayers ?? [])
            .OfType<CustomPlayerProfile>()
            .Select(profile =>
            {
                var profileId = profile.Id ?? "";
                profile.Id = System.Text.RegularExpressions.Regex.IsMatch(
                    profileId, "^custom-[a-f0-9]{32}$")
                    ? profileId.ToLowerInvariant()
                    : $"custom-{Guid.NewGuid():N}";
                profile.Name = string.IsNullOrWhiteSpace(profile.Name)
                    ? "Custom player"
                    : profile.Name.Trim()[..Math.Min(profile.Name.Trim().Length, 80)];
                profile.ExecutablePath = (profile.ExecutablePath ?? "").Trim();
                profile.WorkingDirectory = CleanOptionalPath(profile.WorkingDirectory);
                profile.Arguments = (profile.Arguments ?? []).OfType<string>().ToArray();
                return profile;
            })
            .ToList();
        return this;
    }

    private static string NormalizeSecret(string? value)
    {
        var normalized = (value ?? "").Trim().ToLowerInvariant();
        return normalized.Length == 48 && normalized.All(Uri.IsHexDigit) ? normalized : "";
    }

    private static string? CleanOptionalPath(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static void MigrateLegacyConfigIfNeeded()
    {
        if (File.Exists(AppPaths.ConfigPath) || !File.Exists(AppPaths.LegacyConfigPath)) return;
        File.Copy(AppPaths.LegacyConfigPath, AppPaths.ConfigPath);
        Logger.Log($"Migrated config from '{AppPaths.LegacyConfigPath}' to '{AppPaths.ConfigPath}'.");
    }
}

public class CustomPlayerProfile
{
    public string Id { get; set; } = $"custom-{Guid.NewGuid():N}";
    public string Name { get; set; } = "Custom player";
    public string ExecutablePath { get; set; } = "";
    public string? WorkingDirectory { get; set; }
    public string[] Arguments { get; set; } = [];

    public override string ToString() => Name;
}
