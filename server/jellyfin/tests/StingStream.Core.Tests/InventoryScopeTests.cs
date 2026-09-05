using System;
using System.IO;
using System.Linq;
using StingStream.Core.Federated;
using StingStream.Core.Inventory;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// What a node may advertise to its group as "I hold this".
/// </summary>
/// <remarks>
/// The regression these guard is the one M5's phone found (<c>docs/APP-RELEASE.md</c> §11):
/// <c>/items/{id}/sources</c> named a holder, the phone dialled it, and the holder answered 404
/// with <c>failover_candidates=0</c>. The holder was this node, and the reason it claimed a film it
/// did not have is that <see cref="InventoryService.RebuildAllAsync"/> queries every library on the
/// server — including <c>Shared Movies</c>, where the federated materializer writes one
/// <c>.strm</c> per peer that holds a title.
///
/// The loop that follows is worth remembering, because it is why the symptom was a 404 rather than
/// sixty bytes of URL where a film should be: once the pointer entered the inventory, its item key
/// appeared in <see cref="IInventoryService.Keys"/>, and the next materialization pass read that as
/// "this node holds it locally, the local file wins" and deleted its own pointer file. The
/// inventory row outlived the file it named.
/// </remarks>
public class InventoryScopeTests
{
    private static readonly string _root = Path.Combine(
        Path.GetTempPath(), "stingstream-test", "data", "federated");

    private static string Federated(params string[] parts)
        => Path.Combine(new[] { _root }.Concat(parts).ToArray());

    [Fact]
    public void A_real_file_in_a_real_library_is_inventory()
    {
        Assert.True(InventoryService.IsServableLocally(
            Path.Combine("E:", "media", "Movies", "Sita Sings the Blues (2008)", "film.mkv"),
            new[] { "public domain" },
            _root));
    }

    [Fact]
    public void A_federated_pointer_is_not_inventory()
    {
        var pointer = Federated(
            "movies",
            "Sita Sings the Blues (2008)",
            "Sita Sings the Blues (2008) - loft 1080p.strm");

        Assert.False(
            InventoryService.IsServableLocally(pointer, new[] { NfoWriter.FederatedTag }, _root),
            "a pointer to a peer's file is not a file this node can serve");
    }

    /// <summary>
    /// Each of the three tests stands on its own, so a pointer that slipped past one is still
    /// caught: the <c>.nfo</c> may not have been read yet (no tag), and the federated root is
    /// unknown on a Jellyfin the supervisor did not start (no root).
    /// </summary>
    [Fact]
    public void Each_of_the_three_tests_catches_a_pointer_on_its_own()
    {
        // Extension only: no tag, no root.
        Assert.False(InventoryService.IsServableLocally(
            Path.Combine("E:", "somewhere", "else", "pointer.strm"), Array.Empty<string>(), null));

        // Tag only: not a .strm, not under the root.
        Assert.False(InventoryService.IsServableLocally(
            Path.Combine("E:", "somewhere", "else", "film.mkv"),
            new[] { "hd", NfoWriter.FederatedTag },
            null));

        // Root only: not a .strm, untagged, but living where only pointers live.
        Assert.False(InventoryService.IsServableLocally(
            Federated("tv", "Some Show", "Season 01", "Some Show - S01E01 - loft.mkv"),
            Array.Empty<string>(),
            _root));
    }

    /// <summary>
    /// The rule is "a file this node can serve", not "not in the federated library". A
    /// <c>.strm</c> anyone wrote — a debrid user's own library, say — is sixty bytes of URL, and
    /// handing that to a peer that asked for a film is wrong however it got there.
    /// </summary>
    [Fact]
    public void A_pointer_file_is_excluded_wherever_it_came_from()
    {
        Assert.False(InventoryService.IsServableLocally(
            Path.Combine("E:", "media", "Movies", "Some Film (2020)", "Some Film (2020).STRM"),
            Array.Empty<string>(),
            _root));
    }

    [Fact]
    public void A_path_that_merely_starts_with_the_root_is_not_under_it()
    {
        // `…/federated-backup/x.mkv` shares a prefix with `…/federated` and is a different tree.
        Assert.True(InventoryService.IsServableLocally(
            _root + "-backup" + Path.DirectorySeparatorChar + "x.mkv",
            Array.Empty<string>(),
            _root));
    }

    [Fact]
    public void An_item_with_no_path_is_nothing_to_offer_a_peer()
    {
        Assert.False(InventoryService.IsServableLocally(null, Array.Empty<string>(), _root));
        Assert.False(InventoryService.IsServableLocally("   ", Array.Empty<string>(), _root));
    }

    [Fact]
    public void Absent_tags_and_an_unknown_root_do_not_throw()
    {
        Assert.True(InventoryService.IsServableLocally(
            Path.Combine("E:", "media", "Movies", "film.mkv"), null, null));
    }
}
