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
