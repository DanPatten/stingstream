using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using StingStream.Core.Configuration;
using StingStream.Core.Inventory;
using StingStream.Core.Mesh;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// What a publishing pass must not lose.
/// </summary>
/// <remarks>
/// <para>
/// The regression here is CI runs 34053018232 and 34060142479, where M4 failed waiting five minutes
/// for a BLAKE3 hash that had been computed in a tenth of a second and was never going to be sent.
/// Node B's log tells the whole story in four lines, the same four both times: it hashed three
/// files at 19:06:17.016, .067 and .338, published its first snapshot at .093, and three seconds
/// later published a delta of **one** upsert — the file hashed after the drain. The hashes that
/// landed between the snapshot's read and the drain that followed it were neither in the snapshot
/// nor left in the queue; they were simply dropped, and the next repair was the fifteen-minute
/// snapshot timer.
/// </para>
/// <para>
/// So the rule these guard is an ordering one: drain the change feed **before** reading the
/// records, so anything that lands while a snapshot is in flight is still queued for the next
/// delta.
/// </para>
/// </remarks>
public class InventoryPublisherTests
{
    private const string Group = "abc123";
    private const string Key = "movie:tmdb:10378";

    /// <summary>This server's two libraries.</summary>
    private static readonly Guid Movies = Guid.Parse("11111111111111111111111111111111");
    private static readonly Guid Tv = Guid.Parse("22222222222222222222222222222222");

    /// <summary>A link that has been given everything, which is what the older specs assume.</summary>
    private static FakeShared Everything()
        => new(new Dictionary<string, IReadOnlyList<Guid>>(StringComparer.Ordinal)
        {
            [Group] = new[] { Movies, Tv },
        });

    [Fact]
    public async Task A_change_that_lands_while_a_snapshot_is_in_flight_survives_it()
    {
        var feed = new InventoryChangeFeed();
        var inventory = new FakeInventory();
        inventory.Add(Key, hash: null);

        // The hashing service finishing a file *during* the snapshot: the read has already
        // happened, so the record it returned is hash-less, and the upsert is queued a moment
        // afterwards. This is exactly node B's 19:06:17.067.
        inventory.AfterRead = () =>
        {
            inventory.SetHash(Key, "32d3df5d99104405");
            feed.Upserted(Key);
        };

        var mesh = new FakeMesh();
        var publisher = new InventoryPublisher(
            mesh, inventory, feed, new FakeRuntime(), Everything(), NullLogger<InventoryPublisher>.Instance);

        await publisher.PassAsync(CancellationToken.None);

        Assert.Single(mesh.Snapshots);
        Assert.True(
            feed.HasChanges,
            "a hash that landed while the snapshot was in flight must still be queued: the "
            + "snapshot could not have carried it, and nothing else will for fifteen minutes.");

        // ...and the very next pass sends it, because the snapshot timer is now fifteen minutes out.
        await publisher.PassAsync(CancellationToken.None);

        var delta = Assert.Single(mesh.Deltas);
        var record = Assert.Single(delta.Upserts);
        Assert.Equal(Key, record.ItemKey);
        Assert.Equal("32d3df5d99104405", record.FileHash);
    }

    [Fact]
    public async Task A_change_queued_before_a_snapshot_is_not_sent_twice()
    {
        var feed = new InventoryChangeFeed();
        var inventory = new FakeInventory();
        inventory.Add(Key, hash: "32d3df5d99104405");
        feed.Upserted(Key);

        var mesh = new FakeMesh();
        var publisher = new InventoryPublisher(
            mesh, inventory, feed, new FakeRuntime(), Everything(), NullLogger<InventoryPublisher>.Instance);

        await publisher.PassAsync(CancellationToken.None);
        Assert.Single(mesh.Snapshots);
        Assert.False(feed.HasChanges, "the snapshot carried it; the feed has nothing left to say");

        await publisher.PassAsync(CancellationToken.None);
        Assert.Empty(mesh.Deltas);
    }

