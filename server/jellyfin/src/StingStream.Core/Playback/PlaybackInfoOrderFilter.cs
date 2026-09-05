using System;
using System.Linq;
using System.Threading.Tasks;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.MediaInfo;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;
using StingStream.Core.Federated;

namespace StingStream.Core.Playback;

/// <summary>
/// Puts the scored source order back after Jellyfin has re-sorted it.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="FederatedSourceDecorator"/> orders the sources where they are resolved, which is the
/// right place for everything the *server* then does with them. It is not the last word on what the
/// *client* sees: <c>MediaInfoController</c> calls <c>MediaInfoHelper.SortMediaSources</c> after the
/// decorator has run, and that sort begins by floating "the source belonging to the queried item"
/// to the front.
/// </para>
/// <para>
/// Upstream's rule is right for the case it was written for. A user opening one version of a film
/// they have two copies of expects that version to play, because it carries their resume position,
/// and an unfavourable bitrate should mean transcoding it rather than silently switching to its
/// sibling. But for a federated title *every* version is a pointer at somebody else's disk, none of
/// them is "the one the user opened", and which of them Jellyfin made the primary item is an
/// accident of which <c>.strm</c> its resolver read first. Letting that accident outrank a measured
/// link is how a viewer on a slow connection to one holder gets handed exactly that holder.
/// </para>
/// <para>
/// So the order is applied twice, and the second application is here, in a result filter — which
/// runs after the action and needs no patch to Jellyfin at all. It touches only responses that
/// contain at least one <c>stingstream.local</c> source, which means it is a type check and a
/// string comparison for every other request on the server.
/// </para>
/// </remarks>
public sealed class PlaybackInfoOrderFilter : IAsyncResultFilter
{
    private readonly FederatedSourceDecorator _decorator;
    private readonly ILogger<PlaybackInfoOrderFilter> _logger;

    public PlaybackInfoOrderFilter(FederatedSourceDecorator decorator, ILogger<PlaybackInfoOrderFilter> logger)
    {
        _decorator = decorator;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(next);

        if (context.Result is ObjectResult { Value: PlaybackInfoResponse info }
            && info.MediaSources is { Count: > 0 }
            && info.MediaSources.Any(IsFederated))
        {
            try
            {
                var userId = context.HttpContext.User?.FindFirst(UserIdClaim)?.Value;
                var ordered = await _decorator
                    .ApplyAsync(null, userId, info.MediaSources, context.HttpContext.RequestAborted)
                    .ConfigureAwait(false);
                info.MediaSources = ordered.ToArray();
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Playback with the sources in Jellyfin's own order still works; it is just not the
                // order the scorer would have chosen. Failing the request over it would be worse.
                _logger.LogWarning(ex, "Could not re-apply the scored source order to a PlaybackInfo response");
            }
        }

        await next().ConfigureAwait(false);
    }

    /// <summary>The claim Jellyfin's authentication handler puts the user id in.</summary>
    /// <remarks>
    /// The literal, for the reason given on <c>StingStreamControllerBase.UserIdClaim</c>: the
    /// constant lives in <c>Jellyfin.Api</c>, which this project does not reference, and the value
    /// is part of Jellyfin's own token format rather than an implementation detail.
    /// </remarks>
    private const string UserIdClaim = "Jellyfin-UserId";

    private static bool IsFederated(MediaSourceInfo source)
        => source?.Path is not null
           && source.Path.StartsWith(FederatedLayout.StreamUrlPrefix, StringComparison.OrdinalIgnoreCase);
}
