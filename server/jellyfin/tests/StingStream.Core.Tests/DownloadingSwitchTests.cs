using System;
using System.IO;
using StingStream.Core.Configuration;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Reading and writing the <c>[children]</c> switches in <c>config.toml</c>.
/// </summary>
/// <remarks>
/// This edits, in place, the file that decides which processes a node runs — so the failure modes
/// worth pinning are not "does the happy path work" but "what does it refuse to do". A rewrite that
/// caught the wrong line would turn a port number into <c>true</c>, and a node that then refused to
/// start would be very hard to connect back to a switch somebody flipped in a settings screen.
/// </remarks>
public class DownloadingSwitchTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("stingstream-switch").FullName;

    public void Dispose()
    {
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // A test that cannot tidy up is not a test failure.
        }

        GC.SuppressFinalize(this);
    }

    /// <summary>A config.toml in the shape the supervisor writes, comments and all.</summary>
    private string Write(string body)
    {
        var path = Path.Combine(_dir, "config.toml");
        File.WriteAllText(path, body);
        return path;
    }

    private const string Sample = """
# Written by the supervisor. Edit freely; comments are kept.
node_name = "attic"

[gateway]
bind = "127.0.0.1"
port = 8802

[children]
jellyfin = true
# Films.
radarr = false
sonarr = false
nzbget = false
mesh = true

[ports]
jellyfin = 0
radarr = 7878
sonarr = 8989

""";

    [Fact]
    public void Reads_each_switch()
    {
        var path = Write(Sample);
        var flags = DownloadingSwitch.Read(path);

        Assert.False(flags["radarr"]);
        Assert.False(flags["sonarr"]);
        Assert.False(flags["nzbget"]);
    }

    [Fact]
    public void A_key_the_file_never_mentions_reads_as_on()
    {
        // `ChildrenConfig::default()` is all true and serde fills a missing field from it, so a
        // config.toml that simply does not list nzbget is a node that runs it. Reporting that as
        // off would show a switch in the wrong position on a perfectly working server.
        var path = Write("[children]\njellyfin = true\nradarr = true\n");
        var flags = DownloadingSwitch.Read(path);

        Assert.True(flags["nzbget"]);
    }

    [Fact]
    public void Turning_one_on_changes_one_word_and_leaves_the_file_alone()
    {
        var path = Write(Sample);
        Assert.True(DownloadingSwitch.Write(path, "radarr", true));

        var after = File.ReadAllText(path);
        // The comment above the line, which no TOML serialiser would have kept.
        Assert.Contains("# Films.", after, StringComparison.Ordinal);
        Assert.Contains("radarr = true", after, StringComparison.Ordinal);
        // Its neighbours are untouched...
        Assert.Contains("sonarr = false", after, StringComparison.Ordinal);
        // ...and so is the identically-named key in another table, which is the one that would
        // really hurt: `[ports] radarr = 7878` becoming `true` stops the node starting.
        Assert.Contains("radarr = 7878", after, StringComparison.Ordinal);
        Assert.Equal(
            Sample.Replace("radarr = false", "radarr = true", StringComparison.Ordinal),
            after);
    }

    [Fact]
    public void Writing_what_it_already_says_changes_nothing()
    {
        var path = Write(Sample);
        var before = File.ReadAllText(path);

        Assert.False(DownloadingSwitch.Write(path, "radarr", false));
        Assert.Equal(before, File.ReadAllText(path));
    }

    [Fact]
    public void Refuses_a_file_with_no_such_line_rather_than_inventing_one()
    {
        // Appending `radarr = true` under whatever table happened to be last is how a switch would
        // end up in `[ports]`. Refusing sends the reader to the file instead.
        var path = Write("[gateway]\nport = 8802\n");

        var ex = Assert.Throws<InvalidOperationException>(
            () => DownloadingSwitch.Write(path, "radarr", true));
        Assert.Contains("config.toml", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Will_not_reach_into_a_later_table_for_a_matching_key()
    {
        // `[children]` here has no radarr line at all; `[ports]` does. The rewrite must not find it.
        var path = Write("[children]\njellyfin = true\n\n[ports]\nradarr = 7878\n");

        Assert.Throws<InvalidOperationException>(
            () => DownloadingSwitch.Write(path, "radarr", true));
    }

    [Fact]
    public void Tolerates_the_spacing_a_person_might_type()
    {
        var path = Write("[children]\n  radarr   =   false\n");
        Assert.True(DownloadingSwitch.Write(path, "radarr", true));
        Assert.Contains("radarr   =   true", File.ReadAllText(path), StringComparison.Ordinal);
    }
}