    [Fact]
    public async Task A_node_in_no_group_publishes_its_capacity_and_nothing_else()
    {
        var feed = new InventoryChangeFeed();
        feed.Upserted(Key);
        var mesh = new FakeMesh { Groups = new List<MeshGroup>() };
        var publisher = new InventoryPublisher(
            mesh, new FakeInventory(), feed, new FakeRuntime(), Everything(), NullLogger<InventoryPublisher>.Instance);

        await publisher.PassAsync(CancellationToken.None);

        Assert.Equal(1, mesh.Capacities);
        Assert.Empty(mesh.Snapshots);
        Assert.Empty(mesh.Deltas);
        Assert.False(feed.HasChanges);
    }

    // --- each side picks its own -----------------------------------------------------------------

    /// <summary>
    /// The control Dan asked for, and the reason it needed code rather than a checkbox: the
    /// publisher used to build one record set and push the same one to every link.
    /// </summary>
    [Fact]
    public async Task A_snapshot_carries_only_the_libraries_shared_into_that_link()
    {
        var inventory = new FakeInventory();
        inventory.Add("movie:tmdb:1", hash: null, library: Movies);
        inventory.Add("episode:tvdb:2", hash: null, library: Tv);

        var mesh = new FakeMesh();
        var shared = new FakeShared(new Dictionary<string, IReadOnlyList<Guid>>(StringComparer.Ordinal)
        {
            [Group] = new[] { Movies },
        });
        var publisher = new InventoryPublisher(
            mesh,
            inventory,
            new InventoryChangeFeed(),
            new FakeRuntime(),
            shared,
            NullLogger<InventoryPublisher>.Instance);

        await publisher.PassAsync(CancellationToken.None);

        var snapshot = Assert.Single(mesh.Snapshots);
        var record = Assert.Single(snapshot);
        Assert.Equal("movie:tmdb:1", record.ItemKey);
    }

    /// <summary>
    /// A brand-new link shares nothing until its owner chooses, rather than everything.
    /// </summary>
    /// <remarks>
    /// An empty library is a question somebody can answer. A link that silently published the whole
    /// collection the moment it was created is not — and it is not recoverable either, because by
    /// the time anyone notices, the other server already has the index.
    /// </remarks>
    [Fact]
    public async Task A_link_nobody_has_chosen_libraries_for_gets_nothing()
    {
        var inventory = new FakeInventory();
        inventory.Add("movie:tmdb:1", hash: null, library: Movies);

        var mesh = new FakeMesh();
        var publisher = new InventoryPublisher(
            mesh,
            inventory,
            new InventoryChangeFeed(),
            new FakeRuntime(),
            new FakeShared(new Dictionary<string, IReadOnlyList<Guid>>(StringComparer.Ordinal)),
            NullLogger<InventoryPublisher>.Instance);

        await publisher.PassAsync(CancellationToken.None);

        Assert.Empty(Assert.Single(mesh.Snapshots));
    }

    /// <summary>
    /// A change to something a link cannot see is a **removal**, not silence.
    /// </summary>
    /// <remarks>
    /// This is the half an implementation that merely "publishes less" gets wrong. A film moved
    /// into an un-shared library, or one whose library was never shared, must not sit on a peer as
    /// a pointer to something it will never be offered again.
    /// </remarks>
    [Fact]
    public async Task A_delta_for_an_unshared_library_retracts_rather_than_saying_nothing()
    {
        var inventory = new FakeInventory();
        inventory.Add("episode:tvdb:2", hash: null, library: Tv);

        var mesh = new FakeMesh();
        var shared = new FakeShared(new Dictionary<string, IReadOnlyList<Guid>>(StringComparer.Ordinal)
        {
            [Group] = new[] { Movies },
        });
        var feed = new InventoryChangeFeed();
        var publisher = new InventoryPublisher(
            mesh,
            inventory,
            feed,
            new FakeRuntime(),
            shared,
            NullLogger<InventoryPublisher>.Instance);

        // Get the snapshot out of the way, then change the TV episode.
        await publisher.PassAsync(CancellationToken.None);
        feed.Upserted("episode:tvdb:2");
        await publisher.PassAsync(CancellationToken.None);

        var delta = Assert.Single(mesh.Deltas);
        Assert.Empty(delta.Upserts);
        Assert.Equal("episode:tvdb:2", Assert.Single(delta.Removals));
    }

