using System;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The wanted list: what a request does on a node that has no indexer to search with.
/// </summary>
/// <remarks>
/// Three things here can only be checked against a real database, because they are SQL rather than
/// arithmetic: that a wanted row still absorbs a second person asking for the same title, that
/// losing the last indexer moves the rows nothing has started on and leaves the ones it has, and
/// that the reason somebody gave survives a round trip.
/// </remarks>
public sealed class RequestWantedStoreTests : IDisposable
{
    private readonly string _dir;
    private readonly CoreDatabase _db;
    private readonly RequestStore _store;

    public RequestWantedStoreTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "stingstream-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _db = new CoreDatabase(NullLogger<CoreDatabase>.Instance, new FixedDataDirectory(_dir));
        _store = new RequestStore(_db);
    }

    [Fact]
    public async Task AWantedRequestAbsorbsTheNextPersonWhoAsks()
    {
        // The state most likely to be asked for twice, because it is the one that waits longest: a
        // title can sit on the wanted list for weeks. Two rows for it would give the administrator
        // the same job listed twice.
        var row = await SaveAsync("movie:tmdb:603", RequestStates.Wanted).ConfigureAwait(true);
        Assert.Equal(row.Id, _store.OpenForItem("movie:tmdb:603")?.Id);
    }

    [Fact]
    public async Task LosingTheLastIndexerMovesOnlyWhatNobodyHasStarted()
    {
        var pending = await SaveAsync("movie:tmdb:1", RequestStates.Pending).ConfigureAwait(true);
        var approved = await SaveAsync("movie:tmdb:2", RequestStates.Approved).ConfigureAwait(true);
        var fulfilling = await SaveAsync("movie:tmdb:3", RequestStates.Fulfilling).ConfigureAwait(true);

        var moved = await _store
            .ConvertUnclaimedToWantedAsync(string.Empty, "Waiting for somebody to add it.", CancellationToken.None)
            .ConfigureAwait(true);

        Assert.Equal(2, moved);
        Assert.Equal(RequestStates.Wanted, _store.Get(pending.Id)!.State);
        Assert.Equal(RequestStates.Wanted, _store.Get(approved.Id)!.State);

        // Somebody is already grabbing this one, possibly on a node that still has its own
        // indexers. Relabelling it would be this node overruling the one doing the work.
        Assert.Equal(RequestStates.Fulfilling, _store.Get(fulfilling.Id)!.State);
    }

    [Fact]
    public async Task TheSweepIsSafeToRunWhenThereIsNothingToMove()
    {
        // It runs on every manual pass rather than only on the change, so that a row left behind by
        // an upgrade is still rescued. That only works if the ordinary case is a cheap no-op.
        await SaveAsync("movie:tmdb:4", RequestStates.Available).ConfigureAwait(true);
        var moved = await _store
            .ConvertUnclaimedToWantedAsync(string.Empty, "note", CancellationToken.None)
            .ConfigureAwait(true);
        Assert.Equal(0, moved);
    }

    [Fact]
    public async Task AnotherNodesRequest_IsNotSweptOntoOurList()
    {
        // Only the origin may change a request. A row heard over gossip belongs to the node that
        // made it, whatever this node's own indexers are doing.
        var theirs = await SaveAsync("movie:tmdb:5", RequestStates.Approved, mine: false).ConfigureAwait(true);
        var moved = await _store
            .ConvertUnclaimedToWantedAsync(string.Empty, "note", CancellationToken.None)
            .ConfigureAwait(true);

        Assert.Equal(0, moved);
        Assert.Equal(RequestStates.Approved, _store.Get(theirs.Id)!.State);
    }

    [Fact]
    public async Task InStatesReadsSeveralAtOnce()
    {
        // What lets the watch step poll wanted rows alongside the ones being grabbed, which is the
        // whole manual fulfilment mechanism.
        await SaveAsync("movie:tmdb:6", RequestStates.Wanted).ConfigureAwait(true);
        await SaveAsync("movie:tmdb:7", RequestStates.Fulfilling).ConfigureAwait(true);
        await SaveAsync("movie:tmdb:8", RequestStates.Available).ConfigureAwait(true);

        var rows = _store.InStates(RequestStates.Fulfilling, RequestStates.Wanted);
        Assert.Equal(2, rows.Count);
        Assert.Empty(_store.InStates());
    }

    [Fact]
    public async Task TheReasonSomebodyGaveSurvivesARoundTrip()
    {
        var row = await SaveAsync("movie:tmdb:9", RequestStates.Pending).ConfigureAwait(true);
        row.Reason = RequestReasons.BadCopy;
        row.ReasonNote = "The audio is out of sync.";
        await _store.SaveAsync(row, CancellationToken.None).ConfigureAwait(true);

        var read = _store.Get(row.Id)!;
        Assert.Equal(RequestReasons.BadCopy, read.Reason);
        Assert.Equal("The audio is out of sync.", read.ReasonNote);
        Assert.True(RequestReasons.IsDestructive(read.Reason));
    }

    [Fact]
    public async Task AnOrdinaryRequestCarriesNoReasonAtAll()
    {
        var row = await SaveAsync("movie:tmdb:10", RequestStates.Pending).ConfigureAwait(true);
        var read = _store.Get(row.Id)!;
        Assert.Null(read.Reason);
        Assert.Null(read.ReasonNote);
    }

    [Fact]
    public async Task ModeDefaultsToManualUntilTheLoopSaysOtherwise()
    {
        // A node whose request loop has never run is a node that has just been installed, and a
        // fresh install has no indexers. Guessing automatic there would auto-approve the very first
        // request and then leave it waiting on a download nothing was going to start.
        Assert.False(_store.IsAutomaticMode(string.Empty));
        Assert.False(_store.AnyGroupAutomatic());

        await _store.SetGroupModeAsync("g1", automatic: true, CancellationToken.None).ConfigureAwait(true);
        Assert.True(_store.IsAutomaticMode("g1"));
        Assert.True(_store.AnyGroupAutomatic());

        // Still manual for a group nobody has said anything about.
        Assert.False(_store.IsAutomaticMode("g2"));

        await _store.SetGroupModeAsync("g1", automatic: false, CancellationToken.None).ConfigureAwait(true);
        Assert.False(_store.AnyGroupAutomatic());
    }

    public void Dispose()
    {
        _db.Dispose();
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // A pooled SQLite handle can still hold the file on Windows. A temp directory left
            // behind is not worth failing a test over.
        }

        GC.SuppressFinalize(this);
    }

    private Task<RequestRow> SaveAsync(string itemKey, string state, bool mine = true)
        => _store.SaveAsync(
            new RequestRow
            {
                Id = Guid.NewGuid().ToString("N"),
                Kind = "movie",
                ItemKey = itemKey,
                Provider = "tmdb",
                Title = "A film",
                State = state,
                RequestedBy = "dan",
                RequestedByName = "dan",
                RequestedAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
                Mine = mine,
            },
            CancellationToken.None);

    /// <summary>A data directory and nothing else, which is all <see cref="CoreDatabase"/> reads.</summary>
    private sealed class FixedDataDirectory : INodeRuntimeProvider
    {
        public FixedDataDirectory(string directory) => DataDirectory = directory;

        public string? DataDirectory { get; }

        public string? RuntimeJsonPath => Path.Combine(DataDirectory!, "runtime.json");

        public NodeRuntime? Current => null;

        public void ClearFirstRun()
        {
        }

        public void SetServerName(string name)
        {
        }
    }
}
