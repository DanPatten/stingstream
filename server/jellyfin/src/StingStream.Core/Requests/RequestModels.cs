using System;
using System.Collections.Generic;

namespace StingStream.Core.Requests;

/// <summary>
/// The states a request moves through, and the only strings that ever appear in
/// <c>requests.state</c>.
/// </summary>
/// <remarks>
/// <para>
/// <c>pending → approved → fulfilling → available</c> is the happy path, with <c>declined</c> and
/// <c>failed</c> as the two ways out. Two of the six deserve a note:
/// </para>
/// <list type="bullet">
///   <item><description>
///     <see cref="Approved"/> is not "somebody pressed a button". It is "this request is allowed to
///     cost the group a download", which the policy may decide the instant the request is made. A
///     request under <c>auto_approve: everyone</c> is created already approved and never has a
///     pending row for an admin to look at.
///   </description></item>
///   <item><description>
///     <see cref="Available"/> is reached in two quite different ways, and the note on the row says
///     which: somebody grabbed it, or the group already had it and nothing was downloaded at all.
///     Collapsing those would make the dedupe rule invisible, which is the same mistake
///     <c>library_state</c> exists to avoid.
///   </description></item>
/// </list>
/// </remarks>
public static class RequestStates
{
    /// <summary>Waiting for an administrator. The policy did not auto-approve it.</summary>
    public const string Pending = "pending";

    /// <summary>Allowed to proceed. Waiting to be routed to a node that can fulfil it.</summary>
    public const string Approved = "approved";

    /// <summary>A node has claimed it and is grabbing it.</summary>
    public const string Fulfilling = "fulfilling";

    /// <summary>In the group index. Either somebody grabbed it, or the group already had it.</summary>
    public const string Available = "available";

    /// <summary>An administrator said no.</summary>
    public const string Declined = "declined";

    /// <summary>Nobody could fulfil it, or the node that tried gave up.</summary>
    public const string Failed = "failed";

    /// <summary>
    /// On the administrator's wanted list. Nobody in the group can search, so nothing is going to
    /// grab it: it waits until the library serves the same item, however that happens.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The state a request is born in when the group has no indexer configured at all. It is
    /// deliberately **not** <see cref="Approved"/> with a flag: the fulfilment loop selects
    /// <c>approved or fulfilling</c> to publish, route, claim and grab, so a wanted row reusing
    /// that state would be gossiped and then grabbed by whichever node next gained an indexer,
    /// which is the opposite of an administrator satisfying it by hand. Being a state those queries
    /// never select is the whole mechanism, and it is also why this costs nothing on the wire:
    /// a state that is never published never needs the mesh to understand it.
    /// </para>
    /// <para>
    /// It never fails on its own. The six-hour fulfilment deadline and the "nobody can grab this"
    /// checks exist for a request somebody is actually trying to satisfy, and a wanted row is not
    /// one: waiting a month for a disc to arrive is the feature working, not a fault.
    /// </para>
    /// </remarks>
    public const string Wanted = "wanted";

    /// <summary>States a request can still change out of on its own.</summary>
    public static bool IsOpen(string? state)
        => state is Pending or Approved or Fulfilling or Wanted;
}

/// <summary>Why somebody asked for a title the library already has.</summary>
/// <remarks>
/// <para>
/// Asking for something already held used to create a row that was silently already
/// <see cref="RequestStates.Available"/>, which told the person nothing and gave them no way to
/// reach the copy they had just asked for. It is now a question, and this is the answer to it.
/// </para>
/// <para>
/// <see cref="MissingEpisode"/> is ordinary: the group holds the series but not the seasons wanted,
/// which the existing season handling already covers. The other two are **destructive** — they act
/// on a file that already exists, which is why <see cref="IsDestructive"/> is separate from simply
/// having a reason, and why such a request always waits for an administrator whatever the policy
/// says.
/// </para>
/// <para>
/// A copy below the group's <c>MinimumHeight</c> is already filtered out of the holder list, so it
/// never reaches this question at all and is simply grabbed afresh. These reasons therefore only
/// ever describe a quality problem the height check structurally cannot see: the wrong audio or
/// language, a bad encode, the wrong cut.
/// </para>
/// </remarks>
public static class RequestReasons
{
    /// <summary>The group has the series but not the episodes wanted. Not destructive.</summary>
    public const string MissingEpisode = "missing_episode";

