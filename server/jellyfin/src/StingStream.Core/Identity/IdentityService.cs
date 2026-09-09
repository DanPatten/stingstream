using System;
using System.Collections.Generic;
using System.Globalization;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;
using StingStream.Core.Invites;
using StingStream.Core.Mesh;

namespace StingStream.Core.Identity;

/// <summary>
/// Signing in to this server with an account you hold on your own.
/// </summary>
/// <remarks>
/// <para>
/// Dan: <em>"during the invite flow offer the option to sign in with their own server or create an
/// account - signing in with their own server will re-use their same login on this new server"</em>,
/// and <em>"we dont store the password in the target server's account"</em>.
/// </para>
/// <para>
/// <b>What proves who they are.</b> Their own node signs a short-lived, audience-bound statement
/// with its node key, and an iroh node id <em>is</em> an Ed25519 public key — so this server can
/// check it against the id the assertion names, with nothing exchanged beforehand. The signature
/// check itself lives in the mesh (<c>vouch.rs</c>), because .NET has no built-in Ed25519 and Core
/// already delegates every mesh concern over loopback.
/// </para>
/// <para>
/// <b>Their server has to be up, every time.</b> Dan chose that — <em>"lets just make it so that
/// your server has to be up to sign in with it to another server"</em> — and it falls out of the
/// design rather than being enforced anywhere: nobody but their node can produce the signature.
/// </para>
/// <para>
/// <b>An assertion is not a licence to have an account here.</b> Anybody can run StingStream, so a
/// genuine assertion from a server nobody here has heard of proves identity and grants nothing. The
/// first sign-in has to arrive with an invite; after that the link row is what lets them back in.
/// <see cref="IdentityGate.DecideSignIn"/> holds that rule.
/// </para>
/// </remarks>
public sealed class IdentityService
{
    private readonly IdentityStore _store;
    private readonly IdentityChallenges _challenges;
    private readonly InviteStore _inviteStore;
    private readonly InviteService _invites;
    private readonly IUserManager _users;
    private readonly IServerApplicationHost _host;
    private readonly IMeshClient _mesh;
    private readonly ILogger<IdentityService> _logger;

    public IdentityService(
        IdentityStore store,
        IdentityChallenges challenges,
        InviteStore inviteStore,
        InviteService invites,
        IUserManager users,
        IServerApplicationHost host,
        IMeshClient mesh,
        ILogger<IdentityService> logger)
    {
        _store = store;
        _challenges = challenges;
        _inviteStore = inviteStore;
        _invites = invites;
        _users = users;
        _host = host;
        _mesh = mesh;
        _logger = logger;
    }

    /// <summary>Offer a nonce for somebody's own server to sign.</summary>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The challenge, or null when too many are outstanding.</returns>
    public async Task<IdentityChallengeResponse?> ChallengeAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var nonce = _challenges.Issue(now);
        if (nonce is null)
        {
            return null;
        }

        var status = await _mesh.StatusAsync(cancellationToken).ConfigureAwait(false);
        var audience = status?.Node;
        if (string.IsNullOrWhiteSpace(audience))
        {
            // Without our own node id there is no audience to bind an assertion to, and an
            // unbound one would be a token that signs its holder in to every server. Refuse.
            _logger.LogWarning("Cannot issue an identity challenge: this node has no id yet");
            return null;
        }

