using Microsoft.AspNetCore.Builder;

namespace MediaLauncherPlayerAgent;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.ThreadException += (_, e) => Logger.Log($"UI thread exception: {e.Exception}");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Logger.Log($"Unhandled exception: {e.ExceptionObject}");

        Logger.Log("--- starting ---");
        ApplicationConfiguration.Initialize();

        AppConfig config;
        try
        {
            config = AppConfig.Load();
        }
        catch (InvalidDataException ex)
        {
            MessageBox.Show(
                $"{ex.Message}\n\nThe Settings dialog will open so you can create a new configuration.",
                "Media Launcher configuration error",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            config = new AppConfig();
        }

        if (!config.IsComplete)
        {
            Logger.Log("No saved config found - showing first-run setup.");
            using var settingsForm = new SettingsForm(config);
            if (settingsForm.ShowDialog() != DialogResult.OK)
            {
                Logger.Log("First-run setup cancelled - exiting.");
                return; // user cancelled first-run setup - nothing to run yet
            }
            config = settingsForm.Config;
            config.Save();
        }

        Logger.Log($"Config: HomeAssistantUrl={config.HomeAssistantUrl}, Port={config.Port}, MpcPathOverride={config.MpcPathOverride ?? "(none)"}");

        WebApplication app;
        try
        {
            app = PlayServer.StartAsync(config).GetAwaiter().GetResult();
            Logger.Log($"HTTP server listening on port {config.Port}");
        }
        catch (Exception ex)
        {
            Logger.Log($"Failed to start HTTP server on port {config.Port}: {ex}");
            MessageBox.Show(
                $"Could not start the player agent's HTTP server on port {config.Port}:\n\n{ex.Message}",
                "Media Launcher Player Agent",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        using var shutdown = new CancellationTokenSource();
        PairingClient.Start(config, shutdown.Token);

        using (var mainForm = new MainForm(config, shutdown.Token))
        {
            Application.Run(mainForm);
        }

        shutdown.Cancel();
        app.StopAsync().GetAwaiter().GetResult();
        Logger.Log("--- exited ---");
    }
}