    /// <summary>
    /// A record written before per-library sharing existed is shared with nobody, and triggers a
    /// one-time rebuild that fills its library in.
    /// </summary>
    [Fact]
    public async Task Records_from_before_this_feature_are_rebuilt_rather_than_leaked()
    {
        var inventory = new FakeInventory();
        inventory.Add("movie:tmdb:1", hash: null);
        inventory.ClearLibrary("movie:tmdb:1");

        var mesh = new FakeMesh();
        var publisher = new InventoryPublisher(
            mesh,
            inventory,
            new InventoryChangeFeed(),
            new FakeRuntime(),
            Everything(),
            NullLogger<InventoryPublisher>.Instance);

        await publisher.PassAsync(CancellationToken.None);

        // Shared with nobody rather than with everybody: the other reading of null would publish a
        // library its owner may have un-shared.
        Assert.Empty(Assert.Single(mesh.Snapshots));
        Assert.Equal(1, inventory.Rebuilds);
    }

    // --- fakes ---------------------------------------------------------------------------------

    private sealed class FakeShared : Sharing.ISharedLibraries
    {
        private readonly IReadOnlyDictionary<string, IReadOnlyList<Guid>> _all;

        public FakeShared(IReadOnlyDictionary<string, IReadOnlyList<Guid>> all)
        {
            _all = all;
        }

        public Task<IReadOnlyDictionary<string, IReadOnlyList<Guid>>> AllAsync(
            CancellationToken cancellationToken) => Task.FromResult(_all);
    }


    private sealed class FakeInventory : IInventoryService
    {
        private readonly Dictionary<string, InventoryRecord> _records = new(StringComparer.Ordinal);

        /// <summary>Runs once, immediately after the first page is read.</summary>
        public Action? AfterRead { get; set; }

        public void Add(string key, string? hash, Guid? library = null)
            => _records[key] = new InventoryRecord
            {
                ItemKey = key,
                JellyfinItemId = "1",
                Kind = "movie",
                FileHash = hash,
                LibraryId = (library ?? Movies).ToString("N"),
                UpdatedAt = DateTime.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            };

        public void SetHash(string key, string hash) => _records[key].FileHash = hash;

        /// <summary>A record as it deserialises from before <c>LibraryId</c> existed.</summary>
        public void ClearLibrary(string key) => _records[key].LibraryId = null;

        public int Rebuilds { get; private set; }

        public IReadOnlyList<InventoryRecord> All(int limit = 500, int offset = 0)
        {
            // A copy, because the point of the test is that the list read is a snapshot in time
            // and the record changes underneath it.
            var page = new List<InventoryRecord>();
            if (offset == 0)
            {
                foreach (var record in _records.Values)
                {
                    page.Add(Copy(record));
                }
            }

            var after = AfterRead;
            AfterRead = null;
            after?.Invoke();
            return page;
        }

        public InventoryRecord? ByKey(string itemKey)
            => _records.TryGetValue(itemKey, out var record) ? Copy(record) : null;

        public IReadOnlyCollection<string> Keys => _records.Keys;

        public long Count => _records.Count;

        public Task<int> RebuildAllAsync(CancellationToken cancellationToken = default)
        {
            Rebuilds++;
            return Task.FromResult(_records.Count);
        }

        public Task<InventoryRecord?> RefreshItemAsync(Guid itemId, CancellationToken cancellationToken = default)
            => Task.FromResult<InventoryRecord?>(null);

        public Task<bool> RemoveAsync(string itemKey, CancellationToken cancellationToken = default)
            => Task.FromResult(_records.Remove(itemKey));

        private static InventoryRecord Copy(InventoryRecord record) => new()
        {
            ItemKey = record.ItemKey,
            JellyfinItemId = record.JellyfinItemId,
            Kind = record.Kind,
            FileHash = record.FileHash,
            LocalPath = record.LocalPath,
            LibraryId = record.LibraryId,
            UpdatedAt = record.UpdatedAt,
        };
    }

    private sealed record Delta(IReadOnlyList<MeshInventoryRecord> Upserts, IReadOnlyList<string> Removals);

    private sealed class FakeMesh : IMeshClient
    {
        public List<MeshGroup> Groups { get; set; } = new()
        {
            new MeshGroup { Group = Group, Name = "E2E" },
        };

        public List<IReadOnlyList<MeshInventoryRecord>> Snapshots { get; } = new();

        public List<Delta> Deltas { get; } = new();

        public int Capacities { get; private set; }

        public string? BaseUrl => "http://127.0.0.1:9000";

