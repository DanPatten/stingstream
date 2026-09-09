using System;
using System.Collections.Generic;
using System.Linq;

namespace StingStream.Core.Invites;

/// <summary>What an invite token may do, right now.</summary>
public enum InviteStatus
{
    /// <summary>Go ahead: this token names a live invite.</summary>
    Valid,

    /// <summary>No invite has ever had this token.</summary>
    Unknown,

    /// <summary>The administrator withdrew it.</summary>
    Revoked,

    /// <summary>Somebody already made an account with it. An invite is for one person.</summary>
    AlreadyUsed,

    /// <summary>Its day has passed.</summary>
    Expired,
}

/// <summary>
/// Enough of an invite to judge it. Deliberately not the storage row.
/// </summary>
/// <param name="ExpiresAt">When it stops working, or <see langword="null"/> for never.</param>
/// <param name="RedeemedAt">When somebody used it, or <see langword="null"/>.</param>
/// <param name="RevokedAt">When the administrator withdrew it, or <see langword="null"/>.</param>
/// <remarks>
/// The gate takes this rather than an <see cref="InviteRow"/> so the decision can be tested without
/// a database, and so that adding a column to the row cannot quietly change who is let in.
/// </remarks>
public readonly record struct InviteState(
    DateTimeOffset? ExpiresAt,
    DateTimeOffset? RedeemedAt,
    DateTimeOffset? RevokedAt);

/// <summary>
/// Whether an invite may be redeemed, and the rules a new one is held to.
/// </summary>
/// <remarks>
/// <para>
/// The whole decision behind <c>POST /stingstream/api/v1/invites/accept</c>, as one pure function,
/// for the reason <see cref="FirstRun.SetupGate"/> gives: this suite has no HTTP harness by design,
/// and this is the code that must never be wrong. An invite creates an account on somebody's
/// server, so "is this token still good" is the entire door policy.
/// </para>
/// <para>
/// <b>Single-use and expiry are real here in a way they could not be for a group invite.</b> A
/// node-to-node invite carries the group secret, and the secret <em>is</em> the credential — there
/// is no admitting party, so nobody is in a position to say "that one is spent" (docs/MESH.md, and
/// Part 3 of the plan records why it was dropped). A person invite is different: the server is the
/// admitting party, it holds the row, and it decides. So both are enforced, and this is where.
/// </para>
/// <para>
/// <b>Why a spent token is told what happened, rather than being met with a flat "no such
/// invite".</b> The usual reason to blur those two answers is that the difference tells a prober
/// something. Here it cannot: learning that a particular 256-bit string was once an invite requires
/// already holding that string, and anybody holding it is the person the link was sent to. What
/// they get in exchange is the difference between "this invite has already been used — ask for
/// another" and a dead end, which is the difference between a person getting an account and a
/// person giving up. A token that never existed still gets nothing, because there is nobody on the
/// other end of it to help.
/// </para>
/// </remarks>
public static class InviteGate
{
    /// <summary>Bytes of randomness in a token. 256 bits; see <c>InviteService.NewToken</c>.</summary>
    public const int TokenBytes = 32;

    /// <summary>Longest username an invite may carry.</summary>
    /// <remarks>
    /// The same bound the first-run screen uses, because it is now the same thing: the value in
    /// this field becomes an account name on this server. See <see cref="ValidateMint"/> for why it
    /// stopped being a free-text note.
    /// </remarks>
    public const int MaxLabelLength = FirstRun.SetupGate.MaxUsernameLength;

    /// <summary>
    /// What is stored in <c>expires_at</c> for an invite that does not expire.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Dan: <em>"these all work indefinetly until revoked - no short term links."</em> So a new
    /// invite has no expiry at all — it works until somebody deletes it.
    /// </para>
    /// <para>
    /// <b>Why a sentinel rather than a null column.</b> <c>invites.expires_at</c> is
    /// <c>TEXT NOT NULL</c>, and <see cref="InviteStore"/>'s DDL is <c>IF NOT EXISTS</c>-only by
    /// design (<c>docs/CONTRIBUTING.md</c> rule 2 — it deliberately does not move
    /// <c>CoreDatabase.SchemaVersion</c>), so there is no mechanism here to relax the constraint on
    /// a database that already exists. Writing a date no invite can outlive says the same thing in
    /// a column that already accepts it, and <see cref="IsNever"/> reads it back as "never".
    /// </para>
    /// <para>
    /// <b>Rows minted before this keep their real expiry and still expire.</b> Dropping the check
    /// outright would bring somebody's long-dead invite back to life, which is the one outcome
    /// nobody asked for — so <see cref="InviteStatus.Expired"/> stays, and simply stops being
    /// reachable for anything minted from here on.
    /// </para>
    /// </remarks>
    public static readonly DateTimeOffset NeverExpires = DateTimeOffset.MaxValue;

