using System.Diagnostics;

namespace MediaLauncherPlayerAgent;

public class SettingsForm : Form
{
    private const string MpcDownloadUrl = "https://github.com/clsid2/mpc-hc/releases/latest";

    public AppConfig Config { get; private set; }
    public bool PairingResetRequested => _resetPairingRequested;

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
    private readonly Label _mpcStatusLabel = new() { AutoSize = true, MaximumSize = new Size(430, 0) };
    private readonly LinkLabel _mpcInstallLink = new() { AutoSize = true, Text = "Download MPC-HC", Visible = false };
    private readonly TextBox _vlcPathBox = new() { Dock = DockStyle.Fill };
    private readonly Label _vlcStatusLabel = new() { AutoSize = true, MaximumSize = new Size(430, 0) };
    private readonly TextBox _potPlayerPathBox = new() { Dock = DockStyle.Fill };
    private readonly Label _potPlayerStatusLabel = new() { AutoSize = true, MaximumSize = new Size(430, 0) };
    private readonly ListBox _customPlayersList = new() { Dock = DockStyle.Fill, Height = 110 };
    private readonly List<CustomPlayerProfile> _customPlayers;
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
        _customPlayers = (config.CustomPlayers ?? []).Select(CloneProfile).ToList();

        Text = "Media Launcher - Player Agent Settings";
        Width = 760;
        Height = 700;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterScreen;
        MaximizeBox = false;
        MinimizeBox = false;

        _urlBox.Text = config.HomeAssistantUrl;
        _portBox.Value = config.Port;
        _allowedRootsBox.Lines = config.AllowedMediaRoots;
        _mpcPathBox.Text = config.MpcPathOverride ?? "";
        _vlcPathBox.Text = config.VlcPathOverride ?? "";
        _potPlayerPathBox.Text = config.PotPlayerPathOverride ?? "";
        _startWithWindowsBox.Checked = config.StartWithWindows;
        _pairingStatusLabel.Text = !string.IsNullOrEmpty(config.SharedSecret)
            ? "✓ Paired"
            : !string.IsNullOrEmpty(config.RegistrationSecret)
                ? "Pairing pending — reset here if Home Assistant removed this device"
                : "Waiting for Home Assistant to pair automatically";
        _pairingStatusLabel.ForeColor = string.IsNullOrEmpty(config.SharedSecret) ? Color.DarkOrange : Color.SeaGreen;
        _resetPairingButton.Enabled =
            !string.IsNullOrEmpty(config.SharedSecret) || !string.IsNullOrEmpty(config.RegistrationSecret);
        RefreshCustomPlayers();

        var tabs = new TabControl { Dock = DockStyle.Fill };
        var settingsTab = new TabPage("Settings");
        var playersTab = new TabPage("Players");
        var logTab = new TabPage("Log");
        tabs.TabPages.Add(settingsTab);
        tabs.TabPages.Add(playersTab);
        tabs.TabPages.Add(logTab);
        BuildSettingsTab(settingsTab);
        BuildPlayersTab(playersTab);
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

            var mpcOverride = OptionalPath(_mpcPathBox.Text);
            var vlcOverride = OptionalPath(_vlcPathBox.Text);
            var potPlayerOverride = OptionalPath(_potPlayerPathBox.Text);
            try
            {
                if (mpcOverride is not null) mpcOverride = MpcLocator.ValidateOverride(mpcOverride);
                if (vlcOverride is not null) vlcOverride = WindowsPlayerLocator.ValidateVlcOverride(vlcOverride);
                if (potPlayerOverride is not null)
                    potPlayerOverride = WindowsPlayerLocator.ValidatePotPlayerOverride(potPlayerOverride);
            }
            catch (ArgumentException ex)
            {
                errorLabel.Text = ex.Message;
                errorLabel.Visible = true;
                tabs.SelectedTab = playersTab;
                return;
            }

            Config = new AppConfig
            {
                HomeAssistantUrl = _urlBox.Text.Trim(),
                Port = (int)_portBox.Value,
                InstanceId = _resetPairingRequested ? Guid.NewGuid().ToString("N") : Config.InstanceId,
                SharedSecret = _resetPairingRequested ? "" : Config.SharedSecret,
                RegistrationSecret = _resetPairingRequested ? "" : Config.RegistrationSecret,
                AllowedMediaRoots = allowedRoots,
                MpcPathOverride = mpcOverride,
                VlcPathOverride = vlcOverride,
                PotPlayerPathOverride = potPlayerOverride,
                CustomPlayers = _customPlayers.Select(CloneProfile).ToList(),
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
        DetectPlayers();
    }

