namespace MediaLauncherPlayerAgent;

public static class MediaPathValidator
{
    public static void ValidateWindowsPath(string filePath, IReadOnlyCollection<string> allowedMediaRoots) =>
        MediaPathPolicy.ValidateWindowsUnc(filePath, allowedMediaRoots);
}
