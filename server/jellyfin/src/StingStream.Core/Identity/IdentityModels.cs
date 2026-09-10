using System;

namespace StingStream.Core.Identity;

/// <summary>An account here that belongs to somebody on another server.</summary>
/// <remarks>
/// <b>The link is the credential, not a password.</b> The account this row points at has a password
/// nobody knows (see <c>IdentityService.CreateLinkedAccountAsync</c>) — the way in is an assertion
/// signed by <see cref="IssuerNodeId"/>, which means the other server has to be up. Dan:
/// <em>"lets just make it so that your server has to be up to sign in with it to another server"</em>.
/// </remarks>
public sealed class LinkedIdentity
{
    /// <summary>Node id of the server that vouches for them, 64-character hex.</summary>
    public string IssuerNodeId { get; set; } = string.Empty;

    /// <summary>Their user id on that server. Stable, and what this is keyed on.</summary>
    /// <remarks>
    /// Keyed on the id rather than the name, deliberately. Somebody who renames their account on
    /// their own server is still the same person, and should not arrive here as a stranger with a
    /// second account.
    /// </remarks>
    public string RemoteUserId { get; set; } = string.Empty;

    /// <summary>The local account it maps to.</summary>
    public string LocalUserId { get; set; } = string.Empty;

    /// <summary>Their username there, as it was last seen. For display only.</summary>
    public string RemoteUserName { get; set; } = string.Empty;

    /// <summary>That server's friendly name, as it was last seen.</summary>
    public string IssuerName { get; set; } = string.Empty;

    /// <summary>When the link was made.</summary>
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>When it was last used to sign in.</summary>
    public DateTimeOffset? LastSeenAt { get; set; }

    /// <summary>The salt their client derives this account's password with, or empty.</summary>
    /// <remarks>
    /// <b>Not a secret, and handed to anybody who asks how to sign in as this username</b> — a
    /// client that cannot learn it cannot derive the value, and then nobody could sign in at all.
    /// What it buys is that one server's derived password is useless on another, and that a stolen
    /// one cannot be turned back into a password cheaply.
    /// <para>
    /// Empty means the account signs in with an ordinary password: everything created before this
    /// existed, and anything an administrator has since reset.
    /// </para>
    /// </remarks>
    public string PasswordSalt { get; set; } = string.Empty;

    /// <summary>How many PBKDF2 rounds produced it, or zero.</summary>
    /// <remarks>
    /// Stored rather than assumed, so raising the client's default cannot lock out everybody who
    /// linked before the change.
    /// </remarks>
    public int PasswordIterations { get; set; }
}

/// <summary>One server asking to be linked with this one.</summary>
/// <remarks>
/// <b>Asked by a person, decided about a server.</b> Somebody signing in with their own node can
/// ask for the two to be linked, but only an administrator here can say yes — which is what keeps
/// <c>docs/INVITES.md</c> §3's first row true: holding an account on somebody's server does not let
/// you decide anything about it. Approval mints an ordinary single-use mesh invite; the joining is
/// then the ordinary joining, done on their own server where they are the administrator.
/// </remarks>
public sealed class LinkRequest
{
    /// <summary>Node id of the server asking.</summary>
    public string IssuerNodeId { get; set; } = string.Empty;

    /// <summary>What it calls itself.</summary>
    public string IssuerName { get; set; } = string.Empty;

    /// <summary>The local account of the person who asked.</summary>
    public string RequestedBy { get; set; } = string.Empty;

    /// <summary>When they asked.</summary>
    public DateTimeOffset CreatedAt { get; set; }

    /// <summary><c>pending</c>, <c>approved</c> or <c>declined</c>.</summary>
    public string Status { get; set; } = "pending";

    /// <summary>When an administrator answered, or null.</summary>
    public DateTimeOffset? DecidedAt { get; set; }

    /// <summary>Which administrator, or null.</summary>
    public string? DecidedBy { get; set; }

    /// <summary>The group it was approved into, or null.</summary>
    public string? GroupId { get; set; }

