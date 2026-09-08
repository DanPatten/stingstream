using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Users;
using Microsoft.Extensions.Logging;
using StingStream.Core.FirstRun;
using StingStream.Core.Mesh;

namespace StingStream.Core.Invites;

/// <summary>
/// Inviting a person to this server: minting the link, and turning a click on it into an account.
/// </summary>
/// <remarks>
/// <para>
/// The feature this whole part exists for. Sharing between servers already works — the federated
/// library materialises everything the mesh can reach into this server's own Jellyfin — and what
/// was missing was never identity. It was a way for somebody who has never signed in anywhere to
/// end up with an account on the server that invited them, seeing the libraries whoever invited
/// them chose, and nothing else.
/// </para>
/// <para>
/// <b>Only an administrator invites.</b> Holding an account on somebody's server does not let you
/// hand out accounts on it — that is a decision about somebody else's disk, bandwidth and library.
/// The controller enforces it with <c>RequiresElevation</c>; this class does not second-guess it,
/// but it does record who minted each invite so the list is answerable.
/// </para>
/// </remarks>
public sealed class InviteService
{
    private readonly InviteStore _store;
    private readonly IUserManager _users;
    private readonly ILibraryManager _library;
    private readonly IServerApplicationHost _host;
    private readonly IMeshClient _mesh;
    private readonly ILogger<InviteService> _logger;

    public InviteService(
        InviteStore store,
        IUserManager users,
        ILibraryManager library,
        IServerApplicationHost host,
        IMeshClient mesh,
        ILogger<InviteService> logger)
    {
        _store = store;
        _users = users;
        _library = library;
        _host = host;
        _mesh = mesh;
        _logger = logger;
    }

    /// <summary>The libraries an administrator may choose from when minting an invite.</summary>
    /// <returns>Every library on this server, named.</returns>
    /// <remarks>
    /// The federated "Shared" libraries are in here too, and that is right rather than an oversight:
    /// passing on what a friend shared with you is a choice, and it is the inviter's to make. What
    /// it is not is automatic — an invite grants exactly the libraries it names.
    /// </remarks>
    public IReadOnlyList<InviteLibrary> Libraries()
        => _library.GetVirtualFolders()
            .Where(f => Guid.TryParse(f.ItemId, out var id) && !id.Equals(Guid.Empty))
            .Select(f => new InviteLibrary
            {
                Id = f.ItemId,
                Name = f.Name ?? string.Empty,
                CollectionType = f.CollectionType?.ToString().ToLowerInvariant(),
            })
            .OrderBy(l => l.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToArray();

    /// <summary>Every invite this server has minted, newest first.</summary>
    /// <param name="now">The current time, for deciding which are still live.</param>
    /// <returns>The summaries.</returns>
    public IReadOnlyList<InviteSummary> List(DateTimeOffset now)
    {
        var names = LibraryNames();
        return _store.All().Select(row => Summarise(row, names, now)).ToArray();
    }

    /// <summary>Mint an invite.</summary>
    /// <param name="request">What the administrator asked for.</param>
    /// <param name="createdBy">Their user id.</param>
    /// <param name="createdByName">Their name.</param>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The token, the link and the row — or a sentence saying why not.</returns>
    public async Task<(MintedInvite? Minted, string? Problem)> MintAsync(
        MintInviteRequest request,
        string createdBy,
        string createdByName,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);

        var problem = InviteGate.ValidateMint(request.Label, request.Libraries);
        if (problem is not null)
        {
            return (null, problem);
        }

        var chosen = InviteGate.NormaliseLibraries(request.Libraries);
        var known = LibraryNames();
        var unknown = chosen.Where(id => !known.ContainsKey(id)).ToArray();
        if (unknown.Length > 0)
        {
            // Refused rather than dropped. Silently minting an invite for fewer libraries than the
            // administrator picked is the failure mode where somebody is told "I can't see your
            // films" and neither of them can work out why.
            return (null, "One of those libraries is no longer on this server. Reload and try again.");
        }

        var token = NewToken();
        var row = new InviteRow
        {
            Id = Guid.NewGuid().ToString("N"),
            TokenHash = Hash(token),
            Label = request.Label?.Trim() ?? string.Empty,
            Libraries = chosen,
            CreatedBy = createdBy,
            CreatedByName = createdByName,
            CreatedAt = now,
            ExpiresAt = now.AddDays(InviteGate.ClampExpiry(request.ExpiresInDays)),
        };

        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation(
            "Minted invite {Id} for {Count} librarie(s), expiring {Expires:u}",
            row.Id,
            chosen.Count,
            row.ExpiresAt);

        return (
            new MintedInvite
            {
                Token = token,
                Url = await LinkAsync(token, cancellationToken).ConfigureAwait(false),
                Invite = Summarise(row, known, now),
            },
            null);
    }

