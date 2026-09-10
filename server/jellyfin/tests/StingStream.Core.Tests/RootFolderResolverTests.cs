using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Which folder a new title goes in, now that a library can have several.
/// </summary>
/// <remarks>
/// Five places used to reach into the two root-folder boxes and coalesce them against the
/// supervisor's paths, each with its own copy of the fallback. The question is real now -- a library
/// may span two drives -- so it is answered once and the callers stop guessing. The distinction that
/// matters is between <c>ForDownloads</c>, which is where new things land, and <c>AllLocal</c>,
/// which is everything the download clients need to know exists.
/// </remarks>
public class RootFolderResolverTests
{
    private static readonly PathsRuntime Runtime = new()
    {
        MediaMovies = @"D:\data\media\Movies",
        MediaTv = @"D:\data\media\TV",
    };

    private static SharedSettings Migrated()
    {
        var settings = new SharedSettings();
        LibraryMigration.Apply(settings);
        return settings;
    }

    [Fact]
    public void NewTitlesLandInTheBuiltInLibrarysFirstFolder()
    {
        var settings = Migrated();
        settings.Libraries[0].Paths.Add(@"D:\media\Movies");
        settings.Libraries[0].Paths.Add(@"E:\archive\films");

        Assert.Equal(
            @"D:\media\Movies",
            RootFolderResolver.ForDownloads(settings, Runtime, RootFolderResolver.LibraryKind.Movies));
    }

    [Fact]
    public void AnExtraLibraryNeverReceivesNewTitles()
    {
        // Only the built-in library carries the pointer tree, so it is the only place an import
        // sits beside peers' copies of the same title and merges with them.
        var settings = Migrated();
        settings.Libraries[0].Paths.Add(@"D:\media\Movies");
        settings.Libraries.Insert(0, new LibrarySettings
        {
            Name = "Archive",
            Type = LibraryTypes.Movies,
            Paths = { @"E:\archive\films" },
        });

        Assert.Equal(
            @"D:\media\Movies",
            RootFolderResolver.ForDownloads(settings, Runtime, RootFolderResolver.LibraryKind.Movies));
    }

    [Fact]
    public void AnUnsetLibraryFollowsTheSupervisor()
    {
        Assert.Equal(
            @"D:\data\media\TV",
            RootFolderResolver.ForDownloads(Migrated(), Runtime, RootFolderResolver.LibraryKind.Tv));
    }

    [Fact]
    public void WithNoLibrariesAndNoSupervisorTheAnswerIsEmptyRatherThanAGuess()
    {
        // A bare media server somebody is running by hand. Inventing a path would create a library
        // pointing somewhere nobody asked for.
        Assert.Equal(
            string.Empty,
            RootFolderResolver.ForDownloads(new SharedSettings(), null, RootFolderResolver.LibraryKind.Movies));
    }

    [Fact]
    public void TheDownloadClientsAreToldAboutEveryFolderOfTheType()
    {
        // A title already sitting on the second drive has to be manageable, and an app that does
        // not know a folder reports the wrong free space for everything in it.
        var settings = Migrated();
        settings.Libraries[0].Paths.Add(@"D:\media\Movies");
        settings.Libraries.Add(new LibrarySettings
        {
            Name = "Archive",
            Type = LibraryTypes.Movies,
            Paths = { @"E:\archive\films" },
        });

        Assert.Equal(
            new[] { @"D:\media\Movies", @"E:\archive\films" },
            RootFolderResolver.AllLocal(settings, Runtime, RootFolderResolver.LibraryKind.Movies));
    }

    [Fact]
    public void AHiddenLibraryIsStillToldAbout()
    {
        // Hiding is presentation. A hidden library still imports and still federates.
        var settings = Migrated();
        settings.Libraries[0].Paths.Add(@"D:\media\Movies");
        settings.Libraries[0].Hidden = true;

        Assert.Contains(
            @"D:\media\Movies",
            RootFolderResolver.AllLocal(settings, Runtime, RootFolderResolver.LibraryKind.Movies));
    }

    [Fact]
    public void ARemoteOnlyLibraryHasNoLocalFolderToOffer()
    {
        // Recordings holds nothing but peers' pointers, so there is no folder of yours in it.
        var settings = new SharedSettings();
        settings.Libraries.Add(new LibrarySettings
        {
            Name = LibraryLayoutService.RecordingsLibrary,
            Type = LibraryTypes.Movies,
            Managed = false,
        });

        Assert.Equal(
            new[] { @"D:\data\media\Movies" },
            RootFolderResolver.AllLocal(settings, Runtime, RootFolderResolver.LibraryKind.Movies));
    }
}