    /// <summary>Anything at or past this is the <see cref="NeverExpires"/> sentinel.</summary>
    /// <remarks>
    /// A range rather than an equality, because a timestamp round-trips through
    /// <c>ToString("O")</c> and back carrying its own precision and offset, and an exact comparison
    /// would turn a rounding difference into "this invite expired in the year 9999". Nothing
    /// legitimate lands in the fourth millennium.
    /// </remarks>
    public static readonly DateTimeOffset NeverThreshold = new(4000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    /// <summary>Whether a stored expiry means "this invite does not expire".</summary>
    /// <param name="expiresAt">What the row holds.</param>
    /// <returns>True when it is the sentinel.</returns>
    public static bool IsNever(DateTimeOffset expiresAt) => expiresAt >= NeverThreshold;

    /// <summary>Most libraries one invite may name.</summary>
    /// <remarks>
    /// Not a policy so much as a bound on a list that arrives from the network and is stored as
    /// JSON. A server with more than this many libraries is possible; an invite that names more
    /// than this many is somebody sending a large array to see what happens.
    /// </remarks>
    public const int MaxLibraries = 64;

    /// <summary>Whether this invite may still be redeemed.</summary>
    /// <param name="invite">The invite, or <see langword="null"/> when no row matched the token.</param>
    /// <param name="now">The current time.</param>
    /// <returns>The status.</returns>
    /// <remarks>
    /// <para>
    /// The order is revoked, then used, then expired, and it decides only what a person is
    /// <em>told</em> — every one of them refuses. It is ordered by what is most worth knowing:
    /// revoked is a decision somebody made and could unmake, used means the link already did its
    /// job (usually the sender is looking at the account it created), and expired is the one that
    /// merely happened. An invite can be all three at once, and the first of those is the useful
    /// sentence.
    /// </para>
    /// <para>
    /// Expiry is <c>&gt;=</c> rather than <c>&gt;</c>: an invite whose life has run out exactly now
    /// is over. The boundary is arbitrary but it has to be somewhere, and this is the direction
    /// that never lets one live a moment longer than it was given.
    /// </para>
    /// <para>
    /// A <see langword="null"/> <see cref="InviteState.ExpiresAt"/> means the invite does not
    /// expire, which is what everything minted since <see cref="NeverExpires"/> arrived carries.
    /// The check is skipped rather than deleted, so older rows with a real date still run out.
    /// </para>
    /// </remarks>
    public static InviteStatus Decide(InviteState? invite, DateTimeOffset now)
    {
        if (invite is not { } state)
        {
            return InviteStatus.Unknown;
        }

        if (state.RevokedAt is not null)
        {
            return InviteStatus.Revoked;
        }

        if (state.RedeemedAt is not null)
        {
            return InviteStatus.AlreadyUsed;
        }

        if (state.ExpiresAt is { } expires && now >= expires)
        {
            return InviteStatus.Expired;
        }

        return InviteStatus.Valid;
    }

    /// <summary>One sentence for the person who was refused, or <see langword="null"/> when they were not.</summary>
    /// <param name="status">The status.</param>
    /// <returns>The sentence.</returns>
    /// <remarks>
    /// Written for somebody who has just clicked a link and has no idea what any of this is, so
    /// every one of them says what to do next rather than only what went wrong.
    /// </remarks>
    public static string? Explain(InviteStatus status) => status switch
    {
        InviteStatus.Valid => null,
        InviteStatus.Revoked => "This invite was withdrawn. Ask whoever sent it for a new one.",
        InviteStatus.AlreadyUsed => "This invite has already been used. Ask whoever sent it for a new one.",
        InviteStatus.Expired => "This invite has expired. Ask whoever sent it for a new one.",
        _ => "This invite link is not valid.",
    };

    /// <summary>Why this invite cannot be minted, or <see langword="null"/> when it can.</summary>
    /// <param name="username">The name the invited person's account will get. Optional.</param>
    /// <param name="libraries">The libraries the invited person will be able to see.</param>
    /// <returns>One sentence, or <see langword="null"/>.</returns>
    /// <remarks>
    /// <para>
    /// <b>The name is no longer a private note.</b> It used to be the administrator's own label
    /// — "Mum", "Ben's TV" — shown back to them and to nobody else. Dan: <em>"owner sets
    /// username - can be changed when accepting the invite."</em> So it is the account name the
    /// invited person arrives with, pre-filled on the landing page and still theirs to change, and
    /// it is held to the rules a name is held to everywhere else on this server rather than to a
    /// length bound. Catching it here means the mistake surfaces while the inviter is still looking
    /// at the form, not when somebody else opens the link.
    /// </para>
    /// <para>
    /// <b>Blank is allowed and means "let them choose".</b> An inviter who does not care what the
    /// account is called should not have to invent a name, and the landing page simply opens with
    /// an empty field — which is what it did before this existed.
    /// </para>
    /// <para>
    /// <b>An empty library list is refused.</b> It would mint a working invite to an account that
    /// can see nothing, which looks like a bug on the other end and reads as a snub. If the
    /// intention really is an account with no access, the administrator can make one and say so.
    /// </para>
    /// <para>
    /// A duplicate in the list is not an error — it is what a picker produces when somebody
    /// double-taps — and <see cref="NormaliseLibraries"/> quietly removes it.
    /// </para>
    /// </remarks>
    public static string? ValidateMint(string? username, IReadOnlyCollection<Guid>? libraries)
    {
        if (!string.IsNullOrWhiteSpace(username)
            && FirstRun.SetupGate.ValidateUsername(username) is { } problem)
        {
            return problem;
        }

        var chosen = NormaliseLibraries(libraries);
        if (chosen.Count == 0)
        {
            return "Choose at least one library to share.";
        }

        if (chosen.Count > MaxLibraries)
        {
            return $"An invite can name at most {MaxLibraries} libraries.";
        }

        return null;
    }

    /// <summary>The libraries an invite actually grants: no duplicates, no empty ids, in order.</summary>
    /// <param name="libraries">What the caller sent.</param>
    /// <returns>The list to store.</returns>
    /// <remarks>
    /// The all-zero GUID is dropped rather than stored. It is what a missing value parses to, it
    /// names no library, and a list containing it would look like access to something.
    /// </remarks>
    public static IReadOnlyList<Guid> NormaliseLibraries(IReadOnlyCollection<Guid>? libraries)
    {
        if (libraries is null || libraries.Count == 0)
        {
            return Array.Empty<Guid>();
        }

        return libraries.Where(id => !id.Equals(Guid.Empty)).Distinct().ToArray();
    }
}
