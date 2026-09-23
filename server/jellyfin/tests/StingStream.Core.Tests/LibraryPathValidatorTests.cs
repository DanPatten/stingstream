using System;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Whether a folder somebody typed is one this node can actually use.
/// </summary>
/// <remarks>
/// <para>
/// A root folder was free text that nothing checked, and the first thing to touch it was
/// <c>Directory.CreateDirectory</c> deep inside the arr sync, so a typo surfaced as a failed sync in
/// a status panel rather than as a message under the box it was typed into. Two of these rules are
/// not about typos at all: <see cref="AFolderInsideTheFederatedTreeIsRefused"/> stops the download
/// client being handed every peer's pointer file to rename and delete, and
/// <see cref="AFolderThatOverlapsAnotherLibraryIsRefused"/> is a correctness rule, because an item's
/// id comes from its path and one file under two libraries is a single item with two parents.
/// </para>
/// <para>
/// <b>Every path here is built, not written out.</b> The first rule the validator applies is
/// <c>Path.IsPathFullyQualified</c>, and <c>D:\media\Movies</c> is not fully qualified on Linux — so
/// a fixture written as a Windows literal made every case in this file assert
/// <c>path_not_absolute</c> on the Linux leg of CI while passing on Windows, which is the worst
/// shape a test can fail in: green where it was written, red where nobody was looking.
/// <see cref="Rooted"/> and <see cref="Elsewhere"/> give two absolute roots that are outside each
/// other on both platforms, which is all any of these rules need.
/// </para>
/// </remarks>
public class LibraryPathValidatorTests
{
    /// <summary>An absolute path under the root this node's own folders live on.</summary>
    private static string Rooted(string tail)
        => OperatingSystem.IsWindows()
            ? @"D:\" + tail.Replace('/', '\\')
            : "/srv/" + tail;

    /// <summary>An absolute path that is not under <see cref="Rooted"/> anything.</summary>
    private static string Elsewhere(string tail)
        => OperatingSystem.IsWindows()
            ? @"E:\" + tail.Replace('/', '\\')
            : "/mnt/" + tail;

    private static readonly string FederatedRoot = Rooted("data/federated");

    private static readonly PathsRuntime Runtime = new()
    {
        MediaMovies = Rooted("data/media/Movies"),
        MediaTv = Rooted("data/media/TV"),
        Federated = Rooted("data/federated"),
        Downloads = Rooted("data/downloads"),
        DownloadsTorrents = Rooted("data/downloads/torrents"),
        DownloadsUsenet = Rooted("data/downloads/usenet"),
        Logs = Rooted("data/logs"),
    };

    private static SharedSettings Settings()
    {
        var settings = new SharedSettings();
        LibraryMigration.Apply(settings);
        settings.Libraries[0].Paths.Add(Rooted("media/Movies"));
        settings.Libraries[1].Paths.Add(Rooted("media/TV"));
        return settings;
    }

    private static LibraryProblem? Check(string? path, string? excludeId = null)
        => LibraryPathValidator.Validate(path, Settings(), Runtime, FederatedRoot, excludeId);

    [Fact]
    public void AGoodFolderIsAccepted() => Assert.Null(Check(Elsewhere("archive/films")));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void AnEmptyFolderIsRefused(string? path)
        => Assert.Equal("path_required", Check(path)!.Code);

    [Theory]
    [InlineData(@"media\Movies")]
    [InlineData(@"..\Movies")]
    [InlineData("media/Movies")]
    [InlineData("../Movies")]
    public void ARelativeFolderIsRefused(string path)
    {
        // It would resolve against whatever the server's working directory happens to be, which is
        // not something the person typing it can see or predict. Both separators, because a
        // backslash is an ordinary filename character on Linux and a separator on Windows, and
        // neither spelling is absolute on either.
        Assert.Equal("path_not_absolute", Check(path)!.Code);
    }

    [Theory]
    [InlineData("data/federated")]
    [InlineData("data/federated/movies")]
    [InlineData("data/federated/movies/deeper")]
    [InlineData("data")]
    public void AFolderInsideTheFederatedTreeIsRefused(string tail)
    {
        // Including a parent of it: a films folder at the data directory has the download client
        // managing everything underneath, pointer tree included.
        Assert.Equal("path_is_federated", Check(Rooted(tail))!.Code);
    }

    [Fact]
    public void AFolderMerelySharingAPrefixIsFine()
    {
        // The classic bug in this shape. "dataX" starts with "data" as a string and is not inside
        // it, which is why the comparison is segment by segment.
        Assert.Null(Check(Rooted("dataX/films")));
    }

