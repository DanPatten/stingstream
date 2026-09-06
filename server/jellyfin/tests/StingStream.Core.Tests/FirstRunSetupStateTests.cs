using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The pending flag, through a real <c>core.db</c>.
/// </summary>
/// <remarks>
/// A database-backed test in a suite that is otherwise pure functions, and it earns its place: the
/// flag is stored as a JSON document in the shared <c>settings</c> table rather than in a column of
/// its own, so what is actually being asserted is that <see cref="SettingsStore"/>'s document
/// helpers round-trip a <see cref="bool"/> through camelCase JSON and an upsert — and that a node
/// which has never written the row reads back as <em>not</em> pending, which is the answer that
/// keeps an upgraded node's account out of a stranger's hands. Cheap: one temporary directory and
/// one SQLite file per test.
/// </remarks>
public class FirstRunSetupStateTests
{
    [Fact]
    public async Task ANodeThatHasNeverWrittenTheFlagIsNotPending()
    {
        using var node = new TempNode();

        Assert.False(FirstRunSetupState.Exists(node.Settings));
        Assert.False(FirstRunSetupState.Get(node.Settings).Pending);

        await Task.CompletedTask;
    }

    [Fact]
    public async Task TheFlagRoundTripsBothWays()
    {
        using var node = new TempNode();

        await FirstRunSetupState.SetAsync(node.Settings, true, TestContext.Current.CancellationToken);
        Assert.True(FirstRunSetupState.Exists(node.Settings));
        Assert.True(FirstRunSetupState.Get(node.Settings).Pending);

        await FirstRunSetupState.SetAsync(node.Settings, false, TestContext.Current.CancellationToken);
        // Still there -- "written and false" is a different state from "never written", and the
        // wiring pass tells them apart to decide whether an unrecorded node is one that predates
        // the flag.
        Assert.True(FirstRunSetupState.Exists(node.Settings));
        Assert.False(FirstRunSetupState.Get(node.Settings).Pending);
    }

    [Fact]
    public async Task ClearingItTwiceIsNotAnError()
    {
        using var node = new TempNode();

        await FirstRunSetupState.SetAsync(node.Settings, false, TestContext.Current.CancellationToken);
        await FirstRunSetupState.SetAsync(node.Settings, false, TestContext.Current.CancellationToken);

        Assert.False(FirstRunSetupState.Get(node.Settings).Pending);
    }

    [Fact]
    public async Task TheFlagSurvivesReopeningTheDatabase()
    {
        using var node = new TempNode();
        await FirstRunSetupState.SetAsync(node.Settings, true, TestContext.Current.CancellationToken);

        using var db = new CoreDatabase(NullLogger<CoreDatabase>.Instance, node.Runtime);
        db.EnsureInitialized();
        var settings = new SettingsStore(db, NullLogger<SettingsStore>.Instance);

        Assert.True(FirstRunSetupState.Get(settings).Pending);
    }

    [Fact]
    public async Task ItDoesNotDisturbTheSharedSettingsDocumentBesideIt()
    {
        // Both live in the same key/value table. A flag write that clobbered the Omniarr document
        // would take the node's root folders and indexers with it.
        using var node = new TempNode();

        var shared = SharedSettings.CreateDefault();
        shared.RootFolders.Movies = @"D:\media\Movies";
        await node.Settings.SaveAsync(shared, TestContext.Current.CancellationToken);

        await FirstRunSetupState.SetAsync(node.Settings, true, TestContext.Current.CancellationToken);

        Assert.Equal(@"D:\media\Movies", node.Settings.Get().RootFolders.Movies);
        Assert.True(FirstRunSetupState.Get(node.Settings).Pending);
    }

    /// <summary>A throwaway data directory with a real <c>core.db</c> in it.</summary>
    private sealed class TempNode : IDisposable
    {
        private readonly CoreDatabase _db;

        public TempNode()
        {
            Runtime = new TempRuntimeProvider();
            _db = new CoreDatabase(NullLogger<CoreDatabase>.Instance, Runtime);
            _db.EnsureInitialized();
            Settings = new SettingsStore(_db, NullLogger<SettingsStore>.Instance);
        }

        public TempRuntimeProvider Runtime { get; }

        public SettingsStore Settings { get; }

        public void Dispose()
        {
            _db.Dispose();
            Runtime.Dispose();
        }
    }

    /// <summary>
    /// The minimum <see cref="INodeRuntimeProvider"/> <see cref="CoreDatabase"/> needs: a data
    /// directory. <c>Current</c> is null, which is the "started by hand rather than by the
    /// supervisor" case, and the database falls back to <c>&lt;data&gt;/core.db</c>.
    /// </summary>
    private sealed class TempRuntimeProvider : INodeRuntimeProvider, IDisposable
    {
        public TempRuntimeProvider()
        {
            DataDirectory = Path.Combine(
                Path.GetTempPath(),
                "stingstream-core-tests",
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(DataDirectory);
        }

        public string? DataDirectory { get; }

        public string? RuntimeJsonPath => Path.Combine(DataDirectory!, "runtime.json");

        public NodeRuntime? Current => null;

        public void ClearFirstRun()
        {
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(DataDirectory!, recursive: true);
            }
            catch (IOException)
            {
                // SQLite's connection pool can still hold the file open for a moment on Windows.
                // A leftover directory under %TEMP% is not worth failing a test over.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
