using System;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;

namespace StingStream.Core.Inventory;

/// <summary>
/// Rebuilds this node's inventory when its Jellyfin library changes.
/// </summary>
/// <remarks>
/// <para>
/// **Without this a holder with no arrs never advertises a file that appears after start-up.**
/// <see cref="IInventoryService.RebuildAllAsync"/> used to run from exactly three places —
/// first-run wiring, a completed pin, and <c>POST /inventory/rebuild</c> — and per-item refreshes
/// came only from the arrs' import webhooks and from a finished hash. Nothing was watching the
/// library. So a `storage-node`, or anyone who drops a film into a folder and presses Scan, had a
/// title Jellyfin knew about and the group never heard of, for as long as nobody thought to call
/// an API by hand. Both acceptance harnesses had to paper over it by re-POSTing a rebuild in a
/// polling loop, which is how it was found.
/// </para>
/// <para>
/// ## Why a debounced full rebuild, and not a refresh per event.
/// </para>
/// <para>
/// A scan raises one <c>ItemAdded</c> per file, so anything that acts on each event does work
/// proportional to the library every time the library is read. <see cref="RebuildDebouncer"/>
/// turns the burst into one rebuild after it settles — nothing at all during a ten-minute scan,
/// one pass five seconds after the last file lands. A full rebuild rather than a targeted refresh
/// because it is also the only reconciliation this node gets: it prunes records whose items have
/// gone, which is what makes <c>ItemRemoved</c> retract a row without needing a second code path.
/// </para>
/// <para>
/// ## Publishing.
/// </para>
/// <para>
/// Nothing here publishes. <see cref="InventoryService"/> writes every upsert and removal to
/// <see cref="InventoryChangeFeed"/>, and <c>InventoryPublisher.PassAsync</c> drains it into a
/// delta on its next three-second pass. So a file dropped into a folder reaches the group's index
/// within a few seconds of the scan finishing, by the same path an arr import takes.
/// </para>
/// <para>
/// ## What it ignores.
/// </para>
/// <para>
/// Federated pointers, deliberately. The materializer writes a `.strm` per peer per title into
/// Shared Movies, Jellyfin resolves each one into an item, and every one of those raises an event.
/// A rebuild would skip them all (<see cref="InventoryService.IsServableLocally"/>) and be pure
/// waste — and on a node materializing a large group, waste that never stops. The same test is
/// applied here so the pointers never wake the loop at all.
/// </para>
/// <para>
/// Jellyfin has no "scan finished" event to hang this on: <see cref="ILibraryManager"/> exposes the
/// three item events and nothing else, and <c>ITaskManager.TaskCompleted</c> covers only the
/// *scheduled* scan — `POST /Library/Refresh` calls `ValidateMediaLibrary` directly and never goes
/// near the task manager. Quiet is the signal that is always there.
/// </para>
/// </remarks>
public sealed class InventoryWatcher : BackgroundService
{
    /// <summary>How often the debouncer is asked whether a rebuild is due.</summary>
    public static readonly TimeSpan Tick = TimeSpan.FromSeconds(1);

    private readonly ILibraryManager _library;
    private readonly IInventoryService _inventory;
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<InventoryWatcher> _logger;
    private readonly RebuildDebouncer _debounce = new();

    public InventoryWatcher(
        ILibraryManager library,
        IInventoryService inventory,
        INodeRuntimeProvider runtime,
        ILogger<InventoryWatcher> logger)
    {
        _library = library;
        _inventory = inventory;
        _runtime = runtime;
        _logger = logger;
    }

    /// <summary>How many rebuilds this watcher has run. Test and diagnostics only.</summary>
    public long Rebuilds { get; private set; }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _library.ItemAdded += OnLibraryChanged;
        _library.ItemUpdated += OnLibraryChanged;
        _library.ItemRemoved += OnLibraryChanged;
        _logger.LogInformation(
            "Watching the library: a change rebuilds the inventory once it has been quiet for "
            + "{Quiet:0.#}s, or after {Max:0.#}s whichever comes first",
            _debounce.QuietPeriod.TotalSeconds,
            _debounce.MaximumDelay.TotalSeconds);

        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(Tick, stoppingToken).ConfigureAwait(false);
                if (_debounce.TakeIfDue(DateTime.UtcNow))
                {
                    await RebuildAsync(stoppingToken).ConfigureAwait(false);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down.
        }
        finally
        {
            _library.ItemAdded -= OnLibraryChanged;
            _library.ItemUpdated -= OnLibraryChanged;
            _library.ItemRemoved -= OnLibraryChanged;
        }
    }

    private async Task RebuildAsync(CancellationToken cancellationToken)
    {
        try
        {
            var built = await _inventory.RebuildAllAsync(cancellationToken).ConfigureAwait(false);
            Rebuilds++;
            _logger.LogInformation(
                "The library changed, so the inventory was rebuilt: {Built} record(s)", built);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // A failed rebuild must never take the hosted service down, and must not spin: the flag
            // was already claimed, so this waits for the next change rather than retrying at once.
            _logger.LogWarning(ex, "Rebuilding the inventory after a library change failed");
        }
    }

    /// <summary>Note a library change, unless it is one that could never be inventory.</summary>
    private void OnLibraryChanged(object? sender, ItemChangeEventArgs e)
    {
        var item = e?.Item;
        if (item is null || !CouldBeInventory(item, InventoryService.FederatedRootOf(_runtime)))
        {
            return;
        }

        _debounce.Note(DateTime.UtcNow);
    }

    /// <summary>
    /// A cheap pre-filter for items that could never produce an inventory record.
    /// </summary>
    /// <param name="item">The item that changed.</param>
    /// <param name="federatedRoot">Where this node materializes its peers' titles.</param>
    /// <returns>True when the change is worth a rebuild.</returns>
    /// <remarks>
    /// Deliberately looser than <see cref="InventoryService.BuildAsync"/>, which decides for real:
    /// this only has to reject the two things that arrive in bulk and can never be inventory —
    /// everything that is not a video, and every federated pointer. A false positive costs one
    /// rebuild that finds nothing new; a false negative costs a title the group never hears about,
    /// so when in doubt this says yes.
    /// </remarks>
    public static bool CouldBeInventory(BaseItem item, string? federatedRoot)
    {
        ArgumentNullException.ThrowIfNull(item);

        if (item is not Movie and not Episode and not Video)
        {
            return false;
        }

        return InventoryService.IsServableLocally(item.Path, item.Tags, federatedRoot);
    }
}
