using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using MediaLauncher.Agent.Core;
using MediaLauncher.LinuxAgent;

var tests = new (string Name, Func<Task> Run)[]
{
    ("desktop Exec tokenization never invokes a shell", () =>
    {
        Equal(new[] { "/usr/bin/vlc", "--flag", "two words", "%f" },
            DesktopEntryDiscovery.SplitExec("/usr/bin/vlc --flag \"two words\" %f").ToArray());
        Equal(0, DesktopEntryDiscovery.SplitExec("/usr/bin/vlc \"unterminated").Count);
        return Task.CompletedTask;
    }),
    ("custom player diagnostics reject script hosts and unknown placeholders", () =>
    {
        var profile = new LinuxCustomPlayerProfile
        {
            Id = $"custom-{new string('a', 32)}",
            Name = "Unsafe",
            ExecutablePath = Path.Combine(Path.GetTempPath(), "sh"),
            Arguments = ["-c", "{unknown}"],
        };
        var errors = CustomPlayerValidation.Errors(profile, requireExistingExecutable: false);
        Match("Shells and script hosts", string.Join(' ', errors));
        Match("Unknown argument placeholder", string.Join(' ', errors));
        return Task.CompletedTask;
    }),
    ("MPRIS discovery selects only one newly-created matching player", () =>
    {
        Equal("vlc.instance2", MprisPlayerAdapter.SelectNewMprisPlayer(
            ["vlc", "org.mpris.MediaPlayer2.other"],
            ["vlc", "vlc.instance2", "org.mpris.MediaPlayer2.other"],
            "vlc"));
        Equal<string?>(null, MprisPlayerAdapter.SelectNewMprisPlayer(
            ["vlc"], ["vlc"], "vlc"));
        Throws<InvalidOperationException>(() => MprisPlayerAdapter.SelectNewMprisPlayer(
            [], ["vlc.one", "vlc.two"], "vlc"));
        return Task.CompletedTask;
    }),
    ("configuration writes camelCase and reads property names case-insensitively", TestConfigJsonAsync),
    ("a stale configured default falls back to an available player", () =>
    {
        var unavailable = Descriptor("missing", false);
        var available = Descriptor("fallback", true);
        var definitions = new[]
        {
            new LinuxPlayerDefinition(unavailable, () => new FakePlayerAdapter(unavailable)),
            new LinuxPlayerDefinition(available, () => new FakePlayerAdapter(available)),
        };
        var config = new LinuxAgentConfig { DefaultPlayerId = "missing" };
        Equal("fallback", LinuxPlayerCatalog.GetDefaultPlayerId(config, definitions));
        return Task.CompletedTask;
    }),
    ("Linux path policy accepts a real rooted file and rejects a sibling root", () =>
    {
        if (!OperatingSystem.IsLinux()) return Task.CompletedTask;
        var root = Path.Combine(Path.GetTempPath(), $"media-launcher-linux-path-{Guid.NewGuid():N}");
        var sibling = root + "-other";
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(sibling);
        try
        {
            var movie = Path.Combine(root, "Movie.mkv");
            var outside = Path.Combine(sibling, "Outside.mkv");
            File.WriteAllBytes(movie, [1]);
            File.WriteAllBytes(outside, [1]);
            Equal(movie, MediaLauncher.Agent.Core.MediaPathPolicy.ValidateLinuxFile(movie, [root]));
            Throws<UnauthorizedAccessException>(() =>
                MediaLauncher.Agent.Core.MediaPathPolicy.ValidateLinuxFile(outside, [root]));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
            Directory.Delete(sibling, recursive: true);
        }
        return Task.CompletedTask;
    }),
    ("Linux path policy rejects a media-looking symlink to a disallowed extension", () =>
    {
        if (!OperatingSystem.IsLinux()) return Task.CompletedTask;
        var root = Path.Combine(Path.GetTempPath(), $"media-launcher-linux-link-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var target = Path.Combine(root, "payload.txt");
            var link = Path.Combine(root, "Movie.mkv");
            File.WriteAllText(target, "not media");
            File.CreateSymbolicLink(link, target);
            Throws<ArgumentException>(() => MediaPathPolicy.ValidateLinuxFile(link, [root]));
        }
        finally { Directory.Delete(root, recursive: true); }
        return Task.CompletedTask;
    }),
    ("invalid replacement requests leave the current session untouched", TestReplacementValidationAsync),
    ("ended sessions retain final status and an explicit end reason", TestEndedSessionStatusAsync),
    ("owned processes remain tracked when termination fails", TestOwnedProcessTerminationFailureAsync),
    ("failed stop control preserves the current session and exit tracking", TestFailedStopControlAsync),
    ("HTTP pairing and v2 info fail closed before authorization", TestServerAuthenticationAsync),
};

