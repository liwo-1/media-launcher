using Microsoft.Win32;

namespace MediaLauncherPlayerAgent;

// Replaces the old install-task.ps1 / schtasks.exe approach. That existed specifically because
// this media PC's Task Scheduler CIM/WMI provider denies the standard (non-admin) account the
// modern Register-ScheduledTask cmdlets need. A per-user Run key needs no elevation at all and
// covers the same "start at login" requirement, so there's no scheduled task to register here.
public static class StartupRegistration
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "MediaLauncherPlayerAgent";

    public static void Apply(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        if (key == null) return;

        if (enabled)
        {
            var exePath = Environment.ProcessPath ?? Application.ExecutablePath;
            key.SetValue(ValueName, $"\"{exePath}\"");
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}
