using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using MediaLauncher.Agent.Core;
using MediaLauncherPlayerAgent;

var tests = new (string Name, Func<Task> Run)[]
{
    ("VLC control accepts only numeric loopback endpoints", TestLoopbackValidation),
    ("VLC status uses Basic auth and parses progress", TestVlcStatusAndAuthentication),
    ("VLC pause, seek, and stop commands use the private endpoint", TestVlcCommands),
    ("VLC launch arguments bind and authenticate localhost control", TestVlcLaunchArguments),
    ("MPC-HC launch arguments preserve the provider resume position", TestMpcLaunchArguments),
    ("launchers reject pre-existing player processes without terminating them", TestProcessOwnership),
    ("Windows agent logs rotate and unauthorized rejections are rate-limited", TestBoundedLogging),
    ("PATH player discovery returns canonical absolute paths", TestCanonicalPathDiscovery),
    ("player capabilities advertise only implemented controls", TestCapabilities),
    ("session controls are capability-gated and retain end reasons", TestSessionControlsAndEndReasons),
    ("authenticated HTTP control endpoints enforce capabilities and report terminal state", TestControlEndpoints),
    ("custom player validation reports unsafe and unavailable profiles", TestCustomValidation),
};

var failures = 0;
foreach (var (name, run) in tests)
{
    try
    {
        await run();
        Console.WriteLine($"PASS {name}");
    }
    catch (Exception ex)
    {
        failures += 1;
        Console.Error.WriteLine($"FAIL {name}: {ex.Message}");
    }
}

Console.WriteLine($"{tests.Length - failures}/{tests.Length} tests passed");
return failures == 0 ? 0 : 1;

static Task TestLoopbackValidation()
{
    AssertThrows<ArgumentException>(() =>
        VlcControlClient.ValidateLoopbackEndpoint(new Uri("http://192.168.1.10:42123/")));
    AssertThrows<ArgumentException>(() =>
        VlcControlClient.ValidateLoopbackEndpoint(new Uri("http://localhost:42123/")));
    VlcControlClient.ValidateLoopbackEndpoint(new Uri("http://127.0.0.1:42123/"));
    VlcControlClient.ValidateLoopbackEndpoint(new Uri("http://[::1]:42123/"));
    return Task.CompletedTask;
}

static async Task TestVlcStatusAndAuthentication()
{
    var requests = new List<CapturedRequest>();
    using var client = new VlcControlClient(
        new Uri("http://127.0.0.1:42123/"),
        "private-password",
        new RecordingHandler(requests, """
            {
              "state": "playing",
              "time": 12.5,
              "length": "100",
              "information": { "category": { "meta": {
                "filename": "Movie.mkv",
                "url": "https://media.invalid/library/Movie.mkv"
              } } }
            }
            """));

    var status = await client.GetStatusAsync();

    Equal("playing", status.State);
    Equal("https://media.invalid/library/Movie.mkv", status.File);
    Equal(12_500L, status.PositionMs);
    Equal(100_000L, status.DurationMs);
    Equal("127.0.0.1", requests.Single().Host);
    Equal(
        "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(":private-password")),
        requests.Single().Authorization);
}

static async Task TestVlcCommands()
{
    var requests = new List<CapturedRequest>();
    var handler = new StatefulVlcHandler(requests);
    using var client = new VlcControlClient(
        new Uri("http://127.0.0.1:42124/"),
        "secret",
        handler);

    await client.SetPausedAsync(paused: true);
    await client.SetPausedAsync(paused: true);
    await client.SetPausedAsync(paused: false);
    await client.SetPausedAsync(paused: false);
    await client.SeekAsync(12_345);
    await client.StopPlaybackAsync();

    Equal(2, requests.Count(request => request.Query.Contains("command=pl_pause", StringComparison.Ordinal)));
    True(requests.Any(request => request.Query.Contains("command=seek", StringComparison.Ordinal) &&
                                 request.Query.Contains("val=12.345", StringComparison.Ordinal)));
    True(requests.Any(request => request.Query.Contains("command=pl_stop", StringComparison.Ordinal)));
    True(requests.All(request => request.Host == "127.0.0.1"));
}

