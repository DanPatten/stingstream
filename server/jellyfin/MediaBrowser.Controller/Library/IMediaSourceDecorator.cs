using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;

namespace MediaBrowser.Controller.Library
{
    /// <summary>
    /// A last pass over the media sources of an item, after they have been resolved and sorted.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Added by StingStream (see <c>docs/PATCHES.md</c>), which needs two things that cannot be
    /// expressed through <see cref="IMediaSourceProvider"/>: the sources of a *static* item have to
    /// be re-ordered by how well each one can actually be reached over the mesh, and a source whose
    /// path is only meaningful inside this process has to be given a second URL for ffmpeg.
    /// </para>
    /// <para>
    /// It hangs off <c>IMediaSourceManager.GetPlaybackMediaSources</c> rather than off the
    /// PlaybackInfo controller on purpose: the same list is resolved again, server-side and with no
    /// client involved, when a transcode or a direct stream starts. Decorating only the API response
    /// would give the client one answer and ffmpeg another.
    /// </para>
    /// <para>
    /// Implementations must be cheap and total: this runs on every playback request, and a decorator
    /// that throws would take playback down for items it has no opinion about.
    /// </para>
    /// </remarks>
    public interface IMediaSourceDecorator
    {
        /// <summary>
        /// Adjust and re-order an item's media sources.
        /// </summary>
        /// <param name="item">The item being played.</param>
        /// <param name="user">The user asking, or <c>null</c> for a server-side resolve.</param>
        /// <param name="sources">The sources, already resolved and sorted.</param>
        /// <param name="cancellationToken">The cancellation token.</param>
        /// <returns>The sources to use, in the order to offer them.</returns>
        Task<IReadOnlyList<MediaSourceInfo>> DecorateAsync(
            BaseItem item,
            User user,
            IReadOnlyList<MediaSourceInfo> sources,
            CancellationToken cancellationToken);
    }
}
