namespace MediaLauncher.Agent.Core;

public static class AgentCapabilities
{
    public const string PlayersList = "players.list";
    public const string SessionsCreate = "sessions.create";
    public const string SessionsStatus = "sessions.status";
    public const string SessionsControl = "sessions.control";
    public const string SessionsEndReasons = "sessions.end-reasons";

    public const string PlayFile = "play.file";
    public const string Fullscreen = "fullscreen";
    public const string StatusState = "status.state";
    public const string StatusPosition = "status.position";
    public const string StatusDuration = "status.duration";
    public const string ControlPause = "control.pause";
    public const string ControlSeek = "control.seek";
    public const string ControlStop = "control.stop";

    public static readonly string[] ProtocolV2 =
    [
        PlayersList,
        SessionsCreate,
        SessionsStatus,
        SessionsControl,
        SessionsEndReasons,
    ];
}

public static class AgentProtocol
{
    public const int LegacyVersion = 1;
    public const int CurrentVersion = 2;
    public static readonly int[] SupportedVersions = [LegacyVersion, CurrentVersion];
}
