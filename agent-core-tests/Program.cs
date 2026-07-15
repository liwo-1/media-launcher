using System.Text.Json;
using MediaLauncher.Agent.Core;

var tests = new (string Name, Func<Task> Run)[]
{
    ("bearer authentication is exact and fixed-format", () =>
    {
        Equal(true, BearerAuthentication.IsAuthorized("Bearer secret", "secret"));
        Equal(true, BearerAuthentication.IsAuthorized("bearer secret", "secret"));
        Equal(false, BearerAuthentication.IsAuthorized("Bearer different", "secret"));
        Equal(false, BearerAuthentication.IsAuthorized("Basic secret", "secret"));
        Equal(true, BearerAuthentication.IsPairingSecret(new string('a', 48)));
        Equal(false, BearerAuthentication.IsPairingSecret(new string('g', 48)));
        return Task.CompletedTask;
    }),
    ("request idempotency cache is bounded and expires", () =>
    {
        var now = DateTimeOffset.UtcNow;
        var cache = new BoundedRequestCache<string>(2, TimeSpan.FromMinutes(1));
        cache.Set("first", "one", now);
        cache.Set("second", "two", now.AddSeconds(1));
        cache.Set("third", "three", now.AddSeconds(2));
        Equal(false, cache.TryGet("first", now.AddSeconds(2), out _));
        Equal(true, cache.TryGet("third", now.AddSeconds(2), out var third));
        Equal("three", third);
        Equal(false, cache.TryGet("third", now.AddMinutes(2), out _));
        return Task.CompletedTask;
    }),
    ("protocol JSON keeps additive v2 request fields", () =>
    {
        var request = JsonSerializer.Deserialize<CreateSessionRequest>("""
          {"requestId":"00000000-0000-0000-0000-000000000001","playerId":"mpv","media":{"sourceType":"file","path":"/mnt/media/Movie.mkv","title":"Movie"},"options":{"fullscreen":true,"startPositionMs":1200}}
          """)!;
        Equal("mpv", request.PlayerId);
        Equal("/mnt/media/Movie.mkv", request.Media?.Path);
        Equal(1200L, request.Options?.StartPositionMs);
        var control = JsonSerializer.Deserialize<SessionControlRequest>(
            "{\"action\":\"seek\",\"positionMs\":42000}")!;
        Equal("seek", control.Action);
        Equal(42000L, control.PositionMs);
        return Task.CompletedTask;
    }),
    ("legacy status JSON keeps the protocol-v1 numeric shape", () =>
    {
        var response = LegacyPlayerStatusResponse.From(
            new PlayerStatus("/mnt/media/Movie.mkv", "paused", 12_345, 98_765));
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(response));
        var root = document.RootElement;
        Equal(4, root.EnumerateObject().Count());
        Equal("/mnt/media/Movie.mkv", root.GetProperty("file").GetString());
        Equal(1, root.GetProperty("state").GetInt32());
        Equal(12_345L, root.GetProperty("position").GetInt64());
        Equal(98_765L, root.GetProperty("duration").GetInt64());
        Equal(false, root.TryGetProperty("positionMs", out _));
        Equal(false, root.TryGetProperty("durationMs", out _));
        Equal(2, LegacyPlayerStatusResponse.From(
            new PlayerStatus(null, "playing", 0, 0)).State);
        Equal(0, LegacyPlayerStatusResponse.Stopped().State);
        return Task.CompletedTask;
    }),
    ("capability vocabulary includes gated transport controls", () =>
    {
        Contains(AgentCapabilities.SessionsControl, AgentCapabilities.ProtocolV2);
        Equal(false, AgentCapabilities.ProtocolV2.Contains(AgentCapabilities.ControlPause));
        Equal(new[] { 1, 2 }, AgentProtocol.SupportedVersions);
        return Task.CompletedTask;
    }),
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
        Console.Error.WriteLine($"FAIL {test.Name}: {error.Message}");
    }
}
Console.WriteLine($"{tests.Length - failed}/{tests.Length} agent-core tests passed.");
return failed == 0 ? 0 : 1;

static void Equal<T>(T expected, T actual)
{
    if (expected is Array expectedArray && actual is Array actualArray)
    {
        if (!expectedArray.Cast<object?>().SequenceEqual(actualArray.Cast<object?>()))
            throw new Exception($"Expected [{string.Join(',', expectedArray.Cast<object?>())}] but got [{string.Join(',', actualArray.Cast<object?>())}].");
        return;
    }
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
        throw new Exception($"Expected {expected} but got {actual}.");
}

static void Contains<T>(T expected, IEnumerable<T> values)
{
    if (!values.Contains(expected)) throw new Exception($"Expected collection to contain {expected}.");
}
