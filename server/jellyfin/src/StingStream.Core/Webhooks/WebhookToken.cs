using System;
using System.Security.Cryptography;
using System.Text;
using StingStream.Core.Configuration;

namespace StingStream.Core.Webhooks;

/// <summary>
/// The shared secret Radarr and Sonarr present when they POST an import event.
/// </summary>
/// <remarks>
/// <para>
/// The webhook receiver used to be protected by a loopback check alone, and that check was worth
/// nothing. The gateway proxies <c>/stingstream/api/*</c> to Jellyfin over 127.0.0.1, so a request
/// from anywhere on the LAN arrives at Core with a loopback remote address — the check passed for
/// every caller it was supposed to stop. What it actually guarded was the ability to make the node
/// run a library refresh over any path named in the body.
/// </para>
/// <para>
/// **Derived, not stored.** The obvious fix is a new field in <c>runtime.json</c>, and it is the
/// wrong one here: that file is written by the supervisor and read by Core, so a new secret in it
/// is a schema change, a migration for existing installs, and a node whose two halves disagree
/// until both are upgraded. Deriving the token from a secret the file already carries — the
/// generated qBittorrent password, which exists on every node and is regenerated whenever
/// <c>runtime.json</c> is — gives both halves the same answer with nothing to keep in step. The
/// hash means the qBittorrent password itself is never written into an arr's configuration, where
/// it would sit in that app's own database and logs.
/// </para>
/// <para>
/// A node whose <c>runtime.json</c> has no qBittorrent password yet has no token either. That is a
/// fault rather than a configuration, and the receiver refuses everything rather than falling back
/// to the check that did not work.
/// </para>
/// </remarks>
public static class WebhookToken
{
    private const string Domain = "stingstream arr webhook v1";

    /// <summary>The query-string parameter the token travels in.</summary>
    public const string QueryName = "token";

    /// <summary>
    /// The token for this node, or null when <c>runtime.json</c> does not carry what it is derived
    /// from.
    /// </summary>
    /// <param name="runtime">The node runtime, or null.</param>
    /// <returns>The token, or null.</returns>
    public static string? For(NodeRuntime? runtime)
    {
        var seed = runtime?.Qbittorrent?.Password;
        if (string.IsNullOrEmpty(seed))
        {
            return null;
        }

        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(Domain + "\u0000" + seed));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    /// <summary>Constant-time comparison, so the token cannot be recovered a character at a time.</summary>
    /// <param name="expected">The token this node derived.</param>
    /// <param name="presented">What the caller sent.</param>
    /// <returns>True when they match.</returns>
    public static bool Matches(string? expected, string? presented)
    {
        if (string.IsNullOrEmpty(expected) || string.IsNullOrEmpty(presented))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected),
            Encoding.UTF8.GetBytes(presented));
    }
}
