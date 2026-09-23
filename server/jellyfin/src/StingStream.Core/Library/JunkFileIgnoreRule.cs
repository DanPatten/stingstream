using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Emby.Naming.Common;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Model.IO;

namespace StingStream.Core.Library;

/// <summary>
/// Keeps release-group promo clips and sample cuts out of the libraries.
/// </summary>
/// <remarks>
/// <para>
/// Dan, on a v0.2.1 beta after adding a folder of films: a movie called "RARBG.com" on the home
/// page. Some releases ship a few seconds of advert beside the film, named after the site that
/// made them (<c>RARBG.com.mp4</c>, <c>www.YTS.MX.mp4</c>, <c>ETRG.mp4</c>). A folder holding two
/// videos that are neither stacked parts nor versions of each other is read by the movie resolver
/// as two movies, so the advert got a card, a search against TMDb, and a place in Recently added.
/// </para>
/// <para>
/// Upstream already ignores <c>sample.mkv</c>, <c>*.sample.mkv</c> and a <c>sample</c> folder
/// (<c>IgnorePatterns</c>), and files with a <c>-sample</c> or <c>-trailer</c> suffix are extras
/// (<c>NamingOptions.VideoExtraRules</c>), which never show as movies. This fills the gaps without
/// patching either: a rule exported from this assembly is picked up by
/// <c>ApplicationHost.GetExports&lt;IResolverIgnoreRule&gt;</c> beside the core ones.
/// </para>
/// <para>
/// Deliberately narrow, because a false positive hides a film somebody owns and gives no hint
/// why. Only video files, and apart from a handful of exact names, only small ones: a promo clip
/// is a few megabytes, and nothing named like a web address that is over
/// <see cref="MaxJunkBytes"/> is treated as one. "The.Net.mkv" at 1.4 GB stays a movie.
/// </para>
/// </remarks>
public sealed class JunkFileIgnoreRule : IResolverIgnoreRule
{
    /// <summary>The largest file the name heuristics may call junk. Promo clips are a few MB.</summary>
    public const long MaxJunkBytes = 150L * 1024 * 1024;

    /// <summary>Exact base names (no extension) of promo files, ignored at any size.</summary>
    /// <remarks>Only names no film is ever called. Compared ignoring case.</remarks>
    private static readonly HashSet<string> _promoNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "RARBG",
        "RARBG.com",
        "RARBG_DO_NOT_MIRROR",
        "ETRG",
        "www.YTS.MX",
        "www.YTS.AM",
        "www.YTS.LT",
        "YTSProxies.com",
        "YIFYStatus.com",
    };

    /// <summary>A base name that is nothing but a web address: <c>www.site.to</c>, <c>site.com</c>.</summary>
    /// <remarks>
    /// No spaces, at least one dot, and a top-level domain release groups actually use. A real
    /// title with spaces ("Dr. No") or ending in a year or a quality tag cannot match.
    /// </remarks>
    private static readonly Regex _domainName = new(
        @"^(www\.)?([a-z0-9][a-z0-9-]*\.)+(com|net|org|to|info|me|tv|cc|ws|mx|am|lt|ag|se|nu|io|is|la|pw|xyz|ru|club|site|top|vip|link|lol|biz|co)$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled,
        TimeSpan.FromMilliseconds(200));

    /// <summary>A sample named with the word first: <c>sample-abc.mkv</c>, <c>Sample_Movie.mkv</c>.</summary>
    /// <remarks>The <c>*.sample.mkv</c> and <c>*-sample.mkv</c> shapes are already handled upstream.</remarks>
    private static readonly Regex _samplePrefix = new(
        @"^sample[-_. ]",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled,
        TimeSpan.FromMilliseconds(200));

    private readonly HashSet<string> _videoExtensions;

    /// <summary>Initializes a new instance of the <see cref="JunkFileIgnoreRule"/> class.</summary>
    /// <param name="namingOptions">The server's naming options, for what counts as a video file.</param>
    public JunkFileIgnoreRule(NamingOptions namingOptions)
    {
        ArgumentNullException.ThrowIfNull(namingOptions);
        _videoExtensions = new HashSet<string>(namingOptions.VideoFileExtensions, StringComparer.OrdinalIgnoreCase);
    }

    /// <inheritdoc />
    public bool ShouldIgnore(FileSystemMetadata fileInfo, BaseItem? parent)
    {
        ArgumentNullException.ThrowIfNull(fileInfo);
        if (fileInfo.IsDirectory)
        {
            return false;
        }

        var extension = Path.GetExtension(fileInfo.Name);
        if (string.IsNullOrEmpty(extension) || !_videoExtensions.Contains(extension))
        {
            return false;
        }

        return IsJunk(Path.GetFileNameWithoutExtension(fileInfo.Name), fileInfo.Length);
    }

    /// <summary>Whether a video with this base name and size is a promo clip or a sample.</summary>
    /// <param name="baseName">The file name without its extension.</param>
    /// <param name="length">Its size in bytes; zero or less when unknown.</param>
    /// <returns>True when it should not become a library item.</returns>
    public static bool IsJunk(string? baseName, long length)
    {
        if (string.IsNullOrWhiteSpace(baseName))
        {
            return false;
        }

        var name = baseName.Trim();
        if (_promoNames.Contains(name))
        {
            return true;
        }

        // Every heuristic below is a guess from the name alone, so it needs the size to agree.
        // An unknown size is not agreement.
        if (length <= 0 || length > MaxJunkBytes)
        {
            return false;
        }

        return IsDomainName(name) || _samplePrefix.IsMatch(name);
    }

    private static bool IsDomainName(string name)
    {
        // A label that is all digits is a version or a year ("1.0.com" is not a site anybody
        // advertises), so at least one letter has to appear before the top-level domain.
        return _domainName.IsMatch(name)
            && name[..name.LastIndexOf('.')].Any(char.IsLetter);
    }
}
