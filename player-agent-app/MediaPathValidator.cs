namespace MediaLauncherPlayerAgent;

public static class MediaPathValidator
{
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ts", ".webm", ".wmv",
    };

    public static void ValidateWindowsPath(string filePath, IReadOnlyCollection<string> allowedMediaRoots)
    {
        if (string.IsNullOrWhiteSpace(filePath))
            throw new ArgumentException("Media path is required.");
        if (Uri.TryCreate(filePath, UriKind.Absolute, out var uri) && !uri.IsUnc)
            throw new ArgumentException("URL and local media paths are not allowed.");
        if (!filePath.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Only UNC media paths are allowed.");

        var extension = Path.GetExtension(filePath);
        if (!AllowedExtensions.Contains(extension))
            throw new ArgumentException($"The media extension '{extension}' is not allowed.");

        string normalizedPath;
        try { normalizedPath = Path.GetFullPath(filePath).TrimEnd('\\'); }
        catch (Exception ex) { throw new ArgumentException("Media path is invalid.", ex); }

        var allowed = allowedMediaRoots.Any(root =>
        {
            if (string.IsNullOrWhiteSpace(root) || !root.StartsWith(@"\\", StringComparison.Ordinal)) return false;
            string normalizedRoot;
            try { normalizedRoot = Path.GetFullPath(root).TrimEnd('\\'); }
            catch { return false; }
            return normalizedPath.Equals(normalizedRoot, StringComparison.OrdinalIgnoreCase) ||
                (normalizedPath.StartsWith(normalizedRoot, StringComparison.OrdinalIgnoreCase) &&
                 normalizedPath.Length > normalizedRoot.Length &&
                 normalizedPath[normalizedRoot.Length] == '\\');
        });

        if (!allowed)
            throw new UnauthorizedAccessException("Media path is outside the configured allowed UNC roots.");
    }
}
