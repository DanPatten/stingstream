using System;
using System.Collections.Generic;
using System.Linq;

namespace StingStream.Core.Requests;

/// <summary>What this node, or a peer, can do about a request.</summary>
public sealed class FulfilCapability
{
    /// <summary>The node id. Empty for "this node", which does not know its own id yet.</summary>
    public string Node { get; set; } = string.Empty;

    public string ServerName { get; set; } = string.Empty;

    public bool Online { get; set; } = true;

    /// <summary>Radarr, at least one movie indexer, a root folder, and room.</summary>
    public bool CanFulfilMovies { get; set; }

    /// <summary>Sonarr, at least one TV indexer, a root folder, and room.</summary>
    public bool CanFulfilTv { get; set; }

    /// <summary>Free bytes on the volume holding the node's media.</summary>
    public long FreeSpace { get; set; }

    /// <summary>
    /// Whether this node has at least one indexer configured, enabled or not.
    /// </summary>
    /// <remarks>
    /// Deliberately not the same question as <see cref="CanFulfilMovies"/>. Those go false whenever
    /// an indexer stops answering or an arr is restarting, which is exactly when the group must
    /// *not* change its mind about how requests are governed. This one only moves when somebody
    /// adds or removes an indexer, so <see cref="GroupMode"/> can rest on it without flapping.
    /// </remarks>
    public bool HasIndexers { get; set; }

    /// <summary>Whether this node could fulfil a request of a given kind.</summary>
    /// <param name="kind"><c>movie</c> or <c>series</c>.</param>
    /// <returns>True when it could.</returns>
    public bool CanFulfil(string kind)
        => Online && (string.Equals(kind, "movie", StringComparison.OrdinalIgnoreCase)
            ? CanFulfilMovies
            : CanFulfilTv);
}

/// <summary>Who should fulfil a request, and why.</summary>
public sealed class RoutingDecision
{
    /// <summary>The node that should claim it, or null when nobody in the group can.</summary>
    public FulfilCapability? Node { get; set; }

    /// <summary>Whether that node is this one.</summary>
    public bool IsHome { get; set; }

    /// <summary>A sentence a person can read.</summary>
    public string Reason { get; set; } = string.Empty;
}

/// <summary>
/// Picks the node that should grab a request.
/// </summary>
/// <remarks>
/// <para>
/// Pure functions over capabilities, deliberately: the same input has to produce the same answer on
/// every member of the group, because the claim protocol only converges if the volunteers agree
/// about who *ought* to win before they race for it. Anything that reached out to a service here
/// would make the decision depend on which node asked.
/// </para>
/// <para>
/// The order is: the requester's home node first, then the volunteer with the most free space, node
/// id breaking a tie. Home first is not politeness — it is the only choice that keeps a request
/// working when the group is one node, and it makes the common case (a household where one machine
/// has the indexers) route with no gossip round trip at all. Free space rather than, say, measured
/// bandwidth, because what a fulfilling node spends is disk: it has to keep the file, and a node
/// with 4 GB left will fail the import however fast its link is.
/// </para>
/// </remarks>
public static class RequestRouter
{
    /// <summary>
    /// Bytes a node must have free before it will volunteer.
    /// </summary>
    /// <remarks>
    /// Twenty gigabytes: comfortably more than one film at any sane bitrate and more than a season
    /// of TV at 1080p, and small enough that an ordinary home server still qualifies. The
    /// point is not to predict the release size — nobody knows it at request time — but to keep a
    /// nearly-full node from claiming a request it will fail an hour later, by which time the
    /// requester has been told it is being fulfilled.
    /// </remarks>
    public const long FreeSpaceFloor = 20L * 1024 * 1024 * 1024;

    /// <summary>Choose a fulfilling node.</summary>
    /// <param name="kind"><c>movie</c> or <c>series</c>.</param>
    /// <param name="home">This node's own capability.</param>
    /// <param name="peers">Every other member's advertised capability.</param>
    /// <returns>The decision. <see cref="RoutingDecision.Node"/> is null when nobody can.</returns>
    public static RoutingDecision Route(
        string kind,
        FulfilCapability home,
        IReadOnlyList<FulfilCapability> peers)
    {
        ArgumentNullException.ThrowIfNull(home);
        ArgumentNullException.ThrowIfNull(peers);

        if (home.CanFulfil(kind) && home.FreeSpace >= FreeSpaceFloor)
        {
            return new RoutingDecision
            {
                Node = home,
                IsHome = true,
                Reason = "The requester's own node has the indexers and the room, so it grabs it.",
            };
        }

        var volunteers = peers
            .Where(p => p.CanFulfil(kind) && p.FreeSpace >= FreeSpaceFloor)
            .OrderByDescending(p => p.FreeSpace)
            .ThenBy(p => p.Node, StringComparer.Ordinal)
            .ToList();

        if (volunteers.Count == 0)
        {
            return new RoutingDecision
            {
                Node = null,
                IsHome = false,
                Reason = home.CanFulfil(kind)
                    ? "The only node that could grab this is short of disk space."
                    : $"No node in the group advertises that it can grab a {Noun(kind)}.",
            };
        }

        return new RoutingDecision
        {
            Node = volunteers[0],
            IsHome = false,
            Reason = string.Create(
                System.Globalization.CultureInfo.InvariantCulture,
                $"{volunteers[0].ServerName} has the indexers and {volunteers[0].FreeSpace / (1024L * 1024 * 1024)} GB free."),
        };
    }

