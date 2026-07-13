using System.Diagnostics;

namespace MediaLauncherPlayerAgent;

public class SettingsForm : Form
{
    // clsid2's fork is the actively maintained continuation of MPC-HC - the original
    // sourceforge/codeplex project is dead.
    private const string McpDownloadUrl = "https://github.com/clsid2/mpc-hc/releases/latest";

    public AppConfig Config { get; private set; }

    private readonly TextBox _urlBox = new() { Dock = DockStyle.Fill };
    private readonly NumericUpDown _portBox = new() { Minimum = 1, Maximum = 65535, Width = 90 };
    private readonly Label _pairingStatusLabel = new() { AutoSize = true };
    private readonly Button _resetPairingButton = new() { Text = "Reset pairing", AutoSize = true };
    private readonly TextBox _allowedRootsBox = new()
    {
        Dock = DockStyle.Fill,
        Multiline = true,
        Height = 64,
        ScrollBars = ScrollBars.Vertical,
        PlaceholderText = @"\\nas-host\share\Movies (one UNC root per line)",
    };
    private readonly TextBox _mpcPathBox = new() { Dock = DockStyle.Fill };
    private readonly Button _browseButton = new() { Text = "Browse...", AutoSize = true };
    private readonly Label _mpcStatusLabel = new() { AutoSize = true, MaximumSize = new Size(380, 0) };
    private readonly LinkLabel _mpcInstallLink = new() { AutoSize = true, Text = "Download MPC-HC", Visible = false };
    private readonly CheckBox _startWithWindowsBox = new() { Text = "Start with Windows", AutoSize = true };
    private bool _resetPairingRequested;

    private readonly TextBox _logBox = new()
    {
        Multiline = true,
        ReadOnly = true,
        Dock = DockStyle.Fill,
        ScrollBars = ScrollBars.Vertical,
        Font = new Font(FontFamily.GenericMonospace, 9),
        WordWrap = false,
    };

    public SettingsForm(AppConfig config)
    {
        Config = config;
        Text = "Media Launcher - Player Agent Settings";
        Width = 720;
        Height = 640;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        MinimizeBox = false;

        _urlBox.Text = config.HomeAssistantUrl;
        _portBox.Value = config.Port;
        _allowedRootsBox.Lines = config.AllowedMediaRoots;
        _mpcPathBox.Text = config.MpcPathOverride ?? "";
        _startWithWindowsBox.Checked = config.StartWithWindows;
        _pairingStatusLabel.Text = string.IsNullOrEmpty(config.SharedSecret)
            ? "Waiting for Home Assistant to pair automatically"
            : "✓ Paired";
        _pairingStatusLabel.ForeColor = string.IsNullOrEmpty(config.SharedSecret) ? Color.DarkOrange : Color.SeaGreen;
        _resetPairingButton.Enabled = !string.IsNullOrEmpty(config.SharedSecret);

        var tabs = new TabControl { Dock = DockStyle.Fill };
        var settingsTab = new TabPage("Settings");
        var logTab = new TabPage("Log");
        tabs.TabPages.Add(settingsTab);
        tabs.TabPages.Add(logTab);

        BuildSettingsTab(settingsTab);
        BuildLogTab(logTab);

        var errorLabel = new Label
        {
            ForeColor = Color.Firebrick,
            AutoSize = true,
            Visible = false,
            Dock = DockStyle.Bottom,
            Padding = new Padding(16, 8, 16, 0),
        };

        var bottomRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            Padding = new Padding(12),
            AutoSize = true,
        };
        var saveButton = new Button { Text = "Save", AutoSize = true };
        var cancelButton = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
        bottomRow.Controls.Add(saveButton);
        bottomRow.Controls.Add(cancelButton);

        saveButton.Click += (_, _) =>
        {
            if (!AppConfig.IsHttpUrl(_urlBox.Text.Trim()))
            {
                errorLabel.Text = "Enter an http:// or https:// Home Assistant add-on URL, e.g. http://192.168.1.x:8088";
                errorLabel.Visible = true;
                tabs.SelectedTab = settingsTab;
                return;
            }

            var allowedRoots = _allowedRootsBox.Lines
                .Select(line => line.Trim().TrimEnd('\\'))
                .Where(line => !string.IsNullOrWhiteSpace(line))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            if (allowedRoots.Length == 0 || allowedRoots.Any(root => !root.StartsWith(@"\\", StringComparison.Ordinal)))
            {
                errorLabel.Text = @"Enter at least one UNC media root, such as \\nas-host\share\Movies.";
                errorLabel.Visible = true;
                tabs.SelectedTab = settingsTab;
                return;
            }

            Config = new AppConfig
            {
                HomeAssistantUrl = _urlBox.Text.Trim(),
                Port = (int)_portBox.Value,
                InstanceId = Config.InstanceId,
                SharedSecret = _resetPairingRequested ? "" : Config.SharedSecret,
                AllowedMediaRoots = allowedRoots,
                MpcPathOverride = string.IsNullOrWhiteSpace(_mpcPathBox.Text) ? null : _mpcPathBox.Text.Trim(),
                StartWithWindows = _startWithWindowsBox.Checked,
            };
            StartupRegistration.Apply(Config.StartWithWindows);
            DialogResult = DialogResult.OK;
            Close();
        };