    /// <summary>A better release is wanted, keeping the existing one as another version.</summary>
    public const string BetterQuality = "better_quality";

    /// <summary>The existing copy is bad and should be replaced outright.</summary>
    public const string BadCopy = "bad_copy";

    /// <summary>Parse a stored or submitted value, or null when it names none of them.</summary>
    /// <param name="value">The value.</param>
    /// <returns>The canonical spelling, or null.</returns>
    public static string? Parse(string? value) => (value ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        MissingEpisode or "missingepisode" or "missing" => MissingEpisode,
        BetterQuality or "betterquality" or "quality" => BetterQuality,
        BadCopy or "badcopy" or "bad" => BadCopy,
        _ => null,
    };

    /// <summary>Whether acting on this reason would touch a file the group already holds.</summary>
    /// <param name="reason">One of the constants here, or null.</param>
    /// <returns>True when it would add to or replace an existing copy.</returns>
    public static bool IsDestructive(string? reason)
        => Parse(reason) is BetterQuality or BadCopy;
}

/// <summary>How a group decides whether a request needs an administrator.</summary>
public static class AutoApprove
{
    /// <summary>Every member's requests are approved as they are made.</summary>
    public const string Everyone = "everyone";

    /// <summary>Administrators and members marked trusted; everybody else waits.</summary>
    public const string Trusted = "trusted";

    /// <summary>Only an administrator's own requests skip the queue.</summary>
    public const string AdminsOnly = "admins_only";

    /// <summary>Parse a stored or submitted value, or null when it names none of them.</summary>
    /// <param name="value">The value.</param>
    /// <returns>The canonical spelling, or null.</returns>
    public static string? Parse(string? value) => (value ?? string.Empty).Trim().ToLowerInvariant() switch
    {
        Everyone => Everyone,
        Trusted => Trusted,
        AdminsOnly or "admins" or "adminsonly" => AdminsOnly,
        _ => null,
    };
}

/// <summary>
/// One group's request policy: who may request without asking, and how often.
/// </summary>
/// <remarks>
/// Per group rather than per node, because a request costs the *group* a download and the answer to
/// "may this person spend that" is a property of the group they are spending it in. A node in two
/// groups has two policies.
/// </remarks>
public sealed class RequestPolicy
{
    /// <summary>The group id, or an empty string for this node's default.</summary>
    public string Group { get; set; } = string.Empty;

    /// <summary>One of <see cref="AutoApprove"/>.</summary>
    public string AutoApprove { get; set; } = Requests.AutoApprove.Trusted;

    /// <summary>
    /// How many requests one member may make in a rolling seven days. Zero means no limit.
    /// </summary>
    /// <remarks>
    /// Declined requests do not count. Counting them would let one bad request cost a member a
    /// week's allowance for a decision they did not make.
    /// </remarks>
    public int WeeklyQuota { get; set; }

    /// <summary>
    /// Ignore a group copy shorter than this many pixels when deciding a request is already
    /// satisfied. Zero means any copy the group has will do.
    /// </summary>
    public int MinimumHeight { get; set; }

    public string UpdatedAt { get; set; } = string.Empty;
}

/// <summary>One member, as the request policy sees them.</summary>
public sealed class RequestUser
{
    public string UserId { get; set; } = string.Empty;

    public string UserName { get; set; } = string.Empty;

    /// <summary>Whether Jellyfin considers them an administrator on this node.</summary>
    public bool IsAdministrator { get; set; }

    /// <summary>
    /// Whether they are trusted, under <c>auto_approve: trusted</c>. Administrators always are.
    /// </summary>
    public bool Trusted { get; set; }