    [Theory]
    [InlineData("data/downloads")]
    [InlineData("data/downloads/torrents/films")]
    [InlineData("data/logs")]
    public void AFolderStingStreamRunsOnIsRefused(string tail)
        => Assert.Equal("path_is_reserved", Check(Rooted(tail))!.Code);

    [Fact]
    public void AFolderAnotherLibraryAlreadyUsesIsRefused()
    {
        var problem = Check(Rooted("media/Movies"))!;

        Assert.Equal("path_duplicate", problem.Code);
        Assert.Equal(LibraryLayoutService.MoviesLibrary, problem.ConflictsWith);
    }

    [Theory]
    [InlineData("media")]
    [InlineData("media/Movies/4k")]
    public void AFolderThatOverlapsAnotherLibraryIsRefused(string tail)
    {
        // Both directions: a parent of an existing library, and a child of one.
        Assert.Equal("path_overlaps", Check(Rooted(tail))!.Code);
    }

    [Fact]
    public void ALibraryDoesNotCollideWithItself()
    {
        // Editing Movies and leaving its folder alone must not report that Movies is using it.
        var settings = Settings();

        Assert.Null(LibraryPathValidator.Validate(
            Rooted("media/Movies"),
            settings,
            Runtime,
            FederatedRoot,
            settings.Libraries[0].Id));
    }

    [Fact]
    public void AFolderThatDoesNotExistYetIsAWarningRatherThanARefusal()
    {
        // Somebody naming a folder they are about to create is doing something reasonable; the
        // screen should say what will happen rather than block them.
        Assert.Null(Check(Elsewhere("not-yet/films")));

        var warnings = LibraryPathValidator.Warnings(Elsewhere("not-yet/films"), _ => false);

        Assert.Single(warnings);
        Assert.Contains("will be created", warnings[0], StringComparison.Ordinal);
    }

    [Fact]
    public void AnExistingFolderHasNothingToWarnAbout()
        => Assert.Empty(LibraryPathValidator.Warnings(Elsewhere("films"), _ => true));

    [Fact]
    public void SeveralGoodFoldersAreAccepted()
    {
        var folders = new[] { Elsewhere("kids/one"), Elsewhere("kids/two") };

        Assert.Null(LibraryPathValidator.ValidateSet(
            folders, folders, "Kids TV", Settings(), Runtime, FederatedRoot));
    }

    [Fact]
    public void TwoFoldersInOneLibraryThatOverlapAreRefused()
    {
        // One file reachable through both locations is one item with two parents, whether the two
        // locations belong to two libraries or to one.
        var folders = new[] { Elsewhere("kids"), Elsewhere("kids/two") };

        var problem = LibraryPathValidator.ValidateSet(
            folders, folders, "Kids TV", Settings(), Runtime, FederatedRoot)!;

        Assert.Equal("path_overlaps", problem.Code);
        Assert.Equal("Kids TV", problem.ConflictsWith);
    }

    [Fact]
    public void ANewFolderIsStillCheckedAgainstOtherLibraries()
    {
        var folders = new[] { Elsewhere("kids/one"), Rooted("media/Movies") };

        var problem = LibraryPathValidator.ValidateSet(
            new[] { Rooted("media/Movies") }, folders, "Kids TV", Settings(), Runtime, FederatedRoot)!;

        Assert.Equal("path_duplicate", problem.Code);
        Assert.Equal(LibraryLayoutService.MoviesLibrary, problem.ConflictsWith);
    }

    // --- v0.2.0 Windows report: "couldn't add a 2nd folder, and it said it overlapped when it 100%
    // did not". The refusal named a library but not a folder, so there was no way to check it.

    [Fact]
    public void AnOverlapNamesTheFolderItCollidesWith()
    {
        var problem = Check(Rooted("media"))!;

        Assert.Equal("path_overlaps", problem.Code);
        Assert.Equal(Rooted("media/Movies"), problem.ConflictingPath);
        Assert.Contains(Rooted("media/Movies"), problem.Error, StringComparison.Ordinal);
        Assert.Contains(LibraryLayoutService.MoviesLibrary, problem.Error, StringComparison.Ordinal);
    }

    [Fact]
    public void AFolderInsideAnotherLibrarysFolderSaysSo()
    {
        var problem = Check(Rooted("media/Movies/4k"))!;

        Assert.Equal(Rooted("media/Movies"), problem.ConflictingPath);
        Assert.Contains("inside", problem.Error, StringComparison.Ordinal);
    }

