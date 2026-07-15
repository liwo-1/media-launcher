using System.Text.Json;
using Microsoft.AspNetCore.Builder;

namespace MediaLauncher.LinuxAgent;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        try
        {
            var configPath = Option(args, "--config") ?? AgentPaths.DefaultConfigPath;
            if (args.Contains("--version", StringComparer.Ordinal))
            {
                Console.WriteLine(AgentIdentity.Version);
                return 0;
            }
            var commands = new HashSet<string>(StringComparer.Ordinal)
            {
                "configure", "diagnose", "reset-pairing", "run",
            };
            var command = args.FirstOrDefault(commands.Contains) ?? "run";
            return command switch
            {
                "configure" => await ConfigureAsync(args, configPath),
                "diagnose" => Diagnose(configPath),
                "reset-pairing" => await ResetPairingAsync(args, configPath),
                "run" => await RunAsync(configPath),
                _ => Usage($"Unknown command '{command}'."),
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    private static async Task<int> ConfigureAsync(string[] args, string configPath)
    {
        var config = LinuxAgentConfig.Load(configPath);
        var url = Option(args, "--home-assistant-url");
        var roots = Options(args, "--allowed-root");
        if (!string.IsNullOrWhiteSpace(url)) config.HomeAssistantUrl = url;
        if (roots.Count > 0) config.AllowedMediaRoots = roots.ToList();
        if (int.TryParse(Option(args, "--port"), out var port)) config.Port = port;
        var name = Option(args, "--name");
        if (!string.IsNullOrWhiteSpace(name)) config.DisplayName = name;
        var defaultPlayer = Option(args, "--default-player");
        if (defaultPlayer is not null) config.DefaultPlayerId = defaultPlayer;
        config.Validate();
        await config.SaveAsync(configPath);
        Console.WriteLine($"Saved private Linux agent configuration to {configPath}");
        Console.WriteLine("Start the user service; pairing with the configured Home Assistant app is automatic.");
        return 0;
    }

    private static int Diagnose(string configPath)
    {
        var config = LinuxAgentConfig.Load(configPath);
        var players = LinuxPlayerCatalog.GetDescriptors(config);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            version = AgentIdentity.Version,
            architecture = AgentIdentity.Architecture,
            configPath,
            configured = config.IsComplete,
            paired = !string.IsNullOrEmpty(config.SharedSecret),
            port = config.Port,
            displayName = config.DisplayName,
            allowedRootCount = config.AllowedMediaRoots.Count,
            defaultPlayerId = config.DefaultPlayerId,
            players,
        }, new JsonSerializerOptions { WriteIndented = true }));
        return config.IsComplete && players.Any(player => player.Available) ? 0 : 2;
    }

    private static async Task<int> ResetPairingAsync(string[] args, string configPath)
    {
        if (!args.Contains("--yes", StringComparer.Ordinal))
            return Usage("reset-pairing rotates the local identity. Repeat with --yes after removing the device in Home Assistant.");
        var config = LinuxAgentConfig.Load(configPath);
        config.ResetPairingIdentity();
        await config.SaveAsync(configPath);
        Console.WriteLine("Pairing identity reset. Restart the user service to enroll as a new device.");
        return 0;
    }

    private static async Task<int> RunAsync(string configPath)
    {
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException("The Linux player agent can run only on Linux.");
        var config = LinuxAgentConfig.Load(configPath);
        if (!config.IsComplete)
        {
            return Usage(
                $"Configuration is incomplete. Run: media-launcher-linux-agent configure --home-assistant-url http://HA-HOST:8089 --allowed-root /mnt/media --config {configPath}");
        }
        config.Validate();
        if (string.IsNullOrEmpty(config.SharedSecret) && string.IsNullOrEmpty(config.RegistrationSecret))
        {
            config.EnsureRegistrationCredential();
            await config.SaveAsync(configPath);
        }
        AgentPaths.EnsurePrivateDirectory(AgentPaths.RuntimeDirectory);
        AgentLogger.Log($"Starting Linux player agent {AgentIdentity.Version} on port {config.Port}.");

        using var shutdown = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            shutdown.Cancel();
        };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => shutdown.Cancel();

        WebApplication? server = null;
        try
        {
            server = await LinuxPlayServer.StartAsync(config, configPath, shutdown.Token);
            var pairing = LinuxPairingClient.RunAsync(config, configPath, shutdown.Token);
            try { await server.WaitForShutdownAsync(shutdown.Token); }
            catch (OperationCanceledException) { /* expected */ }
            shutdown.Cancel();
            try { await pairing; } catch (OperationCanceledException) { /* expected */ }
            await server.StopAsync();
            return 0;
        }
        finally
        {
            if (server is not null) await server.DisposeAsync();
            AgentLogger.Log("Linux player agent stopped.");
        }
    }

    private static string? Option(IReadOnlyList<string> args, string name)
    {
        for (var index = 0; index < args.Count - 1; index++)
        {
            if (string.Equals(args[index], name, StringComparison.Ordinal)) return args[index + 1];
        }
        return null;
    }

    private static IReadOnlyList<string> Options(IReadOnlyList<string> args, string name)
    {
        var values = new List<string>();
        for (var index = 0; index < args.Count - 1; index++)
        {
            if (string.Equals(args[index], name, StringComparison.Ordinal)) values.Add(args[index + 1]);
        }
        return values;
    }

    private static int Usage(string message)
    {
        Console.Error.WriteLine(message);
        Console.Error.WriteLine("Commands: run (default), configure, diagnose, reset-pairing --yes, --version");
        return 2;
    }
}
