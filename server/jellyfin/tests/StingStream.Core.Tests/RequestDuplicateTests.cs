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
/// One row per title, however many times somebody presses Request.
/// </summary>
/// <remarks>
/// This exists because of a specific failure: two identical rows for The Lord of the Rings: The
/// Return of the King, both reading "Could not be filled", each with its own Delete button. The
/// de-duplication was there, but it only looked at requests that were still running
/// (<see cref="RequestStore.OpenForItem"/>), so a request that had finished — failed, declined, or
/// filled and since gone — matched nothing and the next ask filed a second row beside it.
/// <para>
/// <see cref="RequestStore.LatestMineForItem"/> is what closes that, and the two facts it has to
/// get right are pinned here: it finds a finished request, and it does not find somebody else's.
/// Reopening a row heard over gossip would be this node rewriting another node's request, which
/// only its origin may do.
/// </para>
/// </remarks>
public sealed class RequestDuplicateTests : IDisposable
{
    private readonly string _dir;
    private readonly CoreDatabase _db;
    private readonly RequestStore _store;

    public RequestDuplicateTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "stingstream-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _db = new CoreDatabase(NullLogger<CoreDatabase>.Instance, new FixedDataDirectory(_dir));
        _store = new RequestStore(_db);
    }

    [Fact]
    public async Task AFinishedRequestIsFoundSoTheNextAskCanReopenIt()
    {
        foreach (var state in new[] { RequestStates.Failed, RequestStates.Declined, RequestStates.Available })
        {
            var row = await SaveAsync("movie:tmdb:122", state, mine: true).ConfigureAwait(true);

            // What the duplicate came from: a finished request is not open, so the old check saw
            // nothing and made a second row.
            Assert.Null(_store.OpenForItem("movie:tmdb:122"));
            Assert.Equal(row.Id, _store.LatestMineForItem("movie:tmdb:122")?.Id);
        }
    }

    [Fact]
    public async Task ARequestStillRunningIsFoundTheWayItAlwaysWas()
    {
        var row = await SaveAsync("movie:tmdb:603", RequestStates.Fulfilling, mine: true).ConfigureAwait(true);
        Assert.Equal(row.Id, _store.OpenForItem("movie:tmdb:603")?.Id);
        Assert.Equal(row.Id, _store.LatestMineForItem("movie:tmdb:603")?.Id);
    }

    [Fact]
    public async Task AnotherNodesRequestIsNeverOfferedForReopening()
    {
        await SaveAsync("movie:tmdb:78", RequestStates.Failed, mine: false).ConfigureAwait(true);
        Assert.Null(_store.LatestMineForItem("movie:tmdb:78"));

        // It is still on this node — a node that may have to fulfil it keeps what it knows — it is
        // simply not ours to reopen.
        Assert.NotNull(_store.LatestForItem("movie:tmdb:78"));
    }

    [Fact]
    public async Task TheNewestAskIsTheOneReopened()
    {
        // Rows made before this rule existed. Two of them for one title is exactly the mess in the
        // screenshot, and the newest is the one carrying the latest answer.
        await SaveAsync("movie:tmdb:120", RequestStates.Failed, mine: true, at: "2026-09-01T10:00:00.0000000Z")
            .ConfigureAwait(true);
        var newer = await SaveAsync(
                "movie:tmdb:120",
                RequestStates.Failed,
                mine: true,
                at: "2026-09-09T10:00:00.0000000Z")
            .ConfigureAwait(true);

        Assert.Equal(newer.Id, _store.LatestMineForItem("movie:tmdb:120")?.Id);
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

    private Task<RequestRow> SaveAsync(string itemKey, string state, bool mine, string? at = null)
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
                RequestedAt = at ?? DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture),
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

        public void SetNodeName(string name)
        {
        }
    }
}