var failed = 0;
foreach (var test in tests)
{
    try
    {
        await test.Run();
        Console.WriteLine($"PASS {test.Name}");
    }
    catch (Exception error)
    {
        failed++;
        Console.Error.WriteLine($"FAIL {test.Name}: {error}");
    }
}
Console.WriteLine($"{tests.Length - failed}/{tests.Length} Linux-agent tests passed.");
return failed == 0 ? 0 : 1;

static PlayerDescriptor Descriptor(string id, bool available) =>
    new(id, "test", id, "test", available, [AgentCapabilities.PlayFile]);

static async Task TestConfigJsonAsync()
{
    var directory = Path.Combine(Path.GetTempPath(), $"media-launcher-linux-config-{Guid.NewGuid():N}");
    Directory.CreateDirectory(directory);
    var path = Path.Combine(directory, "config.json");
    try
    {
        var config = new LinuxAgentConfig
        {
            HomeAssistantUrl = "http://home-assistant.test:8089",
            DisplayName = "Linux player",
            AllowedMediaRoots = [directory],
        };
        await config.SaveAsync(path);
        var json = await File.ReadAllTextAsync(path);
        Match("\"homeAssistantUrl\"", json);
        if (json.Contains("\"HomeAssistantUrl\"", StringComparison.Ordinal))
            throw new Exception("Configuration unexpectedly used PascalCase JSON names.");

        var camelCase = LinuxAgentConfig.Load(path);
        Equal("http://home-assistant.test:8089", camelCase.HomeAssistantUrl);
        Equal(1, camelCase.AllowedMediaRoots.Count);
        Equal(directory, camelCase.AllowedMediaRoots[0]);

        var pascalCase = json.Replace("\"homeAssistantUrl\"", "\"HomeAssistantUrl\"", StringComparison.Ordinal);
        await File.WriteAllTextAsync(path, pascalCase);
        Equal("http://home-assistant.test:8089", LinuxAgentConfig.Load(path).HomeAssistantUrl);
    }
    finally { Directory.Delete(directory, recursive: true); }
}

static async Task TestReplacementValidationAsync()
{
    var currentField = typeof(LinuxSessionManager).GetField(
        "_current",
        System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static) ??
        throw new Exception("Linux session test could not access current state.");
    var previousDescriptor = Descriptor("previous", true);
    var previousAdapter = new FakePlayerAdapter(previousDescriptor);
    var previous = new LinuxPlaybackSession(
        "previous-session", "previous", "", previousAdapter, "/media/Previous.mkv", DateTimeOffset.UtcNow);
    var directory = Path.Combine(Path.GetTempPath(), $"media-launcher-linux-replace-{Guid.NewGuid():N}");
    Directory.CreateDirectory(directory);
    var customId = $"custom-{Guid.NewGuid():N}";
    var config = new LinuxAgentConfig
    {
        HomeAssistantUrl = "http://home-assistant.test:8089",
        AllowedMediaRoots = [directory],
        CustomPlayers =
        [
            new LinuxCustomPlayerProfile
            {
                Id = customId,
                Name = "Test launcher",
                ExecutablePath = Environment.ProcessPath ?? throw new Exception("Process path is unavailable."),
                Arguments = ["{media_path}"],
            },
        ],
    };
    currentField.SetValue(null, previous);
    try
    {
        await ThrowsAsync<ArgumentException>(() => LinuxSessionManager.CreateAsync(
            null, customId, Path.Combine(directory, "Missing.txt"), config));
        Equal(false, previousAdapter.Stopped);
        Equal(previous, LinuxSessionManager.Current);

        await ThrowsAsync<ArgumentException>(() => LinuxSessionManager.CreateAsync(
            null, customId, Path.Combine(directory, "Missing.txt"), config,
            startPositionMs: SessionControlLimits.MaxSeekPositionMs + 1));
        Equal(false, previousAdapter.Stopped);
        Equal(previous, LinuxSessionManager.Current);
    }
    finally
    {
        currentField.SetValue(null, null);
        Directory.Delete(directory, recursive: true);
    }
}

