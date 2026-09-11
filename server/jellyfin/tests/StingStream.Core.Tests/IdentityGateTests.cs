using System;
using System.Collections.Generic;
using StingStream.Core.FirstRun;
using StingStream.Core.Identity;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// The rules behind signing in with your own server.
/// </summary>
/// <remarks>
/// A pure static and its tests, for the reason <c>SetupGate</c> gives and <c>InviteGateTests</c>
/// repeats: there is no HTTP harness in this suite, so the decisions worth pinning are the ones
/// that can be pinned without one. The signature check itself is not here — it is Ed25519 in the
/// mesh, and <c>vouch.rs</c>'s own tests cover it.
/// </remarks>
public class IdentityGateTests
{
    /// <summary>Nothing is taken, which is the plain case.</summary>
    private static readonly Func<string, bool> Free = _ => false;

    private static Func<string, bool> Taken(params string[] names)
    {
        var set = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
        return set.Contains;
    }

    [Fact]
    public void TheirOwnNameWhenItIsFree()
    {
        Assert.Equal("sam", IdentityGate.ChooseUsername("sam", "Loft", NodeId(), Free));
    }

    [Fact]
    public void QualifiedByTheirServerWhenItIsNot()
    {
        // Dan chose the shape: their name, qualified if taken.
        Assert.Equal("sam.loft", IdentityGate.ChooseUsername("sam", "Loft", NodeId(), Taken("sam")));
    }

    [Fact]
    public void TheSeparatorIsOneAUsernameMayActuallyContain()
    {
        // It reads as sam@loft and it cannot be: SetupGate.ValidateUsername allows letters, digits,
        // dots, underscores and dashes and nothing else, and every name this product produces has
        // to survive being re-typed into the sign-in form.
        var name = IdentityGate.ChooseUsername("sam", "Loft", NodeId(), Taken("sam"));
        Assert.Null(SetupGate.ValidateUsername(name));
        Assert.DoesNotContain('@', name!);
    }

    [Fact]
    public void EveryNameItEverReturnsIsALegalOne()
    {
        // The name and the server name both come off another machine and neither has been held to
        // this server's rules. Whatever arrives, what comes out has to be something this server
        // will accept -- otherwise a sign-in fails on a character somebody else chose.
        var awkward = new[]
        {
            ("Sam O'Brien", "Dan's Loft (upstairs)"),
            ("  ", "  "),
            ("!!!", "???"),
            ("сам", "лофт"),
            (new string('x', 200), new string('y', 200)),
            ("....", "----"),
        };

        foreach (var (name, server) in awkward)
        {
            var chosen = IdentityGate.ChooseUsername(name, server, NodeId(), Free);
            Assert.NotNull(chosen);
            Assert.Null(SetupGate.ValidateUsername(chosen));
        }
    }

    [Fact]
    public void SomebodyWithNoUsableNameStillGetsOne()
    {
        // Refusing a sign-in over a character set would be the wrong answer; "someone" is a
        // placeholder they can change.
        Assert.Equal("someone", IdentityGate.ChooseUsername("!!!", null, NodeId(), Free));
    }

    [Fact]
    public void ASpaceBecomesADashRatherThanVanishing()
    {
        // "Loft Server" should read as loft-server, not loftserver.
        Assert.Equal(
            "sam.loft-server",
            IdentityGate.ChooseUsername("sam", "Loft Server", NodeId(), Taken("sam")));
    }

    [Fact]
    public void ItFallsBackToTheNodeIdAndThenToACounter()
    {
        var node = NodeId();
        var byNode = IdentityGate.ChooseUsername("sam", "Loft", node, Taken("sam", "sam.loft"));
        Assert.Equal($"sam.{node[..8]}", byNode);

        var numbered = IdentityGate.ChooseUsername(
            "sam",
            "Loft",
            node,
            Taken("sam", "sam.loft", $"sam.{node[..8]}"));
        Assert.Equal("sam.2", numbered);
    }

    [Fact]
    public void ItTerminatesWhenEverythingIsTaken()
    {
        // A null is a refusal the caller turns into a sentence. An infinite loop is not.
        Assert.Null(IdentityGate.ChooseUsername("sam", "Loft", NodeId(), _ => true));
    }

    [Fact]
    public void ReservedNamesAreNeverHandedOut()
    {
        // Not a security control -- these are taken on any server that has ever had an
        // administrator -- but an account called `admin` created by somebody else's server is a
        // name nobody should have to reason about.
        var chosen = IdentityGate.ChooseUsername("admin", "Loft", NodeId(), Free);
        Assert.NotEqual("admin", chosen);
        Assert.Equal("admin.loft", chosen);
    }