static Task TestVlcLaunchArguments()
{
    var mediaPath = @"\\nas\media\Movie.mkv";
    var startInfo = VlcPlayerAdapter.CreateStartInfo(
        @"C:\Program Files\VideoLAN\VLC\vlc.exe",
        new PlayerLaunchRequest(mediaPath, "Movie", 12_345, true),
        43123,
        "private-password");
    var arguments = startInfo.ArgumentList.ToArray();

    True(arguments.Contains("--http-host=127.0.0.1"));
    True(arguments.Contains("--http-port=43123"));
    True(arguments.Contains("--http-password=private-password"));
    True(arguments.Contains("--start-time=12.345"));
    True(arguments.Contains("--fullscreen"));
    Equal(mediaPath, arguments[^1]);
    return Task.CompletedTask;
}

static Task TestMpcLaunchArguments()
{
    var mediaPath = @"\\nas\media\Movie.mkv";
    var startInfo = MpcLauncher.CreateStartInfo(
        @"C:\Program Files\MPC-HC\mpc-hc64.exe",
        mediaPath,
        startPositionMs: 12_345,
        fullscreen: true);
    var arguments = startInfo.ArgumentList.ToArray();
    var startIndex = Array.IndexOf(arguments, "/start");

    True(startIndex >= 0 && startIndex + 2 < arguments.Length);
    Equal("12345", arguments[startIndex + 1]);
    Equal(mediaPath, arguments[startIndex + 2]);
    True(arguments.Contains("/fullscreen"));
    True(arguments.Contains("/play"));

    var fromBeginning = MpcLauncher.CreateStartInfo(
        @"C:\Program Files\MPC-HC\mpc-hc64.exe",
        mediaPath,
        startPositionMs: 0,
        fullscreen: false).ArgumentList.ToArray();
    False(fromBeginning.Contains("/start"));
    False(fromBeginning.Contains("/fullscreen"));
    return Task.CompletedTask;
}

static Task TestProcessOwnership()
{
    var current = System.Diagnostics.Process.GetCurrentProcess();
    AssertThrows<InvalidOperationException>(() =>
        ProcessOwnershipGuard.ThrowIfProcessNameIsRunning(
            "fixture-player",
            "Fixture Player",
            _ => [current]));
    False(System.Diagnostics.Process.GetCurrentProcess().HasExited);

    var startInfo = MpcLauncher.CreateStartInfo(
        @"C:\Program Files\MPC-HC\mpc-hc64.exe",
        @"\\nas\media\Movie.mkv",
        startPositionMs: 0,
        fullscreen: true);
    var arguments = startInfo.ArgumentList.ToArray();
    True(arguments.Contains("/new"));
    True(arguments.Contains("/fullscreen"));
    True(arguments.Contains("/play"));
    return Task.CompletedTask;
}

static Task TestBoundedLogging()
{
    var directory = Path.Combine(Path.GetTempPath(), $"media-launcher-log-test-{Guid.NewGuid():N}");
    Directory.CreateDirectory(directory);
    var path = Path.Combine(directory, "agent.log");
    try
    {
        File.WriteAllText(path, "12345678");
        Logger.AppendBoundedLine(path, "next", maxLogBytes: 12);
        Equal("12345678", File.ReadAllText(path + ".1"));
        Equal("next" + Environment.NewLine, File.ReadAllText(path));
        True(new FileInfo(path).Length <= 12);

        PlayServer.ResetUnauthorizedLogLimiterForTests();
        var first = DateTimeOffset.UtcNow.UtcTicks;
        True(PlayServer.ShouldLogUnauthorizedRequest(first));
        False(PlayServer.ShouldLogUnauthorizedRequest(first + TimeSpan.FromSeconds(29).Ticks));
        True(PlayServer.ShouldLogUnauthorizedRequest(first + TimeSpan.FromSeconds(30).Ticks));
    }
    finally
    {
        PlayServer.ResetUnauthorizedLogLimiterForTests();
        Directory.Delete(directory, recursive: true);
    }
    return Task.CompletedTask;
}

static Task TestCanonicalPathDiscovery()
{
    var directory = Path.Combine(Path.GetTempPath(), $"media-launcher-path-test-{Guid.NewGuid():N}");
    Directory.CreateDirectory(directory);
    var executable = Path.Combine(directory, "fixture-player.exe");
    File.WriteAllText(executable, "test fixture");
    var previousPath = Environment.GetEnvironmentVariable("PATH");
    var previousDirectory = Environment.CurrentDirectory;
    try
    {
        Environment.CurrentDirectory = Path.GetDirectoryName(directory)!;
        Environment.SetEnvironmentVariable("PATH", Path.GetFileName(directory));
        Equal(Path.GetFullPath(executable), WindowsPlayerLocator.FindOnPath("fixture-player.exe"));
    }
    finally
    {
        Environment.SetEnvironmentVariable("PATH", previousPath);
        Environment.CurrentDirectory = previousDirectory;
        Directory.Delete(directory, recursive: true);
    }
    return Task.CompletedTask;
}