        return new IdentityChallengeResponse
        {
            Nonce = nonce,
            Audience = audience,
            ServerName = _host.FriendlyName,
            ExpiresAt = (now + IdentityGate.ChallengeLifetime)
                .ToString("O", CultureInfo.InvariantCulture),
        };
    }

    /// <summary>Sign a statement about one of this server's own people, for another server.</summary>
    /// <param name="userId">The signed-in user asking for it.</param>
    /// <param name="userName">Their name here.</param>
    /// <param name="audience">The other server's node id.</param>
    /// <param name="nonce">Its challenge.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The assertion, or a sentence saying why not.</returns>
    /// <remarks>
    /// The caller is a signed-in member of <em>this</em> server, and what they get is a statement
    /// about themselves that is only usable at one named audience. There is nothing to authorise
    /// beyond having a session: vouching for yourself to somebody else's server tells that server
    /// who you are and gives it nothing else.
    /// </remarks>
    public async Task<(VouchResponse? Vouch, string? Problem)> VouchAsync(
        string userId,
        string userName,
        string? audience,
        string? nonce,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(audience) || string.IsNullOrWhiteSpace(nonce))
        {
            return (null, "That sign-in request is incomplete. Start again from the other server.");
        }

        try
        {
            var signed = await _mesh
                .VouchAsync(audience.Trim(), nonce.Trim(), userId, userName, cancellationToken)
                .ConfigureAwait(false);

            return (
                new VouchResponse
                {
                    Assertion = signed.Assertion,
                    NodeId = signed.Iss,
                    ServerName = signed.Server,
                },
                null);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not sign an identity assertion for {User}", userName);
            return (null, "This server could not sign you in to the other one. Try again.");
        }
    }

    /// <summary>Turn an assertion somebody presented into an account on this server.</summary>
    /// <param name="assertion">What their server signed.</param>
    /// <param name="inviteToken">An invite, for the first time.</param>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The account, or a sentence saying why not.</returns>
    /// <param name="requestLink">Also ask for the two servers to be linked.</param>
    public async Task<(User? User, string? Problem)> SignInAsync(
        string? assertion,
        string? inviteToken,
        DateTimeOffset now,
        CancellationToken cancellationToken,
        bool requestLink = false)
    {
        MeshVouchClaims? claims;
        try
        {
            claims = await _mesh.VerifyVouchAsync(assertion ?? string.Empty, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // The mesh being unreachable is not the same as an assertion being bad, and reporting
            // it as one would send somebody hunting a problem on their own server.
            _logger.LogError(ex, "Could not check an identity assertion");
            return (null, "This server cannot check sign-ins right now. Try again shortly.");
        }

        // Spent before anything else is decided, and spent even when the rest fails: a nonce that
        // survives a failed attempt is a nonce that can be retried, which is what single use is
        // there to stop.
        var challengeMatched = claims is not null && _challenges.Take(claims.Nonce, now);

        var existing = claims is null
            ? null
            : _store.Find(claims.Iss, claims.Sub);

        // Only looked up when there is no link, so an invite is never spent by somebody who
        // already had an account here.
        InviteRow? invite = null;
        var inviteUsable = false;
        if (claims is not null && existing is null && !string.IsNullOrWhiteSpace(inviteToken))
        {
            var (status, row) = _invites.Lookup(inviteToken, now);
            invite = row;
            inviteUsable = row is not null && status == InviteStatus.Valid;
        }

        var problem = IdentityGate.DecideSignIn(
            claims is not null,
            challengeMatched,
            existing?.LocalUserId,
            inviteUsable);
        if (problem is not null)
        {
            return (null, problem);
        }

        var result = existing is not null
            ? await ReturningAsync(existing, claims!, now, cancellationToken).ConfigureAwait(false)
            : await FirstTimeAsync(claims!, invite!, now, cancellationToken).ConfigureAwait(false);

        // After the account exists, and never instead of it: a request that failed to record is a
        // question somebody can ask again from Settings, while a sign-in that failed because of one
        // would be a person locked out of an account they now have.
        if (requestLink && result.User is not null)
        {
            try
            {
                await RequestLinkAsync(
                    result.User.Id.ToString("N"),
                    now,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Signed in, but could not record the link request");
            }
        }

        return result;
    }

    /// <summary>Somebody who has been here before.</summary>
    private async Task<(User? User, string? Problem)> ReturningAsync(
        LinkedIdentity link,
        MeshVouchClaims claims,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        if (!Guid.TryParse(link.LocalUserId, out var localId)
            || _users.GetUserById(localId) is not { } user)
        {
            // The account was deleted from under the link. Clear it rather than leave a row that
            // can never resolve; with the link gone, an invite would let them start again.
            await _store.DeleteAsync(link.IssuerNodeId, link.RemoteUserId, cancellationToken)
                .ConfigureAwait(false);
            _logger.LogWarning(
                "Dropped a link to {Issuer} whose local account no longer exists",
                link.IssuerName);
            return (null, "Your account on this server is gone. Ask for a new invite link.");
        }

        // Names are refreshed, the account is not. Somebody who renames themselves on their own
        // server is still the same person and must not arrive here as a stranger.
        link.RemoteUserName = claims.Name;
        link.IssuerName = claims.Server;
        link.LastSeenAt = now;
        await _store.SaveAsync(link, cancellationToken).ConfigureAwait(false);

        _logger.LogInformation(
            "{User} signed in from {Server}",
            user.Username,
            claims.Server);
        return (user, null);
    }

    /// <summary>Somebody arriving for the first time, with an invite.</summary>
    private async Task<(User? User, string? Problem)> FirstTimeAsync(
        MeshVouchClaims claims,
        InviteRow invite,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var name = IdentityGate.ChooseUsername(
            claims.Name,
            claims.Server,
            claims.Iss,
            candidate => _users.GetUserByName(candidate) is not null);

        if (name is null)
        {
            return (null, "Could not find a free name for your account here. Ask an administrator.");
        }

        // Claimed before the account is created, and given back if creation fails -- the same shape
        // and the same reason as InviteService.AcceptAsync. A link in a chat gets opened twice.
        if (!await _inviteStore.TryRedeemAsync(invite.Id, string.Empty, name, now, cancellationToken)
                .ConfigureAwait(false))
        {
            return (null, InviteGate.Explain(InviteStatus.AlreadyUsed));
        }

        User created;
        try
        {
            created = await _users.CreateUserAsync(name).ConfigureAwait(false);
            await _users.ChangePassword(created.Id, UnknowablePassword()).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await _inviteStore.ReleaseAsync(invite.Id, cancellationToken).ConfigureAwait(false);
            _logger.LogError(ex, "Could not create a linked account for {Name}", name);
            return (null, "Your account could not be created. Ask whoever invited you to try again.");
        }

        try
        {
            await _invites
                .ApplyInvitePolicyAsync(created, invite.Libraries, invite.IsAdministrator)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // Same call as the ordinary invite path makes, and the same recovery: an account that
            // exists and can see everything is the one outcome this must not produce.
            _logger.LogError(
                ex,
                "Created {Name} from {Server} but could not scope it; disabling the account",
                name,
                claims.Server);
            await _invites.DisableAccountAsync(created).ConfigureAwait(false);
            return (null, "Your account could not be set up. Ask whoever invited you to try again.");
        }

        await _store.SaveAsync(
            new LinkedIdentity
            {
                IssuerNodeId = claims.Iss,
                RemoteUserId = claims.Sub,
                LocalUserId = created.Id.ToString("N"),
                RemoteUserName = claims.Name,
                IssuerName = claims.Server,
                CreatedAt = now,
                LastSeenAt = now,
            },
            cancellationToken).ConfigureAwait(false);

        await _inviteStore.SetRedeemedUserAsync(invite.Id, created.Id.ToString("N"), cancellationToken)
            .ConfigureAwait(false);

        _logger.LogInformation(
            "{Name} from {Server} accepted an invite and now has an account here",
            name,
            claims.Server);
        return (created, null);
    }

    // --- link requests -------------------------------------------------------------------------

    /// <summary>Ask for the asking person's own server to be linked with this one.</summary>
    /// <param name="localUserId">The account here that is asking.</param>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when there is now a request.</returns>
    /// <remarks>
    /// The node id comes from their <em>link</em>, never from the request body: what a link row
    /// holds was proved by a signature, and a node id somebody typed is a node id somebody chose.
    /// So only an account that arrived from another server can ask — which is exactly the set of
    /// people for whom the question means anything.
    /// </remarks>
    public async Task<bool> RequestLinkAsync(
        string localUserId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var link = _store.ForLocalUser(localUserId);
        if (link is null)
        {
            return false;
        }

        await _store.SaveRequestAsync(
            new LinkRequest
            {
                IssuerNodeId = link.IssuerNodeId,
                IssuerName = link.IssuerName,
                RequestedBy = localUserId,
                CreatedAt = now,
                Status = "pending",
            },
            cancellationToken).ConfigureAwait(false);

        _logger.LogInformation("{Server} asked to be linked with this one", link.IssuerName);
        return true;
    }

    /// <summary>Every request, for the administrator's list.</summary>
    /// <returns>The requests, newest first.</returns>
    public IReadOnlyList<LinkRequestSummary> ListRequests()
    {
        var rows = _store.AllRequests();
        var summaries = new List<LinkRequestSummary>(rows.Count);
        foreach (var row in rows)
        {
            summaries.Add(new LinkRequestSummary
            {
                IssuerNodeId = row.IssuerNodeId,
                IssuerName = row.IssuerName,
                RequestedByName = Guid.TryParse(row.RequestedBy, out var id)
                    ? _users.GetUserById(id)?.Username ?? string.Empty
                    : string.Empty,
                CreatedAt = row.CreatedAt.ToString("O", CultureInfo.InvariantCulture),
                Status = row.Status,
                GroupId = row.GroupId,
                // Deliberately not the code. Looking at the queue does not need the credential,
                // and only the person who asked ever needs it at all.
            });
        }

        return summaries;
    }

    /// <summary>What the person who asked is told about their own request.</summary>
    /// <param name="localUserId">Their account here.</param>
    /// <returns>The status, and the code once it is approved.</returns>
    public MyLinkRequest MyRequest(string localUserId)
    {
        var link = _store.ForLocalUser(localUserId);
        if (link is null)
        {
            return new MyLinkRequest { ServerName = _host.FriendlyName };
        }

        var row = _store.FindRequest(link.IssuerNodeId);
        return new MyLinkRequest
        {
            Exists = row is not null,
            Status = row?.Status ?? string.Empty,
            IssuerNodeId = link.IssuerNodeId,
            ServerName = _host.FriendlyName,
            // Only ever handed to the account the request belongs to, which is what `ForLocalUser`
            // above establishes.
            Code = row?.Status == "approved" ? row.Code : null,
        };
    }

    /// <summary>Let another server into one of this one's groups.</summary>
    /// <param name="issuerNodeId">The asking node.</param>
    /// <param name="groupId">The group, or null when there is only one.</param>
    /// <param name="decidedBy">The administrator.</param>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Whether it worked, and a sentence when it did not.</returns>
    /// <remarks>
    /// The invite is minted <b>before</b> the row is decided, and the row is decided in one
    /// <c>UPDATE ... WHERE status = 'pending'</c>: two administrators pressing Approve at the same
    /// moment therefore mint two codes and store one, which wastes a code and hands out exactly one
    /// link. The other ordering — decide, then mint — would leave an approved request with no code
    /// in it if the mesh were down, which is a dead end somebody has to notice.
    /// </remarks>
    public async Task<(bool Ok, string? Problem)> ApproveRequestAsync(
        string issuerNodeId,
        string? groupId,
        string decidedBy,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var row = _store.FindRequest(issuerNodeId);
        if (row is null)
        {
            return (false, null);
        }

        if (row.Status != "pending")
        {
            return (false, "That request has already been answered.");
        }

        var chosen = groupId?.Trim();
        if (string.IsNullOrEmpty(chosen))
        {
            var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
            if (groups is null || groups.Count == 0)
            {
                return (false, "Create a link with another server first, then approve this.");
            }

            if (groups.Count > 1)
            {
                // Which group a new server joins decides what it can see. That is a choice, and
                // guessing at it here would be this code making it.
                return (false, "Choose which of your links to add them to.");
            }

            chosen = groups[0].Group;
        }

        MeshInvite invite;
        try
        {
            invite = await _mesh.InviteAsync(chosen!, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not mint an invite while approving a link request");
            return (false, "Could not create an invite for them. Try again shortly.");
        }

        var decided = await _store.TryDecideRequestAsync(
            issuerNodeId,
            "approved",
            chosen,
            invite.Code,
            decidedBy,
            now,
            cancellationToken).ConfigureAwait(false);

        if (!decided)
        {
            // Somebody else got there first. Their code is the one that stands; this one is simply
            // never handed out, and an unspent mesh invite costs nothing.
            return (false, "That request has already been answered.");
        }

        _logger.LogInformation("{Server} was approved to join {Group}", row.IssuerName, chosen);
        return (true, null);
    }

    /// <summary>Say no.</summary>
    /// <param name="issuerNodeId">The asking node.</param>
    /// <param name="decidedBy">The administrator.</param>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when there was a pending request to decline.</returns>
    /// <remarks>
    /// The row is kept rather than deleted, and that is what makes a decline mean something: an
    /// upsert from another ask will not reset a decided row to pending, so somebody cannot get a
    /// different answer by asking again.
    /// </remarks>
    public Task<bool> DeclineRequestAsync(
        string issuerNodeId,
        string decidedBy,
        DateTimeOffset now,
        CancellationToken cancellationToken)
        => _store.TryDecideRequestAsync(
            issuerNodeId,
            "declined",
            null,
            null,
            decidedBy,
            now,
            cancellationToken);

    /// <summary>Every remote identity holding an account here.</summary>
    /// <returns>The list, newest first.</returns>
    public IReadOnlyList<LinkedIdentitySummary> List()
    {
        var rows = _store.All();
        var summaries = new List<LinkedIdentitySummary>(rows.Count);
        foreach (var row in rows)
        {
            var localName = Guid.TryParse(row.LocalUserId, out var id)
                ? _users.GetUserById(id)?.Username ?? string.Empty
                : string.Empty;

            summaries.Add(new LinkedIdentitySummary
            {
                Id = IdentityGate.LinkKey(row.IssuerNodeId, row.RemoteUserId),
                RemoteUserName = row.RemoteUserName,
                IssuerName = row.IssuerName,
                IssuerNodeId = row.IssuerNodeId,
                LocalUserName = localName,
                CreatedAt = row.CreatedAt.ToString("O", CultureInfo.InvariantCulture),
                LastSeenAt = row.LastSeenAt?.ToString("O", CultureInfo.InvariantCulture),
            });
        }

        return summaries;
    }

    /// <summary>Stop a remote identity signing in here.</summary>
    /// <param name="issuerNodeId">Their server's node id.</param>
    /// <param name="remoteUserId">Their id there.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when a link went.</returns>
    public Task<bool> UnlinkAsync(
        string issuerNodeId,
        string remoteUserId,
        CancellationToken cancellationToken)
        => _store.DeleteAsync(issuerNodeId, remoteUserId, cancellationToken);

    /// <summary>
    /// A password nobody will ever know, so password sign-in can never succeed for this account.
    /// </summary>
    /// <remarks>
    /// <b>Not left blank, deliberately.</b> A Jellyfin account with no password authenticates with
    /// an empty one — which would make every linked account signable-into by name alone, and would
    /// be a far worse door than the one this feature avoids. The account's real credential is an
    /// assertion from its own server; this value exists only so that the other way in is closed,
    /// and it is discarded the moment it is set.
    /// </remarks>
    private static string UnknowablePassword()
        => Convert.ToBase64String(RandomNumberGenerator.GetBytes(48));
}
