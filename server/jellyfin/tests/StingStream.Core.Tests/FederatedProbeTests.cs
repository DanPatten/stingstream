using System;
using System.Collections.Generic;
using MediaBrowser.Model.Dto;
using StingStream.Core.Federated;
using StingStream.Core.Playback;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Which sources a remote content probe must not be run against.
/// </summary>
/// <remarks>
/// <para>
/// Found by driving the player against three real nodes: <c>POST PlaybackInfo</c> never returned
/// for a title whose first source was a federated pointer, five cold loads out of five, while a
/// local-only title answered in about a second. <c>GetPlaybackMediaSources</c> re-probes an item
/// whose first source carries no video stream — which a pointer nothing has played yet does not —
/// and the probe is <c>ffprobe</c>, in its own process, doing its own DNS. It cannot resolve
/// <c>stingstream.local</c>, because that name only means anything inside this one. So the request
/// sat on ffprobe's resolve timeout and the app sat on a spinner: <c>Failed to resolve hostname
/// stingstream.local</c> and then <c>ffprobe failed - streams and format are both null</c>, on tape
/// in the node's own log.
/// </para>
/// <para>
/// The veto is keyed on the same source the probe condition is keyed on, and on the URL rather than
/// the file name — Jellyfin reads a <c>.strm</c> and puts its contents in the source's path.
/// </para>
/// </remarks>
public class FederatedProbeTests
{
    private static readonly string _pointer = FederatedLayout.StreamUrl(
        "450a54514df37ae0ca21c950985536e933151894ed1452e2600be5d40af5822f",
        "movie:tmdb:45745",
        "09949ed9567a33dda6ca55184713469b2e655b6f2ed3f46a51ce50b96a4e1131");

    private static MediaSourceInfo Source(string? path) => new() { Path = path };

    [Fact]
    public void APointerIsOne()
    {
        Assert.True(FederatedSourceDecorator.IsFederatedPointer(Source(_pointer)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(@"E:\media\Movies\Sintel (2010)\Sintel (2010).mkv")]
    [InlineData("/srv/media/Movies/Sintel (2010)/Sintel (2010).mkv")]
    [InlineData("https://example.com/stream/a/b/c")]
    // Right shape, wrong host. Somebody's own .strm must not be mistaken for one of ours, because
    // the consequence is silently skipping a probe they need.
    [InlineData("https://stingstream.local.example.com/stream/a/b/c")]
    [InlineData("https://stingstream.local/notstream/a/b/c")]
    [InlineData("https://stingstream.local/stream/a/b")]
    public void AnythingElseIsNot(string? path)
    {
        Assert.False(FederatedSourceDecorator.IsFederatedPointer(Source(path)));
    }

    [Fact]
    public void TheVetoFollowsTheFirstSource()
    {
        var decorator = Decorator();

        Assert.True(decorator.ShouldSkipRemoteProbe(new[] { Source(_pointer), Source(@"D:\a.mkv") }));

        // A real local file first, a pointer as an alternate version -- the mixed folder an
        // ordinary library becomes the moment a peer also holds a title you have. The probe
        // condition is asking about the local file, so this must not veto it.
        Assert.False(decorator.ShouldSkipRemoteProbe(new[] { Source(@"D:\a.mkv"), Source(_pointer) }));
    }

    [Fact]
    public void NoSourcesIsNotAnOpinion()
    {
        var decorator = Decorator();

        Assert.False(decorator.ShouldSkipRemoteProbe(Array.Empty<MediaSourceInfo>()));
        Assert.False(decorator.ShouldSkipRemoteProbe(null!));
    }

    [Fact]
    public void TheScoringDeadlineIsShorterThanAPersonsPatience()
    {
        // The number itself is a judgement, but the two bounds are not: shorter than the spinner
        // somebody would give up on, and long enough that a slow-but-working mesh lookup finishes.
        Assert.True(FederatedSourceDecorator.ScoringDeadline > TimeSpan.FromSeconds(2));
        Assert.True(FederatedSourceDecorator.ScoringDeadline <= TimeSpan.FromSeconds(10));
    }

    /// <summary>
    /// The decorator with nothing behind it. <see cref="FederatedSourceDecorator.ShouldSkipRemoteProbe"/>
    /// reads only its argument, which is the point: it runs inside the probe decision, before
    /// anything has been asked of the mesh.
    /// </summary>
    private static FederatedSourceDecorator Decorator()
        => new(null!, null!, null!, null!, Microsoft.Extensions.Logging.Abstractions.NullLogger<FederatedSourceDecorator>.Instance);
}
