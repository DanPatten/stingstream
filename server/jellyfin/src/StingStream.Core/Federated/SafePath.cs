using System;
using System.Globalization;
using System.Linq;
using System.Text;

namespace StingStream.Core.Federated;

/// <summary>
/// Turns peer-supplied text into a filesystem path component that is safe on every platform.
/// </summary>
/// <remarks>
/// **This is a security boundary, not a tidiness helper.** Every title, series name and node label
/// that reaches the federated materializer came over the network from another node, and each one
/// becomes a directory or file name under <c>$STINGSTREAM_DATA/federated</c>. A peer that names a
/// film <c>../../../../etc/cron.d/x</c>, or <c>..\..\jellyfin\config\system.xml</c>, or
/// <c>CON</c>, or a 4 000-character string, must not be able to make this node write outside its
/// federated tree, overwrite something, or fail in a way that stops the whole materialization.
///
/// The approach is allow-list rather than deny-list: build the result character by character out
/// of things that are unambiguously safe, instead of trying to strip everything dangerous out of
/// arbitrary input. Anything that reduces to nothing gets a deterministic fallback, so a hostile
/// or merely empty title still produces a stable, unique folder rather than an exception.
///
/// The caller must **also** verify the assembled path is under the federated root — see
/// <see cref="IsUnder"/>. Belt and braces: this function is the belt.
/// </remarks>
public static class SafePath
{
    /// <summary>
    /// Maximum length of one sanitised component.
    /// </summary>
    /// <remarks>
    /// Not a filesystem limit (most allow 255 bytes) but a *path* limit. Windows' default
    /// MAX_PATH is 260 characters for the whole path, and a federated episode path is
    /// root + library + series + season + filename. 96 leaves room for all of it under a data
    /// directory with a reasonable name, and a title longer than 96 characters is not a title
    /// anyone is reading off a screen anyway.
    /// </remarks>
    public const int MaxComponentLength = 96;

    /// <summary>
    /// Names Windows refuses regardless of extension, because they are device names.
    /// </summary>
    /// <remarks>
    /// Creating <c>CON.strm</c> on Windows fails; creating it on Linux and then syncing to a
    /// Windows node fails there. Renaming them is cheaper than either.
    /// </remarks>
    private static readonly string[] _reserved =
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    /// <summary>
    /// Sanitise one path component.
    /// </summary>
    /// <param name="raw">Untrusted text, e.g. a peer's title.</param>
    /// <param name="fallback">
    /// What to use when nothing survives. Sanitised itself, and defaulted to <c>item</c> if it is
    /// empty too, so this function can never return an empty string.
    /// </param>
    /// <returns>A safe, non-empty component.</returns>
    public static string Component(string? raw, string fallback = "item")
    {
        var cleaned = Clean(raw);
        if (cleaned.Length == 0)
        {
            cleaned = Clean(fallback);
        }

        if (cleaned.Length == 0)
        {
            cleaned = "item";
        }

        return cleaned;
    }

    private static string Clean(string? raw)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(Math.Min(raw.Length, MaxComponentLength));
        foreach (var c in raw)
        {
            if (builder.Length >= MaxComponentLength)
            {
                break;
            }

            // Allow-list. Letters and digits in any script (a Japanese title should stay a
            // Japanese title), plus the punctuation that appears in real titles and is safe
            // everywhere. Everything else -- separators, wildcards, quotes, control characters,
            // the ones Windows rejects (< > : " / \ | ? *) -- becomes a space.
            if (char.IsLetterOrDigit(c) || c is ' ' or '-' or '_' or '.' or '\'' or '(' or ')'
                or '[' or ']' or '&' or '+' or ',' or '!' or '#' or '@' or '=' or '~' or '`'
                or '{' or '}' or ';' or '$' or '%' or '^')
            {
                builder.Append(c);
            }
            else if (!char.IsControl(c))
            {
                builder.Append(' ');
            }
        }

        var result = builder.ToString();

        // Collapse runs of whitespace, which the substitution above tends to create.
        result = string.Join(' ', result.Split(' ', StringSplitOptions.RemoveEmptyEntries));

