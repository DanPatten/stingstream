using System;
using System.Collections.Generic;
using System.Linq;

namespace StingStream.Core.Arr;

/// <summary>One of the profiles every node starts with.</summary>
/// <param name="Name">Its name, which is its identity in both managers.</param>
/// <param name="Tiers">The <see cref="QualityTiers"/> it allows.</param>
/// <param name="CutoffTier">The tier at which upgrading stops.</param>
public sealed record BuiltInQualityProfile(string Name, IReadOnlyList<string> Tiers, string CutoffTier);

/// <summary>
/// Any, High, Medium and Low: the profiles a node starts with, and what Reset puts back.
/// </summary>
/// <remarks>
/// Dan, 2026-09-13: <i>"start with Any, High, Med, and Low quality as defaults. Users can modify
/// these, reset to default or add their own."</i> They can be edited and reset, never deleted, so
/// the default profile always has somewhere to point.
/// </remarks>
public static class BuiltInQualityProfiles
{
    /// <summary>The profile a node uses when nothing else has been chosen.</summary>
    public const string DefaultName = "Medium";

    /// <summary>The four, in the order they are listed.</summary>
    public static readonly IReadOnlyList<BuiltInQualityProfile> All = new[]
    {
        new BuiltInQualityProfile(
            "Any",
            new[] { QualityTiers.Sd, QualityTiers.Hd720, QualityTiers.Hd1080, QualityTiers.Uhd },
            QualityTiers.Hd1080),
        new BuiltInQualityProfile("High", new[] { QualityTiers.Hd1080, QualityTiers.Uhd }, QualityTiers.Uhd),
        new BuiltInQualityProfile("Medium", new[] { QualityTiers.Hd720, QualityTiers.Hd1080 }, QualityTiers.Hd1080),
        new BuiltInQualityProfile("Low", new[] { QualityTiers.Sd, QualityTiers.Hd720 }, QualityTiers.Hd720),
    };

    /// <summary>The built-in with this name, or null.</summary>
    public static BuiltInQualityProfile? Find(string? name)
        => All.FirstOrDefault(p => string.Equals(p.Name, name?.Trim(), StringComparison.OrdinalIgnoreCase));

    /// <summary>Whether this name belongs to a built-in.</summary>
    public static bool IsBuiltIn(string? name) => Find(name) is not null;

    /// <summary>Where a built-in sits in the list, or <see cref="int.MaxValue"/> for anything else.</summary>
    public static int Rank(string? name)
    {
        for (var i = 0; i < All.Count; i++)
        {
            if (string.Equals(All[i].Name, name, StringComparison.OrdinalIgnoreCase))
            {
                return i;
            }
        }

        return int.MaxValue;
    }

    /// <summary>The built-in as a write the profile service understands.</summary>
    public static QualityProfileView ToView(BuiltInQualityProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        return new QualityProfileView
        {
            Name = profile.Name,
            UpgradeAllowed = true,
            Tiers = profile.Tiers.ToList(),
            CutoffTier = profile.CutoffTier,
        };
    }
}
