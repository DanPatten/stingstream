using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Data;
using StingStream.Core.Federated;
using StingStream.Core.Inventory;
using StingStream.Core.Mesh;
using StingStream.Core.Playback;

namespace StingStream.Core.Controllers;

/// <summary>
/// What the group knows about one title: where it can be played from, whether anyone holds it, and
/// whether this node should keep its own copy.
/// </summary>
/// <remarks>
/// Every route here takes an <c>{id}</c> that may be either a Jellyfin item id or a StingStream
/// item key (<c>movie:tmdb:603</c>). Both are legitimate things for a caller to have: the app has a
/// Jellyfin id for anything on a library screen, and an item key for anything it read out of the
/// group index or got back from <c>POST /library/add</c> — which by construction has no local item
/// yet, because the whole point of that answer was that nothing was downloaded.
/// </remarks>
[Authorize]
public sealed class ItemsController : StingStreamControllerBase
{
    private readonly ILibraryManager _library;
    private readonly IInventoryService _inventory;
    private readonly FederatedSourceService _sources;
    private readonly PlaybackPolicyStore _policies;
    private readonly LibraryStateStore _state;
    private readonly PinService _pins;

    public ItemsController(
        ILibraryManager library,
        IInventoryService inventory,
        FederatedSourceService sources,
        PlaybackPolicyStore policies,
        LibraryStateStore state,
        PinService pins)
    {
        _library = library;
        _inventory = inventory;
        _sources = sources;
        _policies = policies;
        _state = state;
        _pins = pins;
    }

