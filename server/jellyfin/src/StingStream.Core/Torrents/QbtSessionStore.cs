using System;
using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace StingStream.Core.Torrents;

/// <summary>
/// Session identifiers handed out by the qBittorrent-compatible login.
/// </summary>
/// <remarks>
/// qBittorrent's API authenticates with an opaque cookie rather than a header, and the arrs cache
/// whatever cookie comes back and replay it. Sessions live in memory only: they are worth nothing
/// across a restart -- a 403 makes the arrs log in again and retry, which is the documented
/// behaviour of their own client.
/// </remarks>
public sealed class QbtSessionStore
{
    /// <summary>How long an idle session stays valid.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);

    private readonly ConcurrentDictionary<string, DateTime> _sessions = new(StringComparer.Ordinal);

    /// <summary>Mint a new session identifier.</summary>
    public string Create()
    {
        Prune();
        // 256 bits from the OS CSPRNG, base64url-encoded so it is cookie-safe without escaping.
        var bytes = RandomNumberGenerator.GetBytes(32);
        var sid = Convert.ToBase64String(bytes)
            .Replace('+', '-')
            .Replace('/', '_')
            .TrimEnd('=');
        _sessions[sid] = DateTime.UtcNow;
        return sid;
    }

    /// <summary>Is this session identifier live? Sliding: a valid check extends the session.</summary>
    public bool IsValid(string? sid)
    {
        if (string.IsNullOrEmpty(sid))
        {
            return false;
        }

        if (!_sessions.TryGetValue(sid, out var lastSeen))
        {
            return false;
        }

        if (DateTime.UtcNow - lastSeen > Lifetime)
        {
            _sessions.TryRemove(sid, out _);
            return false;
        }

        _sessions[sid] = DateTime.UtcNow;
        return true;
    }

    /// <summary>End a session.</summary>
    public void Remove(string? sid)
    {
        if (!string.IsNullOrEmpty(sid))
        {
            _sessions.TryRemove(sid, out _);
        }
    }

    /// <summary>Number of live sessions. Diagnostic.</summary>
    public int Count => _sessions.Count;

    private void Prune()
    {
        var cutoff = DateTime.UtcNow - Lifetime;
        foreach (var (sid, lastSeen) in _sessions)
        {
            if (lastSeen < cutoff)
            {
                _sessions.TryRemove(sid, out _);
            }
        }
    }
}
