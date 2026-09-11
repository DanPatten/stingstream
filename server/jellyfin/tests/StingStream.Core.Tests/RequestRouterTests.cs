using System;
using System.Collections.Generic;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Which node should grab a request.
/// </summary>
/// <remarks>
/// Every member of the group runs this function over the same advertised capabilities, so it has to
/// be a pure function of them: if two members disagreed about who *ought* to fulfil a request, both
/// would claim, and the group would pay for the title twice. That is why there is nothing to mock
/// here — the router is arithmetic over four fields.
/// </remarks>
public class RequestRouterTests
{
    private const long Plenty = 500L * 1024 * 1024 * 1024;

    private static FulfilCapability Node(
        string id,
        bool movies = true,
        bool tv = true,
        long free = Plenty,
        bool online = true)
        => new()
        {
            Node = id,
            NodeName = id,
            Online = online,
            CanFulfilMovies = movies,
            CanFulfilTv = tv,
            FreeSpace = free,
        };

    [Fact]
    public void The_requesters_own_node_takes_it_when_it_can()
    {
        // The case with no network in it at all, and the one a household where the media server is
        // also the app server hits every time.
        var decision = RequestRouter.Route("movie", Node("home"), new[] { Node("loft") });
        Assert.True(decision.IsHome);
        Assert.Equal("home", decision.Node!.Node);
    }

    [Fact]
    public void A_home_node_with_no_indexers_hands_it_to_a_volunteer()
    {
        // The acceptance case: a laptop with no usenet asks for a series, and the machine with the
        // indexers grabs it.
        var home = Node("home", movies: false, tv: false);
        var decision = RequestRouter.Route("series", home, new[] { Node("loft") });
        Assert.False(decision.IsHome);
        Assert.Equal("loft", decision.Node!.Node);
    }