static Task TestCapabilities()
{
    var vlc = new VlcPlayerAdapter(@"C:\vlc.exe").Descriptor;
    True(PlayerCapabilities.Supports(vlc, PlayerCapabilities.StatusState));
    True(PlayerCapabilities.Supports(vlc, PlayerCapabilities.ControlPause));
    True(PlayerCapabilities.Supports(vlc, PlayerCapabilities.ControlSeek));
    True(PlayerCapabilities.Supports(vlc, PlayerCapabilities.ControlStop));

    var potPlayer = PlayerCatalog.CreatePotPlayerDescriptor();
    False(PlayerCapabilities.Supports(potPlayer, PlayerCapabilities.StatusState));
    False(PlayerCapabilities.Supports(potPlayer, PlayerCapabilities.ControlPause));
    False(PlayerCapabilities.Supports(potPlayer, PlayerCapabilities.ControlSeek));
    True(PlayerCapabilities.Supports(potPlayer, PlayerCapabilities.ControlStop));
    True(potPlayer.Diagnostics.Any(diagnostic => diagnostic.Code == "potplayer.status_unsupported"));
    return Task.CompletedTask;
}

static async Task TestSessionControlsAndEndReasons()
{
    await PlayerSessionManager.ResetForTestsAsync();
    try
    {
        var config = new AppConfig { AllowedMediaRoots = [@"\\nas\media"] };
        var firstAdapter = new FakePlayerAdapter(
            "fake-first",
            [
                PlayerCapabilities.PlayFile,
                PlayerCapabilities.ControlPause,
                PlayerCapabilities.ControlSeek,
                PlayerCapabilities.ControlStop,
            ]);
        var first = await PlayerSessionManager.CreateWithAdapterAsync(
            Guid.NewGuid().ToString(),
            @"\\nas\media\first.mkv",
            config,
            firstAdapter);
        await PlayerSessionManager.PauseAsync(first.SessionId);
        True(firstAdapter.Paused);
        await PlayerSessionManager.ResumeAsync(first.SessionId);
        False(firstAdapter.Paused);
        await PlayerSessionManager.SeekAsync(first.SessionId, 9_500);
        Equal(9_500L, firstAdapter.SeekPositionMs);

        var secondAdapter = new FakePlayerAdapter(
            "fake-second",
            [PlayerCapabilities.PlayFile, PlayerCapabilities.ControlStop]);
        var second = await PlayerSessionManager.CreateWithAdapterAsync(
            Guid.NewGuid().ToString(),
            @"\\nas\media\second.mkv",
            config,
            secondAdapter);
        True(firstAdapter.Stopped);
        Equal(SessionEndReasons.Replaced, first.EndReason);
        Equal(first, PlayerSessionManager.Find(first.SessionId));

        await AssertThrowsAsync<PlayerSessionControlException>(
            () => PlayerSessionManager.PauseAsync(second.SessionId));
        await PlayerSessionManager.StopAsync(second.SessionId);
        True(secondAdapter.Stopped);
        Equal(SessionEndReasons.StoppedByRequest, second.EndReason);
        Equal(second, PlayerSessionManager.Find(second.SessionId));
    }
    finally
    {
        await PlayerSessionManager.ResetForTestsAsync();
    }
}

