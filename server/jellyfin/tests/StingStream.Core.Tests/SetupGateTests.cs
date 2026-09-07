using System.Net;
using StingStream.Core.FirstRun;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The decision behind the first-run screen, and the rules it holds the typed name and password to.
/// </summary>
/// <remarks>
/// This matters more than its size suggests. While a node is pending, <c>POST setup/admin</c> hands
/// the administrator account to whoever asks — that is the whole feature — so the two conditions
/// that end it are the difference between a one-screen first run and a node anybody who can reach
/// it can take over a year later. There is no HTTP harness in this suite by design, which is why
/// the decision lives in a pure static and the controller only calls it.
/// </remarks>
public class SetupGateTests
{
    [Fact]
    public void APendingNodeAnswersATrustedCaller()
    {
        Assert.Equal(SetupAccess.Allow, SetupGate.Decide(pending: true, isTrustedPeer: true));
    }

    [Fact]
    public void AClaimedNodeRefusesEvenATrustedCaller()
    {
        // 409, not 404: the person is on the network and the honest answer is useful to them.
        Assert.Equal(SetupAccess.NotPending, SetupGate.Decide(pending: false, isTrustedPeer: true));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void AnUntrustedCallerIsToldNothingAtAll(bool pending)
    {
        // Not local wins over not pending in both directions, so a stranger off the network gets
        // one answer -- 404, indistinguishable from the route not existing -- and cannot use the
        // difference between 404 and 409 to find an unclaimed node to race for.
        Assert.Equal(SetupAccess.NotLocal, SetupGate.Decide(pending, isTrustedPeer: false));
    }

    [Theory]
    // This machine.
    [InlineData("127.0.0.1")]
    [InlineData("127.10.20.30")]
    [InlineData("::1")]
    // This network. A node lives in a cupboard and the person setting it up is on the sofa.
    [InlineData("10.0.0.5")]
    [InlineData("10.255.255.254")]
    [InlineData("172.16.0.1")]
    [InlineData("172.31.255.254")]
    [InlineData("192.168.0.16")]
    [InlineData("192.168.255.254")]
    [InlineData("169.254.1.1")]
    [InlineData("fe80::1")]
    [InlineData("fd00::1")]
    [InlineData("fc00::1")]
    // A v4 address over a dual-stack socket. Without unmapping, every range above misses it.
    [InlineData("::ffff:192.168.0.16")]
    [InlineData("::ffff:127.0.0.1")]
    public void ThisMachineAndThisNetworkAreTrusted(string address)
    {
        Assert.True(SetupGate.IsTrustedPeer(IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("8.8.8.8")]
    [InlineData("1.1.1.1")]
    [InlineData("172.15.0.1")]      // just below 172.16/12
    [InlineData("172.32.0.1")]      // just above it
    [InlineData("192.169.0.1")]     // one octet off 192.168/16
    [InlineData("169.253.0.1")]     // one octet off link-local
    [InlineData("11.0.0.1")]        // one octet off 10/8
    [InlineData("2606:4700::1111")]
    [InlineData("fb00::1")]         // one bit below fc00::/7
    [InlineData("::ffff:8.8.8.8")]  // a public v4 wearing a v6 hat
    public void TheInternetIsNot(string address)
    {
        Assert.False(SetupGate.IsTrustedPeer(IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("100.64.0.1")]
    [InlineData("100.127.255.254")]
    public void CarrierGradeNatLooksPrivateAndIsNot(string address)
    {
        // 100.64/10 is the address space an ISP shares between its subscribers, so the other side
        // of it is somebody else's house rather than somebody else's room.
        Assert.False(SetupGate.IsTrustedPeer(IPAddress.Parse(address)));
    }

    [Fact]
    public void NoAddressAtAllIsAnInProcessCaller()
    {
        // Kestrel reports no remote address for an in-process or unix-socket request, which is at
        // least as trusted as loopback.
        Assert.True(SetupGate.IsTrustedPeer(null));
    }

    [Theory]
    [InlineData("dan")]
    [InlineData("a")]
    [InlineData("Dan.Patten")]
    [InlineData("dan_patten")]
    [InlineData("dan-patten-2")]
    [InlineData("stingstream")]
    [InlineData("12345678901234567890123456789012")]
    public void ANameSomebodyWouldActuallyChooseIsAccepted(string username)
    {
        Assert.Null(SetupGate.ValidateUsername(username));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("dan patten")]
    [InlineData("dan@example.com")]
    [InlineData("dan/../etc")]
    [InlineData("dan\"; DROP")]
    [InlineData("123456789012345678901234567890123")]
    public void ANameThatWouldCauseTroubleIsRefusedWithASentence(string? username)
    {
        var problem = SetupGate.ValidateUsername(username);
        Assert.NotNull(problem);
        Assert.EndsWith(".", problem, System.StringComparison.Ordinal);
    }

    [Fact]
    public void TheLengthLimitIsInclusive()
    {
        Assert.Null(SetupGate.ValidateUsername(new string('a', SetupGate.MaxUsernameLength)));
        Assert.NotNull(SetupGate.ValidateUsername(new string('a', SetupGate.MaxUsernameLength + 1)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("short")]
    [InlineData("1234567")]
    public void AShortPasswordIsRefused(string? password)
    {
        Assert.NotNull(SetupGate.ValidatePassword(password));
    }

    [Theory]
    [InlineData("12345678")]
    [InlineData("correct horse battery staple")]
    [InlineData("        ")]
    public void EightCharactersIsEnoughAndNothingElseIsDemanded(string password)
    {
        // Including a passphrase with spaces, and including eight spaces: a rule that insists on a
        // digit and a capital produces "Password1", and the confirm field on the screen is what
        // catches a typo.
        Assert.Null(SetupGate.ValidatePassword(password));
    }

    [Fact]
    public void ValidateReportsTheNameBeforeThePassword()
    {
        // One sentence at a time, and the field the user filled in first is the one they get told
        // about first.
        Assert.Equal(SetupGate.ValidateUsername(string.Empty), SetupGate.Validate(string.Empty, "short"));
        Assert.Equal(SetupGate.ValidatePassword("short"), SetupGate.Validate("dan", "short"));
        Assert.Null(SetupGate.Validate("dan", "12345678"));
    }
}