    [Fact]
    public void A_node_that_can_grab_films_is_not_volunteered_a_series()
    {
        // Radarr and Sonarr are separate, and so are their indexer lists. A node with movie
        // indexers only must not be handed a TV request it cannot search for.
        var home = Node("home", movies: false, tv: false);
        var decision = RequestRouter.Route("series", home, new[] { Node("films-only", movies: true, tv: false) });
        Assert.Null(decision.Node);
        Assert.Contains("series", decision.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void The_volunteer_with_the_most_room_wins()
    {
        var home = Node("home", movies: false, tv: false);
        var decision = RequestRouter.Route(
            "movie",
            home,
            new[]
            {
                Node("small", free: 40L * 1024 * 1024 * 1024),
                Node("big", free: 900L * 1024 * 1024 * 1024),
            });
        Assert.Equal("big", decision.Node!.Node);
    }

    [Fact]
    public void Equal_room_is_broken_by_node_id_so_every_member_agrees()
    {
        // Ordinal on the node id, not on the display name: node ids are public keys and are the
        // same on every member, while names are whatever their owners typed.
        var home = Node("home", movies: false, tv: false);
        var peers = new List<FulfilCapability> { Node("zzzz"), Node("aaaa") };
        Assert.Equal("aaaa", RequestRouter.Route("movie", home, peers).Node!.Node);
        peers.Reverse();
        Assert.Equal("aaaa", RequestRouter.Route("movie", home, peers).Node!.Node);
    }

    [Fact]
    public void An_offline_node_is_not_a_volunteer()
    {
        var home = Node("home", movies: false, tv: false);
        var decision = RequestRouter.Route("movie", home, new[] { Node("asleep", online: false) });
        Assert.Null(decision.Node);
    }

    [Fact]
    public void A_nearly_full_node_does_not_claim_a_request_it_would_fail()
    {
        // Not a prediction of the release size -- nobody knows it at request time. The floor is
        // there so a node with four gigabytes left does not take a request, tell the requester it
        // is in progress, and fail the import an hour later.
        var home = Node("home", free: 4L * 1024 * 1024 * 1024);
        var decision = RequestRouter.Route("movie", home, Array.Empty<FulfilCapability>());
        Assert.Null(decision.Node);
        Assert.Contains("disk space", decision.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void A_full_home_node_still_lets_a_peer_take_it()
    {
        var home = Node("home", free: 1L * 1024 * 1024 * 1024);
        var decision = RequestRouter.Route("movie", home, new[] { Node("loft") });
        Assert.False(decision.IsHome);
        Assert.Equal("loft", decision.Node!.Node);
    }

    [Fact]
    public void Nobody_able_is_a_decision_with_a_reason_rather_than_an_exception()
    {
        // The request has to end up "failed, because nobody in the group has an indexer for it",
        // which is a sentence the requester can act on. Throwing here would put that in a log.
        var decision = RequestRouter.Route(
            "movie",
            Node("home", movies: false, tv: false),
            Array.Empty<FulfilCapability>());
        Assert.Null(decision.Node);
        Assert.False(string.IsNullOrWhiteSpace(decision.Reason));
    }

    [Fact]
    public void A_standalone_node_routes_to_itself_with_no_peers_at_all()
    {
        var decision = RequestRouter.Route("series", Node("only"), Array.Empty<FulfilCapability>());
        Assert.True(decision.IsHome);
    }

    [Fact]
    public void Routing_is_stable_across_repeated_calls()
    {
        // Every member computes this independently and they must agree, so the same inputs have to
        // give the same answer however many times they are asked.
        var home = Node("home", movies: false, tv: false);
        var peers = new[] { Node("a"), Node("b"), Node("c") };
        var first = RequestRouter.Route("movie", home, peers).Node!.Node;
        for (var i = 0; i < 5; i++)
        {
            Assert.Equal(first, RequestRouter.Route("movie", home, peers).Node!.Node);
        }
    }

    // --- acting on a copy the group already holds --------------------------

    private static HashSet<string> Holders(params string[] nodes)
        => new(nodes, StringComparer.Ordinal);

    [Fact]
    public void An_ordinary_request_is_not_narrowed_at_all()
    {
        // Nothing without a destructive reason may be affected by this, including a request for a
        // missing episode, which adds something the group does not have.
        foreach (var reason in new[] { null, RequestReasons.MissingEpisode, "nonsense" })
        {
            var home = Node("home");
            var peers = new[] { Node("loft") };
            var (h, p, blocked) = RequestRouter.ApplyHolderConstraint(reason, home, peers, Holders("home"));
            Assert.Same(home, h);
            Assert.Same(peers, p);
            Assert.Null(blocked);
        }
    }

    [Fact]
    public void Replacing_a_bad_copy_is_left_to_the_node_that_holds_it()
    {
        // The disk belongs to whoever runs that node. Nothing here reaches across to it: the peer
        // that holds the file is the only candidate left standing, and it decides on its own pass.
        var (h, p, blocked) = RequestRouter.ApplyHolderConstraint(
            RequestReasons.BadCopy,
            Node("home"),
            new[] { Node("loft"), Node("shed") },
            Holders("loft"));

        Assert.Null(blocked);
        Assert.False(h.CanFulfil("movie"));
        Assert.True(p[0].CanFulfil("movie"));
        Assert.False(p[1].CanFulfil("movie"));
    }

    [Fact]
    public void A_replace_is_blocked_when_no_holder_can_act()
    {
        // Somebody asked to replace a copy only an offline peer has. Saying so is better than
        // routing it to a node that would grab a second copy nobody asked for.
        var (_, _, blocked) = RequestRouter.ApplyHolderConstraint(
            RequestReasons.BadCopy,
            Node("home"),
            new[] { Node("loft", online: false) },
            Holders("loft"));

        Assert.False(string.IsNullOrWhiteSpace(blocked));
    }

    [Fact]
    public void Keeping_both_qualities_needs_a_node_that_does_not_hold_it()
    {
        // The mirror image: a download manager tracks one file per title, so a second quality has
        // to be grabbed somewhere else or it would simply upgrade over the first.
        var (h, p, blocked) = RequestRouter.ApplyHolderConstraint(
            RequestReasons.BetterQuality,
            Node("home"),
            new[] { Node("loft") },
            Holders("home"));

        Assert.Null(blocked);
        Assert.False(h.CanFulfil("movie"));
        Assert.True(p[0].CanFulfil("movie"));
    }

    [Fact]
    public void A_standalone_node_can_never_keep_both_qualities()
    {
        // One node, and it is always its own only holder. This can never succeed, so it fails now
        // with a sentence rather than after six hours of a claim nobody could satisfy.
        var (_, _, blocked) = RequestRouter.ApplyHolderConstraint(
            RequestReasons.BetterQuality,
            Node("only"),
            Array.Empty<FulfilCapability>(),
            Holders("only"));

        Assert.False(string.IsNullOrWhiteSpace(blocked));
    }

    [Fact]
    public void A_narrowed_candidate_keeps_everything_except_its_offer_to_grab()
    {
        // Route still has to see real free space and a real name for whoever is left, and the
        // blocked ones have to look incapable rather than absent.
        var (h, _, _) = RequestRouter.ApplyHolderConstraint(
            RequestReasons.BadCopy,
            Node("home", free: 123),
            Array.Empty<FulfilCapability>(),
            Holders("loft"));

        Assert.Equal("home", h.Node);
        Assert.Equal(123, h.FreeSpace);
        Assert.False(h.CanFulfilMovies);
        Assert.False(h.CanFulfilTv);
    }

    [Fact]
    public void The_narrowed_result_still_routes_by_the_ordinary_rules()
    {
        // The constraint decides who *may* act; everything after it is Route's job, unchanged. Here
        // two peers may, and the one with more room still wins.
        var (h, p, _) = RequestRouter.ApplyHolderConstraint(
            RequestReasons.BetterQuality,
            Node("home"),
            new[] { Node("small", free: Plenty), Node("big", free: Plenty * 2) },
            Holders("home"));

        var decision = RequestRouter.Route("movie", h, p);
        Assert.Equal("big", decision.Node!.Node);
    }
}