static async Task TestEndedSessionStatusAsync()
{
    await LinuxSessionManager.ResetForTestsAsync();
    var descriptor = new PlayerDescriptor(
        "mpv-test",
        "mpv",
        "mpv test",
        "test",
        true,
        [
            AgentCapabilities.PlayFile,
            AgentCapabilities.StatusState,
            AgentCapabilities.StatusPosition,
            AgentCapabilities.StatusDuration,
            AgentCapabilities.ControlStop,
        ]);
    var adapter = new FakePlayerAdapter(descriptor)
    {
        Status = new PlayerStatus("/media/Movie.mkv", "playing", 95_000, 100_000),
    };
    var session = new LinuxPlaybackSession(
        "retained-session",
        descriptor.Id,
        "",
        adapter,
        "/media/Movie.mkv",
        DateTimeOffset.UtcNow);
    LinuxSessionManager.AdoptForTests(session);
    try
    {
        Equal("playing", (await LinuxSessionManager.GetStatusAsync(session.SessionId)).State);
        await LinuxSessionManager.CompleteExitedForTestsAsync(adapter);

        var retained = LinuxSessionManager.Find(session.SessionId) ??
            throw new Exception("Ended session was not retained.");
        Equal(SessionEndReasons.PlayerExited, retained.EndReason);
        var final = await LinuxSessionManager.GetStatusAsync(session.SessionId);
        Equal("stopped", final.State);
        Equal(95_000L, final.PositionMs);
        Equal(100_000L, final.DurationMs);
        await ThrowsAsync<NotSupportedException>(() =>
            LinuxSessionManager.ControlAsync(session.SessionId, "stop", null));
    }
    finally { await LinuxSessionManager.ResetForTestsAsync(); }
}

static async Task TestOwnedProcessTerminationFailureAsync()
{
    var descriptor = new PlayerDescriptor(
        "owned-process-test",
        "custom",
        "owned process test",
        "test",
        true,
        [AgentCapabilities.PlayFile, AgentCapabilities.StatusState, AgentCapabilities.ControlStop]);
    var adapter = new FailingOwnedProcessAdapter(descriptor);
    var process = StartLongRunningProcess();
    adapter.Adopt(process);
    try
    {
        await ThrowsAsync<IOException>(() => adapter.StopAsync());
        Equal(true, adapter.HasOwnedProcess);
        Equal("playing", (await adapter.GetStatusAsync()).State);

        adapter.FailTermination = false;
        await adapter.StopAsync();
        Equal(false, adapter.HasOwnedProcess);
        Equal("stopped", (await adapter.GetStatusAsync()).State);
    }
    finally
    {
        adapter.FailTermination = false;
        try { await adapter.StopAsync(); } catch { /* test cleanup */ }
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch { /* adapter may already have disposed the process */ }
        try { process.Dispose(); } catch { }
    }
}

static async Task TestFailedStopControlAsync()
{
    await LinuxSessionManager.ResetForTestsAsync();
    var descriptor = new PlayerDescriptor(
        "failed-stop-test",
        "custom",
        "failed stop test",
        "test",
        true,
        [AgentCapabilities.PlayFile, AgentCapabilities.StatusState, AgentCapabilities.ControlStop]);
    var adapter = new FakePlayerAdapter(descriptor)
    {
        StopError = new IOException("simulated termination failure"),
    };
    var session = new LinuxPlaybackSession(
        "failed-stop-session",
        descriptor.Id,
        "",
        adapter,
        "/media/Movie.mkv",
        DateTimeOffset.UtcNow);
    LinuxSessionManager.AdoptForTests(session);
    try
    {
        await ThrowsAsync<IOException>(() =>
            LinuxSessionManager.ControlAsync(session.SessionId, "stop", null));
        Equal(session, LinuxSessionManager.Current);
        Equal<string?>(null, session.EndReason);

        adapter.RaisePlaybackExited();
        for (var attempt = 0; attempt < 50 && LinuxSessionManager.Current is not null; attempt++)
            await Task.Delay(10);
        Equal<LinuxPlaybackSession?>(null, LinuxSessionManager.Current);
        Equal(SessionEndReasons.PlayerExited, session.EndReason);
    }
    finally
    {
        adapter.StopError = null;
        await LinuxSessionManager.ResetForTestsAsync();
    }
}