    /// <summary>
    /// Every source this node could play an item from, scored, with the reasons.
    /// </summary>
    /// <param name="id">A Jellyfin item id or a StingStream item key.</param>
    /// <param name="policy">Override the caller's stored policy for this one answer.</param>
    /// <param name="userId">Whose policy to use. Defaults to the authenticated user.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The scored sources, best first.</response>
    /// <response code="404">Nothing on this node can turn that id into a title.</response>
    /// <returns>The scored sources.</returns>
    /// <remarks>
    /// This is the "Play from…" menu. It is deliberately not the same thing as PlaybackInfo's
    /// ordering, though it uses the same scorer on the same inputs: PlaybackInfo can only return
    /// sources Jellyfin has items for, and this can also list a holder whose pointer this node
    /// never materialized — a title it holds locally, most obviously, whose remote copies are still
    /// perfectly playable and are what a failover would use.
    /// </remarks>
    [HttpGet("{id}/sources")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<ItemSourcesResponse>> Sources(
        string id,
        [FromQuery] string? policy,
        [FromQuery] string? userId,
        CancellationToken cancellationToken)
    {
        var itemKey = ResolveItemKey(id);
        if (itemKey is null)
        {
            return NotFound($"{id} is neither an item on this node nor an item key.");
        }

        var chosen = PolicyNames.Parse(policy) ?? _policies.Get(userId ?? CurrentUserId()).Parsed();
        var candidates = await _sources.CandidatesEverywhereAsync(itemKey, cancellationToken).ConfigureAwait(false);
        var ranked = SourceScorer.Rank(candidates, chosen);

        var local = _inventory.ByKey(itemKey);
        return new ItemSourcesResponse
        {
            ItemKey = itemKey,
            Policy = PolicyNames.Wire(chosen),
            HeldLocally = local is not null,
            Sources = ranked.Select(Present).ToList(),
        };
    }

    /// <summary>
    /// Whether this title needs downloading at all.
    /// </summary>
    /// <param name="id">A Jellyfin item id or a StingStream item key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="200">The availability.</response>
    /// <response code="404">Nothing on this node can turn that id into a title.</response>
    /// <returns>The availability.</returns>
    /// <remarks>
    /// The state is worked out live rather than read back from the row the add flow wrote, because
    /// the group moves underneath it: a holder leaves, a pin completes, someone else grabs a better
    /// encode. The stored row is still returned alongside it as <c>decision</c>, because "what this
    /// node decided, and when" is a different and equally useful question — it is what explains why
    /// no download started.
    /// </remarks>
    [HttpGet("{id}/availability")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<AvailabilityResponse>> Availability(
        string id,
        CancellationToken cancellationToken)
    {
        var itemKey = ResolveItemKey(id);
        if (itemKey is null)
        {
            return NotFound($"{id} is neither an item on this node nor an item key.");
        }

        var local = _inventory.ByKey(itemKey);
        var candidates = await _sources.CandidatesEverywhereAsync(itemKey, cancellationToken).ConfigureAwait(false);
        var holders = candidates
            .Where(c => !string.IsNullOrEmpty(c.Node))
            .Select(Holder)
            .ToList();
        var stored = _state.Get(itemKey);
        var pin = _pins.Status(itemKey);

        var state = local is not null
            ? LibraryStates.Local
            : holders.Any(h => h.Online)
                ? LibraryStates.AvailableViaGroup
                : stored?.State ?? LibraryStates.Unknown;

        return new AvailabilityResponse
        {
            ItemKey = itemKey,
            State = state,
            HeldLocally = local is not null,
            Holders = holders,
            Decision = stored,
            Pin = pin,
        };
    }

    /// <summary>
    /// Keep a copy of this title on this node.
    /// </summary>
    /// <param name="id">A Jellyfin item id or a StingStream item key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="202">Queued, or already running.</response>
    /// <response code="404">Nothing on this node can turn that id into a title.</response>
    /// <response code="409">Nothing online in the group holds it.</response>
    /// <returns>The pin's state.</returns>
    [HttpPost("{id}/pin")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<PinRow>> Pin(string id, CancellationToken cancellationToken)
    {
        var itemKey = ResolveItemKey(id);
        if (itemKey is null)
        {
            return NotFound($"{id} is neither an item on this node nor an item key.");
        }

        try
        {
            var row = await _pins.RequestAsync(itemKey, CurrentUserId(), cancellationToken).ConfigureAwait(false);
            return Accepted(row);
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(new { error = ex.Message });
        }
    }

    /// <summary>How far a pin has got.</summary>
    /// <param name="id">A Jellyfin item id or a StingStream item key.</param>
    /// <response code="200">The pin's state.</response>
    /// <response code="404">This node has never been asked to pin it.</response>
    /// <returns>The pin's state.</returns>
    [HttpGet("{id}/pin")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<PinRow> PinStatus(string id)
    {
        var itemKey = ResolveItemKey(id);
        var row = itemKey is null ? null : _pins.Status(itemKey);
        return row is null ? NotFound($"No pin is recorded for {id}.") : Ok(row);
    }

    /// <summary>Stop pinning, and throw away a partial copy.</summary>
    /// <param name="id">A Jellyfin item id or a StingStream item key.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <response code="204">Forgotten.</response>
    /// <response code="404">There was no pin to forget.</response>
    /// <returns>No content.</returns>
    [HttpDelete("{id}/pin")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult> Unpin(string id, CancellationToken cancellationToken)
    {
        var itemKey = ResolveItemKey(id);
        if (itemKey is null)
        {
            return NotFound($"{id} is neither an item on this node nor an item key.");
        }

        return await _pins.CancelAsync(itemKey, cancellationToken).ConfigureAwait(false)
            ? NoContent()
            : NotFound($"No pin is recorded for {id}.");
    }

    // --- helpers -----------------------------------------------------------

    /// <summary>Turn whatever the caller passed into an item key.</summary>
    private string? ResolveItemKey(string id)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            return null;
        }

        if (id.Contains(':', StringComparison.Ordinal))
        {
            // Already an item key. Not validated against the index on purpose: a key the group has
            // never seen is a perfectly good question to ask availability about, and the answer is
            // "nobody holds it", not a 404.
            return id;
        }

        if (!Guid.TryParse(id, out var guid))
        {
            return null;
        }

        var item = _library.GetItemById<BaseItem>(guid);
        return item is null ? null : InventoryService.BuildItemKey(item);
    }

    private static ScoredSourceResponse Present(ScoredSource scored) => new()
    {
        Node = scored.Candidate.Node,
        NodeName = scored.Candidate.NodeName,
        Group = scored.Candidate.Group,
        Online = scored.Candidate.Online,
        Resolution = scored.Candidate.Resolution,
        Width = scored.Candidate.Width,
        Height = scored.Candidate.Height,
        Bitrate = scored.Candidate.Bitrate,
        SizeBytes = scored.Candidate.Size,
        FileHash = scored.Candidate.FileHash,
        Path = scored.Candidate.Path,
        RttMs = scored.Candidate.RttMs,
        ThroughputBps = scored.Candidate.ThroughputBps,
        MaxDirectStreams = scored.Candidate.MaxDirectStreams,
        ActiveDirectStreams = scored.Candidate.ActiveDirectStreams,
        Score = scored.Score,
        NeededBps = scored.NeededBps,
        Fits = scored.Fits,
        Measured = scored.Measured,
        Reasons = scored.Reasons,
        StreamUrl = FederatedLayout.StreamUrl(
            scored.Candidate.Group,
            scored.Candidate.ItemKey,
            scored.Candidate.Node),
    };

    private static HolderSummary Holder(SourceCandidate c) => new()
    {
        Node = c.Node,
        NodeName = c.NodeName,
        Online = c.Online,
        Group = c.Group,
        Resolution = c.Resolution,
        FileHash = c.FileHash,
        SizeBytes = c.Size,
        Bitrate = c.Bitrate,
    };
}

/// <summary>The answer to <c>GET /items/{id}/sources</c>.</summary>
public sealed class ItemSourcesResponse
{
    public string ItemKey { get; set; } = string.Empty;

    /// <summary>The policy the ordering was computed under.</summary>
    public string Policy { get; set; } = string.Empty;

    /// <summary>True when this node holds the file itself, which always beats a peer's copy.</summary>
    public bool HeldLocally { get; set; }

    public List<ScoredSourceResponse> Sources { get; set; } = new();
}

/// <summary>One scored source, as the API presents it.</summary>
public sealed class ScoredSourceResponse
{
    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    public string Group { get; set; } = string.Empty;

    public bool Online { get; set; }

    public string? Resolution { get; set; }

    public int? Width { get; set; }

    public int? Height { get; set; }

    public long? Bitrate { get; set; }

    public long? SizeBytes { get; set; }

    /// <summary>
    /// BLAKE3 of the holder's file: the <c>stingstream:file_hash</c> tag.
    /// </summary>
    /// <remarks>
    /// Two sources with the same hash are the same bytes, so a player switching between them can
    /// resume at a byte offset — which is what the mesh does by itself, invisibly. Two with
    /// different hashes are different encodes, and switching means restarting at a timestamp, which
    /// is the client's job. PlaybackInfo carries the same value as each MediaSource's weak
    /// <c>ETag</c> (<c>W/"b3-…"</c>).
    /// </remarks>
    public string? FileHash { get; set; }

    /// <summary><c>direct</c>, <c>mixed</c>, <c>relay</c>, or null before any connection.</summary>
    public string? Path { get; set; }

    public long? RttMs { get; set; }

    /// <summary>Rolling measured throughput from this holder, bits per second.</summary>
    public long? ThroughputBps { get; set; }

    public int? MaxDirectStreams { get; set; }

    public int? ActiveDirectStreams { get; set; }

    public double Score { get; set; }

    /// <summary>Bits per second this source needs, margin included.</summary>
    public long NeededBps { get; set; }

    public bool Fits { get; set; }

    public bool Measured { get; set; }

    /// <summary>Why it scored what it scored, in words.</summary>
    public List<string> Reasons { get; set; } = new();

    /// <summary>The URL a client would play this source from.</summary>
    public string StreamUrl { get; set; } = string.Empty;
}

/// <summary>The answer to <c>GET /items/{id}/availability</c>.</summary>
public sealed class AvailabilityResponse
{
    public string ItemKey { get; set; } = string.Empty;

    /// <summary>One of <see cref="LibraryStates"/>, worked out live.</summary>
    public string State { get; set; } = LibraryStates.Unknown;

    public bool HeldLocally { get; set; }

    public List<HolderSummary> Holders { get; set; } = new();

    /// <summary>What the add flow decided, and when. Null when it has never been asked.</summary>
    public LibraryStateRow? Decision { get; set; }

    /// <summary>The pin, if this node is keeping or has kept its own copy.</summary>
    public PinRow? Pin { get; set; }
}
