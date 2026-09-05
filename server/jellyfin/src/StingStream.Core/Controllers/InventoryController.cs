using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using StingStream.Core.Inventory;

namespace StingStream.Core.Controllers;

/// <summary>
/// This node's inventory: what it holds, in the shape M3 will publish to the group.
/// </summary>
/// <remarks>
/// Read-only in M1. The records exist now so that the mesh, when it arrives, has something real to
/// gossip from day one rather than needing the inventory builder written at the same time as the
/// transport.
/// </remarks>
[Authorize(Policy = Policies.RequiresElevation)]
public sealed class InventoryController : StingStreamControllerBase
{
    private readonly IInventoryService _inventory;

    public InventoryController(IInventoryService inventory)
    {
        _inventory = inventory;
    }

    /// <summary>Inventory records, newest first.</summary>
    /// <param name="limit">Maximum records to return (1-5000).</param>
    /// <param name="offset">Records to skip.</param>
    /// <response code="200">The records.</response>
    /// <remarks>
    /// The route is named so the OpenAPI document has a unique <c>operationId</c>; see
    /// <c>SettingsController.Get</c> for why.
    /// </remarks>
    [HttpGet(Name = "GetInventory")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<InventoryPage> Get([FromQuery] int limit = 200, [FromQuery] int offset = 0)
        => new InventoryPage
        {
            Total = _inventory.Count,
            Offset = Math.Max(0, offset),
            Records = _inventory.All(limit, offset),
        };

    /// <summary>One record by item key, e.g. <c>movie:tmdb:10378</c>.</summary>
    /// <param name="itemKey">The item key.</param>
    /// <response code="200">The record.</response>
    /// <response code="404">No record with that key.</response>
    [HttpGet("{itemKey}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<InventoryRecord> GetByKey(string itemKey)
    {
        var record = _inventory.ByKey(itemKey);
        return record is null ? NotFound() : record;
    }

    /// <summary>Rebuild every record from Jellyfin's library.</summary>
    /// <response code="200">How many records were built.</response>
    [HttpPost("rebuild")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<int>> Rebuild(CancellationToken cancellationToken)
        => await _inventory.RebuildAllAsync(cancellationToken).ConfigureAwait(false);
}

/// <summary>A page of inventory records.</summary>
public sealed class InventoryPage
{
    public long Total { get; set; }

    public int Offset { get; set; }

    public IReadOnlyList<InventoryRecord> Records { get; set; } = Array.Empty<InventoryRecord>();
}
