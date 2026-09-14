using System.Linq;
using StingStream.Core.Data;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Turning a node's two root-folder boxes into the library list that replaced them.
/// </summary>
/// <remarks>
/// <para>
/// The settings screen used to ask the same question twice: two editable, blank "Root folders"
/// boxes, and beneath them a read-only list of libraries showing those same folders plus internal
/// ones nobody could act on. Dan: <i>"i dont like this library page its confusing to have root
/// folders and libraries."</i> One list of libraries is the model now, and this is the one-way door
/// onto it, so it runs against every existing node exactly once and has to be right first time.
/// </para>
/// <para>
/// The load-bearing assertion is <see cref="AnUnsetPathStaysUnset"/>. It looks like an omission and
/// is the opposite.
/// </para>
/// </remarks>
public class LibraryMigrationTests
{
    [Fact]
    public void AnOldDocumentBecomesTheTwoBuiltInLibraries()
    {
        var settings = new SharedSettings();
#pragma warning disable CS0618 // Exercising the property the migration exists to read.
        settings.RootFolders.Movies = @"E:\media\Movies";
        settings.RootFolders.Tv = @"E:\media\TV";
#pragma warning restore CS0618

        Assert.True(LibraryMigration.Apply(settings));

        Assert.Collection(
            settings.Libraries,
            movies =>
            {
                Assert.Equal(LibraryLayoutService.MoviesLibrary, movies.Name);
                Assert.Equal(LibraryTypes.Movies, movies.Type);
                Assert.Equal(new[] { @"E:\media\Movies" }, movies.Paths);
                Assert.True(movies.Builtin);
                Assert.True(movies.Managed);
            },
            tv =>
            {
                Assert.Equal(LibraryLayoutService.TvLibrary, tv.Name);
                Assert.Equal(LibraryTypes.TvShows, tv.Type);
                Assert.Equal(new[] { @"E:\media\TV" }, tv.Paths);
                Assert.True(tv.Builtin);
            });
    }

    [Fact]
    public void AFreshNodeHasNoRecordingsLibrary()
    {
        // Recordings is added by its owner from Settings → Libraries. Dan, 2026-09-13: "drop
        // recordings by default".
        var settings = new SharedSettings();

        LibraryMigration.Apply(settings);

        Assert.Null(LibraryLayoutPlan.Recordings(settings));
    }

    [Fact]
    public void ANodeThatAlreadyHasRecordingsKeepsIt()
    {
        // Nodes set up before Recordings became optional have the row. Taking it away on upgrade
        // would withdraw a library somebody may be watching from.
        var settings = new SharedSettings();
        LibraryMigration.Apply(settings);
        settings.Libraries.Add(LibraryMigration.NewRecordings());

        Assert.False(LibraryMigration.Apply(settings));

        var recordings = LibraryLayoutPlan.Recordings(settings)!;
        Assert.True(recordings.Enabled);
        Assert.False(recordings.Managed);
        Assert.Empty(recordings.Paths);
    }

    [Fact]
    public void AnUnsetPathStaysUnset()
    {
        // The blank box meant "use the supervisor's media/Movies", and it has to keep meaning that.
        // Resolving it here would look tidier and would quietly freeze whatever the data directory
        // happened to be on the day of the upgrade into the database -- turning a default that
        // tracks where the node lives into a setting the reader never chose, and making Dan's
        // "default path is set on setup" false the first time a node moved.
        var settings = new SharedSettings();

        Assert.True(LibraryMigration.Apply(settings));

        Assert.All(settings.Libraries, library => Assert.Empty(library.Paths));
    }

    [Fact]
    public void TheFolderNamesMatchTheLibrariesAlreadyOnDisk()
    {
        // Reconciliation finds an existing virtual folder by this name. Get it wrong and a node
        // that has been running for months grows a second, empty "Movies2" beside its real one.
        var settings = new SharedSettings();

        LibraryMigration.Apply(settings);

        Assert.Equal(
            new[]
            {
                LibraryLayoutService.MoviesLibrary,
                LibraryLayoutService.TvLibrary,
            },
            settings.Libraries.Select(l => l.FolderName));
    }

    [Fact]
    public void ItRunsOnceAndThenLeavesTheDocumentAlone()
    {
        // Applied on every read, including reads that happen between a controller mutating the list
        // and saving it, so "already has libraries" is the only safe guard.
        var settings = new SharedSettings();
        LibraryMigration.Apply(settings);
        settings.Libraries[0].Paths.Add(@"D:\second-drive\Movies");

        Assert.False(LibraryMigration.Apply(settings));
        Assert.Equal(2, settings.Libraries.Count);
        Assert.Contains(@"D:\second-drive\Movies", settings.Libraries[0].Paths);
    }

    [Fact]
    public void EveryLibraryGetsItsOwnIdentity()
    {
        var settings = new SharedSettings();

        LibraryMigration.Apply(settings);

        Assert.All(settings.Libraries, library => Assert.NotEmpty(library.Id));
        Assert.Equal(2, settings.Libraries.Select(l => l.Id).Distinct().Count());
    }

    [Fact]
    public void AWholeDocumentWriteCannotWipeTheLibraries()
    {
        // PUT /Settings replaces the document rather than patching it. An app build from before
        // libraries existed sends a body without them, deserialization makes that an empty list,
        // and saving it would delete every library on the node with nothing left to rebuild from.
        var stored = new SharedSettings();
        LibraryMigration.Apply(stored);
        var incoming = new SharedSettings { DefaultQualityProfileName = "HD-1080p" };

        SharedSettings.PreserveServerOwned(incoming, stored);

        Assert.Equal(2, incoming.Libraries.Count);
        Assert.Equal("HD-1080p", incoming.DefaultQualityProfileName);
    }
}
