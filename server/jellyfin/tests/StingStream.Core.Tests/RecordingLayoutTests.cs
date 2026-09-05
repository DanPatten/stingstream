using System.Collections.Generic;
using StingStream.Core.Federated;
using StingStream.Core.Mesh;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Where a federated DVR recording lands, and why it is not in Shared Movies.
/// </summary>
/// <remarks>
/// <para>
/// A recording whose EPG supplied provider ids is not any of this: it gets an ordinary
/// <c>movie:</c> or <c>episode:</c> key, materialises beside every other copy of that title, and
/// dedupes and fails over against a downloaded one. That is the better outcome and it needs no code
/// at all — it falls out of `BuildItemKey` finding what it needs.
/// </para>
/// <para>
/// These cover the other case: a recording the providers could not name, which is what XMLTV
/// listings usually produce. It has no year to agree on and no <c>SxxEyy</c> to parse, so neither
/// existing layout groups it correctly, and forcing one would produce items that silently fail to
/// group.
/// </para>
/// </remarks>
public class RecordingLayoutTests
{
    private static MeshIndexEntry Entry(string itemKey, string? series, string title) => new()
    {
        Node = "abcdef0123456789",
        NodeName = "attic",
        Online = true,
        ItemKey = itemKey,
        Metadata = new MeshMetadata
        {
            Title = title,
            SeriesName = series,
        },
    };

    [Fact]
    public void A_recording_key_is_recognised_and_a_matched_title_is_not()
    {
        Assert.True(FederatedLayout.IsRecording("recording:gardeners-world:20260905T1900"));
        Assert.False(FederatedLayout.IsRecording("movie:tmdb:16205"));
        Assert.False(FederatedLayout.IsRecording("episode:tvdb:73739:s01e01"));
        Assert.False(FederatedLayout.IsRecording(null));
    }

    /// <summary>
    /// Every broadcast of one programme shares a folder, the way every version of a film does — so
    /// the library reads as a list of programmes rather than a list of timestamps.
    /// </summary>
    [Fact]
    public void Every_broadcast_of_one_programme_shares_a_folder()
    {
        var monday = Entry("recording:gardeners-world:20260905T1900", "Gardeners' World", "Episode 12");
        var friday = Entry("recording:gardeners-world:20260912T1900", "Gardeners' World", "Episode 13");

        Assert.Equal(
            FederatedLayout.RecordingFolderName(monday),
            FederatedLayout.RecordingFolderName(friday));
    }

    /// <summary>
    /// …and each broadcast is a separate file inside it, so two weeks do not overwrite each other.
    /// </summary>
    [Fact]
    public void Each_broadcast_is_its_own_file()
    {
        var monday = Entry("recording:gardeners-world:20260905T1900", "Gardeners' World", "Episode 12");
        var friday = Entry("recording:gardeners-world:20260912T1900", "Gardeners' World", "Episode 13");
        var folder = FederatedLayout.RecordingFolderName(monday);

        var one = FederatedLayout.RecordingFileBase(folder, monday, "attic");
        var two = FederatedLayout.RecordingFileBase(folder, friday, "attic");

        Assert.NotEqual(one, two);
        Assert.Contains("2026-09-05", one, System.StringComparison.Ordinal);
        Assert.Contains("2026-09-12", two, System.StringComparison.Ordinal);
    }

    /// <summary>
    /// The rule that makes two nodes' recordings of one broadcast a single item with two sources:
    /// <c>VideoListResolver.IsEligibleForMultiVersion</c> only groups same-folder files whose names
    /// start with the folder name and continue with <c>-</c>, <c>_</c> or <c>.</c>.
    /// </summary>
    [Fact]
    public void Two_nodes_recordings_of_one_broadcast_group_as_alternate_versions()
    {
        var entry = Entry("recording:the-news:20260905T2200", null, "The News");
        var folder = FederatedLayout.RecordingFolderName(entry);

        var attic = FederatedLayout.RecordingFileBase(folder, entry, "attic");
        var loft = FederatedLayout.RecordingFileBase(folder, entry, "loft");

        Assert.NotEqual(attic, loft);
        foreach (var name in new[] { attic, loft })
        {
            Assert.StartsWith(folder, name, System.StringComparison.Ordinal);
            Assert.Equal(" - ", name.Substring(folder.Length, 3));
        }
    }

    [Fact]
    public void A_programme_with_no_series_name_falls_back_to_its_title()
    {
        var entry = Entry("recording:the-news:20260905T2200", null, "The News");
        Assert.Contains("News", FederatedLayout.RecordingFolderName(entry), System.StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// A programme name is untrusted input from a peer the moment it becomes a folder name, and
    /// <see cref="SafePath"/> is what stands between it and this node's filesystem.
    /// </summary>
    [Fact]
    public void A_hostile_programme_name_cannot_escape_the_library()
    {
        var entry = Entry("recording:evil:20260905T2200", "../../../etc", "../../../etc");
        var folder = FederatedLayout.RecordingFolderName(entry);

        // Separators are what would let it escape, and SafePath turns them into spaces — so the
        // result is one ordinary folder called ".. .. .. etc" rather than a path. Asserting the
        // absence of ".." would be asserting cosmetics; asserting the absence of a separator is
        // asserting the property that matters.
        Assert.DoesNotContain("/", folder, System.StringComparison.Ordinal);
        Assert.DoesNotContain("\\", folder, System.StringComparison.Ordinal);
        Assert.NotEqual("..", folder);
        Assert.NotEqual(".", folder);
    }

    /// <summary>
    /// The three libraries are distinct directories. A recording landing in Shared Movies would be
    /// asked to agree on a year it does not have.
    /// </summary>
    [Fact]
    public void Recordings_have_their_own_library_and_directory()
    {
        var directories = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase)
        {
            FederatedLayout.MoviesDirectory,
            FederatedLayout.TvDirectory,
            FederatedLayout.RecordingsDirectory,
        };
        Assert.Equal(3, directories.Count);

        var libraries = new HashSet<string>(System.StringComparer.OrdinalIgnoreCase)
        {
            FederatedLayout.MoviesLibrary,
            FederatedLayout.TvLibrary,
            FederatedLayout.RecordingsLibrary,
        };
        Assert.Equal(3, libraries.Count);
    }
}
