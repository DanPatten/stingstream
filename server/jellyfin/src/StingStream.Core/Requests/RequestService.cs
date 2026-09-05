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

    /// <summary>The HTTP status a controller should answer with.</summary>
    public int Status { get; set; } = 200;
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
    private readonly MediaBrowser.Controller.Library.IUserManager _users;
    private readonly ILogger<RequestService> _logger;

    public RequestService(
        RequestStore store,
        RequestNotifier notifier,
        IMeshClient mesh,
        ArrClientFactory arrs,
        FederatedSourceService sources,
        MediaBrowser.Controller.Library.IUserManager users,
        ILogger<RequestService> logger)
    {
        _store = store;
        _notifier = notifier;
        _mesh = mesh;
        _arrs = arrs;
        _sources = sources;
        _users = users;
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

        // Somebody already asked for this and it has not finished. Fold the request in rather than
        // making a second one: five people wanting the same film on a Sunday evening is one
        // download, and a season list that grows is exactly what Sonarr wants anyway.
        var existing = _store.OpenForItem(itemKey);
        if (existing is not null)
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

        var row = new RequestRow
        {
            Id = Guid.NewGuid().ToString("N"),
            Group = group ?? string.Empty,
            Kind = kind,
            ItemKey = itemKey,
            Provider = isMovie ? "tmdb" : "tvdb",
            ProviderId = isMovie ? body.TmdbId : body.TvdbId,
            Title = body.Title ?? string.Empty,
            Year = body.Year,
            PosterUrl = body.PosterUrl,
            Seasons = MergeSeasons(new List<int>(), body.Seasons),
            RequestedBy = userId,
            RequestedByName = user.UserName,
            RequestedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
            Mine = true,
        };

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
        var holders = await HoldersAsync(itemKey, isMovie, policy.MinimumHeight, row.Seasons, cancellationToken)
            .ConfigureAwait(false);
        if (holders.Count > 0)
        {
            row.State = RequestStates.Available;
            row.Note = string.Create(
                CultureInfo.InvariantCulture,
                $"Already in the group, held by {string.Join(", ", holders.Distinct())}. Nothing was downloaded.");
            await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
            await _store.AddEventAsync(row.Id, row.State, "system", row.Note, cancellationToken)
                .ConfigureAwait(false);
            _logger.LogInformation(
                "Request {Id} for {ItemKey} is already satisfied by {Holders}",
                row.Id,
                itemKey,
                string.Join(", ", holders));
            return new CreateRequestResult { Request = row, Created = true };
        }

        var autoApproved = IsAutoApproved(policy, user.IsAdministrator, user.Trusted);
        row.State = autoApproved ? RequestStates.Approved : RequestStates.Pending;
        row.Note = autoApproved
            ? "Approved automatically by the group's policy."
            : "Waiting for an administrator.";
        if (autoApproved)
        {
            row.DecidedBy = userId;
            row.DecidedByName = user.UserName;
            row.DecidedAt = row.RequestedAt;
        }

        await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        await _store.AddEventAsync(row.Id, row.State, userId, row.Note, cancellationToken).ConfigureAwait(false);

        if (!autoApproved)
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
        return new CreateRequestResult { Request = row, Created = true };
    }

    /// <summary>Approve a pending request.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="adminId">The administrator approving it.</param>
    /// <param name="reason">Optional sentence for the requester.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The updated request, or null when there is no such request.</returns>
    public Task<RequestRow?> ApproveAsync(
        string id,
        string adminId,
        string? reason,
        CancellationToken cancellationToken)
        => DecideAsync(id, adminId, approve: true, reason, cancellationToken);

    /// <summary>Decline a pending request.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="adminId">The administrator declining it.</param>
    /// <param name="reason">Optional sentence for the requester.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The updated request, or null.</returns>
    public Task<RequestRow?> DeclineAsync(
        string id,
        string adminId,
        string? reason,
        CancellationToken cancellationToken)
        => DecideAsync(id, adminId, approve: false, reason, cancellationToken);

    private async Task<RequestRow?> DecideAsync(
        string id,
        string adminId,
        bool approve,
        string? reason,
        CancellationToken cancellationToken)
    {
        var row = _store.Get(id);
        if (row is null)
        {
            return null;
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
        return row;
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
        row.FulfillingNodeName = null;
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
        };
    }

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

        if (wantMovies)
        {
            results.AddRange(await LookupManyAsync(ArrKind.Radarr, term, cancellationToken).ConfigureAwait(false));
        }

        if (wantSeries)
        {
            results.AddRange(await LookupManyAsync(ArrKind.Sonarr, term, cancellationToken).ConfigureAwait(false));
        }

        var policy = _store.Policy(await ResolveGroupAsync(null, cancellationToken).ConfigureAwait(false));
        foreach (var result in results)
        {
            var holders = await HoldersAsync(
                    result.ItemKey,
                    result.TmdbId > 0,
                    policy.MinimumHeight,
                    // A search result is about the whole title, not a season: "the group has some of
                    // this show" is the right answer to show beside it, and the season picker is
                    // where the finer question gets asked.
                    Array.Empty<int>(),
                    cancellationToken)
                .ConfigureAwait(false);
            result.Holders = holders.Distinct().ToList();
            result.AvailableInGroup = holders.Count > 0;

            var existing = _store.LatestForItem(result.ItemKey);
            if (existing is not null)
            {
                result.RequestState = existing.State;
                result.RequestId = existing.Id;
            }
        }

        return results;
    }

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
        };
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
        IReadOnlyList<SourceCandidate> candidates = isMovie
            ? await _sources.CandidatesEverywhereAsync(itemKey, cancellationToken).ConfigureAwait(false)
            : await _sources.GroupsHoldingPrefixAsync(itemKey, cancellationToken).ConfigureAwait(false);

        return candidates
            .Where(c => c.Online && (minimumHeight <= 0 || (c.Height ?? int.MaxValue) >= minimumHeight))
            .Where(c => isMovie
                        || seasons.Count == 0
                        || (RequestWorker.SeasonOf(c.ItemKey) is int s && seasons.Contains(s)))
            .Select(c => string.IsNullOrWhiteSpace(c.NodeName) ? c.Node : c.NodeName)
            .ToList();
    }

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
