using System;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using StingStream.Core.Federated;
using StingStream.Core.Inventory;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// When a burst of library changes has settled enough to be worth one rebuild.
/// </summary>
/// <remarks>
/// <para>
/// The problem being solved: nothing in <c>StingStream.Core</c> used to rebuild the inventory when
/// Jellyfin finished a scan, so a holder with no arrs never advertised a file dropped into a
/// folder. The problem created by solving it naively: a scan raises one <c>ItemAdded</c> per file,
/// and rebuilding on each one walks the whole library once per title.
/// </para>
/// <para>
/// So the rule has two halves and both matter. The quiet period is what makes a ten-minute scan
/// cost one rebuild instead of ten thousand; the maximum delay is what stops a library that never
/// goes quiet from deferring that rebuild forever — the failure a pure debounce always has, and
/// the one that looks exactly like the bug this was written to fix.
/// </para>
/// </remarks>
public class RebuildDebouncerTests
{
    private static readonly DateTime _t0 = new(2026, 9, 7, 12, 0, 0, DateTimeKind.Utc);

    private static RebuildDebouncer Debouncer() => new()
    {
        QuietPeriod = TimeSpan.FromSeconds(5),
        MaximumDelay = TimeSpan.FromSeconds(60),
    };

    [Fact]
    public void Nothing_is_due_until_something_changes()
    {
        var debounce = Debouncer();
        Assert.False(debounce.Pending);
        Assert.False(debounce.TakeIfDue(_t0));
        Assert.False(debounce.TakeIfDue(_t0.AddHours(1)));
    }

    [Fact]
    public void One_change_waits_out_the_quiet_period_and_then_runs_once()
    {
        var debounce = Debouncer();
        debounce.Note(_t0);

        Assert.True(debounce.Pending);
        Assert.False(debounce.TakeIfDue(_t0.AddSeconds(4.9)));
        Assert.True(debounce.TakeIfDue(_t0.AddSeconds(5)));

        // Claimed, so it does not run again on its own.
        Assert.False(debounce.Pending);
        Assert.False(debounce.TakeIfDue(_t0.AddSeconds(30)));
    }

    /// <summary>
    /// The scan case: two thousand events, one rebuild, and not until the scan stops.
    /// </summary>
    /// <remarks>
    /// Two thousand rather than ten, because at one event every 20 ms ten thousand is a
    /// two-hundred-second scan and the maximum delay would — correctly — cut in partway through.
    /// This is the burst that fits inside it: forty seconds of continuous change, no rebuild until
    /// it stops, then exactly one. The longer scan's behaviour is
    /// <see cref="A_library_that_never_settles_is_rebuilt_on_the_maximum_delay"/>.
    /// </remarks>
    [Fact]
    public void A_burst_of_changes_coalesces_into_a_single_rebuild_after_it_stops()
    {
        var debounce = Debouncer();
        var now = _t0;
        for (var i = 0; i < 2_000; i++)
        {
            now = _t0.AddMilliseconds(i * 20);
            debounce.Note(now);
            Assert.False(debounce.TakeIfDue(now), "a rebuild must not start while the scan is running");
        }

        Assert.False(debounce.TakeIfDue(now.AddSeconds(4)));
        Assert.True(debounce.TakeIfDue(now.AddSeconds(5)));
        Assert.False(debounce.TakeIfDue(now.AddSeconds(600)), "one burst is one rebuild");
    }

    /// <summary>
    /// A library that never goes quiet still gets rebuilt, or a node stays silently out of date.
    /// </summary>
    [Fact]
    public void A_library_that_never_settles_is_rebuilt_on_the_maximum_delay()
    {
        var debounce = Debouncer();
        debounce.Note(_t0);

        // A change every second, forever: the quiet period never elapses.
        for (var second = 1; second <= 59; second++)
        {
            var now = _t0.AddSeconds(second);
            debounce.Note(now);
            Assert.False(debounce.TakeIfDue(now));
        }

        debounce.Note(_t0.AddSeconds(60));
        Assert.True(
            debounce.TakeIfDue(_t0.AddSeconds(60)),
            "sixty seconds after the first change, the rebuild happens whatever else is going on");
    }

    /// <summary>
    /// A change that lands while a rebuild is running is not lost: the flag was claimed before the
    /// work started, so setting it again earns a second pass.
    /// </summary>
    [Fact]
    public void A_change_during_a_rebuild_earns_another_one()
    {
        var debounce = Debouncer();
        debounce.Note(_t0);
        Assert.True(debounce.TakeIfDue(_t0.AddSeconds(5)));

        // ...the rebuild is now running, and a file lands.
        debounce.Note(_t0.AddSeconds(6));
        Assert.True(debounce.Pending);
        Assert.False(debounce.TakeIfDue(_t0.AddSeconds(10)));
        Assert.True(debounce.TakeIfDue(_t0.AddSeconds(11)));
    }

    /// <summary>The maximum delay is measured from the first change, not the last.</summary>
    [Fact]
    public void The_maximum_delay_runs_from_the_first_change_of_the_burst()
    {
        var debounce = Debouncer();
        debounce.Note(_t0);
        debounce.Note(_t0.AddSeconds(59));
        Assert.False(debounce.TakeIfDue(_t0.AddSeconds(59.5)));
        Assert.True(debounce.TakeIfDue(_t0.AddSeconds(60)));

        // ...and the next burst starts its own clock.
        debounce.Note(_t0.AddSeconds(61));
        Assert.False(debounce.TakeIfDue(_t0.AddSeconds(65)));
        Assert.True(debounce.TakeIfDue(_t0.AddSeconds(66)));
    }

    // --- what wakes the watcher at all -----------------------------------------------------------

    private static readonly string _federated =
        System.IO.Path.Combine("E:", "data", "federated");

    /// <summary>
    /// A film this node holds is exactly what the watcher exists for.
    /// </summary>
    [Fact]
    public void A_real_film_is_worth_a_rebuild()
    {
        var item = new Movie
        {
            Path = System.IO.Path.Combine("E:", "media", "Movies", "Sita (2008)", "sita.mkv"),
        };

        Assert.True(InventoryWatcher.CouldBeInventory(item, _federated));
    }

    /// <summary>
    /// **The one that must not wake it.** The materializer writes a `.strm` per peer per title, so
    /// on a node in a large group these arrive in their thousands and none of them can ever be
    /// inventory. Waking for them would be a rebuild storm that never ends.
    /// </summary>
    [Fact]
    public void A_federated_pointer_is_not_worth_a_rebuild()
    {
        var strm = new Movie
        {
            Path = System.IO.Path.Combine(_federated, "movies", "Sita (2008)", "Sita - loft.strm"),
        };
        Assert.False(InventoryWatcher.CouldBeInventory(strm, _federated));

        // ...and one that reached this node under some other extension is caught by its tag.
        var tagged = new Movie
        {
            Path = System.IO.Path.Combine("E:", "media", "Movies", "Sita (2008)", "sita.mkv"),
            Tags = new[] { NfoWriter.FederatedTag },
        };
        Assert.False(InventoryWatcher.CouldBeInventory(tagged, _federated));
    }

    [Fact]
    public void Something_that_is_not_a_video_is_not_worth_a_rebuild()
    {
        var folder = new Folder
        {
            Path = System.IO.Path.Combine("E:", "media", "Movies"),
        };

        Assert.False(InventoryWatcher.CouldBeInventory(folder, _federated));
    }

    [Fact]
    public void An_item_with_no_path_is_not_worth_a_rebuild()
    {
        Assert.False(InventoryWatcher.CouldBeInventory(new Movie(), _federated));
    }
}