        public bool IsAvailable => true;

        public Task<IReadOnlyList<MeshGroup>?> GroupsAsync(CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyList<MeshGroup>?>(Groups);

        public Task PutInventoryAsync(
            string group, IReadOnlyList<MeshInventoryRecord> records, CancellationToken cancellationToken)
        {
            Snapshots.Add(records);
            return Task.CompletedTask;
        }

        public Task PatchInventoryAsync(
            string group,
            IReadOnlyList<MeshInventoryRecord> upserts,
            IReadOnlyList<string> removals,
            CancellationToken cancellationToken)
        {
            Deltas.Add(new Delta(upserts, removals));
            return Task.CompletedTask;
        }

        public Task PutCapacityAsync(MeshCapacity capacity, CancellationToken cancellationToken)
        {
            Capacities++;
            return Task.CompletedTask;
        }

        // Nothing else is on the publisher's path; a call would be a change worth noticing.
        public Task<bool> WaitUntilReadyAsync(TimeSpan timeout, CancellationToken cancellationToken)
            => Task.FromResult(true);

        public Task<MeshStatus?> StatusAsync(CancellationToken cancellationToken) => throw Unused();

        public Task<MeshGroup> CreateGroupAsync(string name, CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshJoinResult> JoinGroupAsync(string code, CancellationToken cancellationToken) => throw Unused();

        public Task<MeshInvite> InviteAsync(string group, CancellationToken cancellationToken) => throw Unused();

        public Task<MeshVouch> VouchAsync(
            string audience,
            string nonce,
            string userId,
            string userName,
            CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshVouchClaims?> VerifyVouchAsync(
            string assertion,
            CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshAccountStatus> AccountStatusAsync(CancellationToken cancellationToken) => throw Unused();

        public Task<MeshAccountStatus> AccountRegisterAsync(
            string username,
            string password,
            bool claim,
            CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshAccountStatus> AccountResetAsync(string password, CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshAccountSession> AccountVerifyAsync(string token, CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshSharingSettings> SharingSettingsAsync(CancellationToken cancellationToken) => throw Unused();

        public Task<MeshSharingSettings> SetSharingSettingsAsync(
            MeshSharingSettings settings,
            CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshMembers?> MembersAsync(string group, CancellationToken cancellationToken) => throw Unused();

        public Task<MeshRotation> RemoveMemberAsync(string group, string node, CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshRotation> RotateSecretAsync(string group, CancellationToken cancellationToken) => throw Unused();

        public Task<bool> LeaveGroupAsync(string group, CancellationToken cancellationToken) => throw Unused();

        public Task<MeshIndex?> IndexAsync(string group, CancellationToken cancellationToken) => throw Unused();

        public Task<IReadOnlyList<MeshPeer>?> PeersAsync(string? group, CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshPeer?> PeerStatsAsync(string group, string node, CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshSources?> SourcesAsync(
            string group, string itemKey, Playback.PlaybackPolicy policy, CancellationToken cancellationToken)
            => throw Unused();

        public Task<HttpResponseMessage> OpenRangeAsync(
            string group, string itemKey, string node, long from, long? to, CancellationToken cancellationToken)
            => throw Unused();

        public Task<(byte[] Bytes, string? ContentType)?> ImageAsync(
            string group, string itemKey, string node, string kind, CancellationToken cancellationToken)
            => throw Unused();

        public Task<byte[]?> SubtitleAsync(
            string group, string itemKey, string node, int index, CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshDomains> DomainsAsync(CancellationToken cancellationToken) => throw Unused();

        public Task<MeshDomains> SetTunnelAsync(MeshTunnelRequest request, CancellationToken cancellationToken)
            => throw Unused();

        public Task<MeshDomains> DeleteTunnelAsync(CancellationToken cancellationToken) => throw Unused();

        private static NotSupportedException Unused()
            => new("The inventory publisher does not call this.");
    }

    private sealed class FakeRuntime : INodeRuntimeProvider
    {
        public string? DataDirectory => null;

        public string? RuntimeJsonPath => null;

        public NodeRuntime? Current => null;

        public void ClearFirstRun()
        {
        }

        // The inventory publisher does not name the node; this exists so the double satisfies the
        // interface.
        public void SetNodeName(string name)
        {
        }
    }
}
