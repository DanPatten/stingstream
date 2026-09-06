import type { Api } from "@jellyfin/sdk";
import type {
  BaseItemDto,
  MediaSourceInfo,
} from "@jellyfin/sdk/lib/generated-client/models";
import { BaseItemKind } from "@jellyfin/sdk/lib/generated-client/models/base-item-kind";
import { getMediaInfoApi } from "@jellyfin/sdk/lib/utils/api";
import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { bestOnlineSource, fetchItemSources } from "@/lib/stingstream/sources";
import type { DownloadQuality } from "@/utils/atoms/settings";
import { markExpectedError } from "../../errors";
import { rewriteStreamUrlForMesh } from "../../mesh/streamUrl";
import { generateDownloadProfile } from "../../profiles/download";
import type { AudioTranscodeModeType } from "../../profiles/native";
import { redactUrl } from "@/lib/stingstream/redactUrl";

interface StreamResult {
  url: string;
  sessionId: string | null;
  mediaSource: MediaSourceInfo | undefined;
  requiredHttpHeaders?: Record<string, string>;
}

/**
 * How long a download may go without receiving a byte, by what it is downloading.
 *
 * The mesh-direct original starts sending within a round trip and the mesh does its own stall
 * detection and holder failover at fifteen seconds, so the platform default is right for it. A
 * transcode sends nothing at all while the home node starts ffmpeg, seeks, and fills its first
 * segment; for a 4K source pulled over the mesh that runs past a minute, which is exactly how M5's
 * download died (`docs/APP-RELEASE.md` §11).
 */
export const TRANSCODE_READ_TIMEOUT_SECONDS = 900;

/** What a download needs beyond a URL. */
export interface DownloadTransport {
  /** The URL is a real-time transcode the home node has to produce before it can send bytes. */
  transcoded: boolean;
  /** Pass straight to `BackgroundDownloader.startDownload`'s `options`. */
  readTimeoutSeconds?: number;
}

export type DownloadResult = StreamResult & DownloadTransport;

/**
 * Whether the user asked, in so many words, for something other than the original file.
 *
 * **This is the whole of Dan's decision** (M5 → M7, `docs/APP-RELEASE.md` §6): a download takes the
 * original unless the person doing the downloading said otherwise. `PlaybackInfo` setting
 * `TranscodingUrl` is *not* that: it is the server saying "this device's download profile cannot
 * direct-play this", which for a 4K federated source means "the home node will now pull the whole
 * film over the mesh and re-encode it in real time so the phone can save it" — two hops, an ffmpeg,
 * and a timeout, to produce a worse copy of a file the phone could have fetched directly.
 *
 * Two things count as asking:
 *
 * * a **download quality** that is not `original` — the setting has existed since Streamyfin and
 *   has never been read by anything; this is what it is for;
 * * a **bitrate cap** below Max, which is a number the user typed into a quality picker and which
 *   cannot be honoured any other way. The existing behaviour, kept deliberately.
 */
export const wantsTranscodedDownload = (
  quality: DownloadQuality | undefined,
  maxStreamingBitrate: number | undefined,
): boolean =>
  (quality !== undefined && quality !== "original") ||
  (typeof maxStreamingBitrate === "number" &&
    Number.isFinite(maxStreamingBitrate));

/**
 * Gets the actual streaming URL - handles both transcoded and direct play logic
 * Returns only the URL string
 */