static async Task TestControlEndpoints()
{
    await PlayerSessionManager.ResetForTestsAsync();
    var port = ReserveLoopbackPort();
    var secret = new string('a', 48);
    var config = new AppConfig
    {
        Port = port,
        SharedSecret = secret,
        AllowedMediaRoots = [@"\\nas\media"],
    };
    var adapter = new FakePlayerAdapter(
        "fake-http",
        [
            PlayerCapabilities.PlayFile,
            PlayerCapabilities.StatusState,
            PlayerCapabilities.StatusPosition,
            PlayerCapabilities.StatusDuration,
            PlayerCapabilities.ControlPause,
            PlayerCapabilities.ControlSeek,
            PlayerCapabilities.ControlStop,
        ]);
    var session = await PlayerSessionManager.CreateWithAdapterAsync(
        Guid.NewGuid().ToString(),
        @"\\nas\media\http.mkv",
        config,
        adapter);
    var app = await PlayServer.StartAsync(config);
    try
    {
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}/") };
        var controlPath = $"v2/sessions/{session.SessionId}/control";
        var unauthorized = await client.PostAsJsonAsync(controlPath, new { action = "pause" });
        Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        var legacyPlaying = await client.GetFromJsonAsync<JsonElement>("status");
        Equal(2, legacyPlaying.GetProperty("state").GetInt32());
        Equal(1L, legacyPlaying.GetProperty("duration").GetInt64());

        var info = await client.GetFromJsonAsync<JsonElement>("v2/info");
        var agentCapabilities = info.GetProperty("capabilities")
            .EnumerateArray()
            .Select(capability => capability.GetString())
            .ToArray();
        True(agentCapabilities.Contains("sessions.control"));
        False(agentCapabilities.Contains("sessions.pause"));

        var pause = await client.PostAsJsonAsync(controlPath, new { action = "pause" });
        Equal(HttpStatusCode.OK, pause.StatusCode);
        True(adapter.Paused);
        var repeatedPause = await client.PostAsJsonAsync(controlPath, new { action = "pause" });
        Equal(HttpStatusCode.OK, repeatedPause.StatusCode);
        True(adapter.Paused);

        var resume = await client.PostAsJsonAsync(controlPath, new { action = "resume" });
        Equal(HttpStatusCode.OK, resume.StatusCode);
        False(adapter.Paused);
        var repeatedResume = await client.PostAsJsonAsync(controlPath, new { action = "resume" });
        Equal(HttpStatusCode.OK, repeatedResume.StatusCode);
        False(adapter.Paused);

        var seek = await client.PostAsJsonAsync(controlPath, new { action = "seek", positionMs = 44_500L });
        Equal(HttpStatusCode.OK, seek.StatusCode);
        Equal(44_500L, adapter.SeekPositionMs);
        var invalidSeek = await client.PostAsJsonAsync(
            controlPath,
            new { action = "seek", positionMs = SessionControlLimits.MaxSeekPositionMs + 1 });
        Equal(HttpStatusCode.BadRequest, invalidSeek.StatusCode);

        var stop = await client.PostAsJsonAsync(controlPath, new { action = "stop" });
        Equal(HttpStatusCode.OK, stop.StatusCode);
        var terminal = await client.GetFromJsonAsync<JsonElement>($"v2/sessions/{session.SessionId}");
        Equal("stopped", terminal.GetProperty("state").GetString());
        Equal(SessionEndReasons.StoppedByRequest, terminal.GetProperty("endReason").GetString());
        var legacyStopped = await client.GetFromJsonAsync<JsonElement>("status");
        Equal(0, legacyStopped.GetProperty("state").GetInt32());

        var unsupportedAdapter = new FakePlayerAdapter(
            "fake-launch-only",
            [PlayerCapabilities.PlayFile, PlayerCapabilities.ControlStop]);
        var unsupportedSession = await PlayerSessionManager.CreateWithAdapterAsync(
            Guid.NewGuid().ToString(),
            @"\\nas\media\unsupported.mkv",
            config,
            unsupportedAdapter);
        var unsupportedLegacyStatus = await client.GetAsync("status");
        Equal(HttpStatusCode.BadGateway, unsupportedLegacyStatus.StatusCode);
        var rejected = await client.PostAsJsonAsync(
            $"v2/sessions/{unsupportedSession.SessionId}/control",
            new { action = "pause" });
        Equal(HttpStatusCode.Conflict, rejected.StatusCode);
        var rejection = await rejected.Content.ReadFromJsonAsync<JsonElement>();
        Equal("capability_not_supported", rejection.GetProperty("code").GetString());
    }
    finally
    {
        await app.StopAsync();
        await app.DisposeAsync();
        await PlayerSessionManager.ResetForTestsAsync();
    }
}