    [Fact]
    public void ALongNameIsTrimmedAndTheQualifierIsNot()
    {
        // The qualifier is what makes the name unique, so it is the half that has to survive; a
        // truncated one could collide with a different server's.
        var long_ = new string('x', SetupGate.MaxUsernameLength);
        var chosen = IdentityGate.ChooseUsername(long_, "Loft", NodeId(), Taken(long_));

        Assert.NotNull(chosen);
        Assert.True(chosen!.Length <= SetupGate.MaxUsernameLength);
        Assert.EndsWith(".loft", chosen, StringComparison.Ordinal);
        Assert.Null(SetupGate.ValidateUsername(chosen));
    }

    [Fact]
    public void ABadSignatureIsReportedBeforeASpentNonce()
    {
        // An assertion that was never genuine should not be told which of our nonces it missed.
        var problem = IdentityGate.DecideSignIn(
            verified: false,
            challengeMatched: false,
            linkedUserId: "u1",
            inviteAccepted: true);

        Assert.NotNull(problem);
        Assert.Contains("could not be verified", problem, StringComparison.Ordinal);
    }

    [Fact]
    public void AReplayedOrExpiredNonceIsRefused()
    {
        var problem = IdentityGate.DecideSignIn(
            verified: true,
            challengeMatched: false,
            linkedUserId: "u1",
            inviteAccepted: true);

        Assert.NotNull(problem);
        Assert.Contains("already been used", problem, StringComparison.Ordinal);
    }

    [Fact]
    public void AKnownIdentityNeedsNoInvite()
    {
        Assert.Null(IdentityGate.DecideSignIn(true, true, "u1", inviteAccepted: false));
    }

    [Fact]
    public void AStrangerNeedsOne()
    {
        // The rule that matters. Anybody can run StingStream, so a genuine assertion from a server
        // nobody here has heard of proves identity and grants nothing -- otherwise every
        // StingStream server in the world would accept every other one's users.
        var problem = IdentityGate.DecideSignIn(true, true, null, inviteAccepted: false);
        Assert.NotNull(problem);

        Assert.Null(IdentityGate.DecideSignIn(true, true, null, inviteAccepted: true));
    }

    [Fact]
    public void AddingAServerReportsABadSignatureBeforeASpentNonce()
    {
        // Same order as DecideSignIn, and for the same reason: an assertion that was never genuine
        // is not told which of our nonces it missed.
        var problem = IdentityGate.DecideLinkStart(
            verified: false,
            challengeMatched: false,
            callerIsSignedIn: true,
            issuerIsThisNode: false);

        Assert.NotNull(problem);
        Assert.Contains("could not be verified", problem, StringComparison.Ordinal);
    }

    [Fact]
    public void AddingAServerRefusesAReplayedOrExpiredNonce()
    {
        var problem = IdentityGate.DecideLinkStart(true, false, true, false);

        Assert.NotNull(problem);
        Assert.Contains("too long", problem, StringComparison.Ordinal);
    }

    [Fact]
    public void AddingAServerNeedsNoInvite()
    {
        // The difference from DecideSignIn, and the whole point of the second decision existing.
        // Nobody is asking for an account here: they already hold one, the session proves it, and
        // all the assertion adds is which server they run. Requiring an invite as well would mean
        // an administrator needed an invite to their own server to add their second one.
        Assert.Null(IdentityGate.DecideLinkStart(true, true, callerIsSignedIn: true, issuerIsThisNode: false));
    }

    [Fact]
    public void AddingAServerNeedsASessionHere()
    {
        var problem = IdentityGate.DecideLinkStart(true, true, callerIsSignedIn: false, issuerIsThisNode: false);

        Assert.NotNull(problem);
        Assert.Contains("Sign in", problem, StringComparison.Ordinal);
    }

    [Fact]
    public void AServerCannotOfferItselfToItself()
    {
        // Otherwise it is possible to approve a link with yourself, mint an invite to your own
        // group and join it: the mesh answers by doing nothing and the screens answer by listing
        // this server twice.
        var problem = IdentityGate.DecideLinkStart(true, true, true, issuerIsThisNode: true);

        Assert.NotNull(problem);
        Assert.Contains("this server", problem, StringComparison.Ordinal);
    }

    [Fact]
    public void AnApprovedCodeGoesBackToTheAccountItWasApprovedFor()
    {
        Assert.True(IdentityGate.MayHoldTheCode(false, "user-1", "user-1"));
        // An administrator here could mint another in a tap, so withholding this one buys nothing.
        Assert.True(IdentityGate.MayHoldTheCode(true, "user-1", "somebody-else"));
    }

    [Fact]
    public void AndNotToAnotherMemberOfTheSameServer()
    {
        // The rule that matters. An approval is a decision about one server; the code it minted
        // admits whoever redeems it. A second, ordinary member of the approved server could
        // otherwise meet the standing approval, be handed the code, and redeem it on a node of
        // their own -- a link nobody approved.
        Assert.False(IdentityGate.MayHoldTheCode(false, "user-1", "user-2"));
    }

