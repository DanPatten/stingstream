using StingStream.Core.FirstRun;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The decision behind the first-run screen, and the rules it holds the typed name and password to.
/// </summary>
/// <remarks>
/// This matters more than its size suggests. While a node is pending, <c>POST setup/admin</c> hands
/// the administrator account to whoever asks — that is the whole feature — so the two conditions
/// that end it are the difference between a one-screen first run and a node anybody on the machine
/// can take over a year later. There is no HTTP harness in this suite by design, which is why the
/// decision lives in a pure static and the controller only calls it.
/// </remarks>
public class SetupGateTests
{
    [Fact]
    public void APendingNodeAnswersALocalCaller()
    {
        Assert.Equal(SetupAccess.Allow, SetupGate.Decide(pending: true, isLoopback: true));
    }

    [Fact]
    public void AClaimedNodeRefusesEvenALocalCaller()
    {
        // 409, not 404: the person is sitting at the machine and the honest answer is useful to
        // them.
        Assert.Equal(SetupAccess.NotPending, SetupGate.Decide(pending: false, isLoopback: true));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ARemoteCallerIsToldNothingAtAll(bool pending)
    {
        // Not local wins over not pending in both directions, so a stranger on the LAN gets one
        // answer -- 404, indistinguishable from the route not existing -- and cannot use the
        // difference between 404 and 409 to find an unclaimed node to race for.
        Assert.Equal(SetupAccess.NotLocal, SetupGate.Decide(pending, isLoopback: false));
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
