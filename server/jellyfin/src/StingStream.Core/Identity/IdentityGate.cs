using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace StingStream.Core.Identity;

/// <summary>
/// The decisions behind signing in with your own server, with nothing else attached.
/// </summary>
/// <remarks>
/// Pure and static for the same reason <see cref="Invites.InviteGate"/> and
/// <c>FirstRun.SetupGate</c> are: these are rules, they are the part worth pinning, and pinning
/// them should not need a database, an HTTP harness or Jellyfin's user manager.
/// <c>IdentityGateTests</c> is where they are pinned.
/// </remarks>
public static class IdentityGate
{
    /// <summary>How long a challenge stays answerable.</summary>
    /// <remarks>
    /// Five minutes, the same window <c>PasskeyCeremonies.Lifetime</c> uses, and for the same
    /// reason: long enough to sign in on another device, short enough that a browser left open on
    /// a shared machine is not an open door.
    /// </remarks>
    public static readonly TimeSpan ChallengeLifetime = TimeSpan.FromMinutes(5);

    /// <summary>
    /// How many challenges may be outstanding before new ones are refused.
    /// </summary>
    /// <remarks>
    /// <c>challenge</c> is anonymous, so anybody who can reach the server can ask for one. Each is
    /// a few dozen bytes and expires on its own, but "expires on its own" is not a bound — a loop
    /// issuing them faster than they expire is. Same bound, and the same reasoning, as
    /// <c>PasskeyCeremonies.MaxOutstanding</c>.
    /// </remarks>
    public const int MaxOutstandingChallenges = 2000;

    /// <summary>Bytes of randomness in a challenge.</summary>
    /// <remarks>
    /// The nonce is not a credential — it authorises nothing on its own and is useless without a
    /// signature over it from a node key. It only has to be unguessable enough that an attacker
    /// cannot make somebody's own server sign an assertion against a nonce the attacker chose, so
    /// 128 bits is generous rather than tight.
    /// </remarks>
    public const int ChallengeBytes = 16;

    /// <summary>
    /// The separator between a name and the server it came from.
    /// </summary>
    /// <remarks>
    /// <b>Not <c>@</c>, which is what this reads as and what it cannot be.</b>
    /// <c>FirstRun.SetupGate.ValidateUsername</c> allows letters, digits, dots, underscores and
    /// dashes and nothing else — a rule the sign-in form, the invite form and the first-run screen
    /// all hold people to. An account named <c>sam@loft</c> would be one nobody could re-type,
    /// nobody could rename to itself, and our own validator would refuse. A dot says the same
    /// thing in characters the whole product already accepts.
    /// </remarks>
    public const char ServerSeparator = '.';

    /// <summary>
    /// What to call an account for somebody arriving from another server.
    /// </summary>
    /// <param name="preferred">Their username on their own server.</param>
    /// <param name="serverName">That server's friendly name.</param>
    /// <param name="issuerNodeId">That server's node id, for the last resort.</param>
    /// <param name="taken">Whether a name is already in use here.</param>
    /// <returns>A name that is free and legal, or <see langword="null"/> if none could be found.</returns>
    /// <remarks>
    /// <para>
    /// Dan chose the shape: <em>their name, qualified if taken</em>. So <c>sam</c> if it is free,
    /// <c>sam.loft</c> if it is not, and only then anything uglier.
    /// </para>
    /// <para>
    /// <b>Every candidate is sanitised, not just checked.</b> The name and the server name both
    /// come from another machine, and neither has been held to this server's character rules. A
    /// name that arrives illegal is trimmed to what is legal rather than refused: refusing would
    /// mean somebody cannot sign in here because of what they called their server.
    /// </para>
    /// <para>
    /// <b>It terminates.</b> The last candidates append the issuing node's id, which is unique per
    /// server, and then a counter — so two people called <c>sam</c> on two servers both get a name,
    /// and the same person always gets the same one.
    /// </para>
    /// </remarks>
    public static string? ChooseUsername(
        string? preferred,
        string? serverName,
        string? issuerNodeId,
        Func<string, bool> taken)
    {
        ArgumentNullException.ThrowIfNull(taken);

        // Reserved names count as taken. They are, in practice, on any server that has ever had an
        // administrator -- this just makes the rule not depend on that.
        bool unavailable(string candidate) => IsReserved(candidate) || taken(candidate);

        var name = Sanitise(preferred);
        if (name.Length == 0)
        {
            // They have no usable name at all. "someone" is a placeholder they can change, and it
            // is better than refusing a sign-in over a character set.
            name = "someone";
        }

        if (!unavailable(name))
        {
            return name;
        }

        var server = Sanitise(serverName);
        if (server.Length > 0)
        {
            var qualified = Fit(name, server);
            if (!unavailable(qualified))
            {
                return qualified;
            }
        }

        // The node id is unique per server, so this can only collide with the same person arriving
        // twice -- which is not a collision, it is a hit on the link table before we ever get here.
        var suffix = Sanitise(issuerNodeId);
        if (suffix.Length >= 8)
        {
            var byNode = Fit(name, suffix[..8]);
            if (!unavailable(byNode))
            {
                return byNode;
            }
        }

        for (var i = 2; i < 100; i++)
        {
            var numbered = Fit(name, i.ToString(CultureInfo.InvariantCulture));
            if (!unavailable(numbered))
            {
                return numbered;
            }
        }

        return null;
    }