    /// <summary>Their own weekly quota, or zero to use the group's.</summary>
    public int WeeklyQuota { get; set; }

    /// <summary>How many requests they have made in the last seven days.</summary>
    public int RequestsThisWeek { get; set; }
}

/// <summary>One member request, as this node holds it.</summary>
public sealed class RequestRow
{
    /// <summary>Opaque id, minted here, stable for the life of the request.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>The group the request is made in.</summary>
    public string Group { get; set; } = string.Empty;

    /// <summary><c>movie</c> or <c>series</c>.</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>The film's item key, or the prefix a series' episodes share.</summary>
    public string ItemKey { get; set; } = string.Empty;

    /// <summary><c>tmdb</c> or <c>tvdb</c>.</summary>
    public string Provider { get; set; } = string.Empty;

    /// <summary>The provider's id.</summary>
    public int ProviderId { get; set; }

    public string Title { get; set; } = string.Empty;

    public int? Year { get; set; }

    /// <summary>Poster URL from the arr's own metadata lookup, so the app has something to draw.</summary>
    public string? PosterUrl { get; set; }

    /// <summary>
    /// The blurb, copied from the search result the request was made from.
    /// </summary>
    /// <remarks>
    /// Kept here because there is nowhere else to read it later: the managers hold their own
    /// overview only for titles they track, and a request the group fulfilled elsewhere is tracked
    /// by nothing here. The edit sheet opened on a poster and a title without it.
    /// </remarks>
    public string? Overview { get; set; }

    /// <summary>
    /// How many seasons the show has, excluding specials. <c>0</c> for a film, and for a request
    /// made before this was recorded.
    /// </summary>
    /// <remarks>
    /// So the season picker can offer the seasons that exist rather than a fixed range. Nothing
    /// asks TVDB how long a show is once the request exists, so it is captured when the request is
    /// made or not at all.
    /// </remarks>
    public int SeasonCount { get; set; }

    /// <summary>Season numbers wanted. Empty means every season, which is what Sonarr calls "all".</summary>
    public List<int> Seasons { get; set; } = new();

    /// <summary>One of <see cref="RequestStates"/>.</summary>
    public string State { get; set; } = RequestStates.Pending;

    public string RequestedBy { get; set; } = string.Empty;

    public string RequestedByName { get; set; } = string.Empty;

    public string RequestedAt { get; set; } = string.Empty;

    /// <summary>The administrator who approved or declined it, when one did.</summary>
    public string? DecidedBy { get; set; }

    public string? DecidedByName { get; set; }

    public string? DecidedAt { get; set; }

    /// <summary>The node that claimed it, once one has.</summary>
    public string? FulfillingNode { get; set; }

    public string? FulfillingNodeName { get; set; }

    /// <summary>A sentence a person can read: why it is where it is.</summary>
    public string Note { get; set; } = string.Empty;

    /// <summary>
    /// Why this was asked for when the group already held it. One of <see cref="RequestReasons"/>,
    /// or null for an ordinary request, which is almost all of them.
    /// </summary>
    public string? Reason { get; set; }

    /// <summary>Anything the requester added in their own words. Shown to the administrator.</summary>
    public string? ReasonNote { get; set; }

    /// <summary>Whether this node originated it, as opposed to hearing about it over gossip.</summary>
    public bool Mine { get; set; } = true;

    public string UpdatedAt { get; set; } = string.Empty;

    /// <summary>The one-line description used in notifications and logs.</summary>
    public string Describe()
        => Year is > 0
            ? string.Create(System.Globalization.CultureInfo.InvariantCulture, $"{Title} ({Year})")
            : Title;
}

/// <summary>One thing that happened to a request, kept so a state change has a trail.</summary>
public sealed class RequestEvent
{
    public long Id { get; set; }

    public string RequestId { get; set; } = string.Empty;

    /// <summary>The state the request moved into.</summary>
    public string State { get; set; } = string.Empty;

    /// <summary>Who or what caused it: a user id, a node id, or <c>system</c>.</summary>
    public string Actor { get; set; } = string.Empty;

