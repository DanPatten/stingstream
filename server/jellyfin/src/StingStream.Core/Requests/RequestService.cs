using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Inventory;
using StingStream.Core.Mesh;
using StingStream.Core.Playback;

namespace StingStream.Core.Requests;

/// <summary>What a create-request attempt decided.</summary>
public sealed class CreateRequestResult
{
    /// <summary>The request, whether new or the existing one this collapsed onto.</summary>
    public RequestRow? Request { get; set; }

    /// <summary>True when this call created it, false when it joined one already open.</summary>
    public bool Created { get; set; }

    /// <summary>Set when the request was refused, with a sentence saying why.</summary>
    public string? Refused { get; set; }

    /// <summary>
    /// True when the group already holds this and the caller did not say why they want it anyway.
    /// </summary>
    /// <remarks>
    /// Nothing is created in this case. Asking for something already on the shelf used to file a
    /// row that was silently already available, which told the person nothing and left them no way
    /// to reach the copy they had just asked for. It is now a question: here it is, here is how to
    /// play it, and if you still want it, say why. Answer by calling again with
    /// <see cref="CreateRequestBody.Reason"/> set.
    /// </remarks>
    public bool AlreadyHeld { get; set; }

    /// <summary>Who holds it, by display name, when <see cref="AlreadyHeld"/> is set.</summary>
    public IReadOnlyList<string> Holders { get; set; } = Array.Empty<string>();

    /// <summary>
    /// The library item to play, when one could be resolved. Null when it could not.
    /// </summary>
    /// <remarks>
    /// Null is ordinary rather than an error: a peer's copy becomes an item here only once the
    /// federated materialiser has caught up, which is seconds behind the index it was found in. The
    /// caller names the holder and offers no link, which is still better than what came before.
    /// </remarks>
    public string? PlayableItemId { get; set; }

    /// <summary>The HTTP status a controller should answer with.</summary>
    public int Status { get; set; } = 200;
}

/// <summary>What an approve or decline did.</summary>
public sealed class RequestDecisionResult
{
    /// <summary>The updated request, when one changed.</summary>
    public RequestRow? Request { get; set; }

    /// <summary>True when there is no such request.</summary>
    public bool NotFound { get; set; }

    /// <summary>
    /// Set when the request exists but is not in a state this decision applies to, with a sentence
    /// saying so.
    /// </summary>
    public string? Conflict { get; set; }
}

/// <summary>
/// Making, approving and declining requests, and the policy that decides which of those is needed.
/// </summary>
/// <remarks>
/// This half is synchronous and deals only with what the requester's home node knows. Getting a
/// request onto a node that can actually grab it is <see cref="RequestWorker"/>'s job, and the two
/// are separate on purpose: a request must be recorded and answered for the moment somebody presses
/// the button, whether or not the mesh is up, whether or not any node is willing, and whether or not
/// the arrs are reachable. A person pressing Request and getting a spinner that ends in a timeout
/// because a peer was slow would be a much worse product than one that says "asked, waiting".
/// </remarks>
public sealed class RequestService
{
    private readonly RequestStore _store;
    private readonly RequestNotifier _notifier;
    private readonly IMeshClient _mesh;
    private readonly ArrClientFactory _arrs;
    private readonly FederatedSourceService _sources;
    private readonly ArtworkFallback _artwork;
    private readonly TmdbCatalog _catalogue;
    private readonly MediaBrowser.Controller.Library.IUserManager _users;

    private readonly MediaBrowser.Controller.Library.ILibraryManager _library;

    private readonly StingStream.Core.Configuration.INodeRuntimeProvider _runtime;
    private readonly ILogger<RequestService> _logger;

    public RequestService(
        RequestStore store,
        RequestNotifier notifier,
        IMeshClient mesh,
        ArrClientFactory arrs,
        FederatedSourceService sources,
        ArtworkFallback artwork,
        TmdbCatalog catalogue,
        MediaBrowser.Controller.Library.IUserManager users,
        MediaBrowser.Controller.Library.ILibraryManager library,
        StingStream.Core.Configuration.INodeRuntimeProvider runtime,
        ILogger<RequestService> logger)
    {
        _store = store;
        _notifier = notifier;
        _mesh = mesh;
        _arrs = arrs;
        _sources = sources;
        _artwork = artwork;
        _catalogue = catalogue;
        _users = users;
        _library = library;
        _runtime = runtime;
        _logger = logger;
    }

    /// <summary>The policy in force for a group.</summary>
    /// <param name="group">The group id, or null for this node's default.</param>
    /// <returns>The policy.</returns>
    public RequestPolicy Policy(string? group) => _store.Policy(group);

    /// <summary>Store a group's policy.</summary>
    /// <param name="policy">The policy.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The stored policy.</returns>
    public Task<RequestPolicy> SavePolicyAsync(RequestPolicy policy, CancellationToken cancellationToken)
        => _store.SavePolicyAsync(policy, cancellationToken);

