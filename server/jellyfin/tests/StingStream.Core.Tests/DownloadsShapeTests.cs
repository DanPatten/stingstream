using System.Text.Json.Nodes;
using StingStream.Core.Arr;
using StingStream.Core.Downloads;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Turning the arrs' queue rows into one list of downloads.
/// </summary>
/// <remarks>
/// Every download is in a client the user runs, so a queue row is all StingStream sees of it. The
/// cases below are the ones where a row either tells the truth on a Downloads screen or quietly
/// lies: a finished payload that has not been imported, an import blocker hidden in
/// <c>statusMessages</c>, and a size that arrives as something other than a long.
/// </remarks>
public class DownloadsShapeTests
{
    private static JsonObject Row(string status, long size, long left, string? timeLeft = null) => new()
    {
        ["id"] = 7,
        ["title"] = "Big Buck Bunny (2008) 1080p",
        ["status"] = status,
        ["size"] = size,
        ["sizeleft"] = left,
        ["timeleft"] = timeLeft,
        ["downloadId"] = "ABCDEF0123456789",
    };

    [Fact]
    public void A_downloading_row_keeps_its_progress_and_time_left()
    {
        var item = DownloadsService.FromQueueRow("radarr", Row("downloading", 1_000_000_000, 750_000_000, "00:02:30"))!;

        Assert.Equal("radarr:7", item.Id);
        Assert.Equal(DownloadEngines.Radarr, item.Engine);
        Assert.True(item.Ephemeral);
        Assert.Equal(DownloadStates.Downloading, item.State);
        Assert.Equal(0.25, item.Progress!.Value, 3);
        Assert.Equal(150, item.Eta);
        Assert.Equal(5_000_000, item.DownloadRate);
        Assert.True(item.CanRemove);
    }

    [Fact]
    public void A_finished_payload_the_arr_has_not_imported_reads_as_importing()
    {
        var item = DownloadsService.FromQueueRow("sonarr", Row("completed", 1000, 0))!;

        Assert.Equal(DownloadStates.Importing, item.State);
        Assert.Null(item.Eta);
    }

    [Fact]
    public void An_import_blocker_in_status_messages_is_the_error()
    {
        var row = Row("completed", 1000, 0);
        row["statusMessages"] = new JsonArray
        {
            new JsonObject
            {
                ["title"] = "x",
                ["messages"] = new JsonArray { "No files found are eligible for import" },
            },
        };

        var item = DownloadsService.FromQueueRow("radarr", row)!;

        Assert.Equal(DownloadStates.Failed, item.State);
        Assert.Equal("No files found are eligible for import", item.ErrorMessage);
    }

    [Fact]
    public void A_row_with_no_queue_id_is_skipped()
    {
        var row = Row("downloading", 1000, 500);
        row.Remove("id");
        Assert.Null(DownloadsService.FromQueueRow("radarr", row));
    }

    [Fact]
    public void Numbers_are_read_whatever_backs_them()
    {
        Assert.Equal(5, JsonNumber.Read(JsonValue.Create(5)));
        Assert.Equal(5_000_000_000, JsonNumber.Read(JsonValue.Create(5_000_000_000L)));
        Assert.Equal(12, JsonNumber.Read(JsonValue.Create("12")));
        Assert.Equal(3, JsonNumber.Read(JsonNode.Parse("3.9")));
        Assert.Null(JsonNumber.Read(null));
    }

    [Fact]
    public void An_eta_needs_both_a_rate_and_something_left_to_fetch()
    {
        Assert.Null(DownloadsService.Eta(1000, 0));
        Assert.Null(DownloadsService.Eta(0, 1000));
        Assert.Equal(10, DownloadsService.Eta(10_000, 1_000));
    }

    [Fact]
    public void The_retired_torrent_shim_is_recognised_by_where_it_points()
    {
        Assert.True(OmniarrSyncService.IsRetiredBuiltIn(Client("QBittorrent", "StingStream Torrents", "127.0.0.1", "/jellyfin/stingstream/qbt")));
        Assert.True(OmniarrSyncService.IsRetiredBuiltIn(Client("QBittorrent", "Renamed by hand", "localhost", "/stingstream/qbt/")));

        // A real qBittorrent on the same machine is the user's, whatever it is called.
        Assert.False(OmniarrSyncService.IsRetiredBuiltIn(Client("QBittorrent", "StingStream Torrents", "127.0.0.1", string.Empty)));
        Assert.False(OmniarrSyncService.IsRetiredBuiltIn(Client("QBittorrent", "Seedbox", "10.0.0.5", "/stingstream/qbt")));
    }

    [Fact]
    public void The_retired_nzbget_is_recognised_by_its_name_on_loopback()
    {
        Assert.True(OmniarrSyncService.IsRetiredBuiltIn(Client("Nzbget", "StingStream Usenet", "127.0.0.1", string.Empty)));
        Assert.False(OmniarrSyncService.IsRetiredBuiltIn(Client("Nzbget", "My NZBGet", "127.0.0.1", string.Empty)));
        Assert.False(OmniarrSyncService.IsRetiredBuiltIn(Client("Nzbget", "StingStream Usenet", "nas.local", string.Empty)));
        Assert.False(OmniarrSyncService.IsRetiredBuiltIn(Client("Sabnzbd", "StingStream Usenet", "127.0.0.1", string.Empty)));
    }

    private static JsonObject Client(string implementation, string name, string host, string urlBase) => new()
    {
        ["implementation"] = implementation,
        ["name"] = name,
        ["fields"] = new JsonArray
        {
            new JsonObject { ["name"] = "host", ["value"] = host },
            new JsonObject { ["name"] = "urlBase", ["value"] = urlBase },
        },
    };
}
