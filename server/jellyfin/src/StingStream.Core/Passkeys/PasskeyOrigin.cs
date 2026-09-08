using System;

namespace StingStream.Core.Passkeys;

/// <summary>Where a passkey on this server is bound.</summary>
/// <param name="Domain">The relying-party id: the host, with no scheme and no port.</param>
/// <param name="Origin">The full origin a ceremony must come from.</param>
public readonly record struct PasskeyRelyingParty(string Domain, string Origin);

/// <summary>Why this server cannot offer passkeys, or that it can.</summary>
public enum PasskeySupport
{
    /// <summary>It can.</summary>
    Supported,

    /// <summary>Nobody has pointed a domain at this server.</summary>
    NoAddress,

    /// <summary>The address is an IP, or plain http, or a single label.</summary>
    NotADomain,
}

/// <summary>
/// Whether this server can offer passkeys, and what they would be bound to.
/// </summary>
/// <remarks>
/// <para>
/// A passkey is bound to a **relying-party id**, and the browser refuses any ceremony whose page is
/// not on that domain. So the question "can this server do passkeys" is really "does this server
/// have a domain", and the answer is a pure function of the address its owner set. Which is why it
/// is a static here rather than a branch inside the service: it is the whole policy, and this suite
/// has no HTTP harness (see <see cref="FirstRun.SetupGate"/>).
/// </para>
/// <para>
/// <b>Passkeys are per server, and that is an improvement rather than a limitation.</b> The version
/// that was deleted bound them to one shared hostname, which meant every passkey anybody registered
/// would have silently stopped working the day that service moved. Bound to your own domain there
/// is nothing to move, and a domain arriving later invalidates nothing — because there were no
/// passkeys before it.
/// </para>
/// <para>
/// <b>Why <c>localhost</c> is refused even though the browser would allow it.</b> It is a secure
/// context, so a ceremony there really would work. Two reasons not to. A passkey bound to
/// <c>localhost</c> is shared with every other thing that has ever run on that machine's
/// <c>localhost</c> — the relying-party id is the whole of the isolation, and "localhost" isolates
/// nothing. And it can never be used from anywhere else, so its owner would register one, watch it
/// work, and find it gone the first time they opened the server from their phone. A credential that
/// works exactly once, at the keyboard, is worse than a clear "you need a domain for this".
/// </para>
/// </remarks>
public static class PasskeyOrigin
{
    /// <summary>Whether this address can carry passkeys, and what they bind to.</summary>
    /// <param name="publicAddress">The address the server's owner set, or null.</param>
    /// <returns>The support answer, and the relying party when there is one.</returns>
    public static (PasskeySupport Support, PasskeyRelyingParty? Party) For(string? publicAddress)
    {
        var raw = publicAddress?.Trim();
        if (string.IsNullOrEmpty(raw))
        {
            return (PasskeySupport.NoAddress, null);
        }

        // The node stores an origin, but be forgiving about a bare hostname: this value has been
        // typed by hand into a settings field and the scheme is the part people leave off.
        var withScheme = raw.Contains("://", StringComparison.Ordinal) ? raw : "https://" + raw;
        if (!Uri.TryCreate(withScheme, UriKind.Absolute, out var url))
        {
            return (PasskeySupport.NotADomain, null);
        }

        if (!string.Equals(url.Scheme, "https", StringComparison.OrdinalIgnoreCase))
        {
            // WebAuthn needs a secure context, and every rule below assumes one.
            return (PasskeySupport.NotADomain, null);
        }

        var host = url.Host.Trim('[', ']');
        if (host.Length == 0
            || url.HostNameType is UriHostNameType.IPv4 or UriHostNameType.IPv6
            || !host.Contains('.', StringComparison.Ordinal)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase))
        {
            return (PasskeySupport.NotADomain, null);
        }

        // The origin keeps the port; the relying-party id must not have one. That asymmetry is in
        // the spec and getting it wrong produces a ceremony the browser rejects with a message
        // about the relying party not matching the origin, which reads as a certificate problem.
        var origin = url.IsDefaultPort
            ? $"https://{host}"
            : $"https://{host}:{url.Port}";

        return (PasskeySupport.Supported, new PasskeyRelyingParty(host, origin));
    }

    /// <summary>One sentence for a screen deciding whether to draw the button.</summary>
    /// <param name="support">The support answer.</param>
    /// <returns>The sentence, or null when passkeys work.</returns>
    public static string? Explain(PasskeySupport support) => support switch
    {
        PasskeySupport.Supported => null,
        PasskeySupport.NoAddress =>
            "Passkeys need a domain pointed at this server. Add one under Sharing to turn them on.",
        _ =>
            "Passkeys need an https domain, not an IP address. Add one under Sharing to turn them on.",
    };
}