    public string Note { get; set; } = string.Empty;

    public string At { get; set; } = string.Empty;
}

/// <summary>An in-app notification, waiting for the app to poll for it.</summary>
public sealed class NotificationRow
{
    public long Id { get; set; }

    /// <summary>The Jellyfin user it is for.</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// A machine-readable reason: <c>request_pending</c>, <c>request_approved</c>,
    /// <c>request_declined</c>, <c>request_available</c>, <c>request_failed</c>.
    /// </summary>
    public string Kind { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string Body { get; set; } = string.Empty;

    /// <summary>The request it is about, so the app can deep-link to it.</summary>
    public string? RequestId { get; set; }

    public bool Read { get; set; }

    public string CreatedAt { get; set; } = string.Empty;
}

/// <summary>Badge counts, so a navigation bar does not have to fetch every list to draw a dot.</summary>
public sealed class RequestCounts
{
    /// <summary>Requests waiting for an administrator on this node.</summary>
    public int PendingApproval { get; set; }

    /// <summary>The caller's own open requests.</summary>
    public int MineOpen { get; set; }

    /// <summary>The caller's unread notifications.</summary>
    public int UnreadNotifications { get; set; }

    /// <summary>Whether the caller may see the approvals queue at all.</summary>
    public bool CanApprove { get; set; }

    /// <summary>Requests on the wanted list, for an administrator.</summary>
    public int Wanted { get; set; }

    /// <summary>
    /// How this group fulfils requests: <c>automatic</c> or <c>manual</c>.
    /// </summary>
    /// <remarks>
    /// Carried here rather than on an endpoint of its own because every member needs it and every
    /// screen that touches requests already polls this. The detailed indexer health that drives the
    /// administrator's banner is a different question on a different, administrator-only endpoint;
    /// this is the coarse one a member is allowed to know, and it says nothing about what is
    /// configured beyond how their own request will be treated.
    /// </remarks>
    public string RequestsMode { get; set; } = "automatic";
}

/// <summary>Request to make a request.</summary>
public sealed class CreateRequestBody
{
    /// <summary>The Movie Database id, for a film.</summary>
    public int TmdbId { get; set; }

    /// <summary>The TheTVDB id, for a series. Give one of these, not both.</summary>
    public int TvdbId { get; set; }

    /// <summary>Seasons wanted. Empty or absent means all of them.</summary>
    public List<int> Seasons { get; set; } = new();

    /// <summary>
    /// The group to request in. Optional: with one group, which is the common case, it is obvious.
    /// </summary>
    public string? Group { get; set; }

    /// <summary>Title and year, when the caller already has them from a search.</summary>
    public string? Title { get; set; }

    /// <summary>The release year.</summary>
    public int? Year { get; set; }

    /// <summary>The blurb from the search result, so the request keeps it after the search is gone.</summary>
    public string? Overview { get; set; }

    /// <summary>How many seasons the show has, from the search result. Zero for a film.</summary>
    public int SeasonCount { get; set; }

    /// <summary>A poster URL from the search result, so the request list has artwork immediately.</summary>
    public string? PosterUrl { get; set; }

    /// <summary>
    /// Why this is being asked for when the group already holds it. One of
    /// <see cref="RequestReasons"/>.
    /// </summary>
    /// <remarks>
    /// Absent on a first call. When the group already holds the title, the request is refused with
    /// the holders and something to play, and the caller asks again carrying the answer. That is
    /// the whole two-step: there is no separate endpoint, and an ordinary request never sends this.
    /// </remarks>
    public string? Reason { get; set; }

    /// <summary>Optional: anything the requester wants to add in their own words.</summary>
    public string? ReasonNote { get; set; }
}

/// <summary>Body of an approve or decline.</summary>
public sealed class RequestDecisionBody
{
    /// <summary>Optional sentence shown to the requester.</summary>
    public string? Reason { get; set; }
}

/// <summary>A page of the catalogue, with the options its filters offer.</summary>
/// <remarks>
/// The genres travel with the results rather than through an endpoint of their own, so the chip's
/// options and the grid under it can never disagree, and opening Find is one round trip and not
/// two.
/// </remarks>
public sealed class RequestDiscoverPage
{
    /// <summary>The titles, in the order asked for.</summary>
    public List<RequestSearchResult> Results { get; set; } = new();