static async Task TestServerAuthenticationAsync()
{
    var directory = Path.Combine(Path.GetTempPath(), $"media-launcher-linux-server-{Guid.NewGuid():N}");
    Directory.CreateDirectory(directory);
    var configPath = Path.Combine(directory, "config.json");
    var port = FreePort();
    var config = new LinuxAgentConfig
    {
        HomeAssistantUrl = "http://home-assistant.test:8089",
        Port = port,
        AllowedMediaRoots = [directory],
        RegistrationSecret = new string('a', 48),
    };
    await config.SaveAsync(configPath);
    var previousConfigHome = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
    Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", directory);
    using var shutdown = new CancellationTokenSource();
    var app = await LinuxPlayServer.StartAsync(config, configPath, shutdown.Token);
    try
    {
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") };
        Equal(HttpStatusCode.OK, (await client.GetAsync("/health")).StatusCode);
        Equal(HttpStatusCode.ServiceUnavailable, (await client.GetAsync("/v2/info")).StatusCode);

        var secret = config.RegistrationSecret;
        var rejectedPair = await client.PostAsync("/pair", new StringContent(
            JsonSerializer.Serialize(new { secret = new string('b', 48) }), Encoding.UTF8, "application/json"));
        Equal(HttpStatusCode.Forbidden, rejectedPair.StatusCode);
        Equal("", config.SharedSecret);

        var pair = await client.PostAsync("/pair", new StringContent(
            JsonSerializer.Serialize(new { secret }), Encoding.UTF8, "application/json"));
        Equal(HttpStatusCode.OK, pair.StatusCode);

        Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/v2/info")).StatusCode);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        var info = await client.GetAsync("/v2/info");
        Equal(HttpStatusCode.OK, info.StatusCode);
        Match("\"platform\":\"linux\"", await info.Content.ReadAsStringAsync());

        using (var stoppedDocument = JsonDocument.Parse(await client.GetStringAsync("/status")))
        {
            var stoppedLegacy = stoppedDocument.RootElement;
            Equal(new[] { "duration", "file", "position", "state" }, stoppedLegacy.EnumerateObject()
                .Select(property => property.Name).Order(StringComparer.Ordinal).ToArray());
            Equal(0, stoppedLegacy.GetProperty("state").GetInt32());
            Equal(0L, stoppedLegacy.GetProperty("position").GetInt64());
            Equal(false, stoppedLegacy.TryGetProperty("positionMs", out _));
        }

        var legacyDescriptor = new PlayerDescriptor(
            "legacy-http-test",
            "mpv",
            "legacy HTTP test",
            "test",
            true,
            [
                AgentCapabilities.PlayFile,
                AgentCapabilities.StatusState,
                AgentCapabilities.StatusPosition,
                AgentCapabilities.StatusDuration,
            ]);
        var legacyAdapter = new FakePlayerAdapter(legacyDescriptor)
        {
            Status = new PlayerStatus("/media/Movie.mkv", "paused", 12_345, 98_765),
        };
        LinuxSessionManager.AdoptForTests(new LinuxPlaybackSession(
            "legacy-http-session",
            legacyDescriptor.Id,
            "",
            legacyAdapter,
            "/media/Movie.mkv",
            DateTimeOffset.UtcNow));
        using (var activeDocument = JsonDocument.Parse(await client.GetStringAsync("/status")))
        {
            var activeLegacy = activeDocument.RootElement;
            Equal(new[] { "duration", "file", "position", "state" }, activeLegacy.EnumerateObject()
                .Select(property => property.Name).Order(StringComparer.Ordinal).ToArray());
            Equal("/media/Movie.mkv", activeLegacy.GetProperty("file").GetString());
            Equal(1, activeLegacy.GetProperty("state").GetInt32());
            Equal(12_345L, activeLegacy.GetProperty("position").GetInt64());
            Equal(98_765L, activeLegacy.GetProperty("duration").GetInt64());
            Equal(false, activeLegacy.TryGetProperty("durationMs", out _));
        }

        var invalidStart = await client.PostAsync("/v2/sessions", new StringContent(
            JsonSerializer.Serialize(new
            {
                requestId = Guid.NewGuid(),
                playerId = "mpv",
                media = new { sourceType = "file", path = Path.Combine(directory, "Movie.mkv") },
                options = new { startPositionMs = SessionControlLimits.MaxSeekPositionMs + 1 },
            }), Encoding.UTF8, "application/json"));
        Equal(HttpStatusCode.BadRequest, invalidStart.StatusCode);

        var secondPair = await client.PostAsync("/pair", new StringContent(
            JsonSerializer.Serialize(new { secret }), Encoding.UTF8, "application/json"));
        Equal(HttpStatusCode.Conflict, secondPair.StatusCode);
    }
    finally
    {
        shutdown.Cancel();
        await app.StopAsync();
        await app.DisposeAsync();
        await LinuxSessionManager.ResetForTestsAsync();
        Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", previousConfigHome);
        Directory.Delete(directory, recursive: true);
    }
}

