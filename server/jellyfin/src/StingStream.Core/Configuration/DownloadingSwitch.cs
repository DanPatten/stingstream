using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace StingStream.Core.Configuration;

/// <summary>
/// Reads and writes the <c>[children]</c> switches in the node's <c>config.toml</c>.
/// </summary>
/// <remarks>
/// <para>
/// Downloading is three of the supervisor's child processes — the film manager, the series manager
/// and the usenet engine — and <c>config.toml</c> is where a node records whether they run. The
/// supervisor watches that file while it is up (<c>supervisor::downloading</c>) and starts or stops
/// them to match, so writing a line here is the whole of turning downloading on.
/// </para>
/// <para>
/// <b>Line rewriting, not a TOML round-trip.</b> The obvious implementation — parse, mutate,
/// re-serialise — needs a TOML library this project does not have, and would be worse if it did:
/// the file is written with a long explanatory header and a comment above most keys
/// (<c>config.rs</c>'s <c>CONFIG_HEADER</c>), and every serialiser in every language throws
/// comments away. An owner who had annotated their own configuration would find it silently
/// stripped the first time they used a switch in the app. So this finds the one line, changes the
/// one word, and leaves every byte around it alone.
/// </para>
/// <para>
/// The shape it matches is narrow on purpose: a key at the start of a line, inside the
/// <c>[children]</c> table, whose value is a bare <c>true</c> or <c>false</c>. That is what the
/// supervisor writes and what its parser accepts. Anything else — the key absent, the table
/// absent, a value this does not recognise — is reported rather than guessed at, because a
/// half-understood rewrite of the file that decides what this node runs is worse than a refusal.
/// </para>
/// </remarks>
public static class DownloadingSwitch
{
    /// <summary>The <c>[children]</c> keys this covers, in the order a screen shows them.</summary>
    /// <remarks>
    /// Jellyfin and the mesh are deliberately absent, and it is not an oversight: Jellyfin is the
    /// server doing the asking, and the mesh runs inside it. Neither is something an app served by
    /// them may switch off.
    /// </remarks>
    public static readonly IReadOnlyList<string> Keys = new[] { "radarr", "sonarr", "nzbget" };

    /// <summary>Where <c>config.toml</c> lives for a given data directory.</summary>
    public static string PathFor(string dataDirectory) => Path.Combine(dataDirectory, "config.toml");

    /// <summary>Whether each key in <see cref="Keys"/> is switched on.</summary>
    /// <param name="configPath">Path to <c>config.toml</c>.</param>
    /// <returns>One entry per key. Absent keys are reported as <see langword="true"/>, matching the supervisor's own defaults.</returns>
    public static Dictionary<string, bool> Read(string configPath)
    {
        var text = File.ReadAllText(configPath);
        var result = new Dictionary<string, bool>(StringComparer.Ordinal);
        foreach (var key in Keys)
        {
            var match = Match(text, key);
            // A key the file does not mention is on, because `ChildrenConfig::default()` is all
            // true and serde fills a missing field from it. Reporting it as off would show a
            // switch in the wrong position on a node that is downloading perfectly well.
            result[key] = match.Success ? match.Groups["value"].Value == "true" : true;
        }

        return result;
    }

    /// <summary>Set one key, leaving the rest of the file byte-for-byte alone.</summary>
    /// <param name="configPath">Path to <c>config.toml</c>.</param>
    /// <param name="key">One of <see cref="Keys"/>.</param>
    /// <param name="enabled">What it should become.</param>
    /// <returns><see langword="true"/> when the file changed; <see langword="false"/> when it already said this.</returns>
    /// <exception cref="InvalidOperationException">The key is not in the file in a shape this can safely change.</exception>
    public static bool Write(string configPath, string key, bool enabled)
    {
        var text = File.ReadAllText(configPath);
        var match = Match(text, key);
        if (!match.Success)
        {
            throw new InvalidOperationException(
                $"config.toml has no [children] {key} line to change. Edit the file by hand.");
        }

        if ((match.Groups["value"].Value == "true") == enabled)
        {
            return false;
        }

        var updated = text[..match.Groups["value"].Index]
            + (enabled ? "true" : "false")
            + text[(match.Groups["value"].Index + match.Groups["value"].Length)..];

        // Write beside it and move it into place, the way the supervisor writes runtime.json: the
        // supervisor re-reads this file every few seconds, and a reader must never catch it
        // half-written. A parse failure there is harmless (it waits and looks again), but a
        // truncated file that happens to parse is not.
        var temp = configPath + ".tmp";
        File.WriteAllText(temp, updated);
        File.Move(temp, configPath, overwrite: true);
        return true;
    }

    /// <summary>
    /// The assignment line for one child, inside the <c>[children]</c> table only.
    /// </summary>
    /// <remarks>
    /// The table matters: <c>[ports]</c> carries a <c>radarr</c> key too, and a regex that ignored
    /// which table it was in would happily rewrite a port number as <c>true</c>. So the pattern
    /// anchors on the <c>[children]</c> header and refuses to cross the next header.
    /// </remarks>
    private static System.Text.RegularExpressions.Match Match(string text, string key)
    {
        // `\r?` before the anchor: .NET's multiline `$` matches before the `\n`, so a file saved
        // with CRLF line endings leaves a carriage return between the value and the anchor and
        // nothing matches at all. The supervisor writes `\n`, but config.toml is a text file its
        // owner is invited to edit, and an editor on Windows will convert the whole file to suit
        // itself the first time they save one.
        var pattern =
            @"^\[children\][^\[]*?^(?<key>[ \t]*" + Regex.Escape(key) + @"[ \t]*=[ \t]*)(?<value>true|false)[ \t]*\r?$";
        return Regex.Match(
            text,
            pattern,
            RegexOptions.Multiline | RegexOptions.Singleline,
            TimeSpan.FromSeconds(1));
    }
}
