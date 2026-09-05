using System;
using StingStream.Core.Federated;
using StingStream.Core.Mesh;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// <c>stingstream.local</c> resolves nowhere on purpose. This is the one place it is turned into
/// something Jellyfin can actually fetch, and getting it wrong means a browser gets a connection
/// error instead of a film.
/// </summary>
public class StingStreamLocalHandlerTests
{
    [Fact]
    public void TheSchemeChangesToo()
    {
        // A DNS-level ConnectCallback would have been the obvious mechanism and would not work: the
        // URL is https and the gateway speaks plain HTTP on loopback, so the client would send a
        // TLS ClientHello into an HTTP listener.
        var original = new Uri(FederatedLayout.StreamUrl("g1", "movie:tmdb:10378", "n1"));
        var rewritten = StingStreamLocalHandler.Rewrite(original, 8790);

        Assert.NotNull(rewritten);
        Assert.Equal("http", rewritten!.Scheme);
        Assert.Equal("127.0.0.1", rewritten.Host);
        Assert.Equal(8790, rewritten.Port);
    }

    [Fact]
    public void ThePathSurvivesItsPercentEncoding()
    {
        // The item key contains colons and is percent-encoded in the URL. Rebuilding the path from
        // parts rather than copying it would double-encode and the mesh would answer 404.
        var original = new Uri(FederatedLayout.StreamUrl("g1", "movie:tmdb:10378", "n1"));
        var rewritten = StingStreamLocalHandler.Rewrite(original, 9000);

        Assert.Equal(original.AbsolutePath, rewritten!.AbsolutePath);
        Assert.Equal("/stream/g1/movie%3Atmdb%3A10378/n1", rewritten.AbsolutePath);
    }

    [Fact]
    public void AQueryStringIsCarriedOver()
    {
        var original = new Uri("https://stingstream.local/stream/g/k/n?probe=1&x=2");
        var rewritten = StingStreamLocalHandler.Rewrite(original, 8790);
        Assert.Equal("?probe=1&x=2", rewritten!.Query);
    }

    [Fact]
    public void WithoutAKnownGatewayPortNothingIsRewritten()
    {
        // Better to fail the request with the marker host intact -- which is at least
        // recognisable in a log -- than to send it somewhere arbitrary.
        var original = new Uri("https://stingstream.local/stream/g/k/n");
        Assert.Null(StingStreamLocalHandler.Rewrite(original, 0));
        Assert.Null(StingStreamLocalHandler.Rewrite(original, -1));
    }
}
