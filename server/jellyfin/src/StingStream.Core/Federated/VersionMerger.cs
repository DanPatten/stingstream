using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;
using StingStream.Core.Inventory;

namespace StingStream.Core.Federated;

/// <summary>
/// Makes one film held by this node and by a peer into one item with two versions.
/// </summary>
/// <remarks>
/// <para>
/// Series and seasons merge on their own once both trees live in one collection folder —
/// <c>Series.CreatePresentationUniqueKey</c> keys a series on its provider id plus the folder ids
/// it belongs to, and a season's key is its series' key plus the index. Movies and episodes do not:
/// <c>BaseItem.CreatePresentationUniqueKey</c> returns the item id, so this node's
/// <c>Sintel (2010).mkv</c> and the <c>Sintel (2010) - attic 2160p.strm</c> materialized beside it
/// are two films with the same name until something says otherwise.
/// </para>
/// <para>
/// That something is Jellyfin's own merge mechanic, applied in process rather than over HTTP:
/// <c>Video.SetPrimaryVersionId</c> on the federated item, which also rewrites its
/// <c>PresentationUniqueKey</c> to the primary's id, plus a <c>LinkedAlternateVersions</c> entry on
/// the primary. Two things follow, and both are what this exists for. Library grids, search and
/// "recently added" collapse the pair to one row and prefer the item whose
/// <c>PrimaryVersionId</c> is null. And <c>Video.GetAllItemsForMediaSources</c> walks the primary's
/// linked alternates <em>and then each of those items' own same-folder alternates</em>, so one link
/// to the federated primary brings every other peer's <c>.strm</c> with it and PlaybackInfo returns
/// the whole set.
/// </para>
/// <para>
/// <b>The local item is always the primary.</b> Not upstream's "widest video stream" heuristic from
/// <c>VideosController.MergeVersions</c>: the local file carries the resume position, it is the one
/// copy that still plays with the mesh down, and its id is what every collection, playlist and
/// watched row already names. A peer's 4K copy winning the *scoring* is a different question, and
/// belongs to <see cref="Playback.SourceScorer"/>.
/// </para>
/// <para>
/// <b>Every write here is behind an equality check, and that is load-bearing rather than tidy.</b>
/// <c>UpdateToRepositoryAsync</c> raises <c>ItemUpdated</c>, which wakes
/// <see cref="InventoryWatcher"/>, which debounces into a full inventory rebuild. A pass that wrote
/// unconditionally every fifteen seconds would put the node into a permanent rebuild loop that
/// looked like nothing at all from the outside except a busy disk.
/// </para>
/// </remarks>
public sealed class VersionMerger
{
    private readonly ILibraryManager _library;
    private readonly IInventoryService _inventory;
    private readonly FederatedStore _store;
    private readonly ILogger<VersionMerger> _logger;

    public VersionMerger(
        ILibraryManager library,
        IInventoryService inventory,
        FederatedStore store,
        ILogger<VersionMerger> logger)
    {
        _library = library;
        _inventory = inventory;
        _store = store;
        _logger = logger;
    }

    /// <summary>Link and unlink versions so the library matches what is on disk.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>What changed.</returns>
    public async Task<MergeReport> ReconcileAsync(CancellationToken cancellationToken)
    {
        var report = new MergeReport();

        // The federated items this node has written, grouped by the title they are copies of.
        var pointersByKey = new Dictionary<string, List<FederatedPointer>>(StringComparer.Ordinal);
        foreach (var pointer in _store.All())
        {
            if (string.IsNullOrWhiteSpace(pointer.ItemKey))
            {
                continue;
            }

            if (!pointersByKey.TryGetValue(pointer.ItemKey, out var list))
            {
                list = new List<FederatedPointer>();
                pointersByKey[pointer.ItemKey] = list;
            }

            list.Add(pointer);
        }

        // Which local items are currently linked to something, so a link that should no longer
        // exist can be found without walking the whole library.
        var linkedLocally = new HashSet<Guid>();

        foreach (var (itemKey, pointers) in pointersByKey)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var local = LocalItem(itemKey);
            var federated = FederatedItems(pointers);

            if (local is null || federated.Count == 0)
            {
                // Either this node does not hold the title (the ordinary case -- nothing to merge,
                // the pointers are the only copies) or the pointers have not resolved into items
                // yet. Un-merging a stale link is handled by the sweep below either way.
                continue;
            }

            linkedLocally.Add(local.Id);
            if (await LinkAsync(local, federated, itemKey, report, cancellationToken).ConfigureAwait(false))
            {
                report.Merged++;
            }
        }

        await UnlinkStaleAsync(linkedLocally, report, cancellationToken).ConfigureAwait(false);

        if (report.Merged > 0 || report.Unmerged > 0)
        {
            _logger.LogInformation(
                "Versions: {Merged} title(s) linked to a peer's copy, {Unmerged} unlinked",
                report.Merged,
                report.Unmerged);
        }