    [Fact]
    public void TheSameFolderSpelledWithADotIsADuplicateNotAnOverlap()
    {
        var problem = Check(Rooted("media/Movies/."))!;

        Assert.Equal("path_duplicate", problem.Code);
        Assert.Equal(Rooted("media/Movies"), problem.ConflictingPath);
    }

    [Fact]
    public void AnInLibraryOverlapNamesTheFolderItCollidesWith()
    {
        var all = new[] { Elsewhere("kids"), Elsewhere("kids/two") };

        var problem = LibraryPathValidator.ValidateSet(
            new[] { Elsewhere("kids/two") }, all, "Kids TV", Settings(), Runtime, FederatedRoot)!;

        Assert.Equal("path_overlaps", problem.Code);
        Assert.Equal(Elsewhere("kids"), problem.ConflictingPath);
        Assert.Contains(Elsewhere("kids"), problem.Error, StringComparison.Ordinal);
    }

    [Fact]
    public void TwoOldFoldersThatOverlapDoNotBlockANewUnrelatedOne()
    {
        // The library already held a pair an older build let through. Adding a third folder that
        // touches neither used to be refused as "overlapping", about a folder the reader never
        // chose, which is exactly what "it said it overlapped when it did not" looks like.
        var all = new[] { Elsewhere("kids"), Elsewhere("kids/two"), Elsewhere("cartoons") };

        Assert.Null(LibraryPathValidator.ValidateSet(
            new[] { Elsewhere("cartoons") }, all, "Kids TV", Settings(), Runtime, FederatedRoot));
    }

    [Fact]
    public void ASecondFolderOnALibraryFollowingTheDefaultIsAccepted()
    {
        // A fresh install: Movies has no folder of its own, so the screen shows (and sends back)
        // the data directory's default beside the new one.
        var settings = new SharedSettings();
        LibraryMigration.Apply(settings);
        var movies = settings.Libraries[0];
        var all = new[] { Runtime.MediaMovies, Elsewhere("films") };

        Assert.Null(LibraryPathValidator.ValidateSet(
            new[] { Elsewhere("films") }, all, movies.Name, settings, Runtime, FederatedRoot, movies.Id));
    }

    [Fact]
    public void AFolderInAnotherLibraryBesideAnExistingOneIsAccepted()
    {
        // Movies holds media/Movies; a new library next to it, not inside it.
        Assert.Null(LibraryPathValidator.ValidateSet(
            new[] { Rooted("media/Movies 4K") }, new[] { Rooted("media/Movies 4K") }, "4K", Settings(), Runtime, FederatedRoot));
    }

    [Theory]
    [InlineData(@"d:\MEDIA\movies", "path_duplicate")]
    [InlineData(@"D:\media\Movies\", "path_duplicate")]
    [InlineData("D:/media/Movies", "path_duplicate")]
    [InlineData(@"D:\media\Movies2", null)]
    [InlineData(@"D:\media\Movies 4K", null)]
    [InlineData(@"D:\Media2", null)]
    [InlineData(@"E:\media\Movies", null)]
    [InlineData(@"\\nas\media\Movies", null)]
    [InlineData(@"D:\", "path_is_federated")]
    [InlineData(@"d:/media/movies/Action", "path_overlaps")]
    public void WindowsSpellingsCompareAsWindowsDoes(string path, string? code)
    {
        // Only meaningful where these are absolute paths at all.
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        Assert.Equal(code, Check(path)?.Code);
    }

    [Theory]
    [InlineData(@"Z:\Movies", "drive_not_found")]
    [InlineData(@"z:/Movies/Action", "drive_not_found")]
    [InlineData(@"D:\Movies", null)]
    [InlineData(@"\\nas\media\Movies", null)]
    [InlineData("/mnt/media/Movies", null)]
    public void AFolderOnADriveThisServerCannotSeeIsRefusedByName(string path, string? code)
    {
        // Dan's beta runs as a Windows service, and a drive letter mapped in somebody's sign-in
        // session does not exist for a service at all. The write probe used to report that as
        // "Could not find a part of the path", which does not say what to do.
        var problem = LibraryPathValidator.MissingDrive(
            path, root => root[0] != 'Z');

        Assert.Equal(code, problem?.Code);
        if (problem is not null)
        {
            Assert.Contains("Z:", problem.Error, StringComparison.Ordinal);
            Assert.Contains(@"\\server\share", problem.Error, StringComparison.Ordinal);
            Assert.DoesNotContain("\u2014", problem.Error, StringComparison.Ordinal);
        }
    }
}
