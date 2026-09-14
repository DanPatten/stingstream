using System.IO;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The folder the Libraries screen shows for Recordings has to be the one recordings actually go to.
/// </summary>
public class RecordingFolderTests
{
    [Fact]
    public void AConfiguredFolderWins()
    {
        Assert.Equal(@"E:\dvr", RecordingFolder.Resolve(@"E:\dvr", @"D:\data"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NothingConfiguredFollowsTheMediaServersOwnDefault(string? configured)
    {
        Assert.Equal(
            Path.Combine(@"D:\data", "livetv", "recordings"),
            RecordingFolder.Resolve(configured, @"D:\data"));
    }

    [Fact]
    public void NoDataDirectoryAndNothingConfiguredIsEmpty()
    {
        Assert.Equal(string.Empty, RecordingFolder.Resolve(null, null));
    }
}
