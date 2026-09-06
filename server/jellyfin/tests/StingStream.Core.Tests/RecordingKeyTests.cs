using System;
using MediaBrowser.Controller.Entities;
using StingStream.Core.Inventory;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// When a recording may be given a name the whole group will use.
/// </summary>
/// <remarks>
/// <para>
/// An item key is an *identity*: two nodes holding the same broadcast produce the same one, and a
/// peer writes it into a <c>.strm</c> and fetches by it. A key that changes is therefore not a
/// slightly worse key, it is a broken pointer on every node that materialized the first one — the
/// M5 404 (<c>docs/APP-RELEASE.md</c> §11) reached by a different road.
/// </para>
/// <para>
/// <see cref="InventoryService.BuildRecordingKey"/> stamps the broadcast instant from the air date,
/// falling back to when the file arrived on this node. The fallback is deliberate — a recording
/// whose EPG gave no air date should federate without deduplicating rather than not federate — but
/// it must only be reached once we know no air date is coming. `tools/e2e-m7.ps1` found the
/// difference the hard way: node A materialized `Gardeners World - 2026-09-06 - loft.strm` from a
/// key stamped with the file's arrival, and playing it answered 404 the moment node B's metadata
/// pass re-published the same file under its real air date of 2026-09-05.
/// </para>
/// </remarks>
public class RecordingKeyTests
{
    private static readonly DateTime _aired = new(2026, 9, 5, 19, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime _arrived = new(2026, 9, 6, 22, 41, 0, DateTimeKind.Utc);

    [Fact]
    public void The_air_date_names_the_broadcast_so_two_nodes_agree()
    {
        var item = new Video
        {
            Name = "Gardeners World",
            PremiereDate = _aired,
            DateCreated = _arrived,
        };

        Assert.Equal(
            "recording:gardeners-world:20260905T1900",
            InventoryService.BuildRecordingKey(item));
    }

    [Fact]
    public void A_recording_with_no_air_date_yet_has_no_name_yet()
    {
        var item = new Video
        {
            Name = "Gardeners World",
            DateCreated = _arrived,
        };

        Assert.Null(
            InventoryService.BuildRecordingKey(item));
    }

    /// <summary>
    /// The case the fallback was written for: refreshed, and the EPG still gave nothing. Now the
    /// answer is settled, so this node names it after its own copy and the recording federates
    /// without deduplicating — which beats not federating.
    /// </summary>
    [Fact]
    public void A_refreshed_recording_the_epg_never_named_falls_back_to_when_it_arrived()
    {
        var item = new Video
        {
            Name = "Gardeners World",
            DateCreated = _arrived,
            DateLastRefreshed = new DateTime(2026, 9, 6, 22, 45, 0, DateTimeKind.Utc),
        };

        Assert.Equal(
            "recording:gardeners-world:20260906T2241",
            InventoryService.BuildRecordingKey(item));
    }

    [Fact]
    public void A_recording_with_no_name_at_all_has_no_key()
    {
        Assert.Null(InventoryService.BuildRecordingKey(new Video
        {
            Name = string.Empty,
            PremiereDate = _aired,
        }));
    }
}
