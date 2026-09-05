using System;
using System.Collections.Generic;
using System.Linq;

namespace StingStream.Core.Requests;

/// <summary>What this node, or a peer, can do about a request.</summary>
public sealed class FulfilCapability
{
    /// <summary>The node id. Empty for "this node", which does not know its own id yet.</summary>
    public string Node { get; set; } = string.Empty;

    public string NodeName { get; set; } = string.Empty;

    public bool Online { get; set; } = true;

    /// <summary>Radarr, at least one movie indexer, a root folder, and room.</summary>
    public bool CanFulfilMovies { get; set; }

    /// <summary>Sonarr, at least one TV indexer, a root folder, and room.</summary>
    public bool CanFulfilTv { get; set; }

    /// <summary>Free bytes on the volume holding the node's media.</summary>
    public long FreeSpace { get; set; }

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
    /// of television at 1080p, and small enough that an ordinary home server still qualifies. The
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
                $"{volunteers[0].NodeName} has the indexers and {volunteers[0].FreeSpace / (1024L * 1024 * 1024)} GB free."),
        };
    }

    private static string Noun(string kind)
        => string.Equals(kind, "movie", StringComparison.OrdinalIgnoreCase) ? "film" : "series";
}
