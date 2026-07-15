namespace MediaLauncherPlayerAgent;

public sealed class CustomPlayerForm : Form
{
    private readonly TextBox _nameBox = new() { Dock = DockStyle.Fill };
    private readonly TextBox _executableBox = new() { Dock = DockStyle.Fill };
    private readonly TextBox _workingDirectoryBox = new() { Dock = DockStyle.Fill };
    private readonly TextBox _argumentsBox = new()
    {
        Dock = DockStyle.Fill,
        Multiline = true,
        Height = 120,
        ScrollBars = ScrollBars.Vertical,
        Font = new Font(FontFamily.GenericMonospace, 9),
        PlaceholderText = "One argument per line",
    };
    private readonly string _profileId;

    public CustomPlayerProfile Profile { get; private set; }

    public CustomPlayerForm(CustomPlayerProfile? existing = null)
    {
        _profileId = existing?.Id ?? $"custom-{Guid.NewGuid():N}";
        Profile = existing ?? new CustomPlayerProfile { Id = _profileId };
        Text = existing is null ? "Add custom media player" : "Edit custom media player";
        Width = 680;
        Height = 500;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MaximizeBox = false;
        MinimizeBox = false;

        _nameBox.Text = existing?.Name ?? "";
        _executableBox.Text = existing?.ExecutablePath ?? "";
        _workingDirectoryBox.Text = existing?.WorkingDirectory ?? "";
        _argumentsBox.Lines = existing?.Arguments ?? [];

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            RowCount = 6,
            Padding = new Padding(16),
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 155));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < 4; i++) layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        Label FieldLabel(string text) => new()
        {
            Text = text,
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(3, 9, 3, 9),
        };

        layout.Controls.Add(FieldLabel("Friendly name:"), 0, 0);
        layout.Controls.Add(_nameBox, 1, 0);
        layout.Controls.Add(FieldLabel("Executable:"), 0, 1);
        layout.Controls.Add(PathRow(_executableBox, BrowseExecutable), 1, 1);
        layout.Controls.Add(FieldLabel("Working directory:"), 0, 2);
        layout.Controls.Add(PathRow(_workingDirectoryBox, BrowseDirectory), 1, 2);
        layout.Controls.Add(FieldLabel("Arguments:"), 0, 3);
        layout.Controls.Add(_argumentsBox, 1, 3);

        var help = new Label
        {
            AutoSize = true,
            MaximumSize = new Size(450, 0),
            ForeColor = Color.DimGray,
            Text = "Enter one argument per line. Supported placeholders: {media_path}, {title}, and {start_seconds}. " +
                   "If {media_path} is omitted, the file path is appended automatically. Commands are launched directly; no shell is used. " +
                   "Choose the real media-player executable, not a short-lived launcher or wrapper.",
        };
        layout.Controls.Add(help, 1, 4);

        var errorLabel = new Label { AutoSize = true, ForeColor = Color.Firebrick, Visible = false };
        var buttons = new FlowLayoutPanel
        {
            AutoSize = true,
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Fill,
        };
        var save = new Button { Text = "Save", AutoSize = true };
        var cancel = new Button { Text = "Cancel", AutoSize = true, DialogResult = DialogResult.Cancel };
        buttons.Controls.Add(save);
        buttons.Controls.Add(cancel);
        layout.Controls.Add(errorLabel, 0, 5);
        layout.SetColumnSpan(errorLabel, 1);
        layout.Controls.Add(buttons, 1, 5);

        save.Click += (_, _) =>
        {
            try
            {
                var name = _nameBox.Text.Trim();
                var executable = _executableBox.Text.Trim();
                var workingDirectory = _workingDirectoryBox.Text.Trim();
                var arguments = _argumentsBox.Lines
                    .Select(line => line.Trim())
                    .Where(line => line.Length > 0)
                    .ToArray();
                var candidate = new CustomPlayerProfile
                {
                    Id = _profileId,
                    Name = name,
                    ExecutablePath = executable,
                    WorkingDirectory = workingDirectory.Length > 0 ? workingDirectory : null,
                    Arguments = arguments,
                };
                var validation = CustomPlayerProfileValidator.Validate(candidate, requireExistingPaths: true);
                if (!validation.IsValid)
                {
                    throw new ArgumentException(string.Join(
                        Environment.NewLine,
                        validation.Diagnostics
                            .Where(diagnostic => diagnostic.Severity == "error")
                            .Select(diagnostic => diagnostic.Message)));
                }

                candidate.ExecutablePath = Path.GetFullPath(executable);
                candidate.WorkingDirectory = workingDirectory.Length > 0
                    ? Path.GetFullPath(workingDirectory)
                    : null;
                Profile = candidate;
                DialogResult = DialogResult.OK;
                Close();
            }
            catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
            {
                errorLabel.Text = ex.Message;
                errorLabel.Visible = true;
            }
        };

        Controls.Add(layout);
        AcceptButton = save;
        CancelButton = cancel;
    }

    private static Control PathRow(TextBox box, Action browse)
    {
        var row = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, AutoSize = true };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        var button = new Button { Text = "Browse...", AutoSize = true };
        button.Click += (_, _) => browse();
        row.Controls.Add(box, 0, 0);
        row.Controls.Add(button, 1, 0);
        return row;
    }

    private void BrowseExecutable()
    {
        using var dialog = new OpenFileDialog
        {
            Title = "Locate the media player executable",
            Filter = "Windows executables|*.exe",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) _executableBox.Text = dialog.FileName;
    }

    private void BrowseDirectory()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose the player's working directory",
            UseDescriptionForTitle = true,
        };
        if (dialog.ShowDialog(this) == DialogResult.OK) _workingDirectoryBox.Text = dialog.SelectedPath;
    }
}
