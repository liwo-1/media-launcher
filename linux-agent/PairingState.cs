namespace MediaLauncher.LinuxAgent;

internal static class PairingState
{
    public static readonly SemaphoreSlim MutationLock = new(1, 1);
}
