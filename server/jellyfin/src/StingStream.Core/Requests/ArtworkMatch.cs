using System;
using System.Globalization;
using System.Text;

namespace StingStream.Core.Requests;

/// <summary>
/// Whether a candidate from an artwork provider is the same show the arr was talking about.
/// </summary>
/// <remarks>
/// <para>
/// Pulled out of <see cref="ArtworkFallback"/> and kept pure so it can be tested without a network,
/// because this is the part that can be wrong in a way nobody notices. A missing poster is visibly
/// missing. A <em>wrong</em> poster looks exactly like a right one.
/// </para>
/// <para>
/// The rule that follows is deliberately strict, and it is strict because of a measurement. While
/// working out whether a fallback was worth building at all, a title-only search of TMDB returned
/// the same poster (<c>/jqKc1aJji5bORUVqtbdM8FTqLKt.jpg</c>) for both <em>The Office</em> (2020) and
/// <em>The Office Wife</em> (1934). Fuzzy title matching filled three times as many gaps and filled
/// several of them with the wrong picture, which is worse than the placeholder tile it replaced:
/// the placeholder is at least honest about not knowing.
/// </para>
/// <para>
/// So: an exact id match is trusted unconditionally, and a title match is trusted only when the
/// normalised title is identical <em>and</em> the year agrees. Everything else is a miss.
/// </para>
/// </remarks>
public static class ArtworkMatch
{
    /// <summary>
    /// Whether a search candidate may be used as artwork for a title the arr named.
    /// </summary>
    /// <param name="candidateName">The provider's name for the candidate.</param>
    /// <param name="candidatePremiered">
    /// The provider's premiere date, as an ISO-ish string. Only the leading year is read, so
    /// <c>2018-05-31</c> and <c>2018</c> are both fine.
    /// </param>
    /// <param name="arrTitle">The title the arr returned.</param>
    /// <param name="arrYear">The year the arr returned, if it had one.</param>
    /// <returns>True when the candidate is certainly the same title.</returns>
    public static bool IsAcceptable(
        string? candidateName,
        string? candidatePremiered,
        string? arrTitle,
        int? arrYear)
    {
        // No year on either side is not "close enough". A sizeable share of the titles this runs
        // against are obscure enough to have no year in the arr's own metadata, and those are
        // exactly the ones with near-identical names to something else.
        if (arrYear is not > 0)
        {
            return false;
        }

        var candidateYear = YearOf(candidatePremiered);
        if (candidateYear != arrYear.Value)
        {
            return false;
        }

        var a = Normalize(candidateName);
        var b = Normalize(arrTitle);
        return a.Length > 0 && string.Equals(a, b, StringComparison.Ordinal);
    }

    /// <summary>
    /// The four-digit year at the front of a date string.
    /// </summary>
    /// <param name="premiered">The date, or null.</param>
    /// <returns>The year, or 0 when there is not one.</returns>
    public static int YearOf(string? premiered)
    {
        if (string.IsNullOrWhiteSpace(premiered) || premiered.Length < 4)
        {
            return 0;
        }

        return int.TryParse(
            premiered.AsSpan(0, 4),
            NumberStyles.None,
            CultureInfo.InvariantCulture,
            out var year)
            ? year
            : 0;
    }

    /// <summary>
    /// A title reduced to the part worth comparing.
    /// </summary>
    /// <param name="title">The title.</param>
    /// <returns>Lower case, letters and digits only, single-spaced.</returns>
    /// <remarks>
    /// Punctuation and case go, because the two providers disagree about them constantly and
    /// harmlessly: <c>Marvel's Daredevil</c> against <c>Marvel’s Daredevil</c> (a different
    /// apostrophe), <c>L. A. Doctors</c> against <c>L.A. Doctors</c>. Words never go. Dropping a
    /// leading article or a trailing qualifier is how <em>The Office</em> starts matching
    /// <em>Office</em>, and that is the failure this whole class exists to prevent.
    /// </remarks>
    public static string Normalize(string? title)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(title.Length);
        var pendingSpace = false;
        foreach (var c in title)
        {
            if (char.IsLetterOrDigit(c))
            {
                if (pendingSpace && builder.Length > 0)
                {
                    builder.Append(' ');
                }

                pendingSpace = false;
                builder.Append(char.ToLowerInvariant(c));
            }
            else
            {
                // Any run of punctuation or whitespace collapses to at most one separator, so
                // "L. A. Doctors" and "L.A. Doctors" land on the same string.
                pendingSpace = true;
            }
        }

        return builder.ToString();
    }
}