    /// <summary>Which page this is. One-based.</summary>
    public int Page { get; set; } = 1;

    /// <summary>Every genre the current kind can be filtered by.</summary>
    public List<string> Genres { get; set; } = new();
}

/// <summary>One search result, with what the group already has attached.</summary>
public sealed class RequestSearchResult
{
    /// <summary><c>movie</c> or <c>series</c>.</summary>
    public string Kind { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public int? Year { get; set; }

    public string? Overview { get; set; }

    public string? PosterUrl { get; set; }

    public int TmdbId { get; set; }

    public int TvdbId { get; set; }

    /// <summary>The item key, or the series prefix.</summary>
    public string ItemKey { get; set; } = string.Empty;

    /// <summary>
    /// The IMDb id, <c>tt</c> and seven or eight digits, when the lookup carried one.
    /// </summary>
    /// <remarks>
    /// The one id in this class that is not for us: nothing here is keyed by it, and the app uses
    /// it for exactly one thing, which is to send a reader who taps a score to the page the score
    /// came from. Null is a normal answer and the app falls back to an IMDb search on the title.
    /// </remarks>
    public string? ImdbId { get; set; }

    /// <summary>
    /// How many seasons this show has, excluding specials. <c>0</c> for a movie, and for a series
    /// whose lookup did not say.
    /// </summary>
    /// <remarks>
    /// So the app can offer the seasons that exist rather than a fixed range. It costs nothing:
    /// the season list is already on the lookup entry this result is built from, and it comes down
    /// the same endpoint a member is allowed to call -- asking Sonarr directly from the app would
    /// need elevation, which is why the picker used to guess at twenty.
    /// </remarks>
    public int SeasonCount { get; set; }

    /// <summary>
    /// The genres this title is filed under, in the metadata provider's own words.
    /// </summary>
    /// <remarks>
    /// On the wire so the Find screen can filter by genre the way a library does. Both arr lookups
    /// have carried this all along and it was simply dropped; the catalogue fills it from the
    /// provider's genre table.
    /// </remarks>
    public List<string> Genres { get; set; } = new();

    /// <summary>The community rating out of ten, when the provider has one.</summary>
    public double? Rating { get; set; }

    /// <summary>
    /// How much attention this title is getting, on the provider's own scale.
    /// </summary>
    /// <remarks>
    /// Only comparable against other titles from the same answer, which is all the feed uses it
    /// for. Sonarr does not report it, so a series found by search carries none.
    /// </remarks>
    public double? Popularity { get; set; }

    /// <summary>Length in minutes, when the lookup said. An episode length, for a series.</summary>
    public int? Runtime { get; set; }

    /// <summary>The age rating, in whichever country's scheme the lookup answered in.</summary>
    public string? Certification { get; set; }

    /// <summary>True when a member of the group already holds it at an acceptable quality.</summary>
    public bool AvailableInGroup { get; set; }

    /// <summary>Who holds it.</summary>
    public List<string> Holders { get; set; } = new();

    /// <summary>
    /// The library item to play, when the group's copy has resolved to one on this node.
    /// </summary>
    /// <remarks>
    /// Set only for a result the group already holds, because that is the one case anybody needs
    /// it: being told "your library already has this" without a way to go and watch it is the
    /// unhelpful half of the answer. Null is ordinary rather than an error -- a peer's copy becomes
    /// an item here only once the federated materialiser has caught up -- and the app simply offers
    /// no link then.
    /// </remarks>
    public string? LocalItemId { get; set; }

    /// <summary>The state of an existing request for the same title, if there is one.</summary>
    public string? RequestState { get; set; }

    /// <summary>The id of that request, so the app can link to it rather than offering a duplicate.</summary>
    public string? RequestId { get; set; }
}
