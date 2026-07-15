using System.Reflection;
using System.Runtime.InteropServices;

namespace MediaLauncher.LinuxAgent;

internal static class AgentIdentity
{
    public static string Version =>
        Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion.Split('+')[0] ?? "unknown";

    public static string Architecture => RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant();
}
