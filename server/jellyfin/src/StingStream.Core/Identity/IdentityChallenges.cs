using System;
using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace StingStream.Core.Identity;

/// <summary>
/// The nonces this server has handed out and not yet seen back.
/// </summary>
/// <remarks>
/// <para>
/// Signing in with your own server is two requests: this server offers a nonce, the other server
/// signs a statement over it, this server checks the signature <em>against the nonce it
/// offered</em>. So the offer has to be remembered here — a nonce the client hands back with no
/// record of it being issued is not a nonce, it is a value the client chose, and the whole
/// freshness property goes with it.
/// </para>
/// <para>
/// <b>Freshness is the audience's job and nobody else's.</b> The mesh checks the signature, the
/// audience and the expiry, because those are inside the assertion. Only this server knows which
/// nonces it issued and which it has already spent, so only this server can refuse a replay. See
/// <c>mesh/crates/stingstream-mesh/src/vouch.rs</c>.
/// </para>
/// <para>
/// <b>In memory, not in the database</b>, and <b>single use</b>: <see cref="Take"/> removes as it
/// reads, so a captured sign-in cannot be replayed against the same nonce. Both decisions, and the
/// bound below, are <c>PasskeyCeremonies</c>'s — this is the same problem with a smaller payload,
/// and having two answers to it would be worse than having one twice.
/// </para>
/// </remarks>
public sealed class IdentityChallenges
{
    private readonly ConcurrentDictionary<string, DateTimeOffset> _pending =
        new(StringComparer.Ordinal);

    /// <summary>Issue a nonce, or null when too many are already outstanding.</summary>
    /// <param name="now">The current time.</param>
    /// <returns>The nonce, or null.</returns>
    /// <remarks>
    /// Sweeps before it counts, so the bound is on live challenges rather than on everything ever
    /// issued — without that, a server that had been up for a week would start refusing sign-ins.
    /// </remarks>
    public string? Issue(DateTimeOffset now)
    {
        Sweep(now);

        if (_pending.Count >= IdentityGate.MaxOutstandingChallenges)
        {
            return null;
        }

        var nonce = Convert.ToBase64String(
                RandomNumberGenerator.GetBytes(IdentityGate.ChallengeBytes))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');

        _pending[nonce] = now + IdentityGate.ChallengeLifetime;
        return nonce;
    }

    /// <summary>Spend a nonce. True only for the call that spends it.</summary>
    /// <param name="nonce">What came back.</param>
    /// <param name="now">The current time.</param>
    /// <returns>True when this nonce was live and is now spent.</returns>
    /// <remarks>
    /// Removes first and judges after, so two requests racing the same nonce cannot both win —
    /// which is the same shape, for the same reason, as <c>InviteStore.TryRedeemAsync</c>'s single
    /// <c>UPDATE ... WHERE redeemed_at IS NULL</c>.
    /// </remarks>
    public bool Take(string? nonce, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(nonce))
        {
            return false;
        }

        if (!_pending.TryRemove(nonce, out var expires))
        {
            return false;
        }

        return expires > now;
    }

    /// <summary>How many are outstanding. For tests and diagnostics.</summary>
    public int Count => _pending.Count;

    private void Sweep(DateTimeOffset now)
    {
        foreach (var pair in _pending)
        {
            if (pair.Value <= now)
            {
                _pending.TryRemove(pair.Key, out _);
            }
        }
    }
}