        // A component that is only dots is `.` or `..`: traversal, or a no-op directory. Both are
        // refused outright rather than trimmed, because "..." trimmed to ".." is worse than
        // nothing.
        if (result.All(c => c == '.'))
        {
            return string.Empty;
        }

        // Windows silently strips trailing dots and spaces from file names, which turns
        // "Movie." into "Movie" *after* the check that the path is where we think it is. Strip
        // them here, where it is visible.
        result = result.TrimEnd('.', ' ').TrimStart(' ');

        if (result.Length == 0)
        {
            return string.Empty;
        }

        // A reserved device name, with or without an extension: CON, con.strm, NUL.nfo.
        var stem = result.Split('.', 2)[0];
        if (_reserved.Contains(stem, StringComparer.OrdinalIgnoreCase))
        {
            result = "_" + result;
        }

        return result;
    }

    /// <summary>
    /// A short, stable, filesystem-safe token derived from an item key.
    /// </summary>
    /// <param name="itemKey">The item key, e.g. <c>movie:tmdb:10378</c>.</param>
    /// <returns>Something like <c>movie-tmdb-10378</c>, never empty.</returns>
    /// <remarks>
    /// Used as the fallback folder name when a peer sends a title that sanitises to nothing, and
    /// as the disambiguator when two different item keys would otherwise collide on one folder
    /// name. Derived from the key rather than random so the same title lands in the same place on
    /// every pass, which is what makes materialization idempotent.
    /// </remarks>
    public static string FromItemKey(string itemKey)
    {
        var token = Component(itemKey?.Replace(':', '-'), "item");
        return token;
    }

    /// <summary>
    /// Reports whether <paramref name="candidate"/> is at or below <paramref name="root"/>.
    /// </summary>
    /// <param name="root">The directory that must contain the candidate.</param>
    /// <param name="candidate">The path to check.</param>
    /// <returns>True when the candidate is inside the root.</returns>
    /// <remarks>
    /// The second half of the belt-and-braces. <see cref="Component"/> should make traversal
    /// impossible, but this is what is actually asserted before anything is written: both paths
    /// are fully resolved first, so a symlink, a <c>..</c> that slipped through, or a UNC path
    /// cannot pass.
    /// </remarks>
    public static bool IsUnder(string root, string candidate)
    {
        if (string.IsNullOrWhiteSpace(root) || string.IsNullOrWhiteSpace(candidate))
        {
            return false;
        }

        string fullRoot;
        string fullCandidate;
        try
        {
            fullRoot = System.IO.Path.GetFullPath(root);
            fullCandidate = System.IO.Path.GetFullPath(candidate);
        }
        catch (Exception ex) when (ex is ArgumentException or System.IO.PathTooLongException
                                      or NotSupportedException or System.Security.SecurityException)
        {
            return false;
        }

        var normalizedRoot = fullRoot.TrimEnd(
            System.IO.Path.DirectorySeparatorChar,
            System.IO.Path.AltDirectorySeparatorChar);
        var normalizedCandidate = fullCandidate.TrimEnd(
            System.IO.Path.DirectorySeparatorChar,
            System.IO.Path.AltDirectorySeparatorChar);

        var comparison = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

        return normalizedCandidate.Equals(normalizedRoot, comparison)
            || normalizedCandidate.StartsWith(
                normalizedRoot + System.IO.Path.DirectorySeparatorChar,
                comparison);
    }

    /// <summary>Format a season folder name the way Jellyfin's season resolver expects.</summary>
    /// <param name="season">The season number.</param>
    /// <returns><c>Season 01</c>, or <c>Specials</c> for season 0.</returns>
    public static string SeasonFolder(int season)
        => season <= 0
            ? "Specials"
            : string.Create(CultureInfo.InvariantCulture, $"Season {season:00}");

    /// <summary>Format the <c>SxxEyy</c> part of an episode filename.</summary>
    /// <param name="season">The season number.</param>
    /// <param name="episode">The episode number.</param>
    /// <returns><c>S01E05</c>.</returns>
    public static string EpisodeTag(int season, int episode)
        => string.Create(CultureInfo.InvariantCulture, $"S{season:00}E{episode:00}");
}