static Process StartLongRunningProcess()
{
    var startInfo = new ProcessStartInfo
    {
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
    };
    if (OperatingSystem.IsWindows())
    {
        startInfo.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
        foreach (var argument in new[] { "/d", "/c", "ping", "-n", "31", "127.0.0.1" })
            startInfo.ArgumentList.Add(argument);
    }
    else
    {
        startInfo.FileName = "/bin/sh";
        startInfo.ArgumentList.Add("-c");
        startInfo.ArgumentList.Add("sleep 30");
    }
    var process = new Process { StartInfo = startInfo };
    if (!process.Start()) throw new Exception("Could not start the process-ownership fixture.");
    return process;
}

static int FreePort()
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    var port = ((IPEndPoint)listener.LocalEndpoint).Port;
    listener.Stop();
    return port;
}

static void Equal<T>(T expected, T actual)
{
    if (expected is Array expectedArray && actual is Array actualArray)
    {
        if (!expectedArray.Cast<object?>().SequenceEqual(actualArray.Cast<object?>()))
            throw new Exception("Arrays differ.");
        return;
    }
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
        throw new Exception($"Expected {expected} but got {actual}.");
}

static void Match(string expected, string actual)
{
    if (!actual.Contains(expected, StringComparison.Ordinal))
        throw new Exception($"Expected '{actual}' to contain '{expected}'.");
}

static void Throws<T>(Action action) where T : Exception
{
    try { action(); }
    catch (T) { return; }
    throw new Exception($"Expected {typeof(T).Name}.");
}

static async Task ThrowsAsync<T>(Func<Task> action) where T : Exception
{
    try { await action(); }
    catch (T) { return; }
    throw new Exception($"Expected {typeof(T).Name}.");
}

internal sealed class FakePlayerAdapter(PlayerDescriptor descriptor) : IPlayerAdapter
{
    public PlayerDescriptor Descriptor { get; } = descriptor;
    public bool Stopped { get; private set; }
    public Exception? StopError { get; set; }
    public PlayerStatus Status { get; set; } = new(null, "playing", 0, 0);
    public event EventHandler? PlaybackExited;

    public Task LaunchAsync(PlayerLaunchRequest request, IReadOnlyCollection<string> allowedMediaRoots) =>
        Task.CompletedTask;

    public Task StopAsync()
    {
        if (StopError is not null) return Task.FromException(StopError);
        Stopped = true;
        return Task.CompletedTask;
    }

    public Task<PlayerStatus> GetStatusAsync() =>
        Task.FromResult(Status);

    public void RaisePlaybackExited() => PlaybackExited?.Invoke(this, EventArgs.Empty);
}

internal sealed class FailingOwnedProcessAdapter(PlayerDescriptor descriptor)
    : OwnedProcessAdapter(descriptor)
{
    public bool FailTermination { get; set; } = true;
    public bool HasOwnedProcess => OwnedProcess is not null;

    public void Adopt(Process process) => Own(process);

    public override Task LaunchAsync(
        PlayerLaunchRequest request,
        IReadOnlyCollection<string> allowedMediaRoots) => Task.CompletedTask;

    protected override Task TerminateOwnedProcessAsync(Process process) =>
        FailTermination
            ? Task.FromException(new IOException("simulated termination failure"))
            : base.TerminateOwnedProcessAsync(process);
}
