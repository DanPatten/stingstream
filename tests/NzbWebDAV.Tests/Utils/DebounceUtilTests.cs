using NzbWebDAV.Utils;

namespace NzbWebDAV.Tests.Utils;

public class DebounceUtilTests
{
    [Fact]
    public void CreateDebounce_LeadingEdgeThrow_DoesNotPropagate()
    {
        var debounce = DebounceUtil.CreateDebounce(TimeSpan.FromMilliseconds(200));

        var exception = Record.Exception(() =>
            debounce(() => throw new InvalidOperationException("leading boom")));

        Assert.Null(exception);
    }

    [Fact]
    public async Task CreateDebounce_TrailingEdgeThrow_DoesNotPropagate_AndSubsequentActionsStillRun()
    {
        var window = TimeSpan.FromMilliseconds(50);
        var debounce = DebounceUtil.CreateDebounce(window);
        using var trailingEdgeFired = new ManualResetEventSlim(false);
        var subsequentRan = false;

        // First call runs immediately (leading edge).
        debounce(() => { });
        // Second call within the window is scheduled on the timer.
        debounce(() =>
        {
            trailingEdgeFired.Set();
            throw new InvalidOperationException("trailing boom");
        });

        // The timer callback stamps the window start, so wait for the throw to
        // land before timing anything against it. A loaded threadpool can delay
        // the callback well past the window.
        Assert.True(trailingEdgeFired.Wait(TimeSpan.FromSeconds(10)), "trailing edge never fired");
        await Task.Delay(window * 3);

        // After the window, a new leading-edge call should still work.
        debounce(() => subsequentRan = true);
        Assert.True(subsequentRan);
    }
}