        return report;
    }

    /// <summary>The local Jellyfin item for a title, or null when this node does not hold it.</summary>
    /// <remarks>
    /// Through the inventory rather than by searching the library: <c>InventoryRecord</c> already
    /// holds the mapping from item key to Jellyfin item id, written when the file was hashed, and
    /// it is by construction a record of a <em>local</em> file — <c>IsServableLocally</c> keeps
    /// pointers out of the inventory, which is what stops this matching a pointer against itself.
    /// </remarks>
    private Video? LocalItem(string itemKey)
    {
        var record = _inventory.ByKey(itemKey);
        if (record is null || !Guid.TryParse(record.JellyfinItemId, out var id) || id.Equals(Guid.Empty))
        {
            return null;
        }

        return _library.GetItemById(id) as Video;
    }

    /// <summary>The Jellyfin items behind a title's pointer files.</summary>
    private List<Video> FederatedItems(IEnumerable<FederatedPointer> pointers)
    {
        var found = new List<Video>();
        foreach (var pointer in pointers)
        {
            if (string.IsNullOrWhiteSpace(pointer.StrmPath))
            {
                continue;
            }

            // The same lookup the enrichment pass uses: a .strm resolves to exactly one item, and
            // Jellyfin indexes items by path.
            if (_library.FindByPath(pointer.StrmPath, false) is Video video)
            {
                found.Add(video);
            }
        }

        return found;
    }

    /// <summary>
    /// Which of a title's federated items Jellyfin considers the primary of its own folder.
    /// </summary>
    /// <param name="candidates">Every federated item for one title.</param>
    /// <returns>The one to link the local item to, or null when there are none.</returns>
    /// <remarks>
    /// <para>
    /// Several peers holding one film write several <c>.strm</c> files into a single folder, and
    /// Jellyfin's resolver has already made one of them the item and the rest its <em>local</em>
    /// alternate versions — with <c>OwnerId</c> set to that primary. Linking to an alternate rather
    /// than to the folder's own primary would produce a chain rather than a group, and
    /// <c>GetAllItemsForMediaSources</c> would not walk it.
    /// </para>
    /// <para>
    /// It has to be recomputed every pass rather than remembered, because Jellyfin reassigns it
    /// when the folder changes: a link onto yesterday's primary is a link onto an item that is now
    /// somebody else's alternate. Pure and public so the rule can be pinned by a test without a
    /// library behind it.
    /// </para>
    /// </remarks>
    public static (Guid Id, Guid OwnerId, Guid? PrimaryVersionId)? FederatedPrimary(
        IReadOnlyList<(Guid Id, Guid OwnerId, Guid? PrimaryVersionId)> candidates)
    {
        ArgumentNullException.ThrowIfNull(candidates);
        foreach (var candidate in candidates)
        {
            if (candidate.OwnerId.Equals(Guid.Empty) && !candidate.PrimaryVersionId.HasValue)
            {
                return candidate;
            }
        }

        foreach (var candidate in candidates)
        {
            if (candidate.OwnerId.Equals(Guid.Empty))
            {
                return candidate;
            }
        }

        return candidates.Count > 0 ? candidates[0] : null;
    }

    private static Video? FederatedPrimary(IReadOnlyList<Video> candidates)
    {
        var chosen = FederatedPrimary(
            candidates.Select(v => (v.Id, v.OwnerId, v.PrimaryVersionId)).ToList());
        return chosen is null ? null : candidates.First(v => v.Id.Equals(chosen.Value.Id));
    }

    /// <summary>Point a title's federated copies at the local one. Returns true when anything changed.</summary>
    private async Task<bool> LinkAsync(
        Video local,
        IReadOnlyList<Video> federated,
        string itemKey,
        MergeReport report,
        CancellationToken cancellationToken)
    {
        var primary = FederatedPrimary(federated);
        if (primary is null || primary.Id.Equals(local.Id))
        {
            return false;
        }

        var changed = false;

        if (!primary.PrimaryVersionId.HasValue || !primary.PrimaryVersionId.Value.Equals(local.Id))
        {
            primary.SetPrimaryVersionId(local.Id);
            await primary.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken)
                .ConfigureAwait(false);

            // Anything that named the federated item -- a collection somebody made before this
            // node held the film, a playlist entry -- should follow the copy that is now canonical.
            await _library.RerouteLinkedChildReferencesAsync(primary.Id, local.Id).ConfigureAwait(false);
            changed = true;
            _logger.LogDebug(
                "{ItemKey}: a peer's copy is now a version of the local one",
                itemKey);
        }

        var wanted = new[]
        {
            new LinkedChild { ItemId = primary.Id, Type = LinkedChildType.LinkedAlternateVersion },
        };
        if (!SameLinks(local.LinkedAlternateVersions, wanted))
        {
            local.LinkedAlternateVersions = wanted;
            await local.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken)
                .ConfigureAwait(false);
            changed = true;
        }

        // A federated item that is neither the folder's primary nor one of its local alternates
        // should not also claim the local item as its primary; that would be a second row in the
        // presentation group with no source of its own.
        foreach (var other in federated)
        {
            if (other.Id.Equals(primary.Id)
                || !other.PrimaryVersionId.HasValue
                || !other.PrimaryVersionId.Value.Equals(local.Id))
            {
                continue;
            }

            if (other.OwnerId.Equals(Guid.Empty))
            {
                continue;
            }

            other.SetPrimaryVersionId(null);
            await other.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken)
                .ConfigureAwait(false);
            changed = true;
        }

        if (changed)
        {
            report.Titles.Add(itemKey);
        }

        return changed;
    }

    /// <summary>
    /// Undo links whose other half has gone.
    /// </summary>
    /// <remarks>
    /// Two directions, and each has a real trigger. The last peer holding a title goes offline long
    /// enough for its pointer to be deleted, and the local item is left advertising an alternate
    /// version that no longer resolves. Or the local file is deleted and the pointers outlive it,
    /// leaving federated items whose <c>PresentationUniqueKey</c> still names a primary that is not
    /// there — which would hide them from every library query, so the film would vanish from a node
    /// that can still play it.
    /// </remarks>
    private async Task UnlinkStaleAsync(
        HashSet<Guid> linkedLocally,
        MergeReport report,
        CancellationToken cancellationToken)
    {
        foreach (var item in FederatedVideos())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!item.PrimaryVersionId.HasValue)
            {
                continue;
            }

            var primaryId = item.PrimaryVersionId.Value;
            if (linkedLocally.Contains(primaryId))
            {
                continue;
            }

            // Its primary is not a local item this pass linked. Either the local file is gone, or
            // the link belongs to a title whose pointers have since been removed.
            var primary = _library.GetItemById(primaryId) as Video;
            item.SetPrimaryVersionId(null);
            await item.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken)
                .ConfigureAwait(false);
            report.Unmerged++;

            if (primary is not null && primary.LinkedAlternateVersions.Length > 0)
            {
                primary.LinkedAlternateVersions = Array.Empty<LinkedChild>();
                await primary.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken)
                    .ConfigureAwait(false);
            }

            _logger.LogDebug(
                "{Path} is no longer a version of anything on this node",
                item.Path);
        }
    }

    /// <summary>Every federated video item, found by the tag every materialized NFO carries.</summary>
    private IReadOnlyList<Video> FederatedVideos()
    {
        var query = new InternalItemsQuery
        {
            Tags = new[] { FederatedLibraryService.FederatedTag },
            IncludeItemTypes = new[]
            {
                Jellyfin.Data.Enums.BaseItemKind.Movie,
                Jellyfin.Data.Enums.BaseItemKind.Episode,
                Jellyfin.Data.Enums.BaseItemKind.Video,
            },
            Recursive = true,
            // The whole point is to find items a presentation-key group would hide.
            GroupByPresentationUniqueKey = false,
            DtoOptions = new MediaBrowser.Controller.Dto.DtoOptions(false),
        };

        return _library.GetItemList(query).OfType<Video>().ToList();
    }

    /// <summary>Whether two alternate-version lists name the same items.</summary>
    /// <param name="a">What the item currently carries.</param>
    /// <param name="b">What this pass wants it to carry.</param>
    /// <returns>True when they name the same set, in any order.</returns>
    /// <remarks>
    /// On the id set rather than on the array, so a reordering is not a change. This is <em>the</em>
    /// guard that keeps a pass from writing: every write wakes <see cref="InventoryWatcher"/>, which
    /// debounces into a full inventory rebuild, so a comparison that returned false on identical
    /// state would put the node into a permanent rebuild loop. Public so a test can pin it.
    /// </remarks>
    public static bool SameLinks(IReadOnlyList<LinkedChild>? a, IReadOnlyList<LinkedChild> b)
    {
        ArgumentNullException.ThrowIfNull(b);
        var left = (a ?? Array.Empty<LinkedChild>())
            .Where(c => c.ItemId.HasValue)
            .Select(c => c.ItemId!.Value)
            .ToHashSet();
        var right = b.Where(c => c.ItemId.HasValue).Select(c => c.ItemId!.Value).ToHashSet();
        return left.SetEquals(right);
    }
}

/// <summary>What one <see cref="VersionMerger.ReconcileAsync"/> call did.</summary>
public sealed class MergeReport
{
    /// <summary>Titles whose links were created or corrected.</summary>
    public int Merged { get; set; }

    /// <summary>Federated items that stopped being a version of a local one.</summary>
    public int Unmerged { get; set; }

    /// <summary>The item keys that changed, for the pass report.</summary>
    public List<string> Titles { get; } = new();

    /// <summary>A one-line summary, for a log or an API.</summary>
    /// <returns>The summary.</returns>
    public override string ToString()
        => string.Create(CultureInfo.InvariantCulture, $"merged {Merged}, unmerged {Unmerged}");
}
