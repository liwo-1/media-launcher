using System.Security.Cryptography;
using System.Text;

namespace MediaLauncher.Agent.Core;

public static class BearerAuthentication
{
    public static bool IsAuthorized(string? authorizationHeader, string? expectedSecret)
    {
        if (string.IsNullOrEmpty(expectedSecret) || string.IsNullOrEmpty(authorizationHeader))
            return false;
        if (!authorizationHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return false;

        var supplied = authorizationHeader[7..];
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(expectedSecret));
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
        return CryptographicOperations.FixedTimeEquals(expectedHash, suppliedHash);
    }

    public static bool IsPairingSecret(string? value) =>
        value is { Length: 48 } && value.All(Uri.IsHexDigit);
}
