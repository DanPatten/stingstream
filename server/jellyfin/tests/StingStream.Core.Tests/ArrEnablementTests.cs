using System.IO;
using Microsoft.Extensions.Logging.Abstractions;
using StingStream.Core.Arr;
using StingStream.Core.Data;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Whether a download manager should be running.
/// </summary>
/// <remarks>
/// The rule used to be the library switch alone, which meant that switch said two different things
/// at once and started managers that had nothing to search with. Both halves are pinned here, in
/// both directions, because getting it wrong is either a process running for no reason or a node
/// that cannot fetch anything with everything apparently switched on.
/// </remarks>
public class ArrEnablementTests
{
    private static SharedSettings Settings(
        bool moviesLibrary = true,
        bool tvLibrary = true,
        bool movieIndexer = true,
        bool tvIndexer = true,
        bool indexerEnabled = true)
    {
        var settings = SharedSettings.CreateDefault();
        if (moviesLibrary)
        {
            settings.Libraries.Add(new LibrarySettings
            {
                Name = "Movies",
                Type = LibraryTypes.Movies,
                Enabled = true,
            });
        }

        if (tvLibrary)
        {
            settings.Libraries.Add(new LibrarySettings
            {
                Name = "TV Shows",
                Type = LibraryTypes.TvShows,
                Enabled = true,
            });
        }

        if (movieIndexer || tvIndexer)
        {
            settings.Indexers.Add(new IndexerSettings
            {
                Name = "an indexer",
                Enabled = indexerEnabled,
                ForMovies = movieIndexer,
                ForSeries = tvIndexer,
            });
        }

        return settings;
    }

    [Fact]
    public void A_fresh_node_runs_neither_manager()
    {
        // Nothing ships configured, so a brand new node has no indexer and should start no manager.
        // It can still be asked for things -- that is the wanted list's job, not a manager's.
        var settings = SharedSettings.CreateDefault();
        Assert.False(ArrEnablement.ShouldRun(settings, LibraryTypes.Movies));
        Assert.False(ArrEnablement.ShouldRun(settings, LibraryTypes.TvShows));
    }

    [Fact]
    public void Both_halves_are_required()
    {
        Assert.True(ArrEnablement.ShouldRun(Settings(), LibraryTypes.Movies));

        // A library switched on with no indexer has nowhere to search.
        Assert.False(ArrEnablement.ShouldRun(
            Settings(movieIndexer: false, tvIndexer: false),
            LibraryTypes.Movies));

        // An indexer with the library switched off has nothing to search on behalf of.
        Assert.False(ArrEnablement.ShouldRun(Settings(moviesLibrary: false), LibraryTypes.Movies));
    }

    [Fact]
    public void A_disabled_indexer_does_not_count()
    {
        // Unlike GroupMode, which deliberately reads "configured, enabled or not". Here the question
        // is whether anything could actually be fetched right now, and a switched-off indexer cannot.
        Assert.False(ArrEnablement.ShouldRun(Settings(indexerEnabled: false), LibraryTypes.Movies));
    }

    [Fact]
    public void An_indexer_only_starts_the_manager_for_the_kind_it_carries()
    {
        // Somebody who only follows films should never have a series manager started for them.
        var filmsOnly = Settings(movieIndexer: true, tvIndexer: false);
        Assert.True(ArrEnablement.ShouldRun(filmsOnly, LibraryTypes.Movies));
        Assert.False(ArrEnablement.ShouldRun(filmsOnly, LibraryTypes.TvShows));

        var seriesOnly = Settings(movieIndexer: false, tvIndexer: true);
        Assert.False(ArrEnablement.ShouldRun(seriesOnly, LibraryTypes.Movies));
        Assert.True(ArrEnablement.ShouldRun(seriesOnly, LibraryTypes.TvShows));
    }

    [Fact]
    public void Each_library_type_maps_to_its_own_child()
    {
        Assert.Equal("radarr", ArrEnablement.ChildFor(LibraryTypes.Movies));
        Assert.Equal("sonarr", ArrEnablement.ChildFor(LibraryTypes.TvShows));
        // Recordings and anything else answer to no manager, and must not be treated as one.
        Assert.Null(ArrEnablement.ChildFor("recordings"));
        Assert.Null(ArrEnablement.ChildFor(null));
    }

    [Fact]
    public void The_child_named_in_config_gets_the_same_answer_as_its_library_type()
    {
        var filmsOnly = Settings(movieIndexer: true, tvIndexer: false);
        Assert.True(ArrEnablement.ShouldRunChild(filmsOnly, "radarr"));
        Assert.False(ArrEnablement.ShouldRunChild(filmsOnly, "sonarr"));

        // A child this rule does not govern is never switched on by it. NZBGet is a transfer engine
        // rather than a manager for a library, and Jellyfin is the server doing the asking.
        Assert.False(ArrEnablement.ShouldRunChild(Settings(), "nzbget"));
        Assert.False(ArrEnablement.ShouldRunChild(Settings(), "jellyfin"));
    }

