using System.Text.Json;

namespace MediaLauncherPlayerAgent;

public class AppConfig
{
    private static readonly object SaveLock = new();

    public string HomeAssistantUrl { get; set; } = "";
    public int Port { get; set; } = 7777;
    public string? MpcPathOverride { get; set; }
    public bool StartWithWindows { get; set; } = false;
    public string InstanceId { get; set; } = Guid.NewGuid().ToString("N");
    public string SharedSecret { get; set; } = "";
    public string[] AllowedMediaRoots { get; set; } = [];

    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsComplete =>
        IsHttpUrl(HomeAssistantUrl) &&
        AllowedMediaRoots.Length > 0;

    public static bool IsHttpUrl(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
        (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    public static AppConfig Load()
    {
        AppPaths.EnsureDataDirectory();
        MigrateLegacyConfigIfNeeded();
        if (!File.Exists(AppPaths.ConfigPath)) return new AppConfig();

        try
        {
            var json = File.ReadAllText(AppPaths.ConfigPath);
            return JsonSerializer.Deserialize<AppConfig>(json) ??
                throw new InvalidDataException("The configuration file contained no settings.");
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
            AppPaths.EnsureDataDirectory();
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            var tempPath = $"{AppPaths.ConfigPath}.{Environment.ProcessId}.tmp";
            File.WriteAllText(tempPath, json);
            File.Move(tempPath, AppPaths.ConfigPath, overwrite: true);
        }
    }

    private static void MigrateLegacyConfigIfNeeded()
    {
        if (File.Exists(AppPaths.ConfigPath) || !File.Exists(AppPaths.LegacyConfigPath)) return;
        File.Copy(AppPaths.LegacyConfigPath, AppPaths.ConfigPath);
        Logger.Log($"Migrated config from '{AppPaths.LegacyConfigPath}' to '{AppPaths.ConfigPath}'.");
    }
}
