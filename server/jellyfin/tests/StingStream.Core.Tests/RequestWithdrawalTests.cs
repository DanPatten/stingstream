using System.Text.Json.Nodes;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The one decision withdrawing a request turns on: is this download finished or not?
/// </summary>
/// <remarks>
/// Everything else about a withdrawal is HTTP against Radarr or Sonarr, but this is the judgement
/// call, and it is the difference between deleting a half-downloaded file and deleting an episode
/// somebody can watch. Wrong in one direction it leaves rubbish on the disk; wrong in the other it
/// throws away a finished download nobody asked it to.
/// </remarks>
public class RequestWithdrawalTests
{
    [Fact]
    public void A_download_still_running_is_incomplete()
    {
        var row = new JsonObject
        {
            ["id"] = 7,
            ["status"] = "downloading",
            ["size"] = 8_000_000_000L,
            ["sizeleft"] = 3_000_000_000L,
            ["trackedDownloadState"] = "downloading",
        };

        Assert.True(RequestWithdrawal.IsIncomplete(row));
    }

    [Fact]
    public void Queued_and_paused_rows_are_incomplete_too()
    {
        foreach (var status in new[] { "queued", "paused", "delay", "warning" })
        {
            var row = new JsonObject
            {
                ["status"] = status,
                ["size"] = 8_000_000_000L,
                ["sizeleft"] = 8_000_000_000L,
            };

            Assert.True(RequestWithdrawal.IsIncomplete(row));
        }
    }

    [Fact]
    public void A_finished_download_says_so_three_different_ways()
    {
        // The arrs use all three and a row only has to say it once, so each on its own has to be
        // enough to keep the file.
        var byStatus = new JsonObject
        {
            ["status"] = "Completed",
            ["size"] = 8_000_000_000L,
            ["sizeleft"] = 4_000_000L,
        };
        var bySizeleft = new JsonObject
        {
            ["status"] = "downloading",
            ["size"] = 8_000_000_000L,
            ["sizeleft"] = 0L,
        };
        var byTrackedState = new JsonObject
        {
            ["status"] = "warning",
            ["size"] = 8_000_000_000L,
            ["sizeleft"] = 12_000L,
            ["trackedDownloadState"] = "importPending",
        };

        Assert.False(RequestWithdrawal.IsIncomplete(byStatus));
        Assert.False(RequestWithdrawal.IsIncomplete(bySizeleft));
        Assert.False(RequestWithdrawal.IsIncomplete(byTrackedState));
    }

    [Fact]
    public void A_row_that_says_nothing_useful_counts_as_incomplete()
    {
        // Being wrong this way round costs a partial file. The other way round costs an episode.
        // A row with no sizes at all is one an arr has only just accepted.
        Assert.True(RequestWithdrawal.IsIncomplete(new JsonObject { ["id"] = 1 }));
        Assert.True(RequestWithdrawal.IsIncomplete(new JsonObject
        {
            ["size"] = 0L,
            ["sizeleft"] = 0L,
        }));
    }

    [Fact]
    public void Sizes_are_read_whether_the_arr_sends_them_as_integers_or_not()
    {
        // Sonarr's queue serialises sizeleft as a JSON number that can arrive with a decimal point.
        var row = new JsonObject
        {
            ["status"] = "downloading",
            ["size"] = 8_000_000_000.0,
            ["sizeleft"] = 0.0,
        };

        Assert.False(RequestWithdrawal.IsIncomplete(row));
    }
}
