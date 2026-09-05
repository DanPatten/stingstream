using System;
using System.Collections.Concurrent;
using System.Collections.Generic;

namespace StingStream.Core.Inventory;

/// <summary>
/// A coalescing queue of "this item key changed", between whoever changed it and whoever
/// publishes it to the mesh.
/// </summary>
/// <remarks>
/// It exists to break a dependency cycle. The obvious wiring — the inventory service calls the
/// mesh publisher — cannot be built, because the publisher has to read inventory records and would
/// therefore depend on the inventory service in turn. A tiny singleton that depends on nothing
/// sits between them: <see cref="InventoryService"/> writes to it, the publisher drains it.
///
/// Coalescing is not incidental either. A single Sonarr season import fires one webhook per
/// episode and one hash-completion per file, so a naive "publish on every change" would send a
/// dozen gossip deltas in a few seconds where one would do. Draining on a short timer turns that
/// burst into one delta, and a key touched five times before the drain is still one entry.
/// </remarks>
public sealed class InventoryChangeFeed
{
    // byte rather than bool: ConcurrentDictionary is the only lock-free set in the BCL, and the
    // value is never read.
    private readonly ConcurrentDictionary<string, byte> _upserts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _removals = new(StringComparer.Ordinal);

    /// <summary>True when a drain would return anything.</summary>
    public bool HasChanges => !_upserts.IsEmpty || !_removals.IsEmpty;

    /// <summary>Note that a record was written or replaced.</summary>
    /// <param name="itemKey">The item key.</param>
    public void Upserted(string itemKey)
    {
        if (string.IsNullOrWhiteSpace(itemKey))
        {
            return;
        }

        // A key that comes back after being removed must not stay in the removal set, or the
        // delta would say "add this" and "drop this" in the same message.
        _removals.TryRemove(itemKey, out _);
        _upserts[itemKey] = 0;
    }

    /// <summary>Note that a record was deleted.</summary>
    /// <param name="itemKey">The item key.</param>
    public void Removed(string itemKey)
    {
        if (string.IsNullOrWhiteSpace(itemKey))
        {
            return;
        }

        _upserts.TryRemove(itemKey, out _);
        _removals[itemKey] = 0;
    }

    /// <summary>Take everything queued so far, leaving the feed empty.</summary>
    /// <returns>The keys upserted and the keys removed since the last drain.</returns>
    public (IReadOnlyList<string> Upserts, IReadOnlyList<string> Removals) Drain()
    {
        var upserts = new List<string>(_upserts.Count);
        foreach (var key in _upserts.Keys)
        {
            if (_upserts.TryRemove(key, out _))
            {
                upserts.Add(key);
            }
        }

        var removals = new List<string>(_removals.Count);
        foreach (var key in _removals.Keys)
        {
            if (_removals.TryRemove(key, out _))
            {
                removals.Add(key);
            }
        }

        return (upserts, removals);
    }

    /// <summary>Put drained keys back after a failed publish, so the next pass retries them.</summary>
    /// <param name="upserts">Keys that were being upserted.</param>
    /// <param name="removals">Keys that were being removed.</param>
    public void Requeue(IReadOnlyList<string> upserts, IReadOnlyList<string> removals)
    {
        foreach (var key in upserts)
        {
            _upserts[key] = 0;
        }

        foreach (var key in removals)
        {
            _removals[key] = 0;
        }
    }
}
