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
}