    /// <summary>
    /// Narrow the candidates to the ones a reason allows to act, before <see cref="Route"/> runs.
    /// </summary>
    /// <param name="reason">One of <see cref="RequestReasons"/>, or null for an ordinary request.</param>
    /// <param name="home">This node's own capability.</param>
    /// <param name="peers">Every other member's advertised capability.</param>
    /// <param name="holders">Node ids that already hold the title.</param>
    /// <returns>
    /// The narrowed capabilities to hand to <see cref="Route"/>, and a sentence when the reason
    /// leaves nobody who may act. A non-null reason there means the request cannot proceed.
    /// </returns>
    /// <remarks>
    /// <para>
    /// A separate function rather than an argument to <see cref="Route"/>, which knows about
    /// capacity and nothing about who holds what, and whose existing behaviour must not move.
    /// Candidates the reason forbids are returned with their fulfil flags cleared rather than
    /// removed, so <see cref="Route"/>'s own ordering, free-space floor and home-first bias all
    /// still apply to whoever is left.
    /// </para>
    /// <para>
    /// **This is also what keeps one node from acting on another's disk.** Every member runs the
    /// same pass over the same gossiped request and decides for itself whether to claim. A node
    /// only passes this filter when it is itself a holder (for a replace) or itself not one (for a
    /// second version), so whichever node ends up claiming has decided about files it owns. Nothing
    /// is commanded across the wire, and no message needed inventing to say so.
    /// </para>
    /// <para>
    /// The two reasons pull in opposite directions, which is the whole point. Replacing a bad copy
    /// has to happen where the bad copy is. Keeping both qualities needs a *second* node, because a
    /// download manager tracks one file per title and would upgrade over the first rather than sit
    /// beside it — so a standalone node can never satisfy it, and says so rather than trying.
    /// </para>
    /// </remarks>
    public static (FulfilCapability Home, IReadOnlyList<FulfilCapability> Peers, string? BlockedReason)
        ApplyHolderConstraint(
            string? reason,
            FulfilCapability home,
            IReadOnlyList<FulfilCapability> peers,
            IReadOnlySet<string> holders)
    {
        ArgumentNullException.ThrowIfNull(home);
        ArgumentNullException.ThrowIfNull(peers);
        ArgumentNullException.ThrowIfNull(holders);

        var parsed = RequestReasons.Parse(reason);
        if (parsed is not (RequestReasons.BetterQuality or RequestReasons.BadCopy))
        {
            return (home, peers, null);
        }

        var wantHolder = parsed == RequestReasons.BadCopy;
        var narrowedHome = Narrow(home, holders, wantHolder);
        var narrowedPeers = new List<FulfilCapability>(peers.Count);
        for (var i = 0; i < peers.Count; i++)
        {
            narrowedPeers.Add(Narrow(peers[i], holders, wantHolder));
        }

        // Online matters here as much as the flags do, the same way it does inside CanFulfil: the
        // one node allowed to replace a copy being unreachable is precisely the case worth saying
        // out loud, rather than letting it fall through to Route's much vaguer "nobody advertises
        // that it can grab a film".
        var anybody = Usable(narrowedHome);
        for (var i = 0; !anybody && i < narrowedPeers.Count; i++)
        {
            anybody = Usable(narrowedPeers[i]);
        }

        if (anybody)
        {
            return (narrowedHome, narrowedPeers, null);
        }

        return (
            narrowedHome,
            narrowedPeers,
            wantHolder
                ? "Only the node holding this copy can replace it, and it cannot do that right now."
                : "Keeping both versions needs a second node that does not already hold this one.");
    }

    /// <summary>Whether a candidate could grab anything at all, of either kind.</summary>
    /// <param name="node">The candidate.</param>
    /// <returns>True when it is online and offers at least one kind.</returns>
    private static bool Usable(FulfilCapability node)
        => node.Online && (node.CanFulfilMovies || node.CanFulfilTv);

    /// <summary>Clear a candidate's fulfil flags when the reason does not let it act.</summary>
    /// <param name="node">The candidate.</param>
    /// <param name="holders">Node ids that already hold the title.</param>
    /// <param name="wantHolder">True to keep only holders, false to keep only non-holders.</param>
    /// <returns>The candidate, or a copy of it that cannot fulfil anything.</returns>
    private static FulfilCapability Narrow(
        FulfilCapability node,
        IReadOnlySet<string> holders,
        bool wantHolder)
    {
        if (holders.Contains(node.Node) == wantHolder)
        {
            return node;
        }

        return new FulfilCapability
        {
            Node = node.Node,
            ServerName = node.ServerName,
            Online = node.Online,
            CanFulfilMovies = false,
            CanFulfilTv = false,
            FreeSpace = node.FreeSpace,
            HasIndexers = node.HasIndexers,
        };
    }

    private static string Noun(string kind)
        => string.Equals(kind, "movie", StringComparison.OrdinalIgnoreCase) ? "film" : "series";
}