static Task TestCustomValidation()
{
    var directory = Path.Combine(Path.GetTempPath(), $"media-launcher-custom-test-{Guid.NewGuid():N}");
    Directory.CreateDirectory(directory);
    try
    {
        var executable = Path.Combine(directory, "player.exe");
        File.WriteAllText(executable, "test fixture");
        var valid = new CustomPlayerProfile
        {
            Id = $"custom-{Guid.NewGuid():N}",
            Name = "Fixture player",
            ExecutablePath = executable,
            WorkingDirectory = directory,
            Arguments = ["--open", "{media_path}"],
        };
        True(CustomPlayerProfileValidator.Validate(valid, requireExistingPaths: true).IsValid);
        var config = new AppConfig { CustomPlayers = [valid] };
        var customDescriptor = PlayerCatalog.GetDescriptors(config).Single(
            descriptor => descriptor.Id == valid.Id);
        False(PlayerCapabilities.Supports(customDescriptor, PlayerCapabilities.ControlStop));
        var customAdapter = PlayerCatalog.GetAdapter(valid.Id, config);
        False(PlayerCapabilities.Supports(customAdapter.Descriptor, PlayerCapabilities.ControlStop));

        var unsafeNetworkExecutable = new CustomPlayerProfile
        {
            Id = $"custom-{Guid.NewGuid():N}",
            Name = "Network player",
            ExecutablePath = @"\\server\share\player.exe",
        };
        var networkResult = CustomPlayerProfileValidator.Validate(
            unsafeNetworkExecutable,
            requireExistingPaths: false);
        False(networkResult.IsValid);
        True(networkResult.Diagnostics.Any(diagnostic => diagnostic.Code == "custom.executable_not_local"));

        valid.WorkingDirectory = Path.Combine(directory, "missing");
        var missingDirectory = CustomPlayerProfileValidator.Validate(valid, requireExistingPaths: true);
        False(missingDirectory.IsValid);
        True(missingDirectory.Diagnostics.Any(
            diagnostic => diagnostic.Code == "custom.working_directory_missing"));
    }
    finally
    {
        Directory.Delete(directory, recursive: true);
    }
    return Task.CompletedTask;
}

static void True(bool condition)
{
    if (!condition) throw new InvalidOperationException("Expected condition to be true.");
}

static void False(bool condition) => True(!condition);

static void Equal<T>(T expected, T actual)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
        throw new InvalidOperationException($"Expected '{expected}', got '{actual}'.");
}

static void AssertThrows<TException>(Action action) where TException : Exception
{
    try
    {
        action();
    }
    catch (TException)
    {
        return;
    }
    throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
}

static int ReserveLoopbackPort()
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    try
    {
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
    finally
    {
        listener.Stop();
    }
}

static async Task AssertThrowsAsync<TException>(Func<Task> action) where TException : Exception
{
    try
    {
        await action();
    }
    catch (TException)
    {
        return;
    }
    throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
}

internal sealed record CapturedRequest(string Host, string Query, string Authorization);

internal sealed class RecordingHandler(List<CapturedRequest> requests, string responseJson) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var uri = request.RequestUri ?? throw new InvalidOperationException("Request URI was missing.");
        requests.Add(new CapturedRequest(
            uri.Host,
            uri.Query,
            request.Headers.Authorization?.ToString() ?? ""));
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(responseJson, Encoding.UTF8, "application/json"),
        });
    }
}

internal sealed class StatefulVlcHandler(List<CapturedRequest> requests) : HttpMessageHandler
{
    private string _state = "playing";

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        var uri = request.RequestUri ?? throw new InvalidOperationException("Request URI was missing.");
        requests.Add(new CapturedRequest(
            uri.Host,
            uri.Query,
            request.Headers.Authorization?.ToString() ?? ""));
        if (uri.Query.Contains("command=pl_pause", StringComparison.Ordinal))
            _state = _state == "playing" ? "paused" : "playing";
        var json = $"{{\"state\":\"{_state}\",\"time\":1,\"length\":2}}";
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        });
    }
}

internal sealed class FakePlayerAdapter(string id, string[] capabilities) : IPlayerAdapter
{
    public PlayerDescriptor Descriptor { get; } = new(id, "fake", id, "test", true, capabilities);
    public event EventHandler? PlaybackExited;
    public bool Paused { get; private set; }
    public bool Stopped { get; private set; }
    public long SeekPositionMs { get; private set; } = -1;

    public Task LaunchAsync(PlayerLaunchRequest request, IReadOnlyCollection<string> allowedMediaRoots) =>
        Task.CompletedTask;

    public Task StopAsync()
    {
        Stopped = true;
        return Task.CompletedTask;
    }

    public Task<PlayerStatus> GetStatusAsync() =>
        Task.FromResult(new PlayerStatus(null, "playing", 0, 1));

    public Task SetPausedAsync(bool paused)
    {
        Paused = paused;
        return Task.CompletedTask;
    }

    public Task SeekAsync(long positionMs)
    {
        SeekPositionMs = positionMs;
        return Task.CompletedTask;
    }

    public void Exit() => PlaybackExited?.Invoke(this, EventArgs.Empty);
}
