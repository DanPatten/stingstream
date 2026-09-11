using System;
using System.Collections.Generic;

namespace StingStream.Core.Requests;

/// <summary>
/// Whether a group's requests are fulfilled automatically or by hand.
/// </summary>
/// <remarks>
/// <para>
/// A node with no indexer cannot search for anything, so there is nothing for an approval queue to
/// govern: approving a request would authorise a download that is never going to happen. Such a
/// group runs in **manual** mode, where a request goes straight onto the administrator's wanted
/// list, waits indefinitely, and resolves itself when the library ends up serving the same item
/// however the administrator got hold of it. A group where somebody *can* search runs in
/// **automatic** mode, which is the behaviour that has always existed: policy, approval, routing,
/// grabbing.
/// </para>
/// <para>
/// **Configured, not capable.** The signal is <see cref="FulfilCapability.HasIndexers"/> and not
/// <see cref="FulfilCapability.CanFulfil"/>, because the latter also goes false when an indexer
/// stops answering, when an arr is restarting, or when a disk fills up. Resting mode on that would
/// mean a three minute outage silently deleted the approval policy screen and let requests through
/// unapproved, which is a governance change nobody asked for and nobody would notice. Configuration
/// only moves when a person moves it, so mode only moves when a person moves it.
/// </para>
/// <para>
/// **Offline peers still count**, for the same reason. A node that is merely unreachable has not
/// stopped having indexers, and a laptop closing its lid must not change how the household's
/// requests are governed. An offline node is the limit case of an outage, and the answer there has
/// to be the same one.
/// </para>
/// <para>
/// **Group-wide, not per node.** Policy and trust are already stored per group, and
/// <see cref="RequestRouter"/> already routes to any capable peer regardless of whose request it
/// was. A request therefore spends the group's bandwidth and the group's disk, so a laptop with no
/// indexers sitting in a group with a capable server must not get to skip the queue that governs
/// them. One member with indexers puts the whole group in automatic mode.
/// </para>
/// </remarks>
public static class GroupMode
{
    /// <summary>Whether a group fulfils requests automatically.</summary>
    /// <param name="home">This node's own capability.</param>
    /// <param name="peers">
    /// Every other member's advertised capability. Empty for a standalone node, which is then
    /// judged on its own configuration alone.
    /// </param>
    /// <returns>
    /// True when at least one member has an indexer configured, and requests should go through
    /// policy and approval. False when none does, and requests go onto the wanted list.
    /// </returns>
    public static bool IsAutomatic(FulfilCapability home, IReadOnlyList<FulfilCapability> peers)
    {
        ArgumentNullException.ThrowIfNull(home);
        ArgumentNullException.ThrowIfNull(peers);

        if (home.HasIndexers)
        {
            return true;
        }

        for (var i = 0; i < peers.Count; i++)
        {
            // Online is deliberately not consulted. See the remarks.
            if (peers[i].HasIndexers)
            {
                return true;
            }
        }

        return false;
    }
}
