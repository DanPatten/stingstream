using System;
using System.Globalization;
using StingStream.Core.Federated;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Timestamp handling for the offline lifecycle.
/// </summary>
/// <remarks>
/// This exists because of a specific failure. <see cref="FederatedStore.Parse"/> originally passed
/// <c>DateTimeStyles.RoundtripKind | DateTimeStyles.AdjustToUniversal</c>, which .NET rejects with
/// an <c>ArgumentException</c> — and the only code path that reaches it is the *first* pass after
/// a peer goes offline, so the whole pass threw and the symptom was "the unavailable tag never
/// appears", three layers away from a date-parsing bug. The two-node harness caught it; nothing
/// cheaper would have.
/// </remarks>
public class FederatedStoreTests
{
    [Fact]
    public void NowRoundTripsThroughParse()
    {
        var now = FederatedStore.Now();
        var parsed = FederatedStore.Parse(now);

        Assert.NotNull(parsed);
        Assert.Equal(DateTimeKind.Utc, parsed!.Value.Kind);
        Assert.True(Math.Abs((DateTime.UtcNow - parsed.Value).TotalSeconds) < 60);
    }

    [Fact]
    public void AGracePeriodComparisonIsNotOffByTheMachinesTimeZone()
    {
        // The comparison the grace period actually makes. If Parse returned a local time, a node in
        // UTC+13 would delete a peer's titles thirteen hours early and one in UTC-8 eight hours
        // late, and neither would look like a bug for a week.
        var written = FederatedStore.Now();
        var elapsed = DateTime.UtcNow - FederatedStore.Parse(written)!.Value;
        Assert.True(elapsed >= TimeSpan.Zero);
        Assert.True(elapsed < TimeSpan.FromMinutes(1));
    }

    [Theory]
    [InlineData("2026-09-05T11:20:24.0000000Z")]
    [InlineData("2026-09-05T11:20:24Z")]
    [InlineData("2026-09-05T11:20:24.000+00:00")]
    public void EveryUtcSpellingParsesToTheSameInstant(string value)
    {
        var parsed = FederatedStore.Parse(value);
        Assert.NotNull(parsed);
        Assert.Equal(
            new DateTime(2026, 9, 5, 11, 20, 24, DateTimeKind.Utc),
            new DateTime(parsed!.Value.Ticks - (parsed.Value.Ticks % TimeSpan.TicksPerSecond), DateTimeKind.Utc));
    }

    [Fact]
    public void AnOffsetIsConvertedRatherThanTakenAtFaceValue()
    {
        var parsed = FederatedStore.Parse("2026-09-05T13:20:24+02:00");
        Assert.Equal(DateTimeKind.Utc, parsed!.Value.Kind);
        Assert.Equal(11, parsed.Value.Hour);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("yesterday")]
    [InlineData("{}")]
    public void NonsenseIsNullRatherThanAnException(string? value)
    {
        // A hand-edited or truncated row must degrade to "no grace period recorded", not take the
        // whole materialization pass down.
        Assert.Null(FederatedStore.Parse(value));
    }

    [Fact]
    public void NowIsInvariantCultureSoADanishMachineWritesTheSameString()
    {
        var previous = System.Threading.Thread.CurrentThread.CurrentCulture;
        try
        {
            System.Threading.Thread.CurrentThread.CurrentCulture = new CultureInfo("da-DK");
            var now = FederatedStore.Now();
            Assert.NotNull(FederatedStore.Parse(now));
            Assert.Contains("T", now, StringComparison.Ordinal);
        }
        finally
        {
            System.Threading.Thread.CurrentThread.CurrentCulture = previous;
        }
    }
}
