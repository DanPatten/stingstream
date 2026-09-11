using System;
using System.Collections.Generic;
using StingStream.Core.Requests;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Whether a group governs its requests by approval, or by an administrator's wanted list.
/// </summary>
/// <remarks>
/// The whole value of this function is that it answers "has anybody configured an indexer" and not
/// "can anybody reach one right now". The two are easy to conflate and the difference is only
/// visible in the outage tests below: a group whose indexers are all down keeps its approval
/// policy, because an administrator restarting a service has not asked to change how requests are
/// governed. Most of this file exists to pin that distinction.
/// </remarks>
public class GroupModeTests
{
    private const long Plenty = 500L * 1024 * 1024 * 1024;

    private static FulfilCapability Node(
        string id,
        bool hasIndexers = true,
        bool canFulfil = true,
        bool online = true)
        => new()
        {
            Node = id,
            ServerName = id,
            Online = online,
            CanFulfilMovies = canFulfil,
            CanFulfilTv = canFulfil,
            FreeSpace = Plenty,
            HasIndexers = hasIndexers,
        };

    private static readonly FulfilCapability[] Alone = Array.Empty<FulfilCapability>();

    [Fact]
    public void A_fresh_install_is_manual()
    {
        // The out-of-box state, and the reason this feature exists: nothing ships configured, so a
        // brand new node has nowhere to search and no business showing an approval queue.
        Assert.False(GroupMode.IsAutomatic(Node("home", hasIndexers: false), Alone));
    }

    [Fact]
    public void A_standalone_node_with_an_indexer_is_automatic()
    {
        Assert.True(GroupMode.IsAutomatic(Node("home"), Alone));
    }

    [Fact]
    public void One_peer_with_an_indexer_puts_the_whole_group_in_automatic()
    {
        // A laptop with no indexers in a household whose server has them. The request spends the
        // group's bandwidth, so it goes through the group's approval policy.
        var home = Node("laptop", hasIndexers: false);
        Assert.True(GroupMode.IsAutomatic(home, new[] { Node("loft") }));
    }

    [Fact]
    public void A_group_where_nobody_has_an_indexer_is_manual()
    {
        var home = Node("laptop", hasIndexers: false);
        var peers = new[] { Node("loft", hasIndexers: false), Node("shed", hasIndexers: false) };
        Assert.False(GroupMode.IsAutomatic(home, peers));
    }

    [Fact]
    public void An_indexer_that_has_stopped_answering_does_not_flip_the_group_to_manual()
    {
        // The outage case, and the point of reading HasIndexers rather than CanFulfil. Radarr is
        // restarting, or every indexer is timing out, so this node can fulfil nothing at all. The
        // approval policy must survive that: it is a configuration, not a health check.
        var home = Node("home", hasIndexers: true, canFulfil: false);
        Assert.True(GroupMode.IsAutomatic(home, Alone));
    }

    [Fact]
    public void An_offline_peer_still_counts_as_configured()
    {
        // A closed laptop is the limit case of an outage. It has not stopped having indexers, and
        // the household's requests must not change how they are governed because somebody went out.
        var home = Node("home", hasIndexers: false);
        var peers = new[] { Node("laptop", online: false) };
        Assert.True(GroupMode.IsAutomatic(home, peers));
    }

    [Fact]
    public void A_disabled_indexer_still_counts_as_configured()
    {
        // HasIndexers is deliberately "configured, enabled or not". Somebody who has switched their
        // only indexer off temporarily has still set this group up to work by approval, and toggling
        // it back on must not need the policy screen to reappear first.
        Assert.True(GroupMode.IsAutomatic(Node("home", hasIndexers: true, canFulfil: false), Alone));
    }

    [Fact]
    public void The_answer_does_not_depend_on_which_member_asks()
    {
        // Every node evaluates this over the same gossiped capabilities. If two disagreed, one would
        // show an approval queue governing requests the other had already let through.
        var configured = Node("loft");
        var bare = Node("laptop", hasIndexers: false);

        Assert.True(GroupMode.IsAutomatic(bare, new[] { configured }));
        Assert.True(GroupMode.IsAutomatic(configured, new[] { bare }));
    }

    [Fact]
    public void A_null_argument_is_a_bug_rather_than_a_mode()
    {
        Assert.Throws<ArgumentNullException>(() => GroupMode.IsAutomatic(null!, Alone));
        Assert.Throws<ArgumentNullException>(() => GroupMode.IsAutomatic(Node("home"), null!));
    }
}