    [Fact]
    public void A_run_that_may_not_stop_anything_still_starts_what_is_wanted()
    {
        // The half that must keep working while stopping is held back: a node that gains an indexer
        // during setup gets its manager the moment the rule says so.
        using var dir = new TempDirectory();
        dir.WriteConfig(radarr: false, sonarr: false);

        var changed = ArrEnablement.Reconcile(
            Settings(),
            dir.Path,
            NullLogger.Instance,
            mayStop: false);

        Assert.Equal(new[] { "radarr", "sonarr" }, changed);
        Assert.Contains("radarr = true", dir.ReadConfig(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void A_run_that_may_not_stop_anything_leaves_a_running_manager_alone()
    {
        // The bug this exists to stop, and it took out every fresh install: a node being set up has
        // no libraries and no indexers yet, so the rule says "stop both" about the two managers
        // first-run wiring is in the middle of configuring. It stopped them three seconds in, wiring
        // waited five minutes for a manager that was gone, and the node never finished setting up.
        using var dir = new TempDirectory();
        dir.WriteConfig(radarr: true, sonarr: true);

        var bare = SharedSettings.CreateDefault();
        var changed = ArrEnablement.Reconcile(bare, dir.Path, NullLogger.Instance, mayStop: false);

        Assert.Empty(changed);
        Assert.Contains("radarr = true", dir.ReadConfig(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void A_run_that_may_stop_switches_an_unwanted_manager_off()
    {
        using var dir = new TempDirectory();
        dir.WriteConfig(radarr: true, sonarr: true);

        var bare = SharedSettings.CreateDefault();
        var changed = ArrEnablement.Reconcile(bare, dir.Path, NullLogger.Instance, mayStop: true);

        Assert.Equal(new[] { "radarr", "sonarr" }, changed);
        Assert.Contains("radarr = false", dir.ReadConfig(), System.StringComparison.Ordinal);
    }

    [Fact]
    public void A_config_with_no_children_table_is_left_alone_rather_than_failing_the_save()
    {
        // `DownloadingSwitch` refuses to invent a line it cannot see, which is right for a file it
        // may only change one word of. What must not happen is that refusal reaching the caller:
        // this runs from saving a library, and a hand-trimmed config.toml is not a reason to answer
        // a settings screen with an error.
        using var dir = new TempDirectory();
        File.WriteAllLines(
            Path.Combine(dir.Path, "config.toml"),
            new[] { "server_name = \"solo\"" });

        var changed = ArrEnablement.Reconcile(
            SharedSettings.CreateDefault(),
            dir.Path,
            NullLogger.Instance,
            mayStop: true);

        Assert.Empty(changed);
    }

    [Fact]
    public void A_comment_naming_another_table_does_not_hide_the_key_below_it()
    {
        // config.toml ships with a commented header and invites its owner to edit it, so a comment
        // mentioning another table by name is ordinary. The gap between the header and the key used
        // to be "anything that is not a bracket", which such a comment ends: the key below it
        // became invisible and the switch refused to write, silently, for the life of that file.
        using var dir = new TempDirectory();
        File.WriteAllLines(
            Path.Combine(dir.Path, "config.toml"),
            new[]
            {
                "server_name = \"solo\"",
                string.Empty,
                "[children]",
                "# radarr and sonarr take their ports from [ports] below.",
                "radarr = true",
                "sonarr = true",
                "nzbget = true",
                string.Empty,
                "[ports]",
                "radarr = 7878",
            });

        var changed = ArrEnablement.Reconcile(
            SharedSettings.CreateDefault(),
            dir.Path,
            NullLogger.Instance,
            mayStop: true);

        Assert.Equal(new[] { "radarr", "sonarr" }, changed);
        var written = dir.ReadConfig();
        Assert.Contains("radarr = false", written, System.StringComparison.Ordinal);
        // And the table below is untouched: the search must stop at a real header even though it
        // now reaches past a bracket in a comment.
        Assert.Contains("radarr = 7878", written, System.StringComparison.Ordinal);
    }

    private sealed class TempDirectory : System.IDisposable
    {
        public TempDirectory()
        {
            Path = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                "stingstream-arr-" + System.Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        public string Path { get; }

        public void WriteConfig(bool radarr, bool sonarr)
            => File.WriteAllLines(
                System.IO.Path.Combine(Path, "config.toml"),
                new[]
                {
                    "server_name = \"solo\"",
                    string.Empty,
                    "[children]",
                    "jellyfin = true",
                    "radarr = " + (radarr ? "true" : "false"),
                    "sonarr = " + (sonarr ? "true" : "false"),
                    "nzbget = true",
                });

        public string ReadConfig()
            => File.ReadAllText(System.IO.Path.Combine(Path, "config.toml"));

        public void Dispose()
        {
            try
            {
                Directory.Delete(Path, recursive: true);
            }
            catch (IOException)
            {
                // A temp directory that will not delete is not a test failure.
            }
        }
    }

    [Fact]
    public void Recordings_does_not_keep_the_film_manager_alive()
    {
        // Recordings is peers' DVR recordings and no folder of this node's, and its settings row is
        // typed `movies` so it sorts with the films on screen. Counted as a films library it made
        // the Movies switch appear to do nothing: the manager stayed on because "some films
        // library is enabled" was still true of a library this node holds nothing in.
        var settings = Settings();
        settings.Libraries.Add(new LibrarySettings
        {
            Name = "Recordings",
            Type = LibraryTypes.Movies,
            Enabled = true,
            Managed = false,
        });

        foreach (var library in settings.Libraries)
        {
            if (library.Managed && library.Type == LibraryTypes.Movies)
            {
                library.Enabled = false;
            }
        }

        Assert.False(ArrEnablement.ShouldRun(settings, LibraryTypes.Movies));
        // And the series side is untouched by any of it.
        Assert.True(ArrEnablement.ShouldRun(settings, LibraryTypes.TvShows));
    }

    [Fact]
    public void A_second_library_of_the_same_type_keeps_the_manager_on()
    {
        // Libraries are a list, not one row per type: switching one film library off while another
        // is still on must not stop the manager that fills them both.
        var settings = Settings();
        settings.Libraries.Add(new LibrarySettings
        {
            Name = "Kids films",
            Type = LibraryTypes.Movies,
            Enabled = false,
        });
        Assert.True(ArrEnablement.ShouldRun(settings, LibraryTypes.Movies));
    }
}