    /// <summary>Withdraw an invite.</summary>
    /// <param name="id">The invite id.</param>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>True when there was one to withdraw.</returns>
    public Task<bool> RevokeAsync(string id, DateTimeOffset now, CancellationToken cancellationToken)
        => _store.RevokeAsync(id, now, cancellationToken);

    /// <summary>What a token names, and whether it may still be used.</summary>
    /// <param name="token">The token out of a link's fragment.</param>
    /// <param name="now">The current time.</param>
    /// <returns>The status, and the row when there was one.</returns>
    public (InviteStatus Status, InviteRow? Row) Lookup(string? token, DateTimeOffset now)
    {
        var trimmed = token?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return (InviteStatus.Unknown, null);
        }

        var row = _store.ByTokenHash(Hash(trimmed));
        if (row is null || !HashMatches(row.TokenHash, Hash(trimmed)))
        {
            return (InviteStatus.Unknown, null);
        }

        return (InviteGate.Decide(row.ToState(), now), row);
    }

    /// <summary>What the landing page shows somebody who has not signed up yet.</summary>
    /// <param name="row">The invite.</param>
    /// <returns>The description.</returns>
    public InviteDescription Describe(InviteRow row)
    {
        ArgumentNullException.ThrowIfNull(row);
        var names = LibraryNames();
        return new InviteDescription
        {
            ServerName = _host.FriendlyName,
            InvitedBy = row.CreatedByName,
            Libraries = Name(row.Libraries, names),
            ExpiresAt = row.ExpiresAt.ToString("O", CultureInfo.InvariantCulture),
        };
    }

    /// <summary>
    /// Turn a valid invite into an account.
    /// </summary>
    /// <param name="row">The invite, already judged valid.</param>
    /// <param name="username">The name they chose.</param>
    /// <param name="password">The password they chose.</param>
    /// <param name="now">The current time.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The name of the account, or a sentence saying why there is not one.</returns>
    /// <remarks>
    /// <para>
    /// <b>The invite is claimed before the account exists, and given back if it does not.</b> The
    /// other order — create, then mark used — has a window the width of a user creation in which a
    /// link opened twice makes two accounts, and a link in a group chat is precisely the thing that
    /// gets opened twice. <see cref="InviteStore.TryRedeemAsync"/> pushes the decision into a
    /// single <c>UPDATE ... WHERE redeemed_at IS NULL</c>, so exactly one caller wins.
    /// </para>
    /// <para>
    /// <b>Then the policy, and this is the part that silently defeats the whole feature if it is
    /// wrong.</b> A user created by <c>CreateUserAsync</c> and left alone has
    /// <c>EnableAllFolders = true</c> — Jellyfin's <c>AddDefaultPermissions</c> sets it — so an
    /// invite that named one library out of four would hand over all four. It has to be turned off
    /// explicitly and the chosen list written in its place.
    /// </para>
    /// <para>
    /// And the policy is read back before it is written, because
    /// <see cref="IUserManager.UpdatePolicyAsync"/> replaces the <em>whole</em> policy: there is no
    /// partial update and no <c>GetPolicy</c> on the interface, so constructing a fresh
    /// <see cref="UserPolicy"/> here would quietly reset everything Jellyfin's own defaults had
    /// just set.
    /// </para>
    /// </remarks>
    public async Task<(string? Username, string? Problem)> AcceptAsync(
        InviteRow row,
        string? username,
        string? password,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(row);

        var name = username?.Trim();
        var problem = SetupGate.Validate(name, password);
        if (problem is not null)
        {
            return (null, problem);
        }

        // Taken names are checked here as well as by CreateUserAsync, so the common mistake costs
        // the invite nothing: below this line a failure has to put a claimed invite back.
        if (_users.GetUserByName(name) is not null)
        {
            return (null, "That name is already taken on this server. Choose another.");
        }

        if (!await _store.TryRedeemAsync(row.Id, string.Empty, name!, now, cancellationToken)
                .ConfigureAwait(false))
        {
            return (null, InviteGate.Explain(InviteStatus.AlreadyUsed));
        }

        User created;
        try
        {
            created = await _users.CreateUserAsync(name!).ConfigureAwait(false);
            await _users.ChangePassword(created.Id, password!).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            await _store.ReleaseAsync(row.Id, cancellationToken).ConfigureAwait(false);
            _logger.LogWarning(ex, "Invite {Id} could not create the account", row.Id);
            return (null, "That name cannot be used on this server. Choose another.");
        }
        catch (Exception ex)
        {
            await _store.ReleaseAsync(row.Id, cancellationToken).ConfigureAwait(false);
            _logger.LogError(ex, "Invite {Id} failed while creating the account", row.Id);
            throw;
        }

        try
        {
            await ApplyLibraryScopeAsync(created, row.Libraries).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // The account exists and can see everything, which is the one outcome this feature must
            // not produce. Disable it rather than leave it, and say so loudly: an administrator
            // finding a disabled account in their list is recoverable, a friend quietly holding
            // access to libraries nobody shared with them is not.
            _logger.LogError(
                ex,
                "Invite {Id} created {User} but could not scope it to the chosen libraries; "
                + "disabling the account",
                row.Id,
                name);
            await DisableAsync(created).ConfigureAwait(false);
            return (null, "Your account could not be set up. Ask whoever invited you to try again.");
        }

        // The user id was not known when the invite was claimed -- it did not exist yet -- so the
        // row is completed now that it does. One column rather than the whole row: see
        // SetRedeemedUserAsync for the revocation this would otherwise undo.
        await _store.SetRedeemedUserAsync(row.Id, created.Id.ToString("N"), cancellationToken)
            .ConfigureAwait(false);

        _logger.LogInformation(
            "Invite {Id} created {User} with access to {Count} librarie(s)",
            row.Id,
            name,
            row.Libraries.Count);

        return (name, null);
    }

    /// <summary>The link to send, or null when this server has no address anybody could open.</summary>
    /// <param name="token">The token.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The link, or null.</returns>
    /// <remarks>
    /// <para>
    /// The token rides in the <b>fragment</b>, after the <c>#</c>, which a browser never puts on
    /// the wire. That is the same choice group invites make and for the same reason: the token is
    /// the credential, and a query string would be written into this server's access log, every
    /// proxy in front of it, and anything in between. In the fragment it reaches only the page's
    /// own JavaScript, which posts it in a request body.
    /// </para>
    /// <para>
    /// Mirrors <c>stingstream_mesh::sharing::invite_link</c>, including its answer when there is no
    /// host: nothing. A server with no domain is still perfectly usable — the app reaches it over
    /// the mesh from anywhere and a browser reaches it at home — so the honest answer is the token
    /// on its own, and the screen says why there is no link.
    /// </para>
    /// </remarks>
    private async Task<string?> LinkAsync(string token, CancellationToken cancellationToken)
    {
        try
        {
            var settings = await _mesh.SharingSettingsAsync(cancellationToken).ConfigureAwait(false);
            var host = settings?.PublicAddress?.Trim().TrimEnd('/');
            return string.IsNullOrEmpty(host) ? null : $"{host}/join#{token}";
        }
        catch (Exception ex)
        {
            // The mesh being unreachable must not stop an invite being minted: the token is the
            // thing that matters and it already exists. No link, and the screen shows the token.
            _logger.LogWarning(ex, "Could not read this node's address; minting an invite with no link");
            return null;
        }
    }

    /// <summary>Restrict an account to exactly the libraries an invite named.</summary>
    private async Task ApplyLibraryScopeAsync(
        User user,
        IReadOnlyList<Guid> libraries)
    {
        var policy = _users.GetUserDto(user).Policy
            ?? throw new InvalidOperationException("The new account has no policy to restrict.");

        policy.EnableAllFolders = false;
        policy.EnabledFolders = libraries.ToArray();

        // Belt and braces on top of Jellyfin's own default, which already has these false. An
        // invited account is a guest on somebody's server: it should not be able to hand out
        // further accounts, delete anybody's files, or drive other people's sessions.
        policy.IsAdministrator = false;
        policy.EnableContentDeletion = false;
        policy.EnableRemoteControlOfOtherUsers = false;

        await _users.UpdatePolicyAsync(user.Id, policy).ConfigureAwait(false);
    }

    /// <summary>Turn an account off, for the case where scoping it failed.</summary>
    private async Task DisableAsync(User user)
    {
        try
        {
            var policy = _users.GetUserDto(user).Policy;
            if (policy is null)
            {
                return;
            }

            policy.IsDisabled = true;
            policy.EnableAllFolders = false;
            policy.EnabledFolders = Array.Empty<Guid>();
            await _users.UpdatePolicyAsync(user.Id, policy).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not disable {User} after a failed invite", user.Username);
        }
    }

    private Dictionary<Guid, InviteLibrary> LibraryNames()
    {
        var map = new Dictionary<Guid, InviteLibrary>();
        foreach (var library in Libraries())
        {
            if (Guid.TryParse(library.Id, out var id))
            {
                map[id] = library;
            }
        }

        return map;
    }

    private static IReadOnlyList<InviteLibrary> Name(
        IReadOnlyList<Guid> ids,
        Dictionary<Guid, InviteLibrary> known)
        => ids
            .Select(id => known.TryGetValue(id, out var library)
                ? library
                // A library that has been deleted since the invite was minted. Named rather than
                // dropped, so the list still adds up to what the invite says it grants.
                : new InviteLibrary { Id = id.ToString("N"), Name = "A library that no longer exists" })
            .ToArray();

    private static InviteSummary Summarise(
        InviteRow row,
        Dictionary<Guid, InviteLibrary> known,
        DateTimeOffset now)
        => new()
        {
            Id = row.Id,
            Label = row.Label,
            Libraries = Name(row.Libraries, known),
            CreatedByName = row.CreatedByName,
            CreatedAt = row.CreatedAt.ToString("O", CultureInfo.InvariantCulture),
            ExpiresAt = row.ExpiresAt.ToString("O", CultureInfo.InvariantCulture),
            Status = InviteGate.Decide(row.ToState(), now) switch
            {
                InviteStatus.Valid => "valid",
                InviteStatus.Revoked => "revoked",
                InviteStatus.AlreadyUsed => "used",
                _ => "expired",
            },
            RedeemedUserName = row.RedeemedUserName,
            RedeemedAt = row.RedeemedAt?.ToString("O", CultureInfo.InvariantCulture),
        };

    /// <summary>A new token: 256 bits of randomness, in URL-safe base64 with no padding.</summary>
    /// <returns>The token.</returns>
    /// <remarks>
    /// URL-safe because it goes in a link, unpadded because a trailing <c>=</c> is the character
    /// most likely to be eaten by a chat client, and 256 bits because a token that creates an
    /// account has to be unguessable even by somebody who can ask this server about a great many of
    /// them. Forty-three characters is long, and nobody types it: they open the link.
    /// </remarks>
    internal static string NewToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(InviteGate.TokenBytes);
        return Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    /// <summary>Lowercase hex SHA-256 of a token.</summary>
    /// <param name="token">The token.</param>
    /// <returns>The hash, as stored.</returns>
    internal static string Hash(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    /// <summary>Constant-time comparison of two stored hashes.</summary>
    /// <param name="stored">What the row holds.</param>
    /// <param name="presented">What the presented token hashes to.</param>
    /// <returns>True when they match.</returns>
    internal static bool HashMatches(string? stored, string? presented)
    {
        if (string.IsNullOrEmpty(stored) || string.IsNullOrEmpty(presented))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(stored),
            Encoding.UTF8.GetBytes(presented));
    }
}