        Controls.Add(tabs);
        Controls.Add(bottomRow);
        Controls.Add(errorLabel);
        AcceptButton = saveButton;
        CancelButton = cancelButton;

        DetectMpc();
    }

    private void BuildSettingsTab(TabPage tab)
    {
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 8,
            Padding = new Padding(16),
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < 7; i++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); // keeps content pinned to the top

        Label FieldLabel(string text) => new()
        {
            Text = text,
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(3, 9, 3, 9),
        };

        layout.Controls.Add(FieldLabel("Home Assistant add-on URL:"), 0, 0);
        layout.Controls.Add(_urlBox, 1, 0);

        layout.Controls.Add(FieldLabel("Player agent port:"), 0, 1);
        layout.Controls.Add(_portBox, 1, 1);

        layout.Controls.Add(FieldLabel("Home Assistant pairing:"), 0, 2);
        var pairingRow = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = false,
            Margin = new Padding(3, 6, 3, 6),
        };
        pairingRow.Controls.Add(_pairingStatusLabel);
        pairingRow.Controls.Add(_resetPairingButton);
        layout.Controls.Add(pairingRow, 1, 2);

        _resetPairingButton.Click += (_, _) =>
        {
            if (MessageBox.Show(
                    "Reset pairing? Playback will be unavailable until Home Assistant pairs again.",
                    "Reset Home Assistant pairing",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning) != DialogResult.Yes) return;

            _resetPairingRequested = true;
            _pairingStatusLabel.Text = "Pairing will reset when Settings is saved";
            _pairingStatusLabel.ForeColor = Color.DarkOrange;
            _resetPairingButton.Enabled = false;
        };

        layout.Controls.Add(FieldLabel("Allowed UNC media roots:"), 0, 3);
        layout.Controls.Add(_allowedRootsBox, 1, 3);

        layout.Controls.Add(FieldLabel("MPC-HC path (optional override):"), 0, 4);
        var mpcPathRow = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            AutoSize = true,
            Margin = new Padding(0, 6, 0, 6),
        };
        mpcPathRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        mpcPathRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        mpcPathRow.Controls.Add(_mpcPathBox, 0, 0);
        mpcPathRow.Controls.Add(_browseButton, 1, 0);
        layout.Controls.Add(mpcPathRow, 1, 4);

        layout.Controls.Add(FieldLabel("MPC-HC status:"), 0, 5);
        var statusColumn = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Margin = new Padding(3, 9, 3, 9),
        };
        statusColumn.Controls.Add(_mpcStatusLabel);
        statusColumn.Controls.Add(_mpcInstallLink);
        layout.Controls.Add(statusColumn, 1, 5);

        layout.Controls.Add(_startWithWindowsBox, 1, 6);

        tab.Controls.Add(layout);

        _browseButton.Click += (_, _) =>
        {
            using var dialog = new OpenFileDialog
            {
                Title = "Locate the MPC-HC executable",
                Filter = "MPC-HC executable|mpc-hc*.exe|All executables|*.exe",
                CheckFileExists = true,
            };
            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                _mpcPathBox.Text = dialog.FileName;
            }
        };
        _mpcPathBox.TextChanged += (_, _) => DetectMpc();
        _mpcInstallLink.LinkClicked += (_, _) =>
            Process.Start(new ProcessStartInfo(McpDownloadUrl) { UseShellExecute = true });
    }

    private void BuildLogTab(TabPage tab)
    {
        var toolbar = new FlowLayoutPanel { Dock = DockStyle.Top, AutoSize = true, Padding = new Padding(8) };
        var refreshButton = new Button { Text = "Refresh", AutoSize = true };
        var openFolderButton = new Button { Text = "Open log folder", AutoSize = true };
        toolbar.Controls.Add(refreshButton);
        toolbar.Controls.Add(openFolderButton);

        refreshButton.Click += (_, _) => LoadLogText();
        openFolderButton.Click += (_, _) =>
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{Logger.LogPath}\"") { UseShellExecute = true });

        // Dock=Fill control must be added before the Dock=Top toolbar so the toolbar's docked
        // space is carved out first and the log box fills whatever remains.
        tab.Controls.Add(_logBox);
        tab.Controls.Add(toolbar);

        tab.Enter += (_, _) => LoadLogText();
    }

    private void LoadLogText()
    {
        try
        {
            using var stream = new FileStream(Logger.LogPath, FileMode.OpenOrCreate, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            _logBox.Text = reader.ReadToEnd();
        }
        catch (Exception ex)
        {
            _logBox.Text = $"Could not read log file: {ex.Message}";
        }
        _logBox.SelectionStart = _logBox.Text.Length;
        _logBox.ScrollToCaret();
    }

    private void DetectMpc()
    {
        var overridePath = string.IsNullOrWhiteSpace(_mpcPathBox.Text) ? null : _mpcPathBox.Text.Trim();
        try
        {
            var foundPath = MpcLocator.Find(overridePath);
            _mpcStatusLabel.ForeColor = Color.SeaGreen;
            _mpcStatusLabel.Text = $"✓ Found: {foundPath}";
            _mpcInstallLink.Visible = false;
        }
        catch
        {
            _mpcStatusLabel.ForeColor = Color.Firebrick;
            _mpcStatusLabel.Text = "✗ MPC-HC not found automatically. Install it, or use Browse... to point at an existing install.";
            _mpcInstallLink.Visible = true;
        }
    }
}