    /// <summary>Keep only what a username may contain, and cap the length.</summary>
    private static string Sanitise(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return string.Empty;
        }

        var sb = new StringBuilder(raw.Length);
        foreach (var c in raw.Trim())
        {
            if (char.IsLetterOrDigit(c) || c == '.' || c == '_' || c == '-')
            {
                sb.Append(c);
            }
            else if (c == ' ')
            {
                // A space is the one illegal character with an obvious intent behind it: "Loft
                // Server" should become "loft-server", not "loftserver".
                sb.Append('-');
            }
        }

        // Leading and trailing separators are what the two rules above leave behind on something
        // like " (loft) " and read as a typo in every screen that shows the name.
        var cleaned = sb.ToString().Trim('.', '_', '-');
        return cleaned.Length > FirstRun.SetupGate.MaxUsernameLength
            ? cleaned[..FirstRun.SetupGate.MaxUsernameLength]
            : cleaned;
    }

    /// <summary>Join a name and a qualifier, trimming the name if the pair is too long.</summary>
    /// <remarks>
    /// <para>
    /// The qualifier is what makes the name unique, so it is the half that must survive intact; a
    /// truncated one could collide with a different server's. The name is trimmed instead.
    /// </para>
    /// <para>
    /// <b>The qualifier is lowercased and the name is not.</b> The name is what somebody calls
    /// themselves and their capitalisation is theirs to keep; the qualifier is a tag this code
    /// derived from a server name, and <c>sam.Loft</c> reads as a mistake where <c>sam.loft</c>
    /// reads as a suffix. Jellyfin normalises usernames for comparison anyway, so this changes how
    /// it looks and not who it is.
    /// </para>
    /// </remarks>
    private static string Fit(string name, string qualifierRaw)
    {
        var qualifier = qualifierRaw.ToLowerInvariant();
        var room = FirstRun.SetupGate.MaxUsernameLength - qualifier.Length - 1;
        if (room < 1)
        {
            // Nothing sensible left of the name. Return the qualifier alone rather than an
            // empty-ish fragment; it is still unique, which is the job.
            return qualifier[..Math.Min(qualifier.Length, FirstRun.SetupGate.MaxUsernameLength)];
        }

        var head = name.Length > room ? name[..room] : name;
        return string.Concat(head, ServerSeparator.ToString(), qualifier);
    }

    /// <summary>
    /// Why this assertion cannot be turned into a session, or <see langword="null"/> when it can.
    /// </summary>
    /// <param name="verified">Whether the mesh confirmed the signature and the audience.</param>
    /// <param name="challengeMatched">Whether the nonce was one we issued and had not spent.</param>
    /// <param name="linkedUserId">The account already linked to this identity, or null.</param>
    /// <param name="inviteAccepted">Whether a live invite came with it.</param>
    /// <returns>One sentence, or <see langword="null"/>.</returns>
    /// <remarks>
    /// <para>
    /// The order matters. A bad signature is reported before a spent nonce, because an assertion
    /// that was never genuine should not be told which of our nonces it missed.
    /// </para>
    /// <para>
    /// <b>The last rule is the one that matters.</b> A genuine assertion from a server we have
    /// never heard of is not, on its own, permission to have an account here — otherwise anybody
    /// who runs StingStream could sign in to any StingStream server in the world. It has to arrive
    /// with an invite the first time. After that the link exists and the invite is spent.
    /// </para>
    /// </remarks>
    public static string? DecideSignIn(
        bool verified,
        bool challengeMatched,
        string? linkedUserId,
        bool inviteAccepted)
    {
        if (!verified)
        {
            return "That sign-in could not be verified. Try again from your own server.";
        }

        if (!challengeMatched)
        {
            return "That sign-in has already been used or has expired. Try again.";
        }

        if (!string.IsNullOrEmpty(linkedUserId))
        {
            return null;
        }

        return inviteAccepted
            ? null
            : "You do not have an account on this server yet. Ask for an invite link.";
    }

    /// <summary>Whether two node ids name the same server.</summary>
    /// <remarks>
    /// Case-insensitive because a node id is hex and both cases are the same value, and one of
    /// these comes off the wire while the other came out of a database.
    /// </remarks>
    public static bool SameNode(string? a, string? b)
        => !string.IsNullOrWhiteSpace(a)
            && !string.IsNullOrWhiteSpace(b)
            && string.Equals(a.Trim(), b.Trim(), StringComparison.OrdinalIgnoreCase);

    /// <summary>The key a link is stored under: one identity on one server.</summary>
    /// <param name="issuerNodeId">The other server's node id.</param>
    /// <param name="remoteUserId">Their user id there.</param>
    /// <returns>The key.</returns>
    public static string LinkKey(string issuerNodeId, string remoteUserId)
        => string.Concat(
            (issuerNodeId ?? string.Empty).Trim().ToLowerInvariant(),
            "/",
            (remoteUserId ?? string.Empty).Trim());

    /// <summary>Names that must never be handed to an arriving identity.</summary>
    /// <remarks>
    /// Not a security control — <see cref="ChooseUsername"/> already refuses any name that is
    /// taken, and these are taken the moment they exist. It is a readability one: an account called
    /// <c>admin</c> created by somebody else's server is a name nobody should have to reason about.
    /// </remarks>
    public static readonly IReadOnlyList<string> ReservedNames = new[] { "admin", "administrator", "root" };

    /// <summary>Whether a name is one an arriving identity may never be given.</summary>
    /// <param name="name">The candidate.</param>
    /// <returns>True when it is reserved.</returns>
    public static bool IsReserved(string? name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return false;
        }

        foreach (var reserved in ReservedNames)
        {
            if (string.Equals(name.Trim(), reserved, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>The most PBKDF2 rounds this server will record for a derived password.</summary>
    /// <remarks>
    /// A ceiling rather than a fixed value, because the number is the client's to choose and it is
    /// stored so raising the default cannot lock out anybody who linked before the change. The cap
    /// is here because the round count comes off the wire and is handed back out to whoever asks
    /// how to sign in -- an absurd one would be a way to make every client burn a minute of CPU on
    /// a sign-in that was never going to work.
    /// </remarks>
    public const int MaxPasswordIterations = 5_000_000;

    /// <summary>The fewest, below which the derivation is not worth doing.</summary>
    public const int MinPasswordIterations = 1_000;

    /// <summary>
    /// Whether a sign-in carried a usable derived password, and what to store for it.
    /// </summary>
    /// <param name="salt">The salt from the request.</param>
    /// <param name="verifier">The derived password from the request.</param>
    /// <param name="iterations">The round count from the request.</param>
    /// <returns>The three of them, cleaned, or null when there is nothing usable.</returns>
    /// <remarks>
    /// <b>All three or none.</b> A salt with no verifier is a password nobody can reproduce; a
    /// verifier with no round count cannot be derived again once the client's default moves. Either
    /// half would leave somebody holding an account they can never sign in to, and the account is
    /// created either way -- so a partial is treated as an older client sending none at all, which
    /// keeps the password nobody knows and leaves their own server as the way in.
    /// </remarks>
    public static (string Salt, string Verifier, int Iterations)? ReadCredential(
        string? salt,
        string? verifier,
        int? iterations)
    {
        var cleanSalt = (salt ?? string.Empty).Trim();
        var cleanVerifier = (verifier ?? string.Empty).Trim();
        var rounds = iterations ?? 0;

        if (cleanSalt.Length == 0
            || cleanVerifier.Length == 0
            || rounds < MinPasswordIterations
            || rounds > MaxPasswordIterations)
        {
            return null;
        }

        return (cleanSalt, cleanVerifier, rounds);
    }

    /// <summary>What to tell a client asking how to send a password for one username.</summary>
    /// <param name="salt">The salt on that account's link row, or null when it has none.</param>
    /// <param name="iterations">The round count on it.</param>
    /// <returns>The answer to send.</returns>
    /// <remarks>
    /// <b>An ordinary account, an account nobody holds and a linked account that has been reset all
    /// answer identically.</b> That is the whole shape of it: this is answered anonymously, because
    /// the client asking has not signed in yet, so anything that varied with whether the username
    /// exists would be a way to find out who has an account here. What it does tell somebody who
    /// already holds a username is that it arrived from another server, which is the price of the
    /// account being usable at all.
    /// </remarks>
    public static SignInMethodResponse DescribeSignIn(string? salt, int iterations)
    {
        var cleanSalt = (salt ?? string.Empty).Trim();
        if (cleanSalt.Length == 0
            || iterations < MinPasswordIterations
            || iterations > MaxPasswordIterations)
        {
            return new SignInMethodResponse { Derived = false };
        }

        return new SignInMethodResponse
        {
            Derived = true,
            Salt = cleanSalt,
            Iterations = iterations,
        };
    }
}
