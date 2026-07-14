namespace MediaLauncherPlayerAgent;

public static class PairingState
{
    // Registration, compatibility /pair, and local reset all mutate the same two persisted
    // credentials. One process-wide lock prevents last-write-wins key mismatches.
    public static SemaphoreSlim MutationLock { get; } = new(1, 1);
}