const getPlaybackUrl = (
  api: Api,
  itemId: string,
  mediaSource: MediaSourceInfo | undefined,
  params: {
    subtitleStreamIndex?: number;
    audioStreamIndex?: number;
    deviceId?: string | null;
    startTimeTicks?: number;
    maxStreamingBitrate?: number;
    userId: string;
    playSessionId?: string | null;
  },
): string => {
  let transcodeUrl = mediaSource?.TranscodingUrl;

  // Handle transcoded URL if available
  if (transcodeUrl) {
    // For regular streaming, change subtitle method to HLS for transcoded URL
    if (params.subtitleStreamIndex === -1) {
      transcodeUrl = transcodeUrl.replace(
        "SubtitleMethod=Encode",
        "SubtitleMethod=Hls",
      );
    }

    console.log("Video is being transcoded:", redactUrl(transcodeUrl));
    return `${api.basePath}${transcodeUrl}`;
  }

  // Handle remote/external streams (like live TV with external URLs)
  // These have Protocol "Http" and IsRemote true, with the actual URL in Path.
  //
  // A federated library item arrives here too: its `.strm` holds
  // `https://stingstream.local/stream/<group>/<item_key>/<node>`, and this is the one place the
  // app sees that URL before handing it to a player. `rewriteStreamUrlForMesh` points it at the
  // embedded mesh's loopback port when this device has joined the group, so MPV pulls the bytes
  // off the holder's disk over iroh; otherwise it returns the URL untouched and the home node's
  // gateway proxies `/stream/*` instead. See docs/APP-MESH.md.
  if (
    mediaSource?.IsRemote &&
    mediaSource?.Protocol === "Http" &&
    mediaSource?.Path
  ) {
    const remote = rewriteStreamUrlForMesh(mediaSource.Path);
    console.log("Video is remote stream, using direct Path:", redactUrl(remote));
    return remote;
  }

  // Fall back to direct play
  // Use the mediaSource's actual container when available (important for live TV
  // where the container may be ts/hls, not mp4)
  const container = mediaSource?.Container || "mp4";
  const streamParams = new URLSearchParams({
    static: "true",
    container,
    mediaSourceId: mediaSource?.Id || "",
    subtitleStreamIndex: params.subtitleStreamIndex?.toString() || "",
    audioStreamIndex: params.audioStreamIndex?.toString() || "",
    deviceId: params.deviceId || api.deviceInfo.id,
    ApiKey: api.accessToken,
    startTimeTicks: params.startTimeTicks?.toString() || "0",
    maxStreamingBitrate: params.maxStreamingBitrate?.toString() || "",
    userId: params.userId,
  });

  // Add additional parameters if provided
  if (params.playSessionId) {
    streamParams.append("playSessionId", params.playSessionId);
  }

  const directPlayUrl = `${api.basePath}/Videos/${itemId}/stream?${streamParams.toString()}`;

  // Redacted: this URL carries the caller's own Jellyfin access token in `ApiKey`, and
  // `console.log` goes to logcat on Android and to the browser console on web. See
  // `lib/stingstream/redactUrl.ts`.
  console.log("Video is being direct played:", redactUrl(directPlayUrl));
  return directPlayUrl;
};