    private void BuildSettingsTab(TabPage tab)
    {
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 6,
            Padding = new Padding(16),
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < 5; i++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

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
        layout.Controls.Add(_startWithWindowsBox, 1, 4);
        tab.Controls.Add(layout);
    }

    private void BuildPlayersTab(TabPage tab)
    {
        var scroll = new Panel { Dock = DockStyle.Fill, AutoScroll = true };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2,
            RowCount = 10,
            Padding = new Padding(16),
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < 10; i++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var intro = new Label
        {
            AutoSize = true,
            MaximumSize = new Size(500, 0),
            Text = "Installed players are detected automatically. Optional overrides support portable installations. " +
                   "MPC-HC provides progress monitoring; VLC, PotPlayer, and custom profiles currently launch only.",
        };
        layout.Controls.Add(intro, 0, 0);
        layout.SetColumnSpan(intro, 2);

        layout.Controls.Add(FieldLabel("MPC-HC path override:"), 0, 1);
        layout.Controls.Add(PathRow(_mpcPathBox, "MPC-HC executable|mpc-hc*.exe", () => DetectMpc()), 1, 1);
        layout.Controls.Add(FieldLabel("MPC-HC status:"), 0, 2);
        var mpcStatus = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            Margin = new Padding(3, 9, 3, 9),
        };
        mpcStatus.Controls.Add(_mpcStatusLabel);
        mpcStatus.Controls.Add(_mpcInstallLink);
        layout.Controls.Add(mpcStatus, 1, 2);

        layout.Controls.Add(FieldLabel("VLC path override:"), 0, 3);
        layout.Controls.Add(PathRow(_vlcPathBox, "VLC executable|vlc.exe", () => DetectVlc()), 1, 3);
        layout.Controls.Add(FieldLabel("VLC status:"), 0, 4);
        layout.Controls.Add(_vlcStatusLabel, 1, 4);

        layout.Controls.Add(FieldLabel("PotPlayer path override:"), 0, 5);
        layout.Controls.Add(PathRow(
            _potPlayerPathBox,
            "PotPlayer executable|PotPlayerMini*.exe",
            () => DetectPotPlayer()), 1, 5);
        layout.Controls.Add(FieldLabel("PotPlayer status:"), 0, 6);
        layout.Controls.Add(_potPlayerStatusLabel, 1, 6);