    [Fact]
    public void TwoAbsentAnswersAreNotTheSamePerson()
    {
        Assert.False(IdentityGate.MayHoldTheCode(false, null, null));
        Assert.False(IdentityGate.MayHoldTheCode(false, "", ""));
        Assert.False(IdentityGate.MayHoldTheCode(false, "   ", "user-1"));
    }

    [Fact]
    public void NodeIdsAreComparedAsValuesRatherThanAsText()
    {
        var node = NodeId();
        Assert.True(IdentityGate.SameNode(node, node.ToUpperInvariant()));
        Assert.True(IdentityGate.SameNode(node, "  " + node + "  "));
        Assert.False(IdentityGate.SameNode(node, NodeId()));
        Assert.False(IdentityGate.SameNode(null, node));
        Assert.False(IdentityGate.SameNode(string.Empty, string.Empty));
    }

    [Fact]
    public void ALinkKeyIsStableAcrossSpelling()
    {
        var node = NodeId();
        Assert.Equal(
            IdentityGate.LinkKey(node, "u1"),
            IdentityGate.LinkKey(node.ToUpperInvariant(), " u1 "));
    }

    [Fact]
    public void ACompleteCredentialIsReadBackCleaned()
    {
        var read = IdentityGate.ReadCredential("  s4lt ", " v3r1f ", 100_000);
        Assert.NotNull(read);
        Assert.Equal("s4lt", read!.Value.Salt);
        Assert.Equal("v3r1f", read.Value.Verifier);
        Assert.Equal(100_000, read.Value.Iterations);
    }

    [Fact]
    public void HalfACredentialIsNoCredential()
    {
        // A salt with no verifier is a password nobody can reproduce; a verifier with no round
        // count cannot be derived again once the client's default moves. Either half would leave
        // somebody holding an account they can never sign in to, and the account gets created
        // either way -- so a partial has to read as "an older client sent none".
        Assert.Null(IdentityGate.ReadCredential("s4lt", null, 100_000));
        Assert.Null(IdentityGate.ReadCredential(null, "v3r1f", 100_000));
        Assert.Null(IdentityGate.ReadCredential("s4lt", "v3r1f", null));
        Assert.Null(IdentityGate.ReadCredential("   ", "v3r1f", 100_000));
        Assert.Null(IdentityGate.ReadCredential("s4lt", "   ", 100_000));
    }

    [Fact]
    public void ARoundCountOutsideTheBoundsIsRefused()
    {
        // The count comes off the wire and is handed back to whoever asks how to sign in, so an
        // absurd one is a way to make every client burn a minute of CPU on a sign-in that was
        // never going to work.
        Assert.Null(IdentityGate.ReadCredential("s4lt", "v3r1f", 0));
        Assert.Null(
            IdentityGate.ReadCredential("s4lt", "v3r1f", IdentityGate.MinPasswordIterations - 1));
        Assert.Null(
            IdentityGate.ReadCredential("s4lt", "v3r1f", IdentityGate.MaxPasswordIterations + 1));
        Assert.NotNull(
            IdentityGate.ReadCredential("s4lt", "v3r1f", IdentityGate.MinPasswordIterations));
        Assert.NotNull(
            IdentityGate.ReadCredential("s4lt", "v3r1f", IdentityGate.MaxPasswordIterations));
    }

    [Fact]
    public void AnAccountWithASaltIsDescribedAsDerived()
    {
        var described = IdentityGate.DescribeSignIn("s4lt", 100_000);
        Assert.True(described.Derived);
        Assert.Equal("s4lt", described.Salt);
        Assert.Equal(100_000, described.Iterations);
    }

    [Fact]
    public void EverythingElseIsDescribedIdentically()
    {
        // The whole shape of this endpoint. It is answered anonymously, so anything that varied
        // with whether the username exists would be a way to find out who has an account here: an
        // ordinary account, an account nobody holds, and a linked account an administrator has
        // reset all have to come back the same.
        foreach (var (salt, rounds) in new (string?, int)[]
                 {
                     (null, 0),
                     (string.Empty, 0),
                     ("   ", 100_000),
                     ("s4lt", 0),
                     ("s4lt", IdentityGate.MinPasswordIterations - 1),
                     ("s4lt", IdentityGate.MaxPasswordIterations + 1),
                 })
        {
            var described = IdentityGate.DescribeSignIn(salt, rounds);
            Assert.False(described.Derived);
            Assert.Equal(string.Empty, described.Salt);
            Assert.Equal(0, described.Iterations);
        }
    }

    private static string NodeId()
        => Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
}
