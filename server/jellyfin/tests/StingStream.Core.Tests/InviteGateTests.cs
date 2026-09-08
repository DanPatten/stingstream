using System;
using System.Collections.Generic;
using System.Linq;
using StingStream.Core.Invites;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Whether an invite may be redeemed, and the rules a new one is held to.
/// </summary>
/// <remarks>
/// The door policy for person invites, which is the one place in this feature where being wrong
/// hands somebody an account on a server that never meant to give them one. There is no HTTP
/// harness in this suite by design — <c>SetupGateTests</c> says why — so the decision lives in a
/// pure static and the controller only calls it.
/// </remarks>
public class InviteGateTests
{
    private static readonly DateTimeOffset _now = new(2026, 9, 8, 12, 0, 0, TimeSpan.Zero);

    private static InviteState Live => new(_now.AddDays(7), null, null);

    [Fact]
    public void ALiveInviteIsValid()
    {
        Assert.Equal(InviteStatus.Valid, InviteGate.Decide(Live, _now));
    }

    [Fact]
    public void ATokenNobodyMintedIsUnknown()
    {
        // Null is what the store returns when no row matched the hash. It has to be a distinct
        // answer from the three refusals, because the controller answers 404 for it and 410 for
        // them -- there is nobody on the other end of an unknown token to help.
        Assert.Equal(InviteStatus.Unknown, InviteGate.Decide(null, _now));
    }

    [Fact]
    public void AnInviteSomebodyAlreadyUsedIsSpent()
    {
        // The whole of "single use". Part 3 recorded that this was impossible for a node-to-node
        // invite, because the group secret inside it *was* the credential and nobody was in a
        // position to say it had been spent. Here the server is the admitting party, so it can.
        var used = new InviteState(_now.AddDays(7), _now.AddHours(-1), null);
        Assert.Equal(InviteStatus.AlreadyUsed, InviteGate.Decide(used, _now));
    }

    [Fact]
    public void AnInviteWhoseTimeHasPassedIsExpired()
    {
        var expired = new InviteState(_now.AddSeconds(-1), null, null);
        Assert.Equal(InviteStatus.Expired, InviteGate.Decide(expired, _now));
    }

    [Fact]
    public void AnInviteExpiringExactlyNowIsOver()
    {
        // The boundary is arbitrary and it has to be somewhere. This is the direction that never
        // lets an invite live a moment longer than it was given.
        Assert.Equal(InviteStatus.Expired, InviteGate.Decide(new InviteState(_now, null, null), _now));
    }

    [Fact]
    public void AWithdrawnInviteIsRefusedEvenWhileItWouldOtherwiseBeLive()
    {
        // The one that matters most: revocation has to beat "still in date", or withdrawing an
        // invite would do nothing until it expired on its own.
        var revoked = new InviteState(_now.AddDays(7), null, _now.AddMinutes(-1));
        Assert.Equal(InviteStatus.Revoked, InviteGate.Decide(revoked, _now));
    }

    [Fact]
    public void RevokedBeatsUsedBeatsExpired()
    {
        // All three at once is an ordinary end state for an old invite. The order decides only what
        // the person is told; every one of them refuses.
        var all = new InviteState(_now.AddDays(-1), _now.AddDays(-2), _now.AddDays(-3));
        Assert.Equal(InviteStatus.Revoked, InviteGate.Decide(all, _now));

        var usedAndExpired = new InviteState(_now.AddDays(-1), _now.AddDays(-2), null);
        Assert.Equal(InviteStatus.AlreadyUsed, InviteGate.Decide(usedAndExpired, _now));
    }

    [Fact]
    public void EveryRefusalSaysWhatToDoNext()
    {
        foreach (var status in new[]
                 {
                     InviteStatus.Unknown,
                     InviteStatus.Revoked,
                     InviteStatus.AlreadyUsed,
                     InviteStatus.Expired,
                 })
        {
            var sentence = InviteGate.Explain(status);
            Assert.False(string.IsNullOrWhiteSpace(sentence));
        }

        // ...and a valid one is not an error, so it has no sentence at all.
        Assert.Null(InviteGate.Explain(InviteStatus.Valid));
    }

