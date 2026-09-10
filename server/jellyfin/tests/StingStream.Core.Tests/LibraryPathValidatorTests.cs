using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Whether a folder somebody typed is one this node can actually use.
/// </summary>
/// <remarks>
/// A root folder was free text that nothing checked, and the first thing to touch it was
/// <c>Directory.CreateDirectory</c> deep inside the arr sync, so a typo surfaced as a failed sync in
/// a status panel rather than as a message under the box it was typed into. Two of these rules are
/// not about typos at all: <see cref="AFolderInsideTheFederatedTreeIsRefused"/> stops the download
/// client being handed every peer's pointer file to rename and delete, and
/// <see cref="AFolderThatOverlapsAnotherLibraryIsRefused"/> is a correctness rule, because an item's
/// id comes from its path and one file under two libraries is a single item with two parents.
/// </remarks>
public class LibraryPathValidatorTests
{
    private const string FederatedRoot = @"D:\data\federated";

    private static readonly PathsRuntime Runtime = new()
    {
        MediaMovies = @"D:\data\media\Movies",
        MediaTv = @"D:\data\media\TV",
        Federated = FederatedRoot,
        Downloads = @"D:\data\downloads",
        DownloadsTorrents = @"D:\data\downloads\torrents",
        DownloadsUsenet = @"D:\data\downloads\usenet",
        Logs = @"D:\data\logs",
    };

    private static SharedSettings Settings()
    {
        var settings = new SharedSettings();
        LibraryMigration.Apply(settings);
        settings.Libraries[0].Paths.Add(@"D:\media\Movies");
        settings.Libraries[1].Paths.Add(@"D:\media\TV");
        return settings;
    }

    private static LibraryProblem? Check(string? path, string? excludeId = null)
        => LibraryPathValidator.Validate(path, Settings(), Runtime, FederatedRoot, excludeId);

    [Fact]
    public void AGoodFolderIsAccepted() => Assert.Null(Check(@"E:\archive\films"));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void AnEmptyFolderIsRefused(string? path)
        => Assert.Equal("path_required", Check(path)!.Code);

    [Theory]
    [InlineData(@"media\Movies")]
    [InlineData(@"..\Movies")]
    public void ARelativeFolderIsRefused(string path)
    {
        // It would resolve against whatever the server's working directory happens to be, which is
        // not something the person typing it can see or predict.
        Assert.Equal("path_not_absolute", Check(path)!.Code);
    }

    [Theory]
    [InlineData(@"D:\data\federated")]
    [InlineData(@"D:\data\federated\movies")]
    [InlineData(@"D:\data\federated\movies\deeper")]
    [InlineData(@"D:\data")]
    public void AFolderInsideTheFederatedTreeIsRefused(string path)
    {
        // Including a parent of it: a films folder at D:\data has the download client managing
        // everything underneath, pointer tree included.
        Assert.Equal("path_is_federated", Check(path)!.Code);
    }

    [Fact]
    public void AFolderMerelySharingAPrefixIsFine()
    {
        // The classic bug in this shape. "D:\dataX" starts with "D:\data" as a string and is not
        // inside it, which is why the comparison is segment by segment.
        Assert.Null(Check(@"D:\dataX\films"));
    }

    [Theory]
    [InlineData(@"D:\data\downloads")]
    [InlineData(@"D:\data\downloads\torrents\films")]
    [InlineData(@"D:\data\logs")]
    public void AFolderStingStreamRunsOnIsRefused(string path)
        => Assert.Equal("path_is_reserved", Check(path)!.Code);

    [Fact]
    public void AFolderAnotherLibraryAlreadyUsesIsRefused()
    {
        var problem = Check(@"D:\media\Movies")!;

        Assert.Equal("path_duplicate", problem.Code);
        Assert.Equal(LibraryLayoutService.MoviesLibrary, problem.ConflictsWith);
    }

    [Theory]
    [InlineData(@"D:\media")]
    [InlineData(@"D:\media\Movies\4k")]
    public void AFolderThatOverlapsAnotherLibraryIsRefused(string path)
    {
        // Both directions: a parent of an existing library, and a child of one.
        Assert.Equal("path_overlaps", Check(path)!.Code);
    }

    [Fact]
    public void ALibraryDoesNotCollideWithItself()
    {
        // Editing Movies and leaving its folder alone must not report that Movies is using it.
        var settings = Settings();

        Assert.Null(LibraryPathValidator.Validate(
            @"D:\media\Movies",
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
        Assert.Null(Check(@"E:\not-yet\films"));

        var warnings = LibraryPathValidator.Warnings(@"E:\not-yet\films", _ => false);

        Assert.Single(warnings);
        Assert.Contains("will be created", warnings[0], System.StringComparison.Ordinal);
    }

    [Fact]
    public void AnExistingFolderHasNothingToWarnAbout()
        => Assert.Empty(LibraryPathValidator.Warnings(@"E:\films", _ => true));
}
