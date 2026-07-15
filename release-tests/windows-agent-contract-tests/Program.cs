using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using MediaLauncher.Agent.Core;
using MediaLauncherPlayerAgent;
using Microsoft.AspNetCore.Http;

internal static class Program
{
    private static int _assertions;

    private static async Task<int> Main()
    {
        try
        {
            TestConfigurationAndPathValidation();
            TestBearerAuthentication();
            TestProtocolFixturesDeserializeIntoAgentContracts();
            await TestAgentProtocolEndpointsAsync();
            Console.WriteLine($"Windows agent contract tests passed ({_assertions} assertions).");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }

    private static void TestConfigurationAndPathValidation()
    {
        Check(AppConfig.IsHttpUrl("http://home-assistant.test:8123"), "HTTP add-on URLs are valid");
        Check(AppConfig.IsHttpUrl("https://home-assistant.test"), "HTTPS add-on URLs are valid");
        Check(!AppConfig.IsHttpUrl("file:///tmp/config"), "file URLs are rejected");
        Check(!AppConfig.IsHttpUrl("http://user:password@home-assistant.test"),
            "credential-bearing add-on URLs are rejected");

        var config = new AppConfig
        {
            HomeAssistantUrl = " http://home-assistant.test:8123/ ",
            Port = -1,
            SharedSecret = "NOT-A-SECRET",
            AllowedMediaRoots = [@"\\fixture-nas\Media", @"\\fixture-nas\Media"],
        }.Normalize();
        Equal("http://home-assistant.test:8123/", config.HomeAssistantUrl, "URL normalization");
        Equal(7777, config.Port, "invalid ports return to the default");
        Equal("", config.SharedSecret, "invalid secrets fail closed");
        Equal(1, config.AllowedMediaRoots.Length, "allowed roots are de-duplicated");

        MediaPathValidator.ValidateWindowsPath(
            @"\\fixture-nas\Media\Movies\Example Film.mkv",
            [@"\\fixture-nas\Media"]);
        Throws<UnauthorizedAccessException>(() => MediaPathValidator.ValidateWindowsPath(
            @"\\fixture-nas\Media-Other\Example Film.mkv",
            [@"\\fixture-nas\Media"]), "neighboring roots do not pass the boundary check");
        Throws<ArgumentException>(() => MediaPathValidator.ValidateWindowsPath(
            "https://fixture.invalid/video.mkv",
            [@"\\fixture-nas\Media"]), "URL media paths are rejected");
        Throws<ArgumentException>(() => MediaPathValidator.ValidateWindowsPath(
            @"\\fixture-nas\Media\payload.cmd",
            [@"\\fixture-nas\Media"]), "non-media extensions are rejected");
    }

    private static void TestBearerAuthentication()
    {
        const string secret = "000000000000000000000000000000000000000000000002";
        var accepted = new DefaultHttpContext();
        accepted.Request.Headers.Authorization = $"Bearer {secret}";
        Check(PlayServer.IsAuthorized(accepted.Request, secret), "the exact bearer key is accepted");

        var rejected = new DefaultHttpContext();
        rejected.Request.Headers.Authorization = "Bearer 000000000000000000000000000000000000000000000003";
        Check(!PlayServer.IsAuthorized(rejected.Request, secret), "a different bearer key is rejected");
        Check(!PlayServer.IsAuthorized(new DefaultHttpContext().Request, secret), "a missing key is rejected");
    }

    private static void TestProtocolFixturesDeserializeIntoAgentContracts()
    {
        var create = ReadFixture<CreateSessionRequest>("session-create-v2.json");
        Equal("33333333-3333-4333-8333-333333333333", create.RequestId, "v2 request ID field");
        Equal("mpc-hc", create.PlayerId, "v2 player ID field");
        Equal("file", create.Media?.SourceType, "v2 source type field");
        Equal(@"\\fixture-nas\Media\Example Film.mkv", create.Media?.Path, "v2 media path field");
        Equal(12500L, create.Options?.StartPositionMs, "v2 resume position uses milliseconds");
        Check(create.Options?.Fullscreen == true, "v2 fullscreen option");

        var control = ReadFixture<SessionControlRequest>("session-control-v2.json");
        Equal("seek", control.Action, "v2 control action field");
        Equal(42000L, control.PositionMs, "v2 control position uses milliseconds");

        using var registrationV1 = ReadFixture("registration-v1.json");
        Equal(1, registrationV1.RootElement.GetProperty("protocolVersion").GetInt32(),
            "released registration baseline remains v1");
        Check(!registrationV1.RootElement.TryGetProperty("supportedProtocolVersions", out _),
            "released v1 agents need no additive fields");

        using var registrationV2 = ReadFixture("registration-v2-capable.json");
        Equal(
            "1,2",
            string.Join(',', registrationV2.RootElement.GetProperty("supportedProtocolVersions")
                .EnumerateArray().Select(value => value.GetInt32())),
            "current agents advertise v1 and v2 additively");

        using var response = ReadFixture("registration-response-v2.json");
        Equal(48, response.RootElement.GetProperty("secret").GetString()?.Length ?? 0,
            "pairing keys stay 48 hexadecimal characters");
        Equal(2, response.RootElement.GetProperty("selectedProtocolVersion").GetInt32(),
            "the v2 fixture selects v2");
    }

    private static async Task TestAgentProtocolEndpointsAsync()
    {
        const string secret = "000000000000000000000000000000000000000000000002";
        var port = ReservePort();
        var config = new AppConfig
        {
            HomeAssistantUrl = "http://home-assistant.test:8123",
            Port = port,
            InstanceId = "22222222222222222222222222222222",
            SharedSecret = secret,
            AllowedMediaRoots = [@"\\fixture-nas\Media"],
        }.Normalize();
        var app = await PlayServer.StartAsync(config);
        try
        {
            using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{port}") };
            using var healthResponse = await client.GetAsync("/health");
            var healthBody = await healthResponse.Content.ReadAsStringAsync();
            Equal(HttpStatusCode.OK, healthResponse.StatusCode,
                $"health remains unauthenticated; body <{healthBody}>");
            using var health = JsonDocument.Parse(healthBody);
            Equal(1, health.RootElement.GetProperty("protocolVersion").GetInt32(),
                "health keeps the v1 baseline");
            Equal(
                "1,2",
                string.Join(',', health.RootElement.GetProperty("supportedProtocolVersions")
                    .EnumerateArray().Select(value => value.GetInt32())),
                "health advertises both protocol versions");

            using var unauthorized = await client.GetAsync("/v2/info");
            Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode,
                "v2 discovery rejects missing authentication");

            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", secret);
            using var infoResponse = await client.GetAsync("/v2/info");
            Equal(HttpStatusCode.OK, infoResponse.StatusCode, "v2 discovery accepts the paired key");
            using var info = JsonDocument.Parse(await infoResponse.Content.ReadAsStringAsync());
            Equal(
                "players.list,sessions.create,sessions.status,sessions.control,sessions.end-reasons",
                string.Join(',', info.RootElement.GetProperty("capabilities")
                    .EnumerateArray().Select(value => value.GetString())),
                "v2 capability names remain wire-compatible");
            Equal("windows-unc", info.RootElement.GetProperty("acceptedPathKinds")[0].GetString(),
                "Windows path kind remains explicit");
            Equal(1, info.RootElement.GetProperty("maxConcurrentSessions").GetInt32(),
                "Windows agent remains single-session");

            using var controlContent = new StringContent(
                File.ReadAllText(FixturePath("session-control-v2.json")),
                Encoding.UTF8,
                "application/json");
            using var missingSession = await client.PostAsync(
                "/v2/sessions/fixture-missing/control",
                controlContent);
            Equal(HttpStatusCode.NotFound, missingSession.StatusCode,
                "the canonical v2 session-control route is present");
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

    private static T ReadFixture<T>(string name) where T : class =>
        JsonSerializer.Deserialize<T>(File.ReadAllText(FixturePath(name))) ??
        throw new InvalidDataException($"Fixture {name} did not deserialize.");

    private static JsonDocument ReadFixture(string name) =>
        JsonDocument.Parse(File.ReadAllText(FixturePath(name)));

    private static string FixturePath(string name) =>
        Path.Combine(AppContext.BaseDirectory, "fixtures", name);

    private static int ReservePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static void Check(bool condition, string message)
    {
        _assertions++;
        if (!condition) throw new InvalidOperationException($"Assertion failed: {message}");
    }

    private static void Equal<T>(T expected, T actual, string message) =>
        Check(EqualityComparer<T>.Default.Equals(expected, actual),
            $"{message}; expected <{expected}>, received <{actual}>");

    private static void Throws<T>(Action action, string message) where T : Exception
    {
        _assertions++;
        try
        {
            action();
        }
        catch (T)
        {
            return;
        }
        throw new InvalidOperationException($"Assertion failed: {message}; expected {typeof(T).Name}");
    }
}
