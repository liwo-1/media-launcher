using System.Text.Json;

namespace MediaLauncherPlayerAgent;

public class AppConfig
{
    public string HomeAssistantUrl { get; set; } = "";
    public int Port { get; set; } = 7777;
    public string? MpcPathOverride { get; set; }
    public bool StartWithWindows { get; set; } = true;

    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsComplete => !string.IsNullOrWhiteSpace(HomeAssistantUrl);

    private static string ConfigPath => Path.Combine(AppContext.BaseDirectory, "config.json");

    public static AppConfig Load()
    {
        if (!File.Exists(ConfigPath)) return new AppConfig();
        try
        {
            var json = File.ReadAllText(ConfigPath);
            return JsonSerializer.Deserialize<AppConfig>(json) ?? new AppConfig();
        }
        catch
        {
            return new AppConfig();
        }
    }

    public void Save()
    {
        var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(ConfigPath, json);
    }
}
