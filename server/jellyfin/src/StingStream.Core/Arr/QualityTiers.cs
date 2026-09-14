using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace StingStream.Core.Arr;

/// <summary>
/// The four picture sizes a quality profile is edited in: SD, 720p, 1080p and 4K.
/// </summary>
/// <remarks>
/// <para>
/// A person has an opinion about how big the picture is, not about <c>WEBRip-720p</c> against
/// <c>HDTV-720p</c>, so profiles are edited as a set of tiers and each manager is given every quality
/// it has at those sizes. The resolution is resolved per manager, against that manager's own
/// vocabulary, because the movie and series managers do not offer identical lists.
/// </para>
/// <para>
/// Remuxes, raw disc images and pre-release sources (cams, screeners, telesyncs) belong to no tier.
/// A remux is the whole disc at ten to twenty times the size, and nobody who picked "1080p" meant
/// that; a cam is not a copy anyone wants.
/// </para>
/// </remarks>
public static class QualityTiers
{
    /// <summary>Standard definition: SDTV, DVD, 480p and 576p.</summary>
    public const string Sd = "sd";

    /// <summary>720p.</summary>
    public const string Hd720 = "720p";

    /// <summary>1080p.</summary>
    public const string Hd1080 = "1080p";

    /// <summary>4K.</summary>
    public const string Uhd = "2160p";

    /// <summary>Every tier, worst first.</summary>
    public static readonly IReadOnlyList<string> All = new[] { Sd, Hd720, Hd1080, Uhd };

    private static readonly Regex _excluded = new(
        @"remux|raw-?hd|br-?disk|dvd-r\b|scr|\bcam\b|telesync|telecine|workprint|regional|unknown",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex _sd = new(
        @"sdtv|dvd|480p|576p",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>The tier a quality or group name belongs to, or null for none.</summary>
    public static string? TierOf(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || _excluded.IsMatch(name))
        {
            return null;
        }

        if (name.Contains("2160p", StringComparison.OrdinalIgnoreCase))
        {
            return Uhd;
        }

        if (name.Contains("1080p", StringComparison.OrdinalIgnoreCase))
        {
            return Hd1080;
        }

        if (name.Contains("720p", StringComparison.OrdinalIgnoreCase))
        {
            return Hd720;
        }

        return _sd.IsMatch(name) ? Sd : null;
    }

    /// <summary>Whether a string is one of <see cref="All"/>.</summary>
    public static bool IsTier(string? tier) => tier is not null && All.Contains(tier, StringComparer.OrdinalIgnoreCase);

    /// <summary>The tiers a set of allowed names touches, worst first.</summary>
    public static List<string> Of(IEnumerable<string> allowedNames)
    {
        var found = new HashSet<string>(
            allowedNames.Select(TierOf).OfType<string>(),
            StringComparer.OrdinalIgnoreCase);
        return All.Where(found.Contains).ToList();
    }

    /// <summary>
    /// Turn tiers into the concrete names one manager should allow, and the name to stop upgrading at.
    /// </summary>
    /// <param name="vocabulary">Every quality and group name the manager has.</param>
    /// <param name="tiers">The tiers to allow.</param>
    /// <param name="cutoffTier">
    /// Where upgrading stops. When it is not among <paramref name="tiers"/>, the best allowed tier is
    /// used, so a profile never ends up upgrading forever.
    /// </param>
    /// <returns>The allowed names (empty when the manager has nothing in those tiers) and the cutoff.</returns>
    public static (HashSet<string> Allowed, string Cutoff) Resolve(
        IEnumerable<string> vocabulary,
        IEnumerable<string> tiers,
        string? cutoffTier)
    {
        var wanted = new HashSet<string>(tiers.Where(IsTier), StringComparer.OrdinalIgnoreCase);
        var names = vocabulary.Where(n => TierOf(n) is { } t && wanted.Contains(t)).ToList();
        var allowed = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);

        var stopAt = cutoffTier is not null && wanted.Contains(cutoffTier)
            ? cutoffTier
            : All.LastOrDefault(wanted.Contains);
        var inCutoff = names.Where(n => string.Equals(TierOf(n), stopAt, StringComparison.OrdinalIgnoreCase)).ToList();

        // Bluray is the best ordinary source at every size, and naming it rather than relying on the
        // manager's list order keeps the answer the same whichever way round that list arrives.
        var cutoff = inCutoff.FirstOrDefault(n => n.StartsWith("Bluray-", StringComparison.OrdinalIgnoreCase))
            ?? inCutoff.LastOrDefault()
            ?? string.Empty;

        return (allowed, cutoff);
    }
}
