using System;
using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace StingStream.Core.Passkeys;

/// <summary>One ceremony in flight: what was offered, and to whom.</summary>
/// <param name="Options">The options JSON handed to the browser, kept verbatim to verify against.</param>
/// <param name="UserId">The account, for a registration. Null for a sign-in, which has none yet.</param>
/// <param name="Expires">When it stops being answerable.</param>
public readonly record struct PasskeyCeremony(
    string Options,
    string? UserId,
    DateTimeOffset Expires);

/// <summary>
/// The challenges handed out and not yet answered.
/// </summary>
/// <remarks>
/// <para>
/// A WebAuthn ceremony is two requests: the server offers a challenge, the authenticator signs it,
/// the server verifies the signature <em>against the challenge it offered</em>. So the offer has to
/// be remembered, and remembered on the server — a challenge the client hands back is not a
/// challenge, it is a value an attacker chooses.
/// </para>
/// <para>
/// <b>In memory, not in the database.</b> A ceremony lives for the seconds between a button press
/// and a fingerprint; persisting one would mean a challenge outliving a restart for no purpose, and
/// a table that has to be swept. Core is one process, so a dictionary is the whole of it. The cost
/// is that a restart mid-ceremony makes the user press the button again, which is the correct
/// behaviour anyway.
/// </para>
/// <para>
/// <b>Single use, and short.</b> <see cref="Take"/> removes as it reads, so a captured
/// <c>finish</c> request cannot be replayed against the same challenge — which is most of what a
/// challenge is for. Five minutes is long enough to find a security key in a drawer and short
/// enough that a browser left open on a shared machine is not an open door.
/// </para>
/// </remarks>
public sealed class PasskeyCeremonies
{
    /// <summary>How long a challenge stays answerable.</summary>
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    /// <summary>
    /// How many ceremonies may be outstanding before new ones are refused.
    /// </summary>
    /// <remarks>
    /// `login/begin` is anonymous, so anybody who can reach the server can ask for a challenge.
    /// Each one is a few hundred bytes and expires on its own, but "expires on its own" is not a
    /// bound — a loop issuing them faster than they expire is. This is the bound. It is far above
    /// anything a household produces, and reaching it means something is wrong rather than busy.
    /// </remarks>
    public const int MaxOutstanding = 2000;

    private readonly ConcurrentDictionary<string, PasskeyCeremony> _pending = new(StringComparer.Ordinal);

    /// <summary>Remember a challenge, and return the id the client carries back.</summary>
    /// <param name="options">The options JSON, verbatim.</param>
    /// <param name="userId">The account, for a registration; null for a sign-in.</param>
    /// <param name="now">The current time.</param>
    /// <returns>The ceremony id, or null when too many are already outstanding.</returns>
    public string? Remember(string options, string? userId, DateTimeOffset now)
    {
        Sweep(now);
        if (_pending.Count >= MaxOutstanding)
        {
            return null;
        }

        var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        _pending[id] = new PasskeyCeremony(options, userId, now + Lifetime);
        return id;
    }

    /// <summary>Take a challenge back, once.</summary>
    /// <param name="id">The ceremony id.</param>
    /// <param name="now">The current time.</param>
    /// <returns>The ceremony, or null when it is unknown, spent or expired.</returns>
    public PasskeyCeremony? Take(string? id, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(id) || !_pending.TryRemove(id, out var ceremony))
        {
            return null;
        }

        // Removed either way: an expired ceremony is spent by looking at it, so a slow client
        // cannot hold one open by retrying.
        return now >= ceremony.Expires ? null : ceremony;
    }

    /// <summary>How many are outstanding. For tests and diagnostics.</summary>
    public int Count => _pending.Count;

    private void Sweep(DateTimeOffset now)
    {
        foreach (var (id, ceremony) in _pending)
        {
            if (now >= ceremony.Expires)
            {
                _pending.TryRemove(id, out _);
            }
        }
    }
}