        layout.Controls.Add(FieldLabel("Custom players:"), 0, 7);
        layout.Controls.Add(_customPlayersList, 1, 7);
        var customButtons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight };
        var add = new Button { Text = "Add...", AutoSize = true };
        var edit = new Button { Text = "Edit...", AutoSize = true };
        var remove = new Button { Text = "Remove", AutoSize = true };
        customButtons.Controls.Add(add);
        customButtons.Controls.Add(edit);
        customButtons.Controls.Add(remove);
        layout.Controls.Add(customButtons, 1, 8);

        add.Click += (_, _) => AddCustomPlayer();
        edit.Click += (_, _) => EditSelectedCustomPlayer();
        remove.Click += (_, _) => RemoveSelectedCustomPlayer();
        _customPlayersList.DoubleClick += (_, _) => EditSelectedCustomPlayer();
        _mpcInstallLink.LinkClicked += (_, _) =>
            Process.Start(new ProcessStartInfo(MpcDownloadUrl) { UseShellExecute = true });

        scroll.Controls.Add(layout);
        tab.Controls.Add(scroll);
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
        tab.Controls.Add(_logBox);
        tab.Controls.Add(toolbar);
        tab.Enter += (_, _) => LoadLogText();
    }

    private static Label FieldLabel(string text) => new()
    {
        Text = text,
        AutoSize = true,
        Anchor = AnchorStyles.Left,
        Margin = new Padding(3, 9, 3, 9),
    };

    private Control PathRow(TextBox box, string filter, Action changed)
    {
        var row = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            AutoSize = true,
            Margin = new Padding(0, 6, 0, 6),
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var browse = new Button { Text = "Browse...", AutoSize = true };
        browse.Click += (_, _) =>
        {
            using var dialog = new OpenFileDialog
            {
                Title = "Locate the media player executable",
                Filter = $"{filter}|All executables|*.exe",
                CheckFileExists = true,
            };
            if (dialog.ShowDialog(this) == DialogResult.OK) box.Text = dialog.FileName;
        };
        box.TextChanged += (_, _) => changed();
        row.Controls.Add(box, 0, 0);
        row.Controls.Add(browse, 1, 0);
        return row;
    }

    private void AddCustomPlayer()
    {
        using var dialog = new CustomPlayerForm();
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        _customPlayers.Add(dialog.Profile);
        RefreshCustomPlayers(dialog.Profile.Id);
    }

    private void EditSelectedCustomPlayer()
    {
        if (_customPlayersList.SelectedItem is not CustomPlayerProfile selected) return;
        using var dialog = new CustomPlayerForm(CloneProfile(selected));
        if (dialog.ShowDialog(this) != DialogResult.OK) return;
        var index = _customPlayers.FindIndex(profile => profile.Id == selected.Id);
        if (index >= 0) _customPlayers[index] = dialog.Profile;
        RefreshCustomPlayers(dialog.Profile.Id);
    }

    private void RemoveSelectedCustomPlayer()
    {
        if (_customPlayersList.SelectedItem is not CustomPlayerProfile selected) return;
        if (MessageBox.Show(
                $"Remove the custom player '{selected.Name}'?",
                "Remove custom player",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question) != DialogResult.Yes) return;
        _customPlayers.RemoveAll(profile => profile.Id == selected.Id);
        RefreshCustomPlayers();
    }

    private void RefreshCustomPlayers(string? selectedId = null)
    {
        _customPlayersList.BeginUpdate();
        _customPlayersList.Items.Clear();
        foreach (var profile in _customPlayers) _customPlayersList.Items.Add(profile);
        if (selectedId is not null)
        {
            var selected = _customPlayers.Cast<CustomPlayerProfile>().FirstOrDefault(profile => profile.Id == selectedId);
            if (selected is not null) _customPlayersList.SelectedItem = selected;
        }
        _customPlayersList.EndUpdate();
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

    private void DetectPlayers()
    {
        DetectMpc();
        DetectVlc();
        DetectPotPlayer();
    }

    private void DetectMpc()
    {
        var overridePath = OptionalPath(_mpcPathBox.Text);
        try
        {
            var foundPath = MpcLocator.Find(overridePath);
            SetDetected(_mpcStatusLabel, foundPath);
            _mpcInstallLink.Visible = false;
        }
        catch
        {
            SetMissing(_mpcStatusLabel, "MPC-HC not found. Install it, or choose an existing executable.");
            _mpcInstallLink.Visible = true;
        }
    }

    private void DetectVlc()
    {
        var found = WindowsPlayerLocator.FindVlc(OptionalPath(_vlcPathBox.Text));
        if (found is null) SetMissing(_vlcStatusLabel, "VLC not found automatically.");
        else SetDetected(_vlcStatusLabel, found);
    }

    private void DetectPotPlayer()
    {
        var found = WindowsPlayerLocator.FindPotPlayer(OptionalPath(_potPlayerPathBox.Text));
        if (found is null) SetMissing(_potPlayerStatusLabel, "PotPlayer not found automatically.");
        else SetDetected(_potPlayerStatusLabel, found);
    }

    private static void SetDetected(Label label, string path)
    {
        label.ForeColor = Color.SeaGreen;
        label.Text = $"✓ Found: {path}";
    }

    private static void SetMissing(Label label, string message)
    {
        label.ForeColor = Color.Firebrick;
        label.Text = $"✗ {message}";
    }

    private static string? OptionalPath(string value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static CustomPlayerProfile CloneProfile(CustomPlayerProfile profile) => new()
    {
        Id = profile.Id,
        Name = profile.Name,
        ExecutablePath = profile.ExecutablePath,
        WorkingDirectory = profile.WorkingDirectory,
        Arguments = [.. (profile.Arguments ?? [])],
    };
}
