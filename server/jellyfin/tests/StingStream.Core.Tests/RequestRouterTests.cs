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
}
