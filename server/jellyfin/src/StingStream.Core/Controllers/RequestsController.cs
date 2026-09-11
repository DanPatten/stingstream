using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Requests;

namespace StingStream.Core.Controllers;

/// <summary>
/// Member requests: asking for something the group does not have, and watching it arrive.
/// </summary>
/// <remarks>
/// <para>
/// <b>Who may do what.</b> Every authenticated member may search, make a request, and see their own.
/// Approving, declining, retrying, editing the policy and editing trust need elevation, and so does
/// seeing <em>somebody else's</em> requests — a request is a small statement about what a person
/// wants to watch, and a household member should not be able to enumerate the rest of the house's.
/// The <c>[Authorize]</c> on the class is the floor; the elevated actions carry their own attribute.
/// </para>
/// <para>
/// Notifications live under this controller rather than at a route of their own because every one
/// of them is about a request. When M7 has something else to notify about, they move.
/// </para>
/// </remarks>
[Authorize]
[Route("stingstream/api/v1/requests")]
public sealed class RequestsController : StingStreamControllerBase
{
    private readonly RequestService _requests;
    private readonly RequestStore _store;
    private readonly RequestWorker _worker;
    private readonly RequestWithdrawal _withdrawal;

    public RequestsController(
        RequestService requests,
        RequestStore store,
        RequestWorker worker,
        RequestWithdrawal withdrawal)
    {
        _requests = requests;
        _store = store;
        _worker = worker;
        _withdrawal = withdrawal;
    }

    // --- reading -----------------------------------------------------------

    /// <summary>
    /// Requests, filtered.
    /// </summary>
    /// <param name="mine">Only the caller's own. Defaults to true for a non-administrator.</param>
    /// <param name="state">Only requests in this state.</param>
    /// <response code="200">The requests, newest first.</response>
    /// <returns>The requests.</returns>
    /// <remarks>
    /// A non-administrator always gets their own and nothing else, whatever they pass: the filter
    /// is a convenience for an administrator, not an access control the caller chooses.
    /// </remarks>
    [HttpGet]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<RequestRow>> List(
        [FromQuery] bool? mine,
        [FromQuery] string? state)
    {
        var me = CurrentUserId();
        var isAdmin = IsAdministrator();
        var rows = _store.All().AsEnumerable();

        if (!isAdmin || mine == true)
        {
            // `IsSelf` rather than a string compare, for the reason on `MaySee`: a row written
            // with the id in one GUID format and a claim issued in the other are the same user.
            rows = rows.Where(r => IsSelf(r.RequestedBy)
                || (!Guid.TryParse(r.RequestedBy, out _)
                    && string.Equals(r.RequestedBy, me, StringComparison.OrdinalIgnoreCase)));
        }

        if (!string.IsNullOrWhiteSpace(state))
        {
            rows = rows.Where(r => string.Equals(r.State, state, StringComparison.OrdinalIgnoreCase));
        }

        return Ok(rows.ToList());
    }

