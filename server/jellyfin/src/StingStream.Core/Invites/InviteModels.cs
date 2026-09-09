using System;
using System.Collections.Generic;

namespace StingStream.Core.Invites;

/// <summary>One invite, as it is stored.</summary>
/// <remarks>
/// <b>The token itself is not here.</b> What is stored is its SHA-256 hash, so a copy of
/// <c>core.db</c> — a backup, a support bundle, a stolen disk — cannot be turned back into a
/// working invite. The token exists exactly twice: in the response to the mint that created it, and
/// in the link the administrator sends. Losing it means minting another, which is the correct
/// answer and is one tap.
/// </remarks>
public sealed class InviteRow
{
    /// <summary>Opaque id, used in the administrator's own list and to revoke one.</summary>
    /// <remarks>
    /// Not the token and not derived from it: this one is safe to show on a screen, put in a URL
    /// and log. Revocation is addressed by this, never by the token, so withdrawing an invite never
    /// requires handling the credential again.
    /// </remarks>
    public string Id { get; set; } = string.Empty;

    /// <summary>Lowercase hex SHA-256 of the token.</summary>
    public string TokenHash { get; set; } = string.Empty;

    /// <summary>
    /// The token itself, while the invite is still live. Null once it has been redeemed.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Dan: <em>"allow the user to re-open the existing invite to get the url again"</em>. Losing
    /// the one copy of a link is an ordinary thing to do — a closed tab, a phone that did not
    /// receive the message — and answering it with "mint another" leaves a dead link in somebody
    /// else's chat.
    /// </para>
    /// <para>
    /// <b>This is a real trade and it is bounded on purpose.</b> A copy of <c>core.db</c> now
    /// yields working links for the invites nobody has used yet. What it does not yield is a
    /// history: the token is cleared the moment an account is created from it
    /// (<see cref="InviteStore.SetRedeemedUserAsync"/>), and deleting an invite takes the row with
    /// it. So the file holds exactly the live invites and nothing else, and the hash stays the
    /// thing redemption is checked against.
    /// </para>
    /// </remarks>
    public string? Token { get; set; }

    /// <summary>The account name the invited person will arrive with. May be empty.</summary>
    /// <remarks>
    /// <b>This is shown to somebody else.</b> It used to be a private note to whoever minted the
    /// invite; it is now the username the landing page pre-fills, and the invited person may change
    /// it before they accept. The column did not change and neither did its name — what changed is
    /// who reads it, which is worth knowing before writing anything here that was meant to stay on
    /// this side. Empty means "let them choose".
    /// </remarks>
    public string Label { get; set; } = string.Empty;

    /// <summary>The libraries the account will be able to see, and nothing else.</summary>
    public IReadOnlyList<Guid> Libraries { get; set; } = Array.Empty<Guid>();

    /// <summary>Whether this invite creates an administrator rather than a viewer.</summary>
    /// <remarks>
    /// <para>
    /// Dan: <em>"when inviting ask if they should be an admin or end user (default end user)"</em>.
    /// The default is the quiet one on purpose — a link that hands over the server should never be
    /// what you get by not answering a question.
    /// </para>
    /// <para>
    /// <b>An administrator invite ignores <see cref="Libraries"/>, and that is Jellyfin's rule
    /// rather than ours.</b> <c>IsAdministrator</c> is checked before folders are, so a library
    /// list on this kind of invite would be a promise the server does not keep.
    /// <see cref="InviteGate.ValidateMint"/> therefore stops requiring one, and
    /// <c>InviteService.ApplyLibraryScopeAsync</c> writes <c>EnableAllFolders</c> instead of a
    /// list.
    /// </para>
    /// </remarks>
    public bool IsAdministrator { get; set; }

    /// <summary>Jellyfin user id of the administrator who minted it.</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>Their name at the time, so the landing page can say who invited you.</summary>
    /// <remarks>
    /// Copied rather than looked up. The name is part of what the invite said when it was sent, and
    /// a rename afterwards should not retroactively change who a person believes invited them.
    /// </remarks>
    public string CreatedByName { get; set; } = string.Empty;

