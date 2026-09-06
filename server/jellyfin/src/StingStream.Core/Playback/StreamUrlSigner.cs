using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using StingStream.Core.Configuration;

namespace StingStream.Core.Playback;

/// <summary>
/// Mints the signature and expiry that make a <c>/stream/*</c> URL usable from off this machine.
/// </summary>
/// <remarks>
/// <para>
/// The gateway is the enforcing half and carries the full reasoning; see
/// <c>mesh/crates/stingstream/src/gateway/streamurl.rs</c>. The short version: the three path
/// segments of <c>/stream/{group}/{item_key}/{node}</c> are not a credential. The item key is
/// guessable, the node id is published in DNS on purpose (<c>pub.&lt;nodeid&gt;.direct.&lt;host&gt;</c>),
/// and the group id — the only part with real entropy — travels in every invite code, is the
/// gossip topic, and is known forever to a member the group has removed. So a removed member could
/// go on streaming everything the group holds, from any member's side door, which is a hole
/// straight through the middle of M8b's revocation.
/// </para>
/// <para>
/// The signature rides in the query string of the URL this class hands the client, and that is
/// what makes it free: every client rewrites the *host* of a <c>stingstream.local</c> URL and
/// nothing else, so a query string added here survives the trip through the native app, the web
/// bundle's connection racing and the cast sender untouched. No client had to learn anything.
/// </para>
/// <para>
/// The key is derived from the generated qBittorrent password in <c>runtime.json</c> — see
/// <see cref="Webhooks.WebhookToken"/> for why a derived secret beats a new field in that file.
/// </para>
/// </remarks>
public sealed class StreamUrlSigner
{
    /// <summary>Domain separator for the key derivation. Must match the gateway's.</summary>
    private const string KeyContext = "stingstream stream url v1";

    /// <summary>Domain separator for the signature. Must match the gateway's.</summary>
    private const string SigDomain = "stingstream-stream-v1";

    /// <summary>
    /// How long a minted URL is good for.
    /// </summary>
    /// <remarks>
    /// Twelve hours, matching the gateway's <c>DEFAULT_TTL_SECS</c>. Long enough for the longest
    /// film somebody pauses halfway through and comes back to after dinner; short enough that a URL
    /// left in a browser's history, a cast receiver's log or a proxy's access log is worthless by
    /// the next day. Nothing has to refresh it, because <c>MediaSourceInfo.Path</c> is rebuilt on
    /// every PlaybackInfo call — which is every time somebody presses play.
    /// </remarks>
    public static readonly TimeSpan Ttl = TimeSpan.FromHours(12);

    private readonly INodeRuntimeProvider _runtime;

    public StreamUrlSigner(INodeRuntimeProvider runtime)
    {
        _runtime = runtime;
    }

    /// <summary>Whether this node can sign at all.</summary>
    /// <remarks>
    /// False only when <c>runtime.json</c> has no qBittorrent password, which is a fault rather
    /// than a configuration — the supervisor always writes one. A node in that state hands out
    /// unsigned URLs and its own gateway refuses them from off-machine, which is the right way
    /// round: local playback keeps working and remote playback fails loudly.
    /// </remarks>
    public bool CanSign => Key() is not null;

    /// <summary>
    /// Add <c>?exp=…&amp;sig=…</c> to a stream URL, replacing any query it already had.
    /// </summary>
    /// <param name="url">The URL from the <c>.strm</c>, on any host.</param>
    /// <param name="group">The group id, decoded.</param>
    /// <param name="itemKey">The item key, decoded.</param>
    /// <param name="node">The holder's node id, decoded.</param>
    /// <returns>The signed URL, or <paramref name="url"/> unchanged when this node cannot sign.</returns>
    public string Sign(string url, string group, string itemKey, string node)
    {
        var key = Key();
        if (key is null || string.IsNullOrEmpty(url))
        {
            return url;
        }

        var expiry = DateTimeOffset.UtcNow.Add(Ttl).ToUnixTimeSeconds();
        var signature = Signature(key, group, itemKey, node, expiry);
        // Replace rather than append: a URL that already carries a signature is one this node
        // minted earlier in the same PlaybackInfo pass, and two `sig` parameters is a URL whose
        // meaning depends on which one the gateway's parser happens to read first.
        var question = url.IndexOf('?', StringComparison.Ordinal);
        var bare = question >= 0 ? url[..question] : url;
        return string.Create(CultureInfo.InvariantCulture, $"{bare}?exp={expiry}&sig={signature}");
    }

    /// <summary>The signing key, or null when it cannot be derived.</summary>
    private byte[]? Key()
    {
        var seed = _runtime.Current?.Qbittorrent?.Password;
        if (string.IsNullOrEmpty(seed))
        {
            return null;
        }

        return SHA256.HashData(Encoding.UTF8.GetBytes(KeyContext + "\0" + seed));
    }

    /// <summary>
    /// <c>HMAC-SHA256(key, domain || 0 || group || 0 || itemKey || 0 || node || 0 || expiry)</c>,
    /// first 16 bytes, lowercase hex.
    /// </summary>
    /// <remarks>
    /// The fields are separated by a zero byte rather than concatenated, so <c>("ab", "c")</c> and
    /// <c>("a", "bc")</c> cannot produce the same signature — a group id and an item key are both
    /// caller-influenced strings, and a signature that slid across the boundary would be a valid
    /// signature for a URL nobody minted. Sixteen bytes is 128 bits, which is not a compromise for
    /// a credential that expires the same day and keeps the URL readable in a log line.
    /// </remarks>
    private static string Signature(byte[] key, string group, string itemKey, string node, long expiry)
    {
        var message = new MemoryStream();
        void Write(string s)
        {
            var bytes = Encoding.UTF8.GetBytes(s);
            message.Write(bytes, 0, bytes.Length);
        }

        Write(SigDomain);
        foreach (var field in new[] { group, itemKey, node })
        {
            message.WriteByte(0);
            Write(field);
        }

        message.WriteByte(0);
        Write(expiry.ToString(CultureInfo.InvariantCulture));

        var mac = HMACSHA256.HashData(key, message.ToArray());
        return Convert.ToHexString(mac, 0, 16).ToLowerInvariant();
    }
}
