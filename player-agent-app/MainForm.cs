using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MediaLauncherPlayerAgent;

public class MainForm : Form
{
    // Lets MpcLauncher (running on a background HTTP request thread, not the UI thread) tell this
    // window to get out of the way before launching MPC-HC and come back afterwards.
    public static MainForm? Instance { get; private set; }

    private readonly WebView2 _webView = new() { Dock = DockStyle.Fill };
    private readonly NotifyIcon _trayIcon;
    private AppConfig _config;

    public MainForm(AppConfig config)
    {
        Instance = this;
        _config = config;

        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Maximized;
        Text = "Media Launcher";
        BackColor = Color.Black;

        // Pulled from the exe's own embedded icon (set via <ApplicationIcon> in the csproj) rather
        // than shipping a separate .ico file to keep track of at runtime.
        var appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        Icon = appIcon;

        Controls.Add(_webView);

        _trayIcon = new NotifyIcon
        {
            Icon = appIcon,
            Visible = true,
            Text = "Media Launcher Player Agent",
        };
        _trayIcon.DoubleClick += (_, _) => { Show(); WindowState = FormWindowState.Maximized; };

        var trayMenu = new ContextMenuStrip();
        trayMenu.Items.Add("Reload", null, async (_, _) => await ReloadFreshAsync());
        trayMenu.Items.Add("Settings", null, (_, _) => OpenSettings());
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add("Exit", null, (_, _) => { _trayIcon.Visible = false; Application.Exit(); });
        _trayIcon.ContextMenuStrip = trayMenu;

        Load += async (_, _) => await InitializeWebViewAsync();

        // Alt+F4 / the taskbar close button minimize to tray instead of exiting - this window is
        // also the process hosting the /play HTTP server the Home Assistant add-on depends on, so
        // an accidental close shouldn't take that down. Only the tray menu's Exit really quits.
        FormClosing += (_, e) =>
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
        };
    }

    private async Task InitializeWebViewAsync()
    {
        await _webView.EnsureCoreWebView2Async();
        _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _webView.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;

        // Deliberately NOT clearing the disk cache here (see ReloadFreshAsync for why it exists at
        // all) - doing it on every single startup forced a full uncached re-fetch of every JS/CSS
        // asset on every login, which is exactly what made this feel slow to start. A stale cache
        // is now a "hit Reload once after updating the addon" problem instead of a "every boot"
        // cost.
        _webView.Source = new Uri(_config.HomeAssistantUrl);
    }

    private async Task ReloadFreshAsync()
    {
        if (_webView.CoreWebView2 == null) return;
        try
        {
            await _webView.CoreWebView2.Profile.ClearBrowsingDataAsync(CoreWebView2BrowsingDataKinds.DiskCache);
        }
        catch
        {
            // Best-effort - still reload even if clearing cache isn't supported.
        }
        _webView.CoreWebView2.Reload();
    }

    // Minimizing our own window needs no special permission, unlike making MPC-HC's window steal
    // foreground focus from a background-launched process (Windows' foreground-lock routinely
    // blocks that). Called from MpcLauncher, which runs on a Kestrel request thread - marshal back
    // to the UI thread via BeginInvoke rather than touching WinForms controls directly.
    public void MinimizeForPlayback()
    {
        if (InvokeRequired)
        {
            BeginInvoke(MinimizeForPlayback);
            return;
        }
        WindowState = FormWindowState.Minimized;
    }

    public void RestoreFromPlayback()
    {
        if (InvokeRequired)
        {
            BeginInvoke(RestoreFromPlayback);
            return;
        }
        Show();
        WindowState = FormWindowState.Maximized;
        Activate();
    }

    private void OpenSettings()
    {
        using var form = new SettingsForm(_config);
        if (form.ShowDialog() != DialogResult.OK) return;

        var portChanged = form.Config.Port != _config.Port;
        form.Config.Save();
        _config = form.Config;
        if (_webView.CoreWebView2 != null)
        {
            _webView.Source = new Uri(_config.HomeAssistantUrl);
        }

        if (portChanged)
        {
            MessageBox.Show(
                "The player agent port only takes effect after a restart. Restart the app from the tray icon to apply it.",
                "Restart required",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (Instance == this) Instance = null;
            _trayIcon.Dispose();
            _webView.Dispose();
        }
        base.Dispose(disposing);
    }
}