    /// <summary>When it was minted.</summary>
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>
    /// When it stops working. <see cref="InviteGate.NeverExpires"/> for an invite that does not.
    /// </summary>
    /// <remarks>
    /// Every invite minted since Dan asked for <em>"no short term links"</em> carries the sentinel;
    /// older rows carry a real date and still expire. <see cref="ToState"/> is where the two are
    /// told apart.
    /// </remarks>
    public DateTimeOffset ExpiresAt { get; set; }

    /// <summary>When somebody made an account with it, or null.</summary>
    public DateTimeOffset? RedeemedAt { get; set; }

    /// <summary>The account it created, or null.</summary>
    public string? RedeemedUserId { get; set; }

    /// <summary>The name they chose, or null.</summary>
    public string? RedeemedUserName { get; set; }

    /// <summary>When the administrator withdrew it, or null.</summary>
    public DateTimeOffset? RevokedAt { get; set; }

    /// <summary>This row as the gate sees it.</summary>
    /// <returns>The state.</returns>
    /// <remarks>
    /// The sentinel becomes <see langword="null"/> here rather than in the gate, so
    /// <see cref="InviteGate.Decide"/> never has to know how storage spells "never".
    /// </remarks>
    public InviteState ToState()
        => new(InviteGate.IsNever(ExpiresAt) ? null : ExpiresAt, RedeemedAt, RevokedAt);
}

/// <summary>One invite in the administrator's list.</summary>
public sealed class InviteSummary
{
    /// <summary>The id to revoke by.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>The account name it will create, or empty when the person chooses their own.</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>The libraries it grants. Empty for an administrator invite, which grants all.</summary>
    public IReadOnlyList<InviteLibrary> Libraries { get; set; } = Array.Empty<InviteLibrary>();

    /// <summary>Whether it creates an administrator.</summary>
    /// <remarks>
    /// In the list so a pending invite can say what it will do before anybody opens it. An
    /// administrator link is a much larger thing to have left in a chat history than a viewer one,
    /// and the only thing standing behind it is that it is single use.
    /// </remarks>
    public bool IsAdministrator { get; set; }

    /// <summary>Who minted it.</summary>
    public string CreatedByName { get; set; } = string.Empty;

    /// <summary>When it was minted, ISO 8601.</summary>
    public string CreatedAt { get; set; } = string.Empty;

    /// <summary>When it stops working, ISO 8601, or null when it does not.</summary>
    public string? ExpiresAt { get; set; }

    /// <summary><c>valid</c>, <c>expired</c>, <c>used</c> or <c>revoked</c>.</summary>
    public string Status { get; set; } = string.Empty;

    /// <summary>The name of the account it created, or null.</summary>
    public string? RedeemedUserName { get; set; }

    /// <summary>When that happened, ISO 8601, or null.</summary>
    public string? RedeemedAt { get; set; }
}

/// <summary>A library, named so a person can recognise it.</summary>
public sealed class InviteLibrary
{
    /// <summary>Jellyfin's collection-folder item id.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>What it is called.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary><c>movies</c>, <c>tvshows</c> and so on, or null when it has no type.</summary>
    public string? CollectionType { get; set; }
}

/// <summary>What an administrator asked for.</summary>
/// <remarks>
/// There is no <c>ExpiresInDays</c> any more. Dan: <em>"Remove how long the link works, these all
/// work indefinetly until revoked - no short term links."</em> A caller on an older build that
/// still sends one is not refused — the property simply is not bound, and the invite does not
/// expire, which is what the newer server means by the request either way.
/// </remarks>
public sealed class MintInviteRequest
{
    /// <summary>The name the invited person's account will get. Optional.</summary>
    public string? Label { get; set; }

