using System.Text.RegularExpressions;

namespace MediaLauncherPlayerAgent;

// Reads MPC-HC's Web Interface (View -> Options -> Player -> Web Interface, must be enabled on
// the media PC - a one-time manual setting, not something this code can turn on remotely).
// variables.html returns simple HTML with values embedded as <p id="fieldname">value</p> tags.
// state: 0 = stopped, 1 = paused, 2 = playing. position/duration are in milliseconds.
public class MpcStatusResult
{
    public string? File { get; set; }
    public int State { get; set; }
    public long Position { get; set; }
    public long Duration { get; set; }
}

public static class MpcStatusReader
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private static readonly string[] FieldIds = { "file", "state", "position", "duration" };

    public static async Task<MpcStatusResult> GetStatusAsync(int port = 13579)
    {
        var response = await Http.GetAsync($"http://localhost:{port}/variables.html");
        if (!response.IsSuccessStatusCode)
            throw new Exception($"MPC-HC Web Interface returned {(int)response.StatusCode}");

        var html = await response.Content.ReadAsStringAsync();
        var fields = new Dictionary<string, string?>();
        foreach (var id in FieldIds)
        {
            var match = Regex.Match(html, $"<p id=\"{id}\">([^<]*)</p>");
            fields[id] = match.Success ? match.Groups[1].Value : null;
        }

        return new MpcStatusResult
        {
            File = fields["file"],
            State = int.TryParse(fields["state"], out var s) ? s : 0,
            Position = long.TryParse(fields["position"], out var p) ? p : 0,
            Duration = long.TryParse(fields["duration"], out var d) ? d : 0,
        };
    }
}
