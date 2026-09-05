using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Configuration;

namespace StingStream.Core.Mesh;

/// <summary>
/// Makes <c>https://stingstream.local/stream/...</c> reachable from inside Jellyfin by pointing it
/// at this node's own gateway.
/// </summary>
/// <remarks>
/// A federated <c>.strm</c> holds a URL on the marker host <c>stingstream.local</c>. That name
/// deliberately resolves nowhere: the native app rewrites it to its own embedded mesh so bytes flow
/// straight from the holder, and nothing else is expected to reach it directly.
///
/// But a browser, a cast receiver or a stock Jellyfin client has no mesh, and for those the plan is
/// that the home node's Jellyfin proxies the URL through its own mesh
/// (<c>docs/ARCHITECTURE.md</c>, "Playback path"). Jellyfin does that with
/// <c>FileStreamResponseHelpers.GetStaticRemoteStreamResult</c>, which is an ordinary
/// <see cref="HttpClient"/> request — with the client's <c>Range</c> header forwarded and the
/// upstream's <c>206</c>, <c>Content-Range</c> and <c>Accept-Ranges</c> passed back, which is
/// exactly what a seeking player needs.
///
/// So the only thing missing is name resolution, and this supplies it: any request to
/// <c>stingstream.local</c> is rewritten to <c>http://127.0.0.1:&lt;gateway&gt;</c> before it
/// leaves. A message handler rather than a DNS-level <c>ConnectCallback</c> because the URL is
/// <c>https</c> and the gateway speaks plain HTTP on loopback — a connect callback would send a
/// TLS ClientHello into an HTTP listener. Rewriting the whole URI changes the scheme too.
///
/// Registered on Jellyfin's own named HTTP clients from
/// <see cref="StingStreamCoreExtensions.AddStingStreamCore"/>. It touches exactly one hostname and
/// forwards everything else untouched, so it is invisible to the rest of Jellyfin's outbound HTTP.
///
/// **What this does not cover: ffmpeg.** A transcode of a federated source hands the URL to ffmpeg,
/// which does its own DNS and never sees this handler. Direct play — the M3 path — does not
/// involve ffmpeg; the transcode fallback is M4, and will need the URL rewritten where the encoder
/// input is built instead.
/// </remarks>
public sealed class StingStreamLocalHandler : DelegatingHandler
{
    private readonly INodeRuntimeProvider _runtime;
    private readonly ILogger<StingStreamLocalHandler> _logger;

    public StingStreamLocalHandler(INodeRuntimeProvider runtime, ILogger<StingStreamLocalHandler> logger)
    {
        _runtime = runtime;
        _logger = logger;
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var uri = request.RequestUri;
        if (uri is not null
            && string.Equals(uri.Host, Federated.FederatedLayout.LocalHost, StringComparison.OrdinalIgnoreCase))
        {
            var rewritten = Rewrite(uri, GatewayPort());
            if (rewritten is not null)
            {
                _logger.LogDebug("Resolving {From} to this node's gateway at {To}", uri, rewritten);
                request.RequestUri = rewritten;
            }
            else
            {
                _logger.LogWarning(
                    "A request to {Uri} cannot be resolved: this server does not know its own "
                    + "gateway port. Start it through the StingStream supervisor.",
                    uri);
            }
        }

        return base.SendAsync(request, cancellationToken);
    }

    private int GatewayPort() => _runtime.Current?.Gateway.Port ?? 0;

    /// <summary>
    /// Point a <c>stingstream.local</c> URL at loopback.
    /// </summary>
    /// <param name="uri">The original URI.</param>
    /// <param name="gatewayPort">This node's gateway port; 0 when unknown.</param>
    /// <returns>The rewritten URI, or null when it cannot be rewritten.</returns>
    /// <remarks>
    /// Path, query and fragment are carried over verbatim — the path is
    /// <c>/stream/{group}/{item_key}/{node}</c> and the item key is percent-encoded, so
    /// reconstructing it from parts rather than copying it would risk double-encoding.
    /// </remarks>
    public static Uri? Rewrite(Uri uri, int gatewayPort)
    {
        ArgumentNullException.ThrowIfNull(uri);
        if (gatewayPort <= 0)
        {
            return null;
        }

        var builder = new UriBuilder(uri)
        {
            Scheme = Uri.UriSchemeHttp,
            Host = "127.0.0.1",
            Port = gatewayPort,
        };
        return builder.Uri;
    }
}