    /// <summary>
    /// The libraries the invited person will see. At least one, unless
    /// <see cref="IsAdministrator"/> is set.
    /// </summary>
    public IReadOnlyList<Guid>? Libraries { get; set; }

    /// <summary>Make them an administrator of this server rather than a viewer.</summary>
    /// <remarks>
    /// Absent means <see langword="false"/>, which is what an older client sends and what it should
    /// mean: the default is the smaller grant.
    /// </remarks>
    public bool IsAdministrator { get; set; }
}

/// <summary>A freshly minted invite. The only time the token is ever returned.</summary>
public sealed class MintedInvite
{
    /// <summary>The token. Send the link, not this, unless there is no link to send.</summary>
    public string Token { get; set; } = string.Empty;

    /// <summary>The link to send. Null only when this server has no address at all.</summary>
    /// <remarks>
    /// Dan: <em>"After creating generate A FULL LINK to the server, if no domain is setup use the
    /// host's ip address for LAN and if there is a domain setup then use that instead."</em> So
    /// there is nearly always a link now — see <c>InviteService.LinkAsync</c>. Null survives for
    /// the one case that is genuinely address-less: a node bound to loopback with no domain, which
    /// is every harness node and nobody's actual server.
    /// </remarks>
    public string? Url { get; set; }

    /// <summary>
    /// Whether <see cref="Url"/> is a private address, so it only works on this network.
    /// </summary>
    /// <remarks>
    /// The screen says so, and offers to go and set a domain up. Silently handing somebody a
    /// <c>192.168.…</c> link to forward to their mother is how an invite fails at the far end for
    /// a reason neither person can see.
    /// </remarks>
    public bool UrlIsLan { get; set; }

    /// <summary>The invite as it now appears in the list.</summary>
    public InviteSummary Invite { get; set; } = new();
}

/// <summary>What the person who opened a link is told, before they have an account.</summary>
public sealed class InviteDescription
{
    /// <summary>The server's name, so the page can say where they are being invited.</summary>
    public string ServerName { get; set; } = string.Empty;

    /// <summary>Who invited them.</summary>
    public string InvitedBy { get; set; } = string.Empty;

    /// <summary>What they will be able to watch. Empty when the invite makes them an administrator.</summary>
    public IReadOnlyList<InviteLibrary> Libraries { get; set; } = Array.Empty<InviteLibrary>();

    /// <summary>Whether accepting makes them an administrator of this server.</summary>
    /// <remarks>
    /// Told to them before they are asked for anything, for the same reason the library list is:
    /// somebody should know what they are accepting while they can still decline it.
    /// </remarks>
    public bool IsAdministrator { get; set; }

    /// <summary>The name whoever invited them picked, or empty. Theirs to change.</summary>
    /// <remarks>
    /// Pre-filled rather than fixed, because Dan chose exactly that: <em>"owner sets username - can
    /// be changed when accepting the invite."</em> A name somebody else typed is a suggestion, and
    /// the person it belongs to is the one signing in with it.
    /// </remarks>
    public string Username { get; set; } = string.Empty;

    /// <summary>When the invite stops working, ISO 8601, or null when it does not.</summary>
    public string? ExpiresAt { get; set; }
}

/// <summary>The account somebody chose on an invite landing page.</summary>
public sealed class AcceptInviteRequest
{
    /// <summary>The token out of the link's fragment.</summary>
    public string? Token { get; set; }

    /// <summary>The name they want. Same rules as the first-run screen.</summary>
    public string? Username { get; set; }

    /// <summary>The password they chose. At least eight characters.</summary>
    public string? Password { get; set; }
}

/// <summary>A token, on its own, for the route that only looks one up.</summary>
public sealed class InviteTokenRequest
{
    /// <summary>The token out of the link's fragment.</summary>
    public string? Token { get; set; }
}

/// <summary>One sentence saying why an invite request was refused.</summary>
public sealed class InviteError
{
    /// <summary>The sentence, written for the person who is reading it.</summary>
    public string Error { get; set; } = string.Empty;
}