    [Theory]
    [InlineData(0, InviteGate.DefaultExpiryDays)]
    [InlineData(-5, InviteGate.DefaultExpiryDays)]
    [InlineData(1, 1)]
    [InlineData(30, 30)]
    [InlineData(InviteGate.MaxExpiryDays, InviteGate.MaxExpiryDays)]
    [InlineData(100000, InviteGate.MaxExpiryDays)]
    public void ExpiryIsClampedRatherThanRefused(int requested, int expected)
    {
        // Clamped, because the bound exists to stop an invite outliving its reason and silently
        // shortening one does that; making somebody retype the form does not do it any better. The
        // value that comes back is the one shown to them and stored, so nothing is hidden.
        Assert.Equal(expected, InviteGate.ClampExpiry(requested));
    }

    [Fact]
    public void AnInviteMustNameAtLeastOneLibrary()
    {
        // Otherwise it mints a working link to an account that can see nothing, which looks like a
        // bug on the other end and reads as a snub.
        Assert.NotNull(InviteGate.ValidateMint("Mum", Array.Empty<Guid>()));
        Assert.NotNull(InviteGate.ValidateMint("Mum", null));
        Assert.NotNull(InviteGate.ValidateMint("Mum", new[] { Guid.Empty }));
    }

    [Fact]
    public void AnOrdinaryInviteIsAccepted()
    {
        Assert.Null(InviteGate.ValidateMint("Mum", new[] { Guid.NewGuid() }));
        Assert.Null(InviteGate.ValidateMint(null, new[] { Guid.NewGuid() }));
        Assert.Null(InviteGate.ValidateMint(string.Empty, new[] { Guid.NewGuid() }));
    }

    [Fact]
    public void ALabelHasABound()
    {
        var tooLong = new string('x', InviteGate.MaxLabelLength + 1);
        Assert.NotNull(InviteGate.ValidateMint(tooLong, new[] { Guid.NewGuid() }));

        var justRight = new string('x', InviteGate.MaxLabelLength);
        Assert.Null(InviteGate.ValidateMint(justRight, new[] { Guid.NewGuid() }));
    }

    [Fact]
    public void SoDoesTheLibraryList()
    {
        var far = Enumerable.Range(0, InviteGate.MaxLibraries + 1).Select(_ => Guid.NewGuid()).ToArray();
        Assert.NotNull(InviteGate.ValidateMint("Mum", far));
    }

    [Fact]
    public void ADoubleTappedLibraryIsNotAnError()
    {
        // It is what a picker produces, not a mistake worth an error message.
        var id = Guid.NewGuid();
        Assert.Null(InviteGate.ValidateMint("Mum", new[] { id, id }));
        Assert.Equal(new[] { id }, InviteGate.NormaliseLibraries(new[] { id, id }));
    }

    [Fact]
    public void TheEmptyGuidIsNeverStoredAsALibrary()
    {
        // It is what a missing value parses to, it names no library, and a list containing it would
        // look like access to something.
        var real = Guid.NewGuid();
        Assert.Equal(new[] { real }, InviteGate.NormaliseLibraries(new[] { Guid.Empty, real, Guid.Empty }));
        Assert.Empty(InviteGate.NormaliseLibraries(new[] { Guid.Empty }));
        Assert.Empty(InviteGate.NormaliseLibraries((IReadOnlyCollection<Guid>?)null));
    }

    [Fact]
    public void TheChosenOrderIsKept()
    {
        // The list is shown back to the administrator on the invite they just minted, and a picker
        // that reorders what somebody selected reads as though it chose something else.
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var c = Guid.NewGuid();
        Assert.Equal(new[] { c, a, b }, InviteGate.NormaliseLibraries(new[] { c, a, b, a }));
    }
}
