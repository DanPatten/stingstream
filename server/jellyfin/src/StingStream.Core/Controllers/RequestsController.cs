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

    public RequestsController(RequestService requests, RequestStore store, RequestWorker worker)
    {
        _requests = requests;
        _store = store;
        _worker = worker;
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
        var isAdmin = User.IsInRole("Administrator");
        var rows = _store.All().AsEnumerable();

        if (!isAdmin || mine == true)
        {
            rows = rows.Where(r => string.Equals(r.RequestedBy, me, StringComparison.OrdinalIgnoreCase));
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
        if (row is null)
        {
            return NotFound();
        }

        if (!MaySee(row))
        {
            return Forbid();
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
    /// <returns>The results.</returns>
    [HttpGet("search")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<RequestSearchResult>>> Search(
        [FromQuery] string? q,
        [FromQuery] string? kind,
        CancellationToken cancellationToken)
        => Ok(await _requests.SearchAsync(q ?? string.Empty, kind, cancellationToken).ConfigureAwait(false));

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

        return Ok(result.Request);
    }

    /// <summary>Withdraw a request.</summary>
    /// <param name="id">The request id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Withdrawn.</response>
    /// <response code="403">Somebody else's request, and the caller is not an administrator.</response>
    /// <response code="404">No such request.</response>
    /// <returns>No content.</returns>
    /// <remarks>
    /// A request already being fulfilled can be withdrawn too. It does not stop the download — the
    /// grabbing node may be somebody else's and is already committed — but it does take the request
    /// off the requester's list, which is what "I no longer want this" means from their side.
    /// </remarks>
    [HttpDelete("{id}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Delete(string id, CancellationToken cancellationToken)
    {
        var row = _store.Get(id);
        if (row is null)
        {
            return NotFound();
        }

        if (!MaySee(row))
        {
            return Forbid();
        }

        await _store.DeleteAsync(id, cancellationToken).ConfigureAwait(false);
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
        var row = await _requests
            .ApproveAsync(id, CurrentUserId(), body?.Reason, cancellationToken)
            .ConfigureAwait(false);
        return row is null ? NotFound() : Ok(row);
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
        var row = await _requests
            .DeclineAsync(id, CurrentUserId(), body?.Reason, cancellationToken)
            .ConfigureAwait(false);
        return row is null ? NotFound() : Ok(row);
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

    private bool MaySee(RequestRow row)
        => User.IsInRole("Administrator")
           || string.Equals(row.RequestedBy, CurrentUserId(), StringComparison.OrdinalIgnoreCase);
}

/// <summary>One request with its event trail.</summary>
public sealed class RequestDetail
{
    /// <summary>The request.</summary>
    public RequestRow Request { get; set; } = new();

    /// <summary>Everything that has happened to it, oldest first.</summary>
    public List<RequestEvent> Events { get; set; } = new();
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
