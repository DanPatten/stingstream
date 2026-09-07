using System;
using System.Net;

namespace StingStream.Core.FirstRun;

/// <summary>What a first-run setup request may do.</summary>
public enum SetupAccess
{
    /// <summary>Go ahead: setup is pending and the caller is somewhere this node trusts.</summary>
    Allow,

    /// <summary>This node already has an account. Answer 409.</summary>
    NotPending,

    /// <summary>
    /// The caller is off this network. Answer 404, as if the route did not exist.
    /// </summary>
    NotLocal,
}

/// <summary>
/// The whole decision behind <c>POST /stingstream/api/v1/setup/admin</c>, as one pure function.
/// </summary>
/// <remarks>
/// <para>
/// Separated from the controller because the decision is the part worth testing and the controller
/// is the part that cannot be: <c>tests/StingStream.Core.Tests</c> has no HTTP harness, by design.
/// <see cref="Decide"/> is what <c>SetupGateTests</c> exercises.
/// </para>
/// <para>
/// <b>Not local wins over not pending.</b> A caller off this network gets the same answer whatever
/// state the node is in — 404, indistinguishable from the endpoint not existing — so a stranger
/// cannot use the difference between 404 and 409 to learn whether a node they can reach is still
/// unclaimed. Somebody on the network gets the truthful 409 instead, because they are the person
/// who has to act on it.
/// </para>
/// <para>
/// <b>What counts as trusted, and why it is the network rather than the machine.</b> The first
/// version of this took loopback only, on the reasoning that whoever is at the keyboard of the
/// machine running the server already has its files. True, and too narrow to be usable: a node is
/// a box in a cupboard, and the person setting it up is on the sofa with a phone. So the trusted
/// set is this network — loopback, RFC 1918 (<c>10/8</c>, <c>172.16/12</c>, <c>192.168/16</c>),
/// link-local (<c>169.254/16</c>, <c>fe80::/10</c>) and IPv6 unique local addresses
/// (<c>fc00::/7</c>) — and everything else is refused. That is a deliberate trade: for the minutes
/// a fresh node is unclaimed, anybody already on the household Wi-Fi can claim it. They can also
/// unplug it. What they cannot do is reach it from the internet, which is the line that matters
/// and the one <see cref="IsTrustedPeer"/> draws.
/// </para>
/// </remarks>
public static class SetupGate
{
    /// <summary>Longest username this endpoint accepts.</summary>
    /// <remarks>
    /// The server underneath allows more — word characters, spaces, apostrophes, <c>@</c> and
    /// <c>+</c>, with no length limit. This is the deliberately narrower set the first-run screen
    /// offers, chosen so that a name accepted here is always one the rename underneath accepts too.
    /// </remarks>
    public const int MaxUsernameLength = 32;

    /// <summary>Shortest password this endpoint accepts.</summary>
    public const int MinPasswordLength = 8;

    /// <summary>Whether this request may create the first account.</summary>
    /// <param name="pending">Whether the node is still waiting for its first account.</param>
    /// <param name="isTrustedPeer">
    /// Whether the caller is somewhere this node trusts — see <see cref="IsTrustedPeer"/>.
    /// </param>
    /// <returns>The decision.</returns>
    public static SetupAccess Decide(bool pending, bool isTrustedPeer)
    {
        if (!isTrustedPeer)
        {
            return SetupAccess.NotLocal;
        }

        return pending ? SetupAccess.Allow : SetupAccess.NotPending;
    }

    /// <summary>
    /// Whether an address is on this machine or this network, rather than out on the internet.
    /// </summary>
    /// <param name="address">
    /// The caller's address, or <see langword="null"/> for an in-process caller.
    /// </param>
    /// <returns>True when the address is one the first-run screen may be used from.</returns>
    /// <remarks>
    /// <para>
    /// An allow-list, not a deny-list: an address this does not recognise is refused. That is the
    /// direction that fails safe, and it is why the ranges are spelled out rather than left to
    /// "is it public?", which .NET has no single honest answer for.
    /// </para>
    /// <para>
    /// A <see langword="null"/> address means an in-process or unix-socket caller, which is at
    /// least as trusted as loopback. An IPv4 address arriving over a dual-stack socket is mapped
    /// into v6 space, so it is unmapped first — without that, <c>::ffff:192.168.0.16</c> would fall
    /// through every v4 range and be refused as though it came from the internet.
    /// </para>
    /// <para>
    /// Carrier-grade NAT (<c>100.64/10</c>) is deliberately <em>not</em> here. It looks private and
    /// is not: it is the address space an ISP shares between its subscribers, so somebody else's
    /// house can be on the other side of it.
    /// </para>
    /// </remarks>
    public static bool IsTrustedPeer(IPAddress? address)
    {
        if (address is null)
        {
            return true;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return b[0] switch
            {
                10 => true,                                  // 10.0.0.0/8
                172 => b[1] >= 16 && b[1] <= 31,             // 172.16.0.0/12
                192 => b[1] == 168,                          // 192.168.0.0/16
                169 => b[1] == 254,                          // 169.254.0.0/16, link-local
                _ => false,
            };
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal)
            {
                // fe80::/10
                return true;
            }

            // fc00::/7 -- unique local addresses. IPAddress has no predicate for these; the top
            // seven bits are the whole of the definition.
            var b = address.GetAddressBytes();
            return (b[0] & 0xFE) == 0xFC;
        }

        return false;
    }

    /// <summary>
    /// Why this username cannot be used, or <see langword="null"/> when it can.
    /// </summary>
    /// <param name="username">The name somebody typed.</param>
    /// <returns>One sentence for the user, or <see langword="null"/>.</returns>
    public static string? ValidateUsername(string? username)
    {
        if (string.IsNullOrWhiteSpace(username))
        {
            return "Choose a name for your account.";
        }

        if (username.Length > MaxUsernameLength)
        {
            return $"A name can be at most {MaxUsernameLength} characters.";
        }

        foreach (var c in username)
        {
            if (!char.IsLetterOrDigit(c) && c != '.' && c != '_' && c != '-')
            {
                return "A name can only use letters, digits, dots, underscores and dashes.";
            }
        }

        return null;
    }

    /// <summary>
    /// Why this password cannot be used, or <see langword="null"/> when it can.
    /// </summary>
    /// <param name="password">The password somebody typed.</param>
    /// <returns>One sentence for the user, or <see langword="null"/>.</returns>
    /// <remarks>
    /// Length only, and no upper bound: a rule that demands a digit and a capital produces
    /// <c>Password1</c>, and a passphrase somebody will remember is worth more than a shape.
    /// Confirming the password is the screen's job, not this endpoint's.
    /// </remarks>
    public static string? ValidatePassword(string? password)
    {
        if (string.IsNullOrEmpty(password) || password.Length < MinPasswordLength)
        {
            return $"A password needs at least {MinPasswordLength} characters.";
        }

        return null;
    }

    /// <summary>The first thing wrong with these credentials, or <see langword="null"/>.</summary>
    /// <param name="username">The name somebody typed.</param>
    /// <param name="password">The password somebody typed.</param>
    /// <returns>One sentence for the user, or <see langword="null"/>.</returns>
    public static string? Validate(string? username, string? password)
        => ValidateUsername(username) ?? ValidatePassword(password);
}