const getDownloadUrl = async (
  api: Api,
  itemId: string,
  mediaSource: MediaSourceInfo,
  sessionId: string | null | undefined,
  wantsTranscode: boolean,
): Promise<DownloadResult> => {
  const isFederated = Boolean(
    mediaSource.IsRemote && mediaSource.Protocol === "Http" && mediaSource.Path,
  );

  // A federated item has no file on this node to download from, so `/Items/{id}/Download` would
  // make the home node fetch it over the mesh and re-serve it — two hops for the same bytes.
  // Take the mesh path directly when this device can.
  //
  // **`TranscodingUrl` is deliberately not consulted here** (M7; the guard that used to be part of
  // this condition is what M5's 4K download fell through). PlaybackInfo sets it whenever the
  // download profile cannot direct-play the source, and honouring that for a federated item means
  // the home node pulls the whole film over the mesh and re-encodes it in real time so the phone
  // can save a worse copy of a file it could have fetched itself — slowly enough to hit the
  // downloader's timeout in practice. Offline is the case where the *original* matters most: it is
  // the copy that has to still be worth watching in a month, and MPV plays it. See
  // `wantsTranscodedDownload` for the one thing that overrides this.
  if (isFederated && !wantsTranscode) {
    // Pick the source with `GET /stingstream/api/v1/items/{id}/sources` (M4) rather than settling
    // for whichever holder this PlaybackInfo call happened to return. It sees the whole group,
    // including a holder whose pointer this node never materialized because the title is held
    // locally elsewhere on this same node's Jellyfin — candidates PlaybackInfo cannot return at
    // all — so for a *download*, which cares about the fastest holder rather than "the one file
    // Jellyfin already has an item for," it is strictly the fuller answer. Best-effort: any
    // failure (an older node, the mesh unreachable, nothing online) keeps the path PlaybackInfo
    // already gave us, which is why fetchItemSources/bestOnlineSource never throw.
    const sources = await fetchItemSources(
      getStingStreamApiBaseUrl(api.basePath),
      itemId,
      { accessToken: api.accessToken },
    );
    const best = bestOnlineSource(sources);
    const path = best?.streamUrl || mediaSource.Path;
    return {
      url: rewriteStreamUrlForMesh(path as string),
      sessionId: sessionId || null,
      mediaSource,
      transcoded: false,
    };
  }

  // Asked for a transcode, and the server did not offer one: it is telling us the original already
  // satisfies the request. Take the original by whichever route it lives on.
  if (!mediaSource.TranscodingUrl) {
    if (isFederated) {
      return {
        url: rewriteStreamUrlForMesh(mediaSource.Path as string),
        sessionId: sessionId || null,
        mediaSource,
        transcoded: false,
      };
    }

    return {
      url: `${api.basePath}/Items/${mediaSource.Id}/Download?ApiKey=${api.accessToken}`,
      sessionId: sessionId || null,
      mediaSource,
      transcoded: false,
    };
  }

  // A real-time transcode: either the user asked for one, or this is a local source whose codecs
  // or burned-in subtitles the download profile cannot pass through — long-standing behaviour, and
  // the case the long timeout was always missing.
  return {
    url: `${api.basePath}${mediaSource.TranscodingUrl}`,
    sessionId: sessionId || null,
    mediaSource,
    transcoded: true,
    readTimeoutSeconds: TRANSCODE_READ_TIMEOUT_SECONDS,
  };
};

export const getStreamUrl = async ({
  api,
  item,
  userId,
  startTimeTicks = 0,
  maxStreamingBitrate,
  playSessionId,
  deviceProfile,
  audioStreamIndex = 0,
  subtitleStreamIndex = undefined,
  mediaSourceId,
  deviceId,
}: {
  api: Api | null | undefined;
  item: BaseItemDto | null | undefined;
  userId: string | null | undefined;
  startTimeTicks: number;
  maxStreamingBitrate?: number;
  playSessionId?: string | null;
  deviceProfile: any;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  height?: number;
  mediaSourceId?: string | null;
  deviceId?: string | null;
}): Promise<{
  url: string | null;
  sessionId: string | null;
  mediaSource: MediaSourceInfo | undefined;
  requiredHttpHeaders?: Record<string, string>;
} | null> => {
  if (!api || !userId || !item?.Id) {
    console.warn("Missing required parameters for getStreamUrl");
    return null;
  }

  let mediaSource: MediaSourceInfo | undefined;
  let sessionId: string | null | undefined;

  // Please do not remove this we need this for live TV to be working correctly.
  if (item.Type === BaseItemKind.Program) {
    console.log("Item is of type program...");
    const res = await getMediaInfoApi(api).getPlaybackInfo(
      {
        userId,
        itemId: item.ChannelId!,
      },
      {
        method: "POST",
        params: {
          startTimeTicks: 0,
          isPlayback: true,
          autoOpenLiveStream: true,
          maxStreamingBitrate,
          audioStreamIndex,
        },
        data: {
          deviceProfile,
        },
      },
    );

    sessionId = res.data.PlaySessionId || null;
    mediaSource = res.data.MediaSources?.[0];
    if (!mediaSource) {
      // A server-side negotiation outcome (profile can't be satisfied,
      // transcoding disabled), not an app defect: expected keeps it out of
      // Sentry while the player surfaces it to the user.
      throw markExpectedError(
        new Error(
          `PlaybackInfo returned no media source for live channel (${res.data.ErrorCode ?? "no ErrorCode"})`,
        ),
      );
    }
    const url = getPlaybackUrl(api, item.ChannelId!, mediaSource, {
      subtitleStreamIndex,
      audioStreamIndex,
      deviceId,
      startTimeTicks: 0,
      maxStreamingBitrate,
      userId,
    });

    return {
      url,
      sessionId: sessionId || null,
      mediaSource,
      requiredHttpHeaders: mediaSource?.RequiredHttpHeaders as
        | Record<string, string>
        | undefined,
    };
  }

  const res = await getMediaInfoApi(api).getPlaybackInfo(
    {
      itemId: item.Id!,
    },
    {
      method: "POST",
      data: {
        userId,
        deviceProfile,
        subtitleStreamIndex,
        startTimeTicks,
        isPlayback: true,
        autoOpenLiveStream: true,
        maxStreamingBitrate,
        audioStreamIndex,
        mediaSourceId,
      },
    },
  );

  if (res.status !== 200) {
    console.error("Error getting playback info:", res.status, res.statusText);
  }

  sessionId = res.data.PlaySessionId || null;
  mediaSource = res.data.MediaSources?.[0];

  // Jellyfin reports negotiation failures as HTTP 200 with an ErrorCode
  // (NoCompatibleStream, RateLimitExceeded, …) and no MediaSources.
  // Fabricating a stream URL anyway just moves the failure into an opaque
  // decoder error minutes later, so fail here where the reason is known.
  if (!mediaSource) {
    // Same as the live-channel case: the server said no (NoCompatibleStream,
    // RateLimitExceeded), which is its configuration, not an app bug.
    throw markExpectedError(
      new Error(
        `PlaybackInfo returned no media source (${res.data.ErrorCode ?? "no ErrorCode"})`,
      ),
    );
  }

  const url = getPlaybackUrl(api, item.Id!, mediaSource, {
    subtitleStreamIndex,
    audioStreamIndex,
    deviceId,
    startTimeTicks,
    maxStreamingBitrate,
    userId,
    playSessionId: playSessionId || undefined,
  });

  return {
    url,
    sessionId: sessionId || null,
    mediaSource,
    requiredHttpHeaders: mediaSource?.RequiredHttpHeaders as
      | Record<string, string>
      | undefined,
  };
};