    /// <summary>The mesh invite minted on approval, or null.</summary>
    /// <remarks>
    /// Single use, and shown only to the person who asked. It is the ordinary group invite code —
    /// there is no second kind — so redeeming it is the ordinary Join screen on their own server.
    /// </remarks>
    public string? Code { get; set; }
}

/// <summary>One request in the administrator's list.</summary>
public sealed class LinkRequestSummary
{
    /// <summary>Node id of the server asking — also the id to approve or decline by.</summary>
    public string IssuerNodeId { get; set; } = string.Empty;

    /// <summary>What it calls itself.</summary>
    public string IssuerName { get; set; } = string.Empty;

    /// <summary>The name of the account here that asked.</summary>
    public string RequestedByName { get; set; } = string.Empty;

    /// <summary>When they asked, ISO 8601.</summary>
    public string CreatedAt { get; set; } = string.Empty;

    /// <summary><c>pending</c>, <c>approved</c> or <c>declined</c>.</summary>
    public string Status { get; set; } = string.Empty;

    /// <summary>The group it was approved into, or null.</summary>
    public string? GroupId { get; set; }
}

/// <summary>What the person who asked is told about their own request.</summary>
/// <remarks>
/// Carries the code, which the administrator's list deliberately does not: an approved link is
/// theirs to redeem on their own server, and nobody else needs the credential to look at the queue.
/// </remarks>
public sealed class MyLinkRequest
{
    /// <summary>Whether there is a request at all.</summary>
    public bool Exists { get; set; }

    /// <summary><c>pending</c>, <c>approved</c> or <c>declined</c>.</summary>
    public string Status { get; set; } = string.Empty;

    /// <summary>Their own server's node id.</summary>
    public string IssuerNodeId { get; set; } = string.Empty;

    /// <summary>This server's name, for the sentence about who they are asking.</summary>
    public string ServerName { get; set; } = string.Empty;

    /// <summary>The invite to redeem on their own server, once it is approved.</summary>
    public string? Code { get; set; }
}

/// <summary>An administrator approving one, into a group of their choosing.</summary>
public sealed class ApproveLinkRequest
{
    /// <summary>
    /// The group to let them into, or null to use this node's only one.
    /// </summary>
    /// <remarks>
    /// Null is honoured only when there is exactly one group, because then there is no choice to
    /// make. With several it is refused rather than guessed: which of somebody's groups a new
    /// server joins decides what it can see, and a default would be this code deciding that.
    /// </remarks>
    public string? GroupId { get; set; }
}

/// <summary>A challenge this server issued, for somebody to have their own server sign.</summary>
public sealed class IdentityChallengeResponse
{
    /// <summary>The nonce to carry into the assertion.</summary>
    public string Nonce { get; set; } = string.Empty;

    /// <summary>This node's id — the assertion's audience.</summary>
    /// <remarks>
    /// Handed out rather than looked up by the client, because the client has no other way to learn
    /// it and because binding the assertion to the wrong audience is the failure this prevents.
    /// </remarks>
    public string Audience { get; set; } = string.Empty;

    /// <summary>This server's name, so the consent screen can say who is asking.</summary>
    public string ServerName { get; set; } = string.Empty;

    /// <summary>When the nonce stops being answerable, ISO 8601.</summary>
    public string ExpiresAt { get; set; } = string.Empty;
}

/// <summary>What the app asks its own node to sign.</summary>
public sealed class VouchRequest
{
    /// <summary>Node id of the server the assertion is for.</summary>
    public string? Audience { get; set; }

    /// <summary>That server's challenge.</summary>
    public string? Nonce { get; set; }
}

/// <summary>A signed assertion, on its way to the other server.</summary>
public sealed class VouchResponse
{
    /// <summary>The assertion. Opaque to everything but the mesh.</summary>
    public string Assertion { get; set; } = string.Empty;

    /// <summary>This node's id.</summary>
    public string NodeId { get; set; } = string.Empty;

    /// <summary>This node's name.</summary>
    public string ServerName { get; set; } = string.Empty;
}

