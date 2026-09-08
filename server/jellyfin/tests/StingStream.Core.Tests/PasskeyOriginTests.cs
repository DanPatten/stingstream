using System;
using StingStream.Core.Passkeys;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Whether a server can offer passkeys, and what they bind to.
/// </summary>
/// <remarks>
/// A passkey is bound to a relying-party id and the browser refuses any ceremony from a page that
/// is not on it, so getting this wrong does not produce a subtle bug — it produces a button that
/// fails for everybody, with a browser error about the relying party that reads like a certificate
/// problem. There is no HTTP harness in this suite by design, which is why the rule is a pure
/// static and the service only calls it.
/// </remarks>
public class PasskeyOriginTests
{
    [Fact]
    public void ADomainCanCarryPasskeys()
    {
        var (support, party) = PasskeyOrigin.For("https://media.example.com");

        Assert.Equal(PasskeySupport.Supported, support);
        Assert.Equal("media.example.com", party!.Value.Domain);
        Assert.Equal("https://media.example.com", party.Value.Origin);
    }

    [Fact]
    public void ThePortStaysOnTheOriginAndOffTheRelyingParty()
    {
        // The asymmetry is in the spec. Putting the port on the relying-party id produces a
        // ceremony the browser rejects for a reason that names neither the port nor the setting.
        var (_, party) = PasskeyOrigin.For("https://media.example.com:8443");

        Assert.Equal("media.example.com", party!.Value.Domain);
        Assert.Equal("https://media.example.com:8443", party.Value.Origin);
    }

    [Fact]
    public void ABareHostnameIsForgiven()
    {
        // The value is typed by hand into a settings field, and the scheme is the part people
        // leave off.
        var (support, party) = PasskeyOrigin.For("media.example.com");

        Assert.Equal(PasskeySupport.Supported, support);
        Assert.Equal("media.example.com", party!.Value.Domain);
    }

    [Fact]
    public void NoAddressIsItsOwnAnswer()
    {
        // Distinct from "that address will not do", because the sentence a person is shown is
        // different: one says add a domain, the other says the one you added cannot work.
        foreach (var value in new[] { null, "", "   " })
        {
            var (support, party) = PasskeyOrigin.For(value);
            Assert.Equal(PasskeySupport.NoAddress, support);
            Assert.Null(party);
        }
    }

    [Theory]
    [InlineData("https://203.0.113.9")]
    [InlineData("https://203.0.113.9:8790")]
    [InlineData("https://[2001:db8::1]")]
    public void AnIpAddressCannotCarryPasskeys(string address)
    {
        // A relying-party id must be a domain. It is also the case that no certificate authority
        // will issue for a residential IP and that the address rotates, so this refusal agrees with
        // the sharing-address rules rather than adding a new one.
        var (support, party) = PasskeyOrigin.For(address);

        Assert.Equal(PasskeySupport.NotADomain, support);
        Assert.Null(party);
    }

    [Fact]
    public void PlainHttpCannotCarryPasskeys()
    {
        // WebAuthn needs a secure context; there is no version of this that works over http.
        var (support, _) = PasskeyOrigin.For("http://media.example.com");
        Assert.Equal(PasskeySupport.NotADomain, support);
    }

    [Theory]
    [InlineData("https://localhost")]
    [InlineData("https://localhost:8790")]
    [InlineData("https://nas")]
    [InlineData("https://server.localhost")]
    public void LocalhostAndSingleLabelsAreRefusedEvenThoughABrowserWouldAllowThem(string address)
    {
        // localhost really is a secure context, so a ceremony there would work — once, at the
        // keyboard. The credential would be shared with everything else that has ever run on that
        // machine's localhost, and would be gone the first time its owner opened the server from a
        // phone. A clear "you need a domain" beats a credential that works exactly once.
        var (support, party) = PasskeyOrigin.For(address);

        Assert.Equal(PasskeySupport.NotADomain, support);
        Assert.Null(party);
    }

    [Fact]
    public void EveryRefusalSaysWhatToDoAboutIt()
    {
        Assert.Null(PasskeyOrigin.Explain(PasskeySupport.Supported));
        foreach (var support in new[] { PasskeySupport.NoAddress, PasskeySupport.NotADomain })
        {
            Assert.False(string.IsNullOrWhiteSpace(PasskeyOrigin.Explain(support)));
        }
    }
}

/// <summary>
/// The challenges handed out and not yet answered.
/// </summary>
/// <remarks>
/// A challenge that can be answered twice is not a challenge, and one that never expires is a
/// standing offer. Both properties are the point of the type, so both are pinned here.
/// </remarks>
public class PasskeyCeremonyTests
{
    private static readonly DateTimeOffset _now = new(2026, 9, 8, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void AChallengeComesBackOnce()
    {
        var ceremonies = new PasskeyCeremonies();
        var id = ceremonies.Remember("{}", "user-1", _now)!;

        var first = ceremonies.Take(id, _now);
        Assert.NotNull(first);
        Assert.Equal("user-1", first!.Value.UserId);

        // The second attempt is a replay, and this is where it stops.
        Assert.Null(ceremonies.Take(id, _now));
    }

    [Fact]
    public void AnExpiredChallengeIsRefusedAndConsumed()
    {
        var ceremonies = new PasskeyCeremonies();
        var id = ceremonies.Remember("{}", null, _now)!;

        var late = _now + PasskeyCeremonies.Lifetime + TimeSpan.FromSeconds(1);
        Assert.Null(ceremonies.Take(id, late));
        // Consumed either way, so a slow client cannot hold one open by retrying.
        Assert.Equal(0, ceremonies.Count);
    }

    [Fact]
    public void AChallengeNobodyIssuedIsRefused()
    {
        var ceremonies = new PasskeyCeremonies();
        Assert.Null(ceremonies.Take("deadbeef", _now));
        Assert.Null(ceremonies.Take(null, _now));
        Assert.Null(ceremonies.Take(string.Empty, _now));
    }

    [Fact]
    public void ExpiredChallengesAreSweptRatherThanAccumulating()
    {
        var ceremonies = new PasskeyCeremonies();
        for (var i = 0; i < 10; i++)
        {
            ceremonies.Remember("{}", null, _now);
        }

        Assert.Equal(10, ceremonies.Count);

        // Issuing one after they have all expired clears them out.
        ceremonies.Remember("{}", null, _now + PasskeyCeremonies.Lifetime + TimeSpan.FromSeconds(1));
        Assert.Equal(1, ceremonies.Count);
    }

    [Fact]
    public void TooManyOutstandingChallengesAreRefusedRatherThanQueued()
    {
        // `login/begin` is anonymous, so anybody who can reach the server can ask for a challenge.
        // Expiry alone is not a bound: a loop issuing them faster than they expire is unbounded.
        var ceremonies = new PasskeyCeremonies();
        for (var i = 0; i < PasskeyCeremonies.MaxOutstanding; i++)
        {
            Assert.NotNull(ceremonies.Remember("{}", null, _now));
        }

        Assert.Null(ceremonies.Remember("{}", null, _now));

        // ...and the bound lifts on its own once they age out, rather than needing a restart.
        Assert.NotNull(ceremonies.Remember(
            "{}",
            null,
            _now + PasskeyCeremonies.Lifetime + TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void EveryChallengeGetsItsOwnId()
    {
        var ceremonies = new PasskeyCeremonies();
        var a = ceremonies.Remember("{}", "user-1", _now);
        var b = ceremonies.Remember("{}", "user-1", _now);

        Assert.NotEqual(a, b);
    }
}