export const getDownloadStreamUrl = async ({
  api,
  item,
  userId,
  maxStreamingBitrate,
  audioStreamIndex = 0,
  subtitleStreamIndex = undefined,
  mediaSourceId,
  audioMode = "auto",
  downloadQuality,
}: {
  api: Api | null | undefined;
  item: BaseItemDto | null | undefined;
  userId: string | null | undefined;
  maxStreamingBitrate?: number;
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
  mediaSourceId?: string | null;
  audioMode?: AudioTranscodeModeType;
  /**
   * The user's Download quality setting. `original` (the default) means the download takes the
   * source file as it is; anything else is an explicit request to re-encode. Omitted is treated
   * as `original`.
   */
  downloadQuality?: DownloadQuality;
}): Promise<
  | ({
      url: string | null;
      sessionId: string | null;
      mediaSource: MediaSourceInfo | undefined;
    } & DownloadTransport)
  | null
> => {
  if (!api || !userId || !item?.Id) {
    console.warn("Missing required parameters for getStreamUrl");
    return null;
  }

  const res = await getMediaInfoApi(api).getPlaybackInfo(
    {
      itemId: item.Id!,
    },
    {
      method: "POST",
      data: {
        userId,
        deviceProfile: generateDownloadProfile(audioMode),
        subtitleStreamIndex,
        startTimeTicks: 0,
        isPlayback: true,
        autoOpenLiveStream: true,
        maxStreamingBitrate,
        audioStreamIndex,
        mediaSourceId,
      },
    },
  );

  if (res.status !== 200) {
    console.error("Error getting playback info:", res.status, res.statusText);
  }

  const sessionId = res.data.PlaySessionId || null;
  const mediaSource = res.data.MediaSources?.[0];
  if (!mediaSource) {
    console.warn("No media source offered for download");
    return null;
  }

  return getDownloadUrl(
    api,
    item.Id!,
    mediaSource,
    sessionId,
    wantsTranscodedDownload(downloadQuality, maxStreamingBitrate),
  );
};
