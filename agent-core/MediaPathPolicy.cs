namespace MediaLauncher.Agent.Core;

public static class MediaPathPolicy
{
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".avi", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ts", ".webm", ".wmv",
    };

    public static string ValidateLinuxFile(string filePath, IReadOnlyCollection<string> allowedRoots)
    {
        if (string.IsNullOrWhiteSpace(filePath))
            throw new ArgumentException("Media path is required.");
        if (!Path.IsPathFullyQualified(filePath) || Uri.TryCreate(filePath, UriKind.Absolute, out var uri) && !uri.IsFile)
            throw new ArgumentException("Only absolute local media paths are allowed.");
        AssertAllowedExtension(filePath);

        string normalizedPath;
        try { normalizedPath = ResolvePathLinks(Path.GetFullPath(filePath)); }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        {
            throw new ArgumentException("Media path is invalid.", ex);
        }
        AssertAllowedExtension(normalizedPath);
        if (!File.Exists(normalizedPath)) throw new FileNotFoundException("The media file does not exist.");

        var allowed = allowedRoots.Any(root => IsInsideLinuxRoot(normalizedPath, root));
        if (!allowed)
            throw new UnauthorizedAccessException("Media path is outside the configured allowed roots.");
        return normalizedPath;
    }

    public static void ValidateWindowsUnc(string filePath, IReadOnlyCollection<string> allowedRoots)
    {
        if (string.IsNullOrWhiteSpace(filePath)) throw new ArgumentException("Media path is required.");
        if (Uri.TryCreate(filePath, UriKind.Absolute, out var uri) && !uri.IsUnc)
            throw new ArgumentException("URL and local media paths are not allowed.");
        if (!filePath.StartsWith(@"\\", StringComparison.Ordinal))
            throw new ArgumentException("Only UNC media paths are allowed.");
        AssertAllowedExtension(filePath);

        string normalizedPath;
        try { normalizedPath = Path.GetFullPath(filePath).TrimEnd('\\'); }
        catch (Exception ex) { throw new ArgumentException("Media path is invalid.", ex); }

        var allowed = allowedRoots.Any(root =>
        {
            if (string.IsNullOrWhiteSpace(root) || !root.StartsWith(@"\\", StringComparison.Ordinal)) return false;
            string normalizedRoot;
            try { normalizedRoot = Path.GetFullPath(root).TrimEnd('\\'); }
            catch { return false; }
            return normalizedPath.Equals(normalizedRoot, StringComparison.OrdinalIgnoreCase) ||
                normalizedPath.StartsWith(normalizedRoot + "\\", StringComparison.OrdinalIgnoreCase);
        });
        if (!allowed)
            throw new UnauthorizedAccessException("Media path is outside the configured allowed UNC roots.");
    }

    private static void AssertAllowedExtension(string filePath)
    {
        var extension = Path.GetExtension(filePath);
        if (!AllowedExtensions.Contains(extension))
            throw new ArgumentException($"The media extension '{extension}' is not allowed.");
    }

    private static bool IsInsideLinuxRoot(string normalizedPath, string root)
    {
        if (string.IsNullOrWhiteSpace(root) || !Path.IsPathFullyQualified(root)) return false;
        try
        {
            var normalizedRoot = Path.TrimEndingDirectorySeparator(
                ResolvePathLinks(Path.GetFullPath(root)));
            return normalizedPath.Equals(normalizedRoot, StringComparison.Ordinal) ||
                normalizedPath.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal);
        }
        catch { return false; }
    }

    private static string ResolvePathLinks(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var root = Path.GetPathRoot(fullPath) ?? throw new ArgumentException("Path has no root.");
        var current = root;
        foreach (var component in fullPath[root.Length..]
            .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            FileSystemInfo info = Directory.Exists(current)
                ? new DirectoryInfo(current)
                : new FileInfo(current);
            var target = info.ResolveLinkTarget(returnFinalTarget: true);
            if (target is not null) current = Path.GetFullPath(target.FullName);
        }
        return current;
    }
}
