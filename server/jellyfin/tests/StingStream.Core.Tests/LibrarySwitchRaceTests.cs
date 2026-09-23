using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// A library's switch staying where it was put while the layout pass it started is still running.
/// </summary>
/// <remarks>
/// Dan, 2026-09-22: toggling Movies or TV shows "flips randomly". The layout pass read the
/// settings when it began, spent seconds on the media server, and then saved its whole snapshot,
/// so a press made during the pass came back as the value from before it. These pin the two halves
/// of the fix: the pass saves only what it learned, and passes never overlap.
/// </remarks>
public sealed class LibrarySwitchRaceTests : IDisposable
{
    private readonly TempNode _node = new();

    public void Dispose() => _node.Dispose();

    private async Task<SharedSettings> SeedAsync()
    {
        var settings = SharedSettings.CreateDefault();
        settings.Libraries = new List<LibrarySettings>
        {
            new() { Id = "movies", Name = "Movies", FolderName = "Movies", Type = LibraryTypes.Movies, Enabled = true, Builtin = true },
            new() { Id = "tv", Name = "TV Shows", FolderName = "TV Shows", Type = LibraryTypes.TvShows, Enabled = true, Builtin = true },
        };
        return await _node.Settings.SaveAsync(settings, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task A_press_during_a_layout_pass_survives_the_pass_saving()
    {
        await SeedAsync();
        var ct = TestContext.Current.CancellationToken;

        // The pass starts: it reads the settings, Movies on.
        var snapshot = _node.Settings.Get();

        // The reader switches Movies off while the pass is talking to the media server.
        await _node.Settings.UpdateAsync(s => s.Libraries.Single(l => l.Id == "movies").Enabled = false, ct);

        // The pass finishes and records what it learned about the media server's folders.
        var movies = snapshot.Libraries.Single(l => l.Id == "movies");
        movies.JellyfinItemId = "abc123";
        movies.ManagedLocations = new List<string> { @"D:\Movies" };
        await _node.Settings.SaveLibraryBookkeepingAsync(snapshot, ct);

        var stored = _node.Settings.Get().Libraries.Single(l => l.Id == "movies");
        Assert.False(stored.Enabled);
        Assert.Equal("abc123", stored.JellyfinItemId);
        Assert.Equal(new[] { @"D:\Movies" }, stored.ManagedLocations);
    }

    [Fact]
    public async Task The_pass_does_not_bring_back_a_library_removed_while_it_ran()
    {
        await SeedAsync();
        var ct = TestContext.Current.CancellationToken;
        var snapshot = _node.Settings.Get();
        snapshot.Libraries.Add(new LibrarySettings { Id = "gone", Name = "Gone", FolderName = "Gone" });

        await _node.Settings.SaveLibraryBookkeepingAsync(snapshot, ct);

        Assert.DoesNotContain(_node.Settings.Get().Libraries, l => l.Id == "gone");
    }

    [Fact]
    public async Task Hidden_and_folders_survive_the_pass_too()
    {
        await SeedAsync();
        var ct = TestContext.Current.CancellationToken;
        var snapshot = _node.Settings.Get();

        await _node.Settings.UpdateAsync(
            s =>
            {
                var tv = s.Libraries.Single(l => l.Id == "tv");
                tv.Hidden = true;
                tv.Paths = new List<string> { @"E:\TV" };
            },
            ct);
        await _node.Settings.SaveLibraryBookkeepingAsync(snapshot, ct);

        var stored = _node.Settings.Get().Libraries.Single(l => l.Id == "tv");
        Assert.True(stored.Hidden);
        Assert.Equal(new[] { @"E:\TV" }, stored.Paths);
    }

    [Fact]
    public async Task Passes_never_overlap_and_presses_during_one_collapse_into_one_more()
    {
        var running = 0;
        var maxRunning = 0;
        var runs = 0;
        using var release = new SemaphoreSlim(0);
        using var started = new SemaphoreSlim(0);

        var coalescer = new SerialCoalescer(
            async _ =>
            {
                started.Release();
                var now = Interlocked.Increment(ref running);
                maxRunning = Math.Max(maxRunning, now);
                Interlocked.Increment(ref runs);
                await release.WaitAsync(TestContext.Current.CancellationToken);
                Interlocked.Decrement(ref running);
            },
            NullLogger.Instance);

        var first = coalescer.Request();
        await started.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        // Three presses while the first pass is still running.
        var second = coalescer.Request();
        _ = coalescer.Request();
        _ = coalescer.Request();

        release.Release(); // first pass ends; exactly one more starts
        release.Release(); // and that one ends
        await second.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        await first.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        Assert.Equal(1, maxRunning);
        Assert.Equal(2, runs);
    }

    [Fact]
    public async Task Request_returns_before_the_pass_finishes()
    {
        using var release = new SemaphoreSlim(0);
        var coalescer = new SerialCoalescer(
            _ => release.WaitAsync(TestContext.Current.CancellationToken),
            NullLogger.Instance);

        var pass = coalescer.Request();

        Assert.False(pass.IsCompleted);
        release.Release();
        await pass.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task A_pass_that_throws_does_not_stop_the_next()
    {
        var calls = 0;
        var coalescer = new SerialCoalescer(
            _ =>
            {
                calls++;
                if (calls == 1)
                {
                    throw new InvalidOperationException("media server not ready");
                }

                return Task.CompletedTask;
            },
            NullLogger.Instance);

        await coalescer.Request().WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
        await coalescer.Request().WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);

        Assert.Equal(2, calls);
    }

    /// <summary>A throwaway data directory with a real <c>core.db</c> in it.</summary>
    private sealed class TempNode : IDisposable
    {
        private readonly CoreDatabase _db;
        private readonly TempRuntimeProvider _runtime = new();

        public TempNode()
        {
            _db = new CoreDatabase(NullLogger<CoreDatabase>.Instance, _runtime);
            _db.EnsureInitialized();
            Settings = new SettingsStore(_db, NullLogger<SettingsStore>.Instance);
        }

        public SettingsStore Settings { get; }

        public void Dispose()
        {
            Settings.Dispose();
            _db.Dispose();
            _runtime.Dispose();
        }
    }

    private sealed class TempRuntimeProvider : INodeRuntimeProvider, IDisposable
    {
        public TempRuntimeProvider()
        {
            DataDirectory = Path.Combine(Path.GetTempPath(), "stingstream-core-tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(DataDirectory);
        }

        public string? DataDirectory { get; }

        public string? RuntimeJsonPath => Path.Combine(DataDirectory!, "runtime.json");

        public NodeRuntime? Current => null;

        public void ClearFirstRun()
        {
        }

        public void SetServerName(string name)
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
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
