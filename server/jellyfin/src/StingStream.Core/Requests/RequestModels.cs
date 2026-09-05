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

    /// <summary>States a request can still change out of on its own.</summary>
    public static bool IsOpen(string? state)
        => state is Pending or Approved or Fulfilling;
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

    /// <summary>A poster URL from the search result, so the request list has artwork immediately.</summary>
    public string? PosterUrl { get; set; }
}

/// <summary>Body of an approve or decline.</summary>
public sealed class RequestDecisionBody
{
    /// <summary>Optional sentence shown to the requester.</summary>
    public string? Reason { get; set; }
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

    /// <summary>True when a member of the group already holds it at an acceptable quality.</summary>
    public bool AvailableInGroup { get; set; }

    /// <summary>Who holds it.</summary>
    public List<string> Holders { get; set; } = new();

    /// <summary>The state of an existing request for the same title, if there is one.</summary>
    public string? RequestState { get; set; }

    /// <summary>The id of that request, so the app can link to it rather than offering a duplicate.</summary>
    public string? RequestId { get; set; }
}
