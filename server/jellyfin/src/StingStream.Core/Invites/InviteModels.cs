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

    /// <summary>The administrator's own note. Shown to them, never to the invited person.</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>The libraries the account will be able to see, and nothing else.</summary>
    public IReadOnlyList<Guid> Libraries { get; set; } = Array.Empty<Guid>();

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

    /// <summary>When it stops working.</summary>
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
    public InviteState ToState() => new(ExpiresAt, RedeemedAt, RevokedAt);
}

/// <summary>One invite in the administrator's list.</summary>
public sealed class InviteSummary
{
    /// <summary>The id to revoke by.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>The administrator's own note.</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>The libraries it grants.</summary>
    public IReadOnlyList<InviteLibrary> Libraries { get; set; } = Array.Empty<InviteLibrary>();

    /// <summary>Who minted it.</summary>
    public string CreatedByName { get; set; } = string.Empty;

    /// <summary>When it was minted, ISO 8601.</summary>
    public string CreatedAt { get; set; } = string.Empty;

    /// <summary>When it stops working, ISO 8601.</summary>
    public string ExpiresAt { get; set; } = string.Empty;

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
public sealed class MintInviteRequest
{
    /// <summary>A note to themselves. Optional.</summary>
    public string? Label { get; set; }

    /// <summary>The libraries the invited person will see. At least one.</summary>
    public IReadOnlyList<Guid>? Libraries { get; set; }

    /// <summary>How long it should last. Clamped; zero means the default.</summary>
    public int ExpiresInDays { get; set; }
}

/// <summary>A freshly minted invite. The only time the token is ever returned.</summary>
public sealed class MintedInvite
{
    /// <summary>The token. Send the link, not this, unless there is no link to send.</summary>
    public string Token { get; set; } = string.Empty;

    /// <summary>
    /// The link to send, or null when this server has no address anybody could open.
    /// </summary>
    /// <remarks>
    /// Null is a real answer, not a failure: a server with no domain is reachable through the app
    /// and on its own network, and the token still works when typed in. The app shows the token in
    /// that case and says why.
    /// </remarks>
    public string? Url { get; set; }

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

    /// <summary>What they will be able to watch.</summary>
    public IReadOnlyList<InviteLibrary> Libraries { get; set; } = Array.Empty<InviteLibrary>();

    /// <summary>When the invite stops working, ISO 8601.</summary>
    public string ExpiresAt { get; set; } = string.Empty;
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
