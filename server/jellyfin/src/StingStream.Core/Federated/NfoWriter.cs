using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Xml;
using StingStream.Core.Mesh;

namespace StingStream.Core.Federated;

/// <summary>
/// Writes the <c>.nfo</c> sidecars that give a federated pointer its metadata.
/// </summary>
/// <remarks>
/// The Shared libraries have every internet metadata fetcher turned off and the NFO reader turned
/// on, so these files are the *only* source of a federated title's title, plot, cast and provider
/// ids. That is deliberate: the peer that holds the file already looked all of this up, and asking
/// TMDB again on every node in the group would be both slower and ruder.
///
/// The dialect is Kodi's, which is what Jellyfin's <c>MediaBrowser.XbmcMetadata</c> parsers read.
/// Two details are worth knowing:
///
/// * <c>&lt;runtime&gt;</c> is in **minutes**, not seconds or ticks.
/// * Provider ids are written twice — as <c>&lt;uniqueid type="..."&gt;</c> and as the legacy
///   <c>&lt;tmdbid&gt;</c>/<c>&lt;imdbid&gt;</c>/<c>&lt;tvdbid&gt;</c> elements. The parser reads
///   both, and writing both means a file that also opens correctly in Kodi and in older readers.
///
/// Everything written here came from a peer over the network. It goes through
/// <see cref="XmlWriter"/> with checked characters, so a title containing <c>&lt;/movie&gt;</c>
/// produces escaped text rather than a malformed document.
/// </remarks>
public static class NfoWriter
{
    /// <summary>Tag every federated item carries, so they can be found and cleaned up as a set.</summary>
    public const string FederatedTag = "stingstream:federated";

    private static readonly XmlWriterSettings _settings = new()
    {
        Indent = true,
        IndentChars = "  ",
        Encoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
        // A control character that slipped through from a peer would otherwise produce a file the
        // parser rejects. Replacing is better than throwing: one bad character should not cost the
        // whole title its metadata.
        CheckCharacters = false,
        NewLineChars = "\n",
    };

    /// <summary>Write a movie <c>.nfo</c>.</summary>
    /// <param name="path">Destination file.</param>
    /// <param name="entry">The index entry the pointer was built from.</param>
    public static void WriteMovie(string path, MeshIndexEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        Write(path, writer =>
        {
            writer.WriteStartElement("movie");
            WriteCommon(writer, entry);
            writer.WriteEndElement();
        });
    }

    /// <summary>Write an episode <c>.nfo</c>.</summary>
    /// <param name="path">Destination file.</param>
    /// <param name="entry">The index entry the pointer was built from.</param>
    public static void WriteEpisode(string path, MeshIndexEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        Write(path, writer =>
        {
            writer.WriteStartElement("episodedetails");
            WriteCommon(writer, entry);
            Element(writer, "showtitle", entry.Metadata.SeriesName);
            if (entry.Metadata.Season is { } season)
            {
                Element(writer, "season", season.ToString(CultureInfo.InvariantCulture));
            }

            if (entry.Metadata.Episode is { } episode)
            {
                Element(writer, "episode", episode.ToString(CultureInfo.InvariantCulture));
            }

            // Kodi calls an episode's air date <aired>; <premiered> is the film spelling. The
            // parser reads both, but writing the right one keeps the file honest.
            Element(writer, "aired", DatePart(entry.Metadata.PremiereDate));
            writer.WriteEndElement();
        });
    }

    /// <summary>
    /// Write a series-level <c>tvshow.nfo</c>.
    /// </summary>
    /// <param name="path">Destination file (must be named <c>tvshow.nfo</c>).</param>
    /// <param name="entry">Any episode of the series; its series fields are used.</param>
    /// <remarks>
    /// Without this, a series folder full of episode pointers gets a Series item named after the
    /// folder and nothing else — no plot, no provider ids, and therefore no artwork and no
    /// grouping with the same series on another node. The series-level provider ids come from the
    /// <c>series_*</c> pairs the inventory publisher adds to the metadata blob.
    /// </remarks>
    public static void WriteSeries(string path, MeshIndexEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        Write(path, writer =>
        {
            writer.WriteStartElement("tvshow");
            Element(writer, "title", entry.Metadata.SeriesName);
            Element(writer, "sorttitle", entry.Metadata.SeriesName);
            Element(writer, "plot", null);
            Element(writer, "mpaa", entry.Metadata.OfficialRating);
            foreach (var genre in entry.Metadata.Genres)
            {
                Element(writer, "genre", genre);
            }

            WriteProviderIds(writer, entry, seriesLevel: true);
            Element(writer, "tag", FederatedTag);
            writer.WriteEndElement();
        });
    }