/// <summary>Somebody signing in with an assertion from their own server.</summary>
public sealed class IdentitySignInRequest
{
    /// <summary>The assertion their server signed.</summary>
    public string? Assertion { get; set; }

    /// <summary>
    /// An invite token, for the first time only.
    /// </summary>
    /// <remarks>
    /// Required when no link exists yet, and ignored when one does. A genuine assertion from a
    /// server nobody here has heard of is not permission to have an account — otherwise anybody
    /// running StingStream could sign in to every StingStream server there is.
    /// </remarks>
    public string? InviteToken { get; set; }

    /// <summary>Also ask for the two servers to be linked.</summary>
    /// <remarks>
    /// Dan: <em>"signing in with their own server will re-use their same login on this new server
    /// AND submit a request to link their server to this one"</em>. It is a request and not the
    /// link itself: only an administrator here decides which servers join their group.
    /// </remarks>
    public bool RequestLink { get; set; }

    /// <summary>The salt their own server derived <see cref="Verifier"/> with.</summary>
    public string? Salt { get; set; }

    /// <summary>PBKDF2 of their password, which becomes their password here.</summary>
    /// <remarks>
    /// <b>This is not their password and this server never learns it.</b> Dan:
    /// <em>"we need to do this without the OTHER server knowing what that user's password is but it
    /// still can validate it"</em>. Their client derives this on their own origin, from a password
    /// typed there, and Jellyfin hashes what arrives with its own KDF before storing it.
    /// <para>
    /// Absent -- from an older client, or from one that could not derive -- means the account keeps
    /// a password nobody knows, which is what this path did before and is the safe reading.
    /// </para>
    /// </remarks>
    public string? Verifier { get; set; }

    /// <summary>The round count that produced it.</summary>
    public int? Iterations { get; set; }
}

/// <summary>How a client should send a password for one username.</summary>
/// <remarks>
/// Answered anonymously, because it has to be: the client asking is the one that has not signed in
/// yet. An ordinary account and a username nobody holds answer identically, so this cannot be used
/// to find out who has an account here.
/// </remarks>
public sealed class SignInMethodResponse
{
    /// <summary>Whether the password must be derived before it is sent.</summary>
    public bool Derived { get; set; }

    /// <summary>The salt to derive it with, when it must be.</summary>
    public string Salt { get; set; } = string.Empty;

    /// <summary>The round count to derive it with, when it must be.</summary>
    public int Iterations { get; set; }
}

/// <summary>Asking how to sign in as one username.</summary>
public sealed class SignInMethodRequest
{
    /// <summary>The username being signed in as.</summary>
    public string? Username { get; set; }
}

/// <summary>Setting the derived password for the account you are signed in as.</summary>
public sealed class SetLinkedPasswordRequest
{
    /// <summary>The new salt.</summary>
    public string? Salt { get; set; }

    /// <summary>PBKDF2 of the new password, derived with it.</summary>
    public string? Verifier { get; set; }

    /// <summary>The round count that produced it.</summary>
    public int? Iterations { get; set; }
}

/// <summary>Turning one linked account back into an ordinary-password one.</summary>
public sealed class ClearDerivationRequest
{
    /// <summary>The local account whose password an administrator has just reset.</summary>
    public string? UserId { get; set; }
}

/// <summary>One remote identity holding an account here, for the administrator's list.</summary>
public sealed class LinkedIdentitySummary
{
    /// <summary>Opaque id, for removing the link.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>Their name on their own server.</summary>
    public string RemoteUserName { get; set; } = string.Empty;

    /// <summary>That server's name.</summary>
    public string IssuerName { get; set; } = string.Empty;

    /// <summary>That server's node id.</summary>
    public string IssuerNodeId { get; set; } = string.Empty;

    /// <summary>The account here it signs in to.</summary>
    public string LocalUserName { get; set; } = string.Empty;

    /// <summary>When the link was made, ISO 8601.</summary>
    public string CreatedAt { get; set; } = string.Empty;

    /// <summary>When it was last used, ISO 8601, or null.</summary>
    public string? LastSeenAt { get; set; }
}