    /// <summary>One request, with its trail.</summary>
    /// <param name="id">The request id.</param>
    /// <response code="200">The request.</response>
    /// <response code="403">Somebody else's request, and the caller is not an administrator.</response>
    /// <response code="404">No such request.</response>
    /// <returns>The request.</returns>
    [HttpGet("{id}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<RequestDetail> Get(string id)
    {
        var row = _store.Get(id);
        // "Does not exist" and "is not yours" are the same answer on purpose. The two used to be
        // 404 and 403, which told anybody with an account which request ids existed on the node
        // and, by trying a few, roughly how much the other members were asking for.
        if (row is null || !MaySee(row))
        {
            return NotFound();
        }

        return Ok(new RequestDetail { Request = row, Events = _store.Events(id).ToList() });
    }

    /// <summary>Badge counts for the navigation bar.</summary>
    /// <response code="200">The counts.</response>
    /// <returns>The counts.</returns>
    [HttpGet("counts")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<RequestCounts> Counts() => Ok(_requests.Counts(CurrentUserId()));

    /// <summary>
    /// Search for something to request, with what the group already has attached.
    /// </summary>
    /// <param name="q">What to search for.</param>
    /// <param name="kind"><c>movie</c>, <c>series</c>, or omit for both.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The results.</response>
    /// <response code="503">Neither manager is configured on this node, so nothing can be looked up.</response>
    /// <returns>The results.</returns>
    /// <remarks>
    /// The 503 is the difference between "nothing matched" and "I could not look" — two answers
    /// that are the same empty list on the wire and opposite things to the person who typed. The
    /// app already reads any 503 from this controller as "requests are not set up on this server"
    /// and says so instead of drawing an empty result list.
    /// </remarks>
    [HttpGet("search")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<IReadOnlyList<RequestSearchResult>>> Search(
        [FromQuery] string? q,
        [FromQuery] string? kind,
        CancellationToken cancellationToken)
    {
        if (!_requests.CanSearch())
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }

        return Ok(await _requests.SearchAsync(q ?? string.Empty, kind, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>
    /// Browse the catalogue: what is popular now, or the best ever made, narrowed by a filter.
    /// </summary>
    /// <param name="kind"><c>movie</c>, <c>series</c>, or omit for both.</param>
    /// <param name="sort"><c>popular</c> (the default), <c>top_rated</c>, <c>newest</c> or <c>title</c>.</param>
    /// <param name="order"><c>asc</c>, or omit for descending.</param>
    /// <param name="genres">Genre names to narrow to, comma separated.</param>
    /// <param name="year">A release year, or omit for every year.</param>
    /// <param name="page">Which page. One-based.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The page.</response>
    /// <response code="503">Neither manager is configured on this node, so nothing here could be asked for.</response>
    /// <returns>The page.</returns>
    /// <remarks>
    /// <para>
    /// Behind the same 503 as the search, and for the same reason: a node with no managers cannot
    /// fulfil anything, so a catalogue it could not act on would be a grid of dead buttons. The app
    /// gates the whole screen on that answer before it draws a section bar.
    /// </para>
    /// <para>
    /// A metadata provider that will not answer is <em>not</em> a 503. It comes back 200 with an
    /// empty page, and the screen keeps the search box it has always had: "requests are not set up
    /// here" and "the catalogue is quiet this minute" are different sentences and only one of them
    /// is about this server.
    /// </para>
    /// </remarks>
    [HttpGet("discover")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<RequestDiscoverPage>> Discover(
        [FromQuery] string? kind,
        [FromQuery] string? sort,
        [FromQuery] string? order,
        [FromQuery] string? genres,
        [FromQuery] int? year,
        [FromQuery] int page,
        CancellationToken cancellationToken)
    {
        if (!_requests.CanSearch())
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }

        return Ok(await _requests
            .DiscoverAsync(kind, sort, order, genres, year, page, cancellationToken)
            .ConfigureAwait(false));
    }

    // --- making ------------------------------------------------------------

    /// <summary>
    /// Ask for something.
    /// </summary>
    /// <param name="body">What is wanted.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The request. It may already be <c>available</c>, if the group had it.</response>
    /// <response code="400">Neither a TMDB nor a TVDB id was given.</response>
    /// <response code="429">The caller is over their weekly quota.</response>
    /// <returns>The request.</returns>
    /// <remarks>
    /// Answers 200 rather than 201 even for a new request, because the interesting outcome is the
    /// <em>state</em> in the body: a request the group can already satisfy comes back
    /// <c>available</c> having downloaded nothing, and a caller that only looked at the status code
    /// would have no way to tell that from a download starting.
    /// </remarks>
    [HttpPost]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<RequestRow>> Create(
        [FromBody] CreateRequestBody body,
        CancellationToken cancellationToken)
    {
        var result = await _requests
            .CreateAsync(body, CurrentUserId(), cancellationToken)
            .ConfigureAwait(false);
        if (result.Refused is not null)
        {
            return StatusCode(result.Status, new { error = result.Refused });
        }

        if (result.AlreadyHeld)
        {
            // Nothing was created. The caller shows what is already there, offers to play it, and
            // asks again with a reason if the person still wants something done.
            return StatusCode(
                result.Status,
                new
                {
                    alreadyHeld = true,
                    holders = result.Holders,
                    playableItemId = result.PlayableItemId,
                });
        }

        return Ok(result.Request);
    }

    /// <summary>Change which seasons an open request is for.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="body">The seasons wanted. Empty means every season.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The updated request.</response>
    /// <response code="409">The request has already finished, so there is nothing to change.</response>
    /// <response code="404">No such request, or somebody else's.</response>
    /// <returns>The request.</returns>
    /// <remarks>
    /// <see cref="Create"/> already grows a season list — a second request for the same show adds
    /// whatever it asked for — but growing is all it can do, because it cannot tell "I want season
    /// 4 as well" from "I only want season 4 now". So this replaces the list outright, and is what
    /// the app's Edit uses. Asking for fewer seasons unmonitors the rest on the next pass;
    /// <c>RequestWorker.ApplySeasons</c> ticks exactly what the row names and unticks the others.
    /// <para>
    /// Owner or administrator, same rule and the same 404-for-both as <see cref="Delete"/>. Marking
    /// it unpublished is what sends the change out to the group: the row has moved and the peers
    /// holding the old season list need to hear about it.
    /// </para>
    /// </remarks>
    [HttpPut("{id}/seasons")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<RequestRow>> SetSeasons(
        string id,
        [FromBody] RequestSeasonsBody body,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        var row = _store.Get(id);
        if (row is null || !MaySee(row))
        {
            return NotFound();
        }

        // 409 rather than 400, and the distinction earns its keep: the caller is not malformed, it
        // is *out of date*. A request finishes on its own -- a node with no indexer fails one within
        // seconds -- so a sheet opened on an open request can be saved against a finished one
        // through no fault of the person pressing the button. A status the app can branch on lets it
        // do the useful thing (ask again, reopening the row) instead of showing them a refusal for
        // something they did not do.
        if (!RequestStates.IsOpen(row.State))
        {
            return Conflict(new { error = "This request has already finished." });
        }

        // Sorted and deduplicated, and season 0 dropped: the specials folder is never what "the
        // whole show" means to a person, and the app does not offer it either.
        row.Seasons = body.Seasons is null
            ? new List<int>()
            : body.Seasons.Where(s => s > 0).Distinct().OrderBy(s => s).ToList();
        row.Note = "Seasons changed by the requester.";
        var saved = await _store.SaveAsync(row, cancellationToken).ConfigureAwait(false);
        await _store.SetPublishedAsync(row.Id, false, cancellationToken).ConfigureAwait(false);
        return Ok(saved);
    }

    /// <summary>Withdraw a request.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Withdrawn.</response>
    /// <response code="403">Somebody else's request, and the caller is not an administrator.</response>
    /// <response code="404">No such request.</response>
    /// <returns>No content.</returns>
    /// <remarks>
    /// <para>
    /// A request already being fulfilled can be withdrawn too, and doing so <em>stops the
    /// download</em>: an unfinished one is cancelled and its partial files are deleted, wherever in
    /// the group it is running. Anything that has finished downloading is kept and finishes
    /// importing, because a person withdrawing an ask has not asked for an episode they already
    /// have to be thrown away. <see cref="RequestWithdrawal"/> is the whole of that rule.
    /// </para>
    /// <para>
    /// This used to be a row delete, and said so on the confirmation dialog: the request came off
    /// the list and the grab it had started ran to the end on whichever node was doing it.
    /// </para>
    /// </remarks>
    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Delete(string id, CancellationToken cancellationToken)
    {
        var row = _store.Get(id);
        // Same 404 for "no such request" and "not yours", for the reason given on `Get`.
        if (row is null || !MaySee(row))
        {
            return NotFound();
        }

        await _withdrawal.WithdrawAsync(row, cancellationToken).ConfigureAwait(false);
        return NoContent();
    }

    // --- deciding ----------------------------------------------------------

    /// <summary>Approve a pending request.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="body">Optional reason.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The approved request.</response>
    /// <response code="404">No such request.</response>
    /// <returns>The request.</returns>
    [HttpPost("{id}/approve")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<RequestRow>> Approve(
        string id,
        [FromBody] RequestDecisionBody? body,
        CancellationToken cancellationToken)
    {
        var result = await _requests
            .ApproveAsync(id, CurrentUserId(), body?.Reason, cancellationToken)
            .ConfigureAwait(false);
        return Decided(result);
    }

    /// <summary>Decline a pending request.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="body">Optional reason, shown to the requester.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The declined request.</response>
    /// <response code="404">No such request.</response>
    /// <returns>The request.</returns>
    [HttpPost("{id}/decline")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<RequestRow>> Decline(
        string id,
        [FromBody] RequestDecisionBody? body,
        CancellationToken cancellationToken)
    {
        var result = await _requests
            .DeclineAsync(id, CurrentUserId(), body?.Reason, cancellationToken)
            .ConfigureAwait(false);
        return Decided(result);
    }

    /// <summary>Turn a decision outcome into a response.</summary>
    /// <param name="result">The outcome.</param>
    /// <returns>The response.</returns>
    private ActionResult<RequestRow> Decided(RequestDecisionResult result)
    {
        if (result.NotFound)
        {
            return NotFound();
        }

        return result.Conflict is not null
            ? Conflict(new { error = result.Conflict })
            : Ok(result.Request);
    }

    /// <summary>Put a failed request back in the queue.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The request, approved again.</response>
    /// <response code="404">No such request.</response>
    /// <returns>The request.</returns>
    [HttpPost("{id}/retry")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<RequestRow>> Retry(string id, CancellationToken cancellationToken)
    {
        var row = await _requests.RetryAsync(id, CurrentUserId(), cancellationToken).ConfigureAwait(false);
        return row is null ? NotFound() : Ok(row);
    }

    // --- policy ------------------------------------------------------------

    /// <summary>
    /// The group's request policy.
    /// </summary>
    /// <param name="group">The group id, or omit for this node's default.</param>
    /// <response code="200">The policy.</response>
    /// <returns>The policy.</returns>
    /// <remarks>
    /// Readable by every member, deliberately. Whether a request needs approval changes what the
    /// Request button should say, and a member who cannot read the policy would have to guess.
    /// </remarks>
    [HttpGet("policy")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<RequestPolicy> GetPolicy([FromQuery] string? group) => Ok(_requests.Policy(group));

    /// <summary>Set the group's request policy.</summary>
    /// <param name="body">The policy.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The stored policy.</response>
    /// <response code="400">The body names no known auto-approve mode.</response>
    /// <returns>The stored policy.</returns>
    [HttpPut("policy")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<RequestPolicy>> SetPolicy(
        [FromBody] RequestPolicy body,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        var mode = AutoApprove.Parse(body.AutoApprove);
        if (mode is null)
        {
            return BadRequest(new
            {
                error = $"'{body.AutoApprove}' is not an auto-approve mode.",
                allowed = new[] { AutoApprove.Everyone, AutoApprove.Trusted, AutoApprove.AdminsOnly },
            });
        }

        body.AutoApprove = mode;
        body.WeeklyQuota = Math.Max(0, body.WeeklyQuota);
        body.MinimumHeight = Math.Max(0, body.MinimumHeight);
        return Ok(await _requests.SavePolicyAsync(body, cancellationToken).ConfigureAwait(false));
    }

    /// <summary>Every member, with their trust, quota and this week's usage.</summary>
    /// <response code="200">The members.</response>
    /// <returns>The members.</returns>
    [HttpGet("users")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<RequestUser>> Users() => Ok(_requests.Users());

    /// <summary>Set a member's trust flag and personal quota.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="body">Trust and quota.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The updated member.</response>
    /// <returns>The member.</returns>
    [HttpPut("users/{userId}")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<RequestUser>> SetTrust(
        string userId,
        [FromBody] RequestTrustBody body,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        return Ok(await _requests
            .SetTrustAsync(userId, body.Trusted, Math.Max(0, body.WeeklyQuota), cancellationToken)
            .ConfigureAwait(false));
    }

    // --- notifications -----------------------------------------------------

    /// <summary>The caller's in-app notifications, newest first.</summary>
    /// <param name="unreadOnly">Only the unread ones.</param>
    /// <param name="limit">How many at most; 1 to 200.</param>
    /// <response code="200">The notifications.</response>
    /// <returns>The notifications.</returns>
    [HttpGet("notifications")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<NotificationRow>> Notifications(
        [FromQuery] bool unreadOnly = false,
        [FromQuery] int limit = 50)
        => Ok(_store.Notifications(CurrentUserId(), unreadOnly, limit));

    /// <summary>Mark notifications read.</summary>
    /// <param name="body">The ids, or an empty list for all of the caller's.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Marked.</response>
    /// <returns>No content.</returns>
    [HttpPost("notifications/read")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<ActionResult> MarkRead(
        [FromBody] MarkNotificationsBody? body,
        CancellationToken cancellationToken)
    {
        await _store
            .MarkReadAsync(CurrentUserId(), body?.Ids ?? new List<long>(), cancellationToken)
            .ConfigureAwait(false);
        return NoContent();
    }

    // --- diagnostics -------------------------------------------------------

    /// <summary>
    /// Run one fulfilment pass now, and report what it did.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The report.</response>
    /// <returns>The report.</returns>
    /// <remarks>
    /// The worker already runs one every ten seconds; this exists so the acceptance harness and an
    /// impatient administrator do not have to wait for the timer, and so a failure has somewhere to
    /// report itself synchronously instead of only to a log.
    /// </remarks>
    [HttpPost("pass")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<RequestPassReport>> Pass(CancellationToken cancellationToken)
        => Ok(await _worker.RunPassAsync(cancellationToken).ConfigureAwait(false));

    /// <summary>Whether the caller is allowed to see this request at all.</summary>
    /// <param name="row">The request.</param>
    /// <returns>True for an administrator and for the person who made it.</returns>
    /// <remarks>
    /// <see cref="StingStreamControllerBase.IsSelf"/> rather than a case-insensitive string
    /// compare. Both ends of that comparison are Jellyfin user ids, and Jellyfin issues the same id
    /// in <c>N</c> format in some responses and <c>D</c> format in others — so the string version
    /// was one client-side formatting choice away from telling a user that their own request was
    /// somebody else's. The string compare is kept as a fallback for a row whose
    /// <c>RequestedBy</c> is not a GUID at all, which is what an older row written by a
    /// pre-M6 build looks like.
    /// </remarks>
    private bool MaySee(RequestRow row)
        => IsAdministrator()
           || IsSelf(row.RequestedBy)
           || (!Guid.TryParse(row.RequestedBy, out _)
               && string.Equals(row.RequestedBy, CurrentUserId(), StringComparison.OrdinalIgnoreCase));
}

/// <summary>One request with its event trail.</summary>
public sealed class RequestDetail
{
    /// <summary>The request.</summary>
    public RequestRow Request { get; set; } = new();

    /// <summary>Everything that has happened to it, oldest first.</summary>
    public List<RequestEvent> Events { get; set; } = new();
}

/// <summary>Body of <c>PUT /requests/{id}/seasons</c>.</summary>
public sealed class RequestSeasonsBody
{
    /// <summary>Season numbers wanted. Empty, or absent, means every season.</summary>
    public List<int>? Seasons { get; set; }
}

/// <summary>Body of <c>PUT /requests/users/{userId}</c>.</summary>
public sealed class RequestTrustBody
{
    /// <summary>Whether the member's requests skip approval under <c>auto_approve: trusted</c>.</summary>
    public bool Trusted { get; set; }

    /// <summary>Their own weekly quota, or zero to use the group's.</summary>
    public int WeeklyQuota { get; set; }
}

/// <summary>Body of <c>POST /requests/notifications/read</c>.</summary>
public sealed class MarkNotificationsBody
{
    /// <summary>The notification ids, or an empty list for every one of the caller's.</summary>
    public List<long> Ids { get; set; } = new();
}