    private static void WriteCommon(XmlWriter writer, MeshIndexEntry entry)
    {
        var metadata = entry.Metadata;
        Element(writer, "title", metadata.Title);
        Element(writer, "originaltitle", metadata.OriginalTitle);
        Element(writer, "sorttitle", metadata.Title);
        if (metadata.Year is { } year && year > 0)
        {
            Element(writer, "year", year.ToString(CultureInfo.InvariantCulture));
        }

        Element(writer, "plot", metadata.Overview);
        Element(writer, "outline", metadata.Overview);
        Element(writer, "mpaa", metadata.OfficialRating);
        if (metadata.CommunityRating is { } rating && rating > 0)
        {
            Element(writer, "rating", rating.ToString("0.0", CultureInfo.InvariantCulture));
        }

        // Minutes: the unit Kodi's <runtime> uses and the one Jellyfin's parser multiplies up.
        if (entry.Media.DurationMs is { } ms && ms > 0)
        {
            var minutes = (int)Math.Round(ms / 60000.0, MidpointRounding.AwayFromZero);
            if (minutes > 0)
            {
                Element(writer, "runtime", minutes.ToString(CultureInfo.InvariantCulture));
            }
        }

        Element(writer, "premiered", DatePart(metadata.PremiereDate));

        foreach (var genre in metadata.Genres)
        {
            Element(writer, "genre", genre);
        }

        WriteProviderIds(writer, entry, seriesLevel: false);

        var order = 0;
        foreach (var person in metadata.People)
        {
            if (string.IsNullOrWhiteSpace(person.Name))
            {
                continue;
            }

            switch ((person.Kind ?? string.Empty).ToLowerInvariant())
            {
                case "director":
                    Element(writer, "director", person.Name);
                    break;
                case "writer":
                    Element(writer, "writer", person.Name);
                    break;
                case "producer":
                    Element(writer, "producer", person.Name);
                    break;
                default:
                    writer.WriteStartElement("actor");
                    Element(writer, "name", person.Name);
                    Element(writer, "role", person.Role);
                    // Jellyfin's parser reads <type> into PersonKind and defaults to Actor when it
                    // is missing, so this is belt and braces -- but it is also what makes the file
                    // correct for a reader that does not have that default.
                    Element(writer, "type", "Actor");
                    Element(writer, "order", order.ToString(CultureInfo.InvariantCulture));
                    writer.WriteEndElement();
                    order++;
                    break;
            }
        }

        // The tag is how the lifecycle finds federated items again: a Jellyfin query by tag is
        // cheap, and walking the federated folders and mapping paths back to items is not.
        Element(writer, "tag", FederatedTag);
    }

    /// <summary>
    /// Write provider ids in both the modern and the legacy spelling.
    /// </summary>
    /// <param name="writer">The XML writer.</param>
    /// <param name="entry">The index entry.</param>
    /// <param name="seriesLevel">
    /// True to emit the <c>series_*</c> ids under their plain names, which is what a
    /// <c>tvshow.nfo</c> needs; false to emit the item's own ids and skip the series ones.
    /// </param>
    private static void WriteProviderIds(XmlWriter writer, MeshIndexEntry entry, bool seriesLevel)
    {
        var first = true;
        foreach (var pair in entry.Metadata.ProviderIds)
        {
            if (pair.Length < 2 || string.IsNullOrWhiteSpace(pair[0]) || string.IsNullOrWhiteSpace(pair[1]))
            {
                continue;
            }

            var name = pair[0];
            var isSeries = name.StartsWith("series_", StringComparison.OrdinalIgnoreCase);
            if (isSeries != seriesLevel)
            {
                continue;
            }

            if (isSeries)
            {
                name = name["series_".Length..];
            }

            var provider = name.ToLowerInvariant();

            writer.WriteStartElement("uniqueid");
            writer.WriteAttributeString("type", provider);
            if (first)
            {
                writer.WriteAttributeString("default", "true");
                first = false;
            }

            writer.WriteString(pair[1]);
            writer.WriteEndElement();

            // The legacy elements. Jellyfin's parser reads these too, and a file that also works
            // in Kodi and in older tooling costs three lines.
            switch (provider)
            {
                case "tmdb":
                    Element(writer, "tmdbid", pair[1]);
                    break;
                case "imdb":
                    Element(writer, "imdbid", pair[1]);
                    Element(writer, "id", pair[1]);
                    break;
                case "tvdb":
                    Element(writer, "tvdbid", pair[1]);
                    break;
                default:
                    break;
            }
        }
    }

    /// <summary>
    /// The date half of an RFC 3339 timestamp, in the one format Jellyfin's NFO parser accepts.
    /// </summary>
    /// <remarks>
    /// Jellyfin reads date elements with <c>DateTime.TryParseExact</c> against
    /// <c>XbmcMetadataOptions.ReleaseDateFormat</c>, which is <c>yyyy-MM-dd</c>. Anything else —
    /// a full timestamp, `2024-3-5`, slashes — parses as nothing and the item silently has no
    /// release date. So this validates rather than trusting the length: "not a date" happens to be
    /// exactly ten characters, which is how this was found.
    /// </remarks>
    private static string? DatePart(string? timestamp)
    {
        if (string.IsNullOrWhiteSpace(timestamp))
        {
            return null;
        }

        var t = timestamp.IndexOf('T', StringComparison.Ordinal);
        var date = t > 0 ? timestamp[..t] : timestamp.Trim();
        return DateTime.TryParseExact(
            date,
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out _)
            ? date
            : null;
    }

    private static void Element(XmlWriter writer, string name, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return;
        }

        writer.WriteElementString(name, value);
    }

    /// <summary>
    /// Write a document atomically: a sibling temp file, then a rename over the target.
    /// </summary>
    /// <remarks>
    /// Jellyfin's library monitor watches these folders. A half-written <c>.nfo</c> that it reads
    /// mid-write parses as garbage and the item ends up with no metadata until something forces a
    /// re-read, which may be never. The rename is atomic on every filesystem this runs on.
    /// </remarks>
    private static void Write(string path, Action<XmlWriter> body)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var tmp = path + ".tmp";
        using (var stream = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
        using (var writer = XmlWriter.Create(stream, _settings))
        {
            writer.WriteStartDocument(standalone: true);
            body(writer);
            writer.WriteEndDocument();
        }

        File.Move(tmp, path, overwrite: true);
    }
}
