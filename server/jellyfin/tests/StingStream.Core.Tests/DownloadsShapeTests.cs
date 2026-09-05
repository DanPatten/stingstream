using System.Text.Json.Nodes;
using MonoTorrent.Client;
using StingStream.Core.Downloads;
using StingStream.Core.Torrents;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Turning three engines' idea of a download into one.
/// </summary>
/// <remarks>
/// The shaping is where a unified list either tells the truth or quietly lies. The cases below are
/// the ones that were wrong the first time: an NZB's split 64-bit sizes, a seeding torrent that is
/// finished from the user's point of view but "downloading" from the engine's, and an ETA computed
/// from a rate of zero.
/// </remarks>
public class DownloadsShapeTests
{
    private static TorrentView Torrent(TorrentState state, double progress, bool complete = false)
        => new()
        {
            Hash = "ABCDEF0123456789",
            Name = "Big Buck Bunny (2008) 1080p",
            Size = 1_000_000_000,
            Progress = progress,
            State = state,
            Complete = complete,
            Category = "radarr",
            DownloadRate = 5_000_000,
            UploadRate = 1_000,
            SavePath = "/downloads/torrents/radarr",
        };

    [Fact]
    public void A_downloading_torrent_keeps_its_rate_progress_and_eta()
    {
        var item = DownloadsService.FromTorrent(Torrent(TorrentState.Downloading, 0.25));

        Assert.Equal("torrent:ABCDEF0123456789", item.Id);
        Assert.Equal(DownloadEngines.Torrent, item.Engine);
        Assert.Equal(DownloadStates.Downloading, item.State);
        Assert.Equal(0.25, item.Progress);
        Assert.Equal(250_000_000, item.DownloadedBytes);
        Assert.Equal(750_000_000, item.RemainingBytes);
        Assert.Equal(150, item.Eta);
        Assert.True(item.CanPause);
        Assert.False(item.CanResume);
    }

    [Fact]
    public void A_seeding_torrent_reads_as_completed_but_can_still_be_paused()
    {
        // MonoTorrent says "Seeding" for a torrent whose payload is entirely on disk. To a Downloads
        // screen that is finished, and showing it as an active download would make the count wrong
        // and the aggregate rate meaningless — but it is still running, and pausing it stops the
        // upload, which is a thing somebody on a metered line very much wants to do. The state word
        // and the available action are answering two different questions.
        var item = DownloadsService.FromTorrent(Torrent(TorrentState.Seeding, 1.0, complete: true));
        Assert.Equal(DownloadStates.Completed, item.State);
        Assert.True(item.CanPause);
        Assert.False(item.CanResume);
    }

    [Fact]
    public void A_torrent_in_error_offers_nothing_but_removal()
    {
        var item = DownloadsService.FromTorrent(Torrent(TorrentState.Error, 0.3));
        Assert.Equal(DownloadStates.Failed, item.State);
        Assert.False(item.CanPause);
        Assert.False(item.CanResume);
        Assert.True(item.CanRemove);
    }

    [Fact]
    public void A_paused_torrent_offers_resume_and_nothing_else()
    {
        var item = DownloadsService.FromTorrent(Torrent(TorrentState.Paused, 0.4));
        Assert.Equal(DownloadStates.Paused, item.State);
        Assert.False(item.CanPause);
        Assert.True(item.CanResume);
        Assert.True(item.CanRemove);
    }

    [Fact]
    public void An_nzb_size_is_reassembled_from_its_two_halves()
    {
        // NZBGet splits every 64-bit number into Lo and Hi 32-bit fields. Reading the MB field
        // instead -- the obvious shortcut -- rounds a 6 GB download to the nearest megabyte, and
        // reading Lo alone silently wraps anything over 4 GB.
        const long size = 6L * 1024 * 1024 * 1024;
        const long remaining = 2L * 1024 * 1024 * 1024;
        var group = new JsonObject
        {
            ["NZBID"] = 42,
            ["NZBName"] = "Some.Release.1080p",
            ["Category"] = "movies",
            ["Status"] = "DOWNLOADING",
            ["FileSizeLo"] = (long)(uint)(size & 0xFFFFFFFF),
            ["FileSizeHi"] = size >> 32,
            ["RemainingSizeLo"] = (long)(uint)(remaining & 0xFFFFFFFF),
            ["RemainingSizeHi"] = remaining >> 32,
            ["DownloadedSizeLo"] = 0,
            ["DownloadedSizeHi"] = 0,
            ["DownloadRate"] = 10_000_000,
        };

        var item = DownloadsService.FromNzb(group);

        Assert.Equal("usenet:42", item.Id);
        Assert.Equal(size, item.SizeBytes);
        Assert.Equal(remaining, item.RemainingBytes);
        // No DownloadedSize reported, so it is inferred rather than shown as zero.
        Assert.Equal(size - remaining, item.DownloadedBytes);
        Assert.Equal(DownloadStates.Downloading, item.State);
        Assert.True(item.CanPause);
    }

    [Theory]
    [InlineData("PAUSED", DownloadStates.Paused)]
    [InlineData("QUEUED", DownloadStates.Queued)]
    [InlineData("UNPACKING", DownloadStates.Importing)]
    [InlineData("REPAIRING", DownloadStates.Importing)]
    [InlineData("MOVING", DownloadStates.Importing)]
    public void Every_nzbget_post_processing_state_reads_as_importing(string status, string expected)
    {
        var group = new JsonObject
        {
            ["NZBID"] = 1,
            ["Status"] = status,
            ["FileSizeLo"] = 1000,
            ["RemainingSizeLo"] = 0,
        };
        var item = DownloadsService.FromNzb(group);
        Assert.Equal(expected, item.State);
        // The engine's own word survives, because "UNPACKING" is more use than "importing" when
        // somebody is asking why a download has been at 100% for ten minutes.
        Assert.Equal(status, item.StateDetail);
    }

    [Fact]
    public void An_eta_needs_both_a_rate_and_something_left_to_fetch()
    {
        Assert.Null(DownloadsService.Eta(1000, 0));
        Assert.Null(DownloadsService.Eta(0, 1000));
        Assert.Equal(10, DownloadsService.Eta(10_000, 1_000));
    }
}