    /// <summary>Every member of this node, with their trust, quota and usage.</summary>
    /// <returns>The members, administrators first.</returns>
    /// <remarks>
    /// This is the list an administrator edits trust and quotas on, so it is every account on the
    /// node and not only the ones who have made a request. Trust is granted before it is needed,
    /// not after somebody has already been made to wait.
    /// </remarks>
    public IReadOnlyList<RequestUser> Users()
    {
        List<Jellyfin.Database.Implementations.Entities.User> users;
        try
        {
            users = _users.GetUsers().ToList();
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException)
        {
            _logger.LogWarning(ex, "Could not list users");
            return Array.Empty<RequestUser>();
        }

        return users
            .Select(u => Describe(u, RequestNotifier.IsAdministrator(u)))
            .OrderByDescending(u => u.IsAdministrator)
            .ThenBy(u => u.UserName, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>Describe one member.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>The member.</returns>
    public RequestUser User(string userId)
    {
        var (trusted, quota) = _store.Trust(userId);
        return new RequestUser
        {
            UserId = userId,
            UserName = _notifier.NameOf(userId),
            IsAdministrator = _notifier.IsAdministrator(userId),
            Trusted = trusted,
            WeeklyQuota = quota,
            RequestsThisWeek = _store.RequestsThisWeek(userId),
        };
    }

    /// <summary>Set a member's trust flag and personal quota.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="trusted">Whether they are trusted.</param>
    /// <param name="weeklyQuota">Their own quota, or zero for the group's.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The updated member.</returns>
    public async Task<RequestUser> SetTrustAsync(
        string userId,
        bool trusted,
        int weeklyQuota,
        CancellationToken cancellationToken)
    {
        await _store.SetTrustAsync(userId, trusted, weeklyQuota, cancellationToken).ConfigureAwait(false);
        return User(userId);
    }

    /// <summary>
    /// Whether a member's request is auto-approved under a policy.
    /// </summary>
    /// <param name="policy">The group policy.</param>
    /// <param name="isAdministrator">Whether the requester administers this node.</param>
    /// <param name="isTrusted">Whether the requester is marked trusted.</param>
    /// <returns>True when no administrator needs to look at it.</returns>
    /// <remarks>
    /// Static and pure so the rule can be tested without a database, a Jellyfin or a mesh — this is
    /// the one function in M6 whose being wrong is a *privacy* failure rather than an inconvenience,
    /// because it decides whether a stranger on somebody's node can spend their bandwidth.
    ///
    /// An administrator is auto-approved under every policy. Not a special case so much as the
    /// definition: an administrator can change the policy, so making them wait for an approval they
    /// can grant themselves is theatre.
    /// </remarks>
    public static bool IsAutoApproved(RequestPolicy policy, bool isAdministrator, bool isTrusted)
    {
        ArgumentNullException.ThrowIfNull(policy);
        if (isAdministrator)
        {
            return true;
        }

        return policy.AutoApprove switch
        {
            AutoApprove.Everyone => true,
            AutoApprove.Trusted => isTrusted,
            _ => false,
        };
    }

    /// <summary>
    /// The state a new request opens in.
    /// </summary>
    /// <param name="automaticMode">Whether anybody in the group has an indexer configured.</param>
    /// <param name="policy">The group policy.</param>
    /// <param name="isAdministrator">Whether the requester administers this node.</param>
    /// <param name="isTrusted">Whether the requester is marked trusted.</param>
    /// <param name="isDestructive">
    /// Whether this request would add to or replace a copy the group already holds. See
    /// <see cref="RequestReasons.IsDestructive"/>.
    /// </param>
    /// <returns>One of <see cref="RequestStates"/>.</returns>
    /// <remarks>
    /// <para>
    /// A branch here rather than a fourth argument to <see cref="IsAutoApproved"/>, whose whole
    /// value is being a small rule about who may spend the group's bandwidth. Two things now decide
    /// a request's opening state before that rule is even reached, and folding them into it would
    /// dilute the one function in M6 whose being wrong is a privacy failure.
    /// </para>
    /// <para>
    /// **Manual mode wins over everything.** With no indexer anywhere in the group there is nothing
    /// for an approval to authorise: approving would permit a download that is never going to
    /// start. The request goes onto the administrator's wanted list instead and waits there.
    /// </para>
    /// <para>
    /// **A destructive request always waits**, and deliberately short-circuits *before* the
    /// administrator check inside <see cref="IsAutoApproved"/>. Replacing a file somebody already
    /// has, or adding a second copy of it, is not the same act as fetching something the group
    /// lacks: a "better" release is not always better, and the disk belongs to whoever runs the
    /// node. An administrator can approve their own in one click, and the trail then records a
    /// deliberate yes rather than a policy that happened to be permissive.
    /// </para>
    /// </remarks>
    public static string ResolveInitialState(
        bool automaticMode,
        RequestPolicy policy,
        bool isAdministrator,
        bool isTrusted,
        bool isDestructive)
    {
        ArgumentNullException.ThrowIfNull(policy);
        if (!automaticMode)
        {
            return RequestStates.Wanted;
        }

        if (isDestructive)
        {
            return RequestStates.Pending;
        }

        return IsAutoApproved(policy, isAdministrator, isTrusted)
            ? RequestStates.Approved
            : RequestStates.Pending;
    }

    /// <summary>
    /// The quota that applies to a member: their own if they have one, otherwise the group's.
    /// </summary>
    /// <param name="policy">The group policy.</param>
    /// <param name="personalQuota">The member's own quota, or zero.</param>
    /// <returns>The effective weekly quota; zero means unlimited.</returns>
    public static int EffectiveQuota(RequestPolicy policy, int personalQuota)
    {
        ArgumentNullException.ThrowIfNull(policy);
        return personalQuota > 0 ? personalQuota : policy.WeeklyQuota;
    }

    /// <summary>Make a request.</summary>
    /// <param name="body">What is wanted.</param>
    /// <param name="userId">The Jellyfin user asking.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The decision.</returns>
    public async Task<CreateRequestResult> CreateAsync(
        CreateRequestBody body,
        string userId,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        var isMovie = body.TmdbId > 0;
        if (!isMovie && body.TvdbId <= 0)
        {
            return new CreateRequestResult
            {
                Refused = "Give either a tmdbId (a film) or a tvdbId (a series).",
                Status = 400,
            };
        }

        var kind = isMovie ? "movie" : "series";
        var itemKey = isMovie
            ? InventoryKeys.Movie(body.TmdbId)
            : InventoryKeys.SeriesPrefix(body.TvdbId);

        var group = await ResolveGroupAsync(body.Group, cancellationToken).ConfigureAwait(false);
        var policy = _store.Policy(group);
        var user = User(userId);

        // One row per title, whatever became of the last one. Two rows for the same film are never
        // two pieces of information -- the second says only that the button was pressed twice --
        // and they then have to be approved twice, grabbed twice and deleted twice.
        //
        // A request still running absorbs the new one outright: five people wanting the same film on
        // a Sunday evening is one download, and a season list that grows is exactly what Sonarr
        // wants anyway. One that finished is *reopened* below rather than filed beside, so what has
        // already been tried stays attached to the title it was tried on.
        var existing = _store.OpenForItem(itemKey) ?? _store.LatestMineForItem(itemKey);
        if (existing is not null && RequestStates.IsOpen(existing.State))
        {
            var merged = MergeSeasons(existing.Seasons, body.Seasons);
            if (merged.Count != existing.Seasons.Count)
            {
                existing.Seasons = merged;
                existing.Note = "Seasons added by a second request.";
                await _store.SaveAsync(existing, cancellationToken).ConfigureAwait(false);
                await _store.SetPublishedAsync(existing.Id, false, cancellationToken).ConfigureAwait(false);
            }

            return new CreateRequestResult { Request = existing, Created = false };
        }

        var quota = EffectiveQuota(policy, user.WeeklyQuota);
        if (quota > 0 && !user.IsAdministrator && user.RequestsThisWeek >= quota)
        {
            return new CreateRequestResult
            {
                Refused = string.Create(
                    CultureInfo.InvariantCulture,
                    $"You have made {user.RequestsThisWeek} requests this week, and the limit is {quota}."),
                Status = 429,
            };
        }

        var now = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);

        // Declined, failed, or filled and since gone: the same row is asked again, keeping its id
        // and its event trail. Everything the last attempt left behind is cleared, exactly as
        // RetryAsync clears it -- a stale fulfilling node would make the group think somebody was
        // already grabbing this, and a stale decision would attribute an approval nobody just gave.
        var reopening = existing is not null;
        var row = existing ?? new RequestRow
        {
            Id = Guid.NewGuid().ToString("N"),
            Kind = kind,
            ItemKey = itemKey,
            Provider = isMovie ? "tmdb" : "tvdb",
            ProviderId = isMovie ? body.TmdbId : body.TvdbId,
            Title = body.Title ?? string.Empty,
            Year = body.Year,
            PosterUrl = body.PosterUrl,
            Overview = body.Overview,
            SeasonCount = body.SeasonCount,
            RequestedBy = userId,
            RequestedByName = user.UserName,
            Mine = true,
        };

        // A row made before these were recorded, or reopened from a result that has them now: fill
        // the gaps without overwriting what is already there.
        row.Overview ??= body.Overview;
        if (row.SeasonCount == 0)
        {
            row.SeasonCount = body.SeasonCount;
        }

        row.Group = group ?? string.Empty;
        row.Seasons = MergeSeasons(reopening ? row.Seasons : new List<int>(), body.Seasons);

        // The claim race is timed from this, so it has to be the moment of *this* ask: leaving an
        // hour-old timestamp on a reopened request would put every volunteer's 20 second delay in
        // the past, and the home node would lose the race it is meant to win (docs/REQUESTS.md 4.4).
        row.RequestedAt = now;
        if (reopening)
        {
            row.DecidedBy = null;
            row.DecidedByName = null;
            row.DecidedAt = null;
            row.FulfillingNode = null;
            row.FulfillingServerName = null;
            await _store.SetPublishedAsync(row.Id, false, cancellationToken).ConfigureAwait(false);
        }

        // Fill in the title from the arr's own metadata lookup when the caller did not carry one.
        // Not cosmetic: an approvals queue listing "tvdb 73739" instead of "Lost" cannot be
        // triaged, and the arr already has the answer.
        if (string.IsNullOrWhiteSpace(row.Title))
        {
            await FillFromLookupAsync(row, cancellationToken).ConfigureAwait(false);
        }

        // The dedupe rule, applied before anybody is asked to approve anything. A title the group
        // already holds costs nothing to satisfy, so asking an administrator whether it may be
        // downloaded is asking about a download that is not going to happen.
        //
        // Unless the person knows it is there and wants something done about it anyway: an episode
        // that is missing, a better release, or a copy bad enough to replace. That is a question,
        // not a silent no-op, so the first ask is refused with the holders and something to play,
        // and the answer comes back on the second.
        var reason = RequestReasons.Parse(body.Reason);
        var holders = await HoldersAsync(itemKey, isMovie, policy.MinimumHeight, row.Seasons, cancellationToken)
            .ConfigureAwait(false);
        if (holders.Count > 0 && reason is null)
        {
            _logger.LogInformation(
                "Request for {ItemKey} refused: already held by {Holders}",
                itemKey,
                string.Join(", ", holders));
            return new CreateRequestResult
            {
                AlreadyHeld = true,
                Holders = holders.Distinct(StringComparer.OrdinalIgnoreCase).ToList(),
                PlayableItemId = ResolveLibraryItemId(isMovie, isMovie ? body.TmdbId : body.TvdbId),
                Status = 409,
            };
        }

        row.Reason = reason;
        row.ReasonNote = string.IsNullOrWhiteSpace(body.ReasonNote) ? null : body.ReasonNote.Trim();

        // Manual mode, a destructive reason, or the ordinary policy. Read from the store rather
        // than worked out here, because the answer depends on what peers advertise and this method
        // has to answer the moment somebody presses the button, mesh or no mesh.
        var automatic = _store.IsAutomaticMode(row.Group);
        row.State = ResolveInitialState(
            automatic,
            policy,
            user.IsAdministrator,
            user.Trusted,
            RequestReasons.IsDestructive(reason));

        var autoApproved = row.State == RequestStates.Approved;
        row.Note = row.State switch
        {
            RequestStates.Approved => "Approved automatically by the group's policy.",
            RequestStates.Wanted => "Waiting for somebody to add it.",
            _ => "Waiting for an administrator.",
        };

        if (autoApproved || row.State == RequestStates.Wanted)
        {
            // A wanted row is decided too, in the sense that nothing is going to be asked about it.
            // Leaving the decision empty would put it in front of an approvals screen that manual
            // mode does not show.
            row.DecidedBy = userId;
            row.DecidedByName = user.UserName;
            row.DecidedAt = row.RequestedAt;
        }

        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        await _store.AddEventAsync(row.Id, row.State, userId, row.Note, cancellationToken).ConfigureAwait(false);

        if (row.State == RequestStates.Pending)
        {
            await _notifier.NotifyAdministratorsAsync(
                    NotificationKinds.RequestPending,
                    "A request is waiting",
                    string.Create(
                        CultureInfo.InvariantCulture,
                        $"{user.UserName} asked for {row.Describe()}."),
                    row.Id,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        _logger.LogInformation(
            "{User} requested {Title} ({ItemKey}); state {State}",
            user.UserName,
            row.Describe(),
            itemKey,
            row.State);
        return new CreateRequestResult { Request = row, Created = !reopening };
    }

    /// <summary>Approve a pending request.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="adminId">The administrator approving it.</param>
    /// <param name="reason">Optional sentence for the requester.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The outcome.</returns>
    public Task<RequestDecisionResult> ApproveAsync(
        string id,
        string adminId,
        string? reason,
        CancellationToken cancellationToken)
        => DecideAsync(id, adminId, approve: true, reason, cancellationToken);

    /// <summary>Decline a request, or dismiss one from the wanted list.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="adminId">The administrator declining it.</param>
    /// <param name="reason">Optional sentence for the requester.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The outcome.</returns>
    /// <remarks>
    /// The same call serves both, because they are the same act: an administrator saying this is
    /// not going to happen, and the requester being told. Manual mode shows it as Dismiss and never
    /// uses the word approval, but a request nobody is ever going to satisfy has to be clearable or
    /// the wanted list stops being a list of things to do.
    /// </remarks>
    public Task<RequestDecisionResult> DeclineAsync(
        string id,
        string adminId,
        string? reason,
        CancellationToken cancellationToken)
        => DecideAsync(id, adminId, approve: false, reason, cancellationToken);

    private async Task<RequestDecisionResult> DecideAsync(
        string id,
        string adminId,
        bool approve,
        string? reason,
        CancellationToken cancellationToken)
    {
        var row = _store.Get(id);
        if (row is null)
        {
            return new RequestDecisionResult { NotFound = true };
        }

        // Deciding used to have no precondition at all, so a stray call could flip a finished
        // request back into the queue, or approve something already grabbed. Approving only makes
        // sense for a row that is waiting to be approved; declining also covers a wanted row,
        // because that is what Dismiss is.
        var allowed = approve
            ? row.State == RequestStates.Pending
            : row.State is RequestStates.Pending or RequestStates.Wanted;
        if (!allowed)
        {
            return new RequestDecisionResult
            {
                Conflict = string.Create(
                    CultureInfo.InvariantCulture,
                    $"This request is {row.State}, so it cannot be {(approve ? "approved" : "declined")}."),
            };
        }

        row.State = approve ? RequestStates.Approved : RequestStates.Declined;
        row.DecidedBy = adminId;
        row.DecidedByName = _notifier.NameOf(adminId);
        row.DecidedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
        row.Note = string.IsNullOrWhiteSpace(reason)
            ? (approve ? $"Approved by {row.DecidedByName}." : $"Declined by {row.DecidedByName}.")
            : reason;
        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        await _store.AddEventAsync(row.Id, row.State, adminId, row.Note, cancellationToken).ConfigureAwait(false);

        await _notifier.NotifyAsync(
                row.RequestedBy,
                approve ? NotificationKinds.RequestApproved : NotificationKinds.RequestDeclined,
                approve ? "Request approved" : "Request declined",
                string.Create(CultureInfo.InvariantCulture, $"{row.Describe()}: {row.Note}"),
                row.Id,
                cancellationToken)
            .ConfigureAwait(false);
        return new RequestDecisionResult { Request = row };
    }

    /// <summary>Put a failed request back in the queue.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="adminId">The administrator retrying it.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The updated request, or null.</returns>
    /// <remarks>
    /// Retrying clears the fulfilling node and republishes, which is what makes the claim protocol
    /// pick again: a node whose claim failed has dropped out of the ordering, so the next volunteer
    /// wins without anybody naming it.
    /// </remarks>
    public async Task<RequestRow?> RetryAsync(string id, string adminId, CancellationToken cancellationToken)
    {
        var row = _store.Get(id);
        if (row is null)
        {
            return null;
        }

        row.State = RequestStates.Approved;
        row.FulfillingNode = null;
        row.FulfillingServerName = null;
        row.Note = "Retried by " + _notifier.NameOf(adminId) + ".";
        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        await _store.SetPublishedAsync(row.Id, false, cancellationToken).ConfigureAwait(false);
        await _store.AddEventAsync(row.Id, row.State, adminId, row.Note, cancellationToken).ConfigureAwait(false);
        return row;
    }

    /// <summary>Badge counts for one member.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <returns>The counts.</returns>
    public RequestCounts Counts(string userId)
    {
        var isAdmin = _notifier.IsAdministrator(userId);
        var mine = _store.Mine();
        return new RequestCounts
        {
            PendingApproval = isAdmin
                ? mine.Count(r => string.Equals(r.State, RequestStates.Pending, StringComparison.Ordinal))
                : 0,
            MineOpen = mine.Count(r =>
                string.Equals(r.RequestedBy, userId, StringComparison.OrdinalIgnoreCase)
                && RequestStates.IsOpen(r.State)),
            UnreadNotifications = _store.UnreadCount(userId),
            CanApprove = isAdmin,
            Wanted = isAdmin
                ? mine.Count(r => string.Equals(r.State, RequestStates.Wanted, StringComparison.Ordinal))
                : 0,

            // Which group a request lands in needs the mesh to answer, and this is read while a
            // screen is being drawn, so it asks the coarse question instead: can anything this node
            // is part of fulfil a request on its own. Same answer either way for a node in one
            // group, which is nearly all of them.
            RequestsMode = _store.AnyGroupAutomatic() ? "automatic" : "manual",
        };
    }

    /// <summary>
    /// Whether this node can look anything up at all.
    /// </summary>
    /// <returns><c>true</c> when a manager or the catalogue can answer a search.</returns>
    /// <remarks>
    /// <para>
    /// <see cref="SearchAsync"/> answers an empty list when nothing can look anything up, which on
    /// the wire is indistinguishable from "nothing matched" — and the app, reasonably, draws the
    /// same empty state for both. A caller that can tell the two apart can say which it is.
    /// </para>
    /// <para>
    /// **In practice this is now always true**, and that is the point. It used to ask only whether
    /// a download manager was configured, so a node with none replaced the whole Requests screen
    /// with "Requests are not set up on this server. Downloading is turned off." Downloading has
    /// nothing to do with whether somebody may ask for a title: the catalogue ships its own key and
    /// can always be searched, and a request made with nothing configured waits on the wanted list
    /// until an administrator satisfies it. Dan: *"downloading shouldnt be required to put in
    /// requests"*. What remains is an honest fault check for the case where the catalogue key has
    /// been deliberately blanked and no manager is running either.
    /// </para>
    /// </remarks>
    public bool CanSearch()
        => _arrs.Create(ArrKind.Radarr) is not null
            || _arrs.Create(ArrKind.Sonarr) is not null
            || _catalogue.CanBrowse();

    /// <summary>
    /// Search TMDB and TVDB for something to request, and say what the group already has.
    /// </summary>
    /// <param name="term">What the person typed.</param>
    /// <param name="kind"><c>movie</c>, <c>series</c>, or null for both.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The results, films first.</returns>
    /// <remarks>
    /// <para>
    /// The lookup goes through Radarr and Sonarr rather than through a metadata provider of
    /// StingStream's own. They already hold API keys, already normalise the two providers' shapes
    /// onto one, and are the things that will eventually be asked to grab the result — so a title
    /// that cannot be looked up here is a title that could not have been added anyway, which makes
    /// this the honest search surface rather than a convenient one.
    /// </para>
    /// <para>
    /// Every result is annotated with whether the group already holds it. That is the whole
    /// difference between this and a Seerr search: the interesting answer is usually "you already
    /// have this", and finding that out after pressing Request is too late to be useful.
    /// </para>
    /// </remarks>
    public async Task<IReadOnlyList<RequestSearchResult>> SearchAsync(
        string term,
        string? kind,
        CancellationToken cancellationToken)
    {
        var results = new List<RequestSearchResult>();
        if (string.IsNullOrWhiteSpace(term))
        {
            return results;
        }

        var wantMovies = kind is null || string.Equals(kind, "movie", StringComparison.OrdinalIgnoreCase);
        var wantSeries = kind is null || string.Equals(kind, "series", StringComparison.OrdinalIgnoreCase);

        // The managers first, where they are running: they hold the provider keys, they normalise
        // both providers onto one shape, and they are what will eventually be asked to grab the
        // result. But a manager only runs when an indexer covers its kind now, and asking for
        // something is not the same act as fetching it -- so where one is not running, the same
        // question goes straight to the catalogue instead of the screen refusing to work at all.
        if (wantMovies)
        {
            results.AddRange(_arrs.Create(ArrKind.Radarr) is not null
                ? await LookupManyAsync(ArrKind.Radarr, term, cancellationToken).ConfigureAwait(false)
                : await _catalogue.SearchAsync(term, "movie", cancellationToken).ConfigureAwait(false));
        }

        if (wantSeries)
        {
            results.AddRange(_arrs.Create(ArrKind.Sonarr) is not null
                ? await LookupManyAsync(ArrKind.Sonarr, term, cancellationToken).ConfigureAwait(false)
                : await _catalogue.SearchAsync(term, "series", cancellationToken).ConfigureAwait(false));
        }

        // Posters for the series TVDB had none for, before the per-result loop rather than inside
        // it: that loop is sequential and talks to the mesh, and artwork is a bounded parallel pass
        // that must not be serialised behind it. Failure here is silent by design and leaves the
        // result posterless, which is what the app already draws a placeholder tile for.
        await _artwork.FillAsync(results, cancellationToken).ConfigureAwait(false);

        await AnnotateAsync(results, cancellationToken).ConfigureAwait(false);

        return results;
    }

    /// <summary>
    /// Browse the catalogue: what is popular now, or the best ever made, narrowed by a filter.
    /// </summary>
    /// <param name="kind"><c>movie</c>, <c>series</c>, or null for both.</param>
    /// <param name="sort"><c>popular</c>, <c>top_rated</c>, <c>newest</c> or <c>title</c>.</param>
    /// <param name="order"><c>asc</c> or <c>desc</c>.</param>
    /// <param name="genres">Genre names to narrow to, comma separated.</param>
    /// <param name="year">A release year, or null for every year.</param>
    /// <param name="page">Which page. One-based.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The page, with the genres its filter offers.</returns>
    /// <remarks>
    /// <para>
    /// The catalogue is not the arrs. They answer "is there a title called this", which is the
    /// right question for a search and the wrong one for somebody who does not yet know what they
    /// want, and neither of them can be asked what is worth watching.
    /// </para>
    /// <para>
    /// Everything else is the same as a search: the same result shape, the same annotation, the
    /// same Request button. A title found by browsing and the same title found by typing its name
    /// are one thing, and the screen must not be able to tell them apart.
    /// </para>
    /// </remarks>
    public async Task<RequestDiscoverPage> DiscoverAsync(
        string? kind,
        string? sort,
        string? order,
        string? genres,
        int? year,
        int page,
        CancellationToken cancellationToken)
    {
        var query = new TmdbBrowseQuery
        {
            Kind = kind,
            Sort = sort,
            Order = order,
            Genres = SplitGenres(genres),
            Year = year,
            Page = page,
        };

        var results = (await _catalogue.BrowseAsync(query, cancellationToken).ConfigureAwait(false)).ToList();
        await AnnotateAsync(results, cancellationToken).ConfigureAwait(false);

        return new RequestDiscoverPage
        {
            Results = results,
            Page = Math.Max(page, 1),
            Genres = (await _catalogue.GenreNamesAsync(kind, cancellationToken).ConfigureAwait(false)).ToList(),
        };
    }

    /// <summary>The genre names off a query string, empties dropped.</summary>
    private static List<string> SplitGenres(string? genres)
        => (genres ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .ToList();

    private async Task<List<RequestSearchResult>> LookupManyAsync(
        ArrKind kind,
        string term,
        CancellationToken cancellationToken)
    {
        var results = new List<RequestSearchResult>();
        var client = _arrs.Create(kind);
        if (client is null)
        {
            return results;
        }

        var isMovie = kind == ArrKind.Radarr;
        var path = isMovie
            ? $"movie/lookup?term={Uri.EscapeDataString(term)}"
            : $"series/lookup?term={Uri.EscapeDataString(term)}";
        try
        {
            var node = await client.GetAsync(path, cancellationToken).ConfigureAwait(false);
            if (node is not JsonArray array)
            {
                return results;
            }

            foreach (var entry in array.OfType<JsonObject>().Take(20))
            {
                var result = FromLookup(entry, isMovie);
                if (result is not null)
                {
                    results.Add(result);
                }
            }
        }
        catch (ArrApiException ex)
        {
            // A search that cannot reach one app should still show the other's results, and an
            // empty list with a logged reason beats a 502 the user cannot act on.
            _logger.LogWarning(ex, "Could not search {App} for {Term}", client.Name, term);
        }

        return results;
    }

    private static RequestSearchResult? FromLookup(JsonObject entry, bool isMovie)
    {
        var providerId = isMovie
            ? entry["tmdbId"]?.GetValue<int?>() ?? 0
            : entry["tvdbId"]?.GetValue<int?>() ?? 0;
        if (providerId <= 0)
        {
            // Without a provider id there is no item key, and without an item key there is nothing
            // the group index or the arr could be asked about. Not worth showing.
            return null;
        }

        return new RequestSearchResult
        {
            Kind = isMovie ? "movie" : "series",
            Title = entry["title"]?.GetValue<string>() ?? string.Empty,
            Year = entry["year"]?.GetValue<int?>(),
            Overview = entry["overview"]?.GetValue<string>(),
            PosterUrl = PosterOf(entry),
            TmdbId = isMovie ? providerId : 0,
            TvdbId = isMovie ? 0 : providerId,
            ItemKey = isMovie
                ? InventoryKeys.Movie(providerId)
                : InventoryKeys.SeriesPrefix(providerId),

            // Both managers put it on the lookup entry, and it is the only id here that is not for
            // us: the app sends a reader who taps a score to the page the score came from.
            ImdbId = entry["imdbId"]?.GetValue<string>(),
            SeasonCount = isMovie ? 0 : SeasonCountOf(entry),

            // All four have been on the lookup entry all along and were simply thrown away. They
            // are what lets the Find screen narrow a search by genre and reorder it, the same way a
            // library is narrowed, without a second call to anything.
            Genres = GenresOf(entry),
            Rating = RatingOf(entry),
            Popularity = entry["popularity"]?.GetValue<double?>(),
            Runtime = entry["runtime"]?.GetValue<int?>(),
            Certification = entry["certification"]?.GetValue<string>(),
        };
    }

    /// <summary>
    /// The highest real season number on a series lookup entry.
    /// </summary>
    /// <remarks>
    /// The highest number rather than the array's length, because season 0 is in there -- the
    /// specials folder -- and a show can be missing a season from the middle of the list. Both
    /// would make a count one out, and the app draws one chip per season from it.
    /// </remarks>
    private static int SeasonCountOf(JsonObject entry)
    {
        if (entry["seasons"] is not JsonArray seasons)
        {
            return 0;
        }

        var highest = 0;
        foreach (var season in seasons.OfType<JsonObject>())
        {
            var number = season["seasonNumber"]?.GetValue<int?>() ?? 0;
            if (number > highest)
            {
                highest = number;
            }
        }

        return highest;
    }

    /// <summary>The genre names on an arr lookup entry.</summary>
    private static List<string> GenresOf(JsonObject entry)
    {
        var names = new List<string>();
        if (entry["genres"] is not JsonArray genres)
        {
            return names;
        }

        foreach (var genre in genres)
        {
            var name = genre?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(name))
            {
                names.Add(name);
            }
        }

        return names;
    }

    /// <summary>
    /// The community rating on an arr lookup entry.
    /// </summary>
    /// <remarks>
    /// The two apps shape this differently: Radarr nests one object per rating source, Sonarr has a
    /// single flat one. TMDB's is preferred where there is a choice, because it is the number the
    /// catalogue orders by and a screen that mixes two scales sorts by neither.
    /// </remarks>
    private static double? RatingOf(JsonObject entry)
    {
        if (entry["ratings"] is not JsonObject ratings)
        {
            return null;
        }

        return (ratings["tmdb"] as JsonObject)?["value"]?.GetValue<double?>()
               ?? (ratings["imdb"] as JsonObject)?["value"]?.GetValue<double?>()
               ?? ratings["value"]?.GetValue<double?>();
    }

    /// <summary>
    /// The poster out of an arr lookup's <c>images</c> array.
    /// </summary>
    /// <remarks>
    /// Both apps put a <c>remoteUrl</c> and a <c>url</c> on each image and the two mean different
    /// things: <c>url</c> is a path on the arr's own cache, which is not reachable from a phone, and
    /// <c>remoteUrl</c> is TMDB's or TheTVDB's own CDN, which is. Taking the wrong one gives a
    /// Requests screen full of broken images that works perfectly in a browser on the server.
    /// </remarks>
    private static string? PosterOf(JsonObject entry)
    {
        if (entry["images"] is not JsonArray images)
        {
            return null;
        }

        foreach (var image in images.OfType<JsonObject>())
        {
            var cover = image["coverType"]?.GetValue<string>();
            if (string.Equals(cover, "poster", StringComparison.OrdinalIgnoreCase))
            {
                return image["remoteUrl"]?.GetValue<string>() ?? image["url"]?.GetValue<string>();
            }
        }

        return null;
    }

    private async Task FillFromLookupAsync(RequestRow row, CancellationToken cancellationToken)
    {
        var isMovie = string.Equals(row.Kind, "movie", StringComparison.Ordinal);
        var client = _arrs.Create(isMovie ? ArrKind.Radarr : ArrKind.Sonarr);
        if (client is null)
        {
            row.Title = string.Create(
                CultureInfo.InvariantCulture,
                $"{row.Provider} {row.ProviderId}");
            return;
        }

        try
        {
            var term = string.Create(CultureInfo.InvariantCulture, $"{row.Provider}:{row.ProviderId}");
            var found = await client.LookupAsync(term, cancellationToken).ConfigureAwait(false);
            if (found is not null)
            {
                row.Title = found["title"]?.GetValue<string>() ?? row.Title;
                row.Year ??= found["year"]?.GetValue<int?>();
                row.PosterUrl ??= PosterOf(found);
            }
        }
        catch (ArrApiException ex)
        {
            _logger.LogDebug(ex, "Could not look {Provider} {Id} up", row.Provider, row.ProviderId);
        }

        if (string.IsNullOrWhiteSpace(row.Title))
        {
            row.Title = string.Create(CultureInfo.InvariantCulture, $"{row.Provider} {row.ProviderId}");
        }

        // A series the arr had no poster for. Worth one lookup here as well as on the search path,
        // because this one persists: the row keeps the URL, so My Requests and the approvals queue
        // get it without ever asking again.
        if (row.PosterUrl is null
            && !isMovie
            && string.Equals(row.Provider, "tvdb", StringComparison.Ordinal)
            && row.ProviderId > 0)
        {
            row.PosterUrl = await _artwork
                .PosterForSeriesAsync(row.ProviderId, row.Title, row.Year, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    /// <summary>
    /// The group to make a request in.
    /// </summary>
    /// <remarks>
    /// One group is the overwhelmingly common case and the caller should not have to name it. Two
    /// or more and the caller must, because a request costs a specific group a download and picking
    /// one for them would be guessing about somebody else's bandwidth. A node in no group at all
    /// gets an empty string, which is a perfectly good request that simply never leaves the node —
    /// this node grabs it itself or it fails, which is the right behaviour for a standalone server.
    /// </remarks>
    private async Task<string?> ResolveGroupAsync(string? requested, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(requested))
        {
            return requested;
        }

        var groups = await _mesh.GroupsAsync(cancellationToken).ConfigureAwait(false);
        if (groups is null || groups.Count == 0)
        {
            return null;
        }

        return groups[0].Group;
    }

    /// <summary>
    /// Say what the group already thinks about each of these titles.
    /// </summary>
    /// <param name="results">The results, annotated in place.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// <para>
    /// This is the whole difference between asking StingStream for something and asking a Seerr: in
    /// a group that pools libraries the interesting answer is usually "somebody already has this",
    /// and finding that out after pressing Request is too late to be useful. Search and the
    /// catalogue both go through here, so neither can be the surface that quietly drops it.
    /// </para>
    /// <para>
    /// <strong>One pass over the index, not one per title.</strong> Asking
    /// <see cref="HoldersAsync"/> per result walks the whole group index each time, which is fine
    /// for the twenty a search returns and is not fine for the sixty a feed does. The keys are
    /// collected first and matched in a single walk.
    /// </para>
    /// </remarks>
    private async Task AnnotateAsync(
        IReadOnlyList<RequestSearchResult> results,
        CancellationToken cancellationToken)
    {
        if (results.Count == 0)
        {
            return;
        }

        var policy = _store.Policy(await ResolveGroupAsync(null, cancellationToken).ConfigureAwait(false));

        var movieKeys = new List<string>();
        var seriesPrefixes = new List<string>();
        foreach (var result in results)
        {
            if (IsMovie(result))
            {
                movieKeys.Add(result.ItemKey);
            }
            else
            {
                seriesPrefixes.Add(result.ItemKey);
            }
        }

        var held = await _sources
            .CandidatesForKeysAsync(movieKeys, seriesPrefixes, cancellationToken)
            .ConfigureAwait(false);

        foreach (var result in results)
        {
            var candidates = held.TryGetValue(result.ItemKey, out var found)
                ? found
                : Array.Empty<SourceCandidate>();

            // A search result is about the whole title, not a season: "the group has some of this
            // show" is the right answer to show beside it, and the season picker is where the finer
            // question gets asked.
            var holders = Holders(candidates, policy.MinimumHeight, Array.Empty<int>(), IsMovie(result));
            result.Holders = holders.Distinct().ToList();
            result.AvailableInGroup = holders.Count > 0;

            // Only for the ones the group has, which is a small part of a search page. Telling
            // somebody their library already has a title and giving them no way to reach it is the
            // unhelpful half of the answer, and this is the id the sheet's Play control needs.
            if (result.AvailableInGroup)
            {
                result.LocalItemId = ResolveLibraryItemId(
                    IsMovie(result),
                    IsMovie(result) ? result.TmdbId : result.TvdbId);
            }

            var existing = _store.LatestForItem(result.ItemKey);
            if (existing is not null)
            {
                result.RequestState = existing.State;
                result.RequestId = existing.Id;
            }
        }
    }

    /// <summary>Whether a result is a film, by the only field that always says so.</summary>
    private static bool IsMovie(RequestSearchResult result)
        => string.Equals(result.Kind, "movie", StringComparison.Ordinal);

    /// <summary>
    /// Who in the group holds a title at an acceptable quality.
    /// </summary>
    /// <remarks>
    /// For a season-limited series request, only a holder whose episode is in a season that was
    /// actually asked for counts. Without that, a show whose season 1 the group already had would
    /// answer a request for season 2 with "you already have this" the moment it was made — the
    /// dedupe rule turning into a refusal.
    /// </remarks>
    private async Task<List<string>> HoldersAsync(
        string itemKey,
        bool isMovie,
        int minimumHeight,
        IReadOnlyList<int> seasons,
        CancellationToken cancellationToken)
    {
        var group = isMovie
            ? await _sources.CandidatesEverywhereAsync(itemKey, cancellationToken).ConfigureAwait(false)
            : await _sources.GroupsHoldingPrefixAsync(itemKey, cancellationToken).ConfigureAwait(false);

        // Plus this node's own library. The group index only carries what has been published into a
        // group, so without this a single-server install said "nobody has this" about a film on its
        // own disk -- offering Request for something already on the shelf, and never asking the
        // "you already have this" question at all.
        var candidates = new List<SourceCandidate>(group);
        candidates.AddRange(_sources.LocalHoldings(
            itemKey,
            !isMovie,
            string.Empty,
            _runtime.Current?.ServerName ?? string.Empty));

        return Holders(candidates, minimumHeight, seasons, isMovie);
    }

    /// <summary>
    /// The library item for a title, so somebody told "you already have this" can go and play it.
    /// </summary>
    /// <param name="isMovie">Whether this is a film.</param>
    /// <param name="providerId">The TMDB id for a film, the TVDB id for a series.</param>
    /// <returns>The Jellyfin item id, or null when nothing matches yet.</returns>
    /// <remarks>
    /// <para>
    /// By provider id rather than by title, for the same reason the inventory is keyed that way:
    /// two films share a name far more often than they share a TMDB id, and sending somebody to
    /// the wrong one is worse than sending them nowhere.
    /// </para>
    /// <para>
    /// A copy held by a peer resolves here too. The federated materialiser writes every peer's
    /// holdings into this node's own library carrying the same provider ids, so there is no second
    /// lookup for the remote case and no way for the two to disagree. It does mean this can return
    /// null for a few seconds after a peer first announces something, which the caller treats as
    /// ordinary rather than as a failure.
    /// </para>
    /// </remarks>
    private string? ResolveLibraryItemId(bool isMovie, int providerId)
    {
        if (providerId <= 0)
        {
            return null;
        }

        try
        {
            var query = new MediaBrowser.Controller.Entities.InternalItemsQuery
            {
                IncludeItemTypes = new[]
                {
                    isMovie ? Jellyfin.Data.Enums.BaseItemKind.Movie : Jellyfin.Data.Enums.BaseItemKind.Series,
                },
                Recursive = true,
                Limit = 1,
            };
            query.HasAnyProviderId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                [isMovie ? MediaBrowser.Model.Entities.MetadataProvider.Tmdb.ToString()
                         : MediaBrowser.Model.Entities.MetadataProvider.Tvdb.ToString()] =
                    providerId.ToString(CultureInfo.InvariantCulture),
            };

            var items = _library.GetItemList(query);
            return items.Count > 0 ? items[0].Id.ToString("N", CultureInfo.InvariantCulture) : null;
        }
        catch (Exception ex)
        {
            // A link is a courtesy. Losing it must never turn "you already have this" into an error
            // on a request somebody is trying to make.
            _logger.LogDebug(ex, "Could not resolve a library item for provider id {Id}", providerId);
            return null;
        }
    }

    /// <summary>Which of these candidates count as holding the title, and what to call them.</summary>
    /// <remarks>
    /// The rule itself, separated from the fetch, so the per-title path and the batched one that
    /// annotates a whole feed cannot drift into two different answers.
    /// </remarks>
    private static List<string> Holders(
        IReadOnlyList<SourceCandidate> candidates,
        int minimumHeight,
        IReadOnlyList<int> seasons,
        bool isMovie)
        => candidates
            .Where(c => c.Online && (minimumHeight <= 0 || (c.Height ?? int.MaxValue) >= minimumHeight))
            .Where(c => isMovie
                        || seasons.Count == 0
                        || (RequestWorker.SeasonOf(c.ItemKey) is int s && seasons.Contains(s)))
            .Select(c => string.IsNullOrWhiteSpace(c.ServerName) ? c.Node : c.ServerName)
            .ToList();

    /// <summary>Union two season lists, sorted, with duplicates removed.</summary>
    /// <param name="a">One list.</param>
    /// <param name="b">The other.</param>
    /// <returns>The union.</returns>
    /// <remarks>
    /// Public and static because it is the entire behaviour of "two people asked for different
    /// seasons of the same show", and that is worth a test that does not need a database.
    /// </remarks>
    public static List<int> MergeSeasons(IEnumerable<int>? a, IEnumerable<int>? b)
    {
        var set = new SortedSet<int>();
        foreach (var n in (a ?? Enumerable.Empty<int>()).Concat(b ?? Enumerable.Empty<int>()))
        {
            if (n > 0)
            {
                set.Add(n);
            }
        }

        return set.ToList();
    }

    private RequestUser Describe(Jellyfin.Database.Implementations.Entities.User user, bool isAdministrator)
    {
        var id = user.Id.ToString("N");
        var (trusted, quota) = _store.Trust(id);
        return new RequestUser
        {
            UserId = id,
            UserName = user.Username,
            IsAdministrator = isAdministrator,
            Trusted = trusted,
            WeeklyQuota = quota,
            RequestsThisWeek = _store.RequestsThisWeek(id),
        };
    }
}
