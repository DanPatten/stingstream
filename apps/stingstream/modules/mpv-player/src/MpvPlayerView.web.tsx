/**
 * Web backend for the video player (StingStream M2 web target).
 *
 * `MpvPlayerView.tsx` binds a native libmpv surface via
 * `requireNativeView("MpvPlayer")`. There is no libmpv in a browser, so this
 * `.web` sibling implements the *same* `MpvPlayerViewRef` + `MpvPlayerViewProps`
 * contract on top of a plain `<video>` element:
 *
 *   - **HLS** (Jellyfin transcodes, `master.m3u8` / `main.m3u8`) goes through
 *     `hls.js` on Chrome/Firefox/Edge, and through the browser's own HLS support
 *     on Safari/iOS, which `hls.js` reports as `Hls.isSupported() === false`.
 *   - **Direct play** (mp4/webm/mkv the browser can demux) is handed straight to
 *     `video.src`, so no transcode is requested when the codecs line up.
 *
 * Upstream shipped a placeholder here that rendered the stream URL in an
 * `<iframe>`; this replaces it with a working player. Metro only resolves this
 * file for `platform === "web"`, so every native bundle keeps the real MPV view
 * with no behaviour change.
 *
 * Deliberate gaps, all MPV-specific and all inert rather than throwing:
 *   - ASS/SSA subtitle rendering and every subtitle *styling* control
 *     (`setSubtitleStyle`, `setSubtitleAssOverride`, margins, alignment,
 *     scale, delay). The browser renders WebVTT with its own UA styles.
 *   - `source.headers` can only be applied to HLS segment/manifest requests
 *     (via `xhrSetup`); a direct-play `<video src>` cannot carry custom
 *     headers, so Jellyfin's `api_key` query parameter is what authenticates
 *     it. This matters for the StingStream side door, which must therefore keep
 *     accepting query-string auth for web clients.
 *   - `getTechnicalInfo` reports only what the browser exposes (dimensions,
 *     dropped frames, buffered seconds, hls.js level codecs); MPV-only fields
 *     such as `hwdec` or `voDriver` stay undefined.
 */

import Hls, { type ErrorData, type Events as HlsEvents } from "hls.js";
import * as React from "react";
import { View } from "react-native";
import type {
  AudioTrack,
  MpvPlayerViewProps,
  MpvPlayerViewRef,
  SubtitleTrack,
  TechnicalInfo,
} from "./MpvPlayer.types";

/** Jellyfin hands us `.m3u8` for every transcode; everything else is direct play. */
const isHlsUrl = (url: string) => /\.m3u8(\?|$)/i.test(url);

/** Seconds of media buffered ahead of `position` in the video's buffered ranges. */
const bufferedAhead = (video: HTMLVideoElement): number => {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) {
      return Math.max(0, video.buffered.end(i) - t);
    }
  }
  return 0;
};

const MpvPlayerViewWeb = React.forwardRef<MpvPlayerViewRef, MpvPlayerViewProps>(
  function MpvPlayerViewWeb(props, ref) {
    // Only the source/style are read during render; every `on*` callback is
    // reached through `cbRef` below so that a new callback identity does not
    // tear down and re-attach the media element.
    const { source, style } = props;

    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    const hlsRef = React.useRef<Hls | null>(null);
    const zoomedRef = React.useRef(false);
    // Subtitle tracks added through `addSubtitleFile`, keyed by the synthetic id
    // we hand back to callers (native mpv ids are 1-based, so we mirror that).
    const externalSubsRef = React.useRef<
      { id: number; url: string; element: HTMLTrackElement }[]
    >([]);

    // Callbacks change identity every render in the player screen; keep the
    // latest in a ref so the load effect does not re-run (and re-buffer) on
    // every parent render.
    const cbRef = React.useRef(props);
    cbRef.current = props;

    const url = source?.url;
    const startPosition = source?.startPosition;
    const autoplay = source?.autoplay;
    const loop = source?.loop;
    const headersKey = JSON.stringify(source?.headers ?? null);

    // ---- load / teardown -------------------------------------------------
    React.useEffect(() => {
      const video = videoRef.current;
      if (!video || !url) return;

      let cancelled = false;
      const headers: Record<string, string> = source?.headers ?? {};

      const emitError = (message: string) =>
        cbRef.current.onError?.({ nativeEvent: { error: message } });

      const attachDirect = () => {
        video.src = url;
      };

      if (isHlsUrl(url) && Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          // Roughly mirrors the native default of ~10 s of forward cache.
          backBufferLength: 60,
          xhrSetup: (xhr) => {
            for (const [k, v] of Object.entries(headers)) {
              try {
                xhr.setRequestHeader(k, v);
              } catch {
                // Forbidden header names are dropped silently; Jellyfin's
                // api_key query parameter is the real auth path here.
              }
            }
          },
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_e: HlsEvents.ERROR, data: ErrorData) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          emitError(`${data.type}: ${data.details}`);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return;
          cbRef.current.onTracksReady?.({ nativeEvent: {} });
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        // Safari/iOS play HLS natively; everything else here is direct play.
        attachDirect();
      }

      return () => {
        cancelled = true;
        hlsRef.current?.destroy();
        hlsRef.current = null;
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {
          // Teardown races with navigation; nothing useful to report.
        }
      };
      // `source.headers` is compared by value via headersKey.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, headersKey]);

    // ---- DOM events -> the native player's event contract ----------------
    React.useEffect(() => {
      const video = videoRef.current;
      if (!video) return;

      let seeded = false;

      const state = () =>
        cbRef.current.onPlaybackStateChange?.({
          nativeEvent: {
            isPaused: video.paused,
            isPlaying: !video.paused && !video.ended && video.readyState > 2,
            isLoading: video.readyState < 3,
            isReadyToSeek: video.readyState >= 1,
          },
        });

      const onLoadedMetadata = () => {
        if (!seeded && startPosition && startPosition > 0) {
          seeded = true;
          try {
            video.currentTime = startPosition;
          } catch {
            // Seeking before the media is seekable throws in some browsers;
            // the timeupdate path picks it up once it is.
          }
        }
        cbRef.current.onLoad?.({ nativeEvent: { url: url ?? "" } });
        cbRef.current.onTracksReady?.({ nativeEvent: {} });
        state();
      };

      const onTimeUpdate = () => {
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        cbRef.current.onProgress?.({
          nativeEvent: {
            position: video.currentTime,
            duration,
            progress: duration > 0 ? video.currentTime / duration : 0,
            cacheSeconds: bufferedAhead(video),
          },
        });
      };

      const onVideoError = () => {
        const err = video.error;
        cbRef.current.onError?.({
          nativeEvent: {
            error: err
              ? `MEDIA_ERR_${err.code}: ${err.message}`
              : "Media error",
          },
        });
      };

      const onEnterPip = () =>
        cbRef.current.onPictureInPictureChange?.({
          nativeEvent: { isActive: true },
        });
      const onLeavePip = () =>
        cbRef.current.onPictureInPictureChange?.({
          nativeEvent: { isActive: false },
        });

      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("progress", onTimeUpdate);
      video.addEventListener("play", state);
      video.addEventListener("playing", state);
      video.addEventListener("pause", state);
      video.addEventListener("waiting", state);
      video.addEventListener("canplay", state);
      video.addEventListener("ended", state);
      video.addEventListener("error", onVideoError);
      video.addEventListener("enterpictureinpicture", onEnterPip);
      video.addEventListener("leavepictureinpicture", onLeavePip);

      return () => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("progress", onTimeUpdate);
        video.removeEventListener("play", state);
        video.removeEventListener("playing", state);
        video.removeEventListener("pause", state);
        video.removeEventListener("waiting", state);
        video.removeEventListener("canplay", state);
        video.removeEventListener("ended", state);
        video.removeEventListener("error", onVideoError);
        video.removeEventListener("enterpictureinpicture", onEnterPip);
        video.removeEventListener("leavepictureinpicture", onLeavePip);
      };
    }, [url, startPosition]);

    // ---- imperative surface ---------------------------------------------
    React.useImperativeHandle(ref, (): MpvPlayerViewRef => {
      const v = () => videoRef.current;
      const noop = async () => {};

      return {
        play: async () => {
          try {
            await v()?.play();
          } catch {
            // Autoplay policy: the controls layer surfaces a play button.
          }
        },
        pause: async () => {
          v()?.pause();
        },
        destroy: async () => {
          hlsRef.current?.destroy();
          hlsRef.current = null;
          const video = v();
          if (!video) return;
          video.pause();
          video.removeAttribute("src");
          video.load();
        },
        seekTo: async (position: number) => {
          const video = v();
          if (video) video.currentTime = position;
        },
        seekBy: async (offset: number) => {
          const video = v();
          if (video) video.currentTime = video.currentTime + offset;
        },
        setSpeed: async (speed: number) => {
          const video = v();
          if (video) video.playbackRate = speed;
        },
        getSpeed: async () => v()?.playbackRate ?? 1,
        setMute: async (muted: boolean) => {
          const video = v();
          if (video) video.muted = muted;
        },
        isPaused: async () => v()?.paused ?? true,
        getCurrentPosition: async () => v()?.currentTime ?? 0,
        getDuration: async () => {
          const d = v()?.duration ?? 0;
          return Number.isFinite(d) ? d : 0;
        },

        // Picture-in-Picture ------------------------------------------------
        startPictureInPicture: async () => {
          const video = v() as any;
          if (video?.requestPictureInPicture) {
            try {
              await video.requestPictureInPicture();
            } catch {
              // Requires a user gesture in most browsers.
            }
          }
        },
        stopPictureInPicture: async () => {
          const doc = document as any;
          if (doc.pictureInPictureElement) {
            try {
              await doc.exitPictureInPicture();
            } catch {
              // Already exited.
            }
          }
        },
        isPictureInPictureSupported: async () =>
          Boolean((document as any).pictureInPictureEnabled),
        isPictureInPictureActive: async () =>
          Boolean((document as any).pictureInPictureElement),

        // Subtitles ---------------------------------------------------------
        getSubtitleTracks: async (): Promise<SubtitleTrack[]> => {
          const video = v();
          const hls = hlsRef.current;
          if (hls?.subtitleTracks?.length) {
            return hls.subtitleTracks.map((t, i) => ({
              id: i + 1,
              title: t.name,
              lang: t.lang,
              selected: hls.subtitleTrack === i,
            }));
          }
          if (!video) return [];
          return Array.from(video.textTracks).map((t, i) => ({
            id: i + 1,
            title: t.label || undefined,
            lang: t.language || undefined,
            external: externalSubsRef.current.some((e) => e.id === i + 1),
            selected: t.mode === "showing",
          }));
        },
        setSubtitleTrack: async (trackId: number) => {
          const hls = hlsRef.current;
          if (hls?.subtitleTracks?.length) {
            hls.subtitleTrack = trackId - 1;
            return;
          }
          const video = v();
          if (!video) return;
          Array.from(video.textTracks).forEach((t, i) => {
            t.mode = i === trackId - 1 ? "showing" : "disabled";
          });
        },
        disableSubtitles: async () => {
          const hls = hlsRef.current;
          if (hls) hls.subtitleTrack = -1;
          const video = v();
          if (!video) return;
          Array.from(video.textTracks).forEach((t) => {
            t.mode = "disabled";
          });
        },
        getCurrentSubtitleTrack: async () => {
          const hls = hlsRef.current;
          if (hls?.subtitleTracks?.length) return hls.subtitleTrack + 1;
          const video = v();
          if (!video) return -1;
          const idx = Array.from(video.textTracks).findIndex(
            (t) => t.mode === "showing",
          );
          return idx >= 0 ? idx + 1 : -1;
        },
        /**
         * Jellyfin serves sidecar subtitles as WebVTT when asked
         * (`.../Subtitles/<i>/Stream.vtt`), which is the only format a
         * `<track>` accepts. SRT/ASS URLs will load but render nothing.
         */
        addSubtitleFile: async (subUrl: string, select = false) => {
          const video = v();
          if (!video) return;
          const existing = externalSubsRef.current.find(
            (e) => e.url === subUrl,
          );
          if (existing) {
            if (select) existing.element.track.mode = "showing";
            return;
          }
          const el = document.createElement("track");
          el.kind = "subtitles";
          el.src = subUrl;
          el.default = select;
          video.appendChild(el);
          const id = video.textTracks.length;
          externalSubsRef.current.push({ id, url: subUrl, element: el });
          if (select) el.track.mode = "showing";
        },

        // MPV-only subtitle styling: inert on web, never throwing, so the
        // settings screens and the controls overlay behave normally.
        setSubtitlePosition: noop,
        setSubtitleScale: noop,
        setSubtitleDelay: noop,
        setSubtitleMarginY: noop,
        setSubtitleAlignX: noop,
        setSubtitleAlignY: noop,
        setSubtitleStyle: noop,
        setSubtitleFontSize: noop,
        setSubtitleBackgroundColor: noop,
        setSubtitleBorderStyle: noop,
        setSubtitleAssOverride: noop,

        // Audio -------------------------------------------------------------
        getAudioTracks: async (): Promise<AudioTrack[]> => {
          const hls = hlsRef.current;
          if (hls?.audioTracks?.length) {
            return hls.audioTracks.map((t, i) => ({
              id: i + 1,
              title: t.name,
              lang: t.lang,
              selected: hls.audioTrack === i,
            }));
          }
          const tracks = (v() as any)?.audioTracks;
          if (!tracks) return [];
          return Array.from(tracks as ArrayLike<any>).map(
            (t: any, i: number) => ({
              id: i + 1,
              title: t.label || undefined,
              lang: t.language || undefined,
              selected: Boolean(t.enabled),
            }),
          );
        },
        setAudioTrack: async (trackId: number) => {
          const hls = hlsRef.current;
          if (hls?.audioTracks?.length) {
            hls.audioTrack = trackId - 1;
            return;
          }
          const tracks = (v() as any)?.audioTracks;
          if (!tracks) return;
          Array.from(tracks as ArrayLike<any>).forEach((t: any, i: number) => {
            t.enabled = i === trackId - 1;
          });
        },
        getCurrentAudioTrack: async () => {
          const hls = hlsRef.current;
          if (hls?.audioTracks?.length) return hls.audioTrack + 1;
          const tracks = (v() as any)?.audioTracks;
          if (!tracks) return -1;
          const idx = Array.from(tracks as ArrayLike<any>).findIndex(
            (t: any) => t.enabled,
          );
          return idx >= 0 ? idx + 1 : -1;
        },

        // Video scaling: MPV's "zoom to fill" is `object-fit: cover`.
        setZoomedToFill: async (zoomed: boolean) => {
          zoomedRef.current = zoomed;
          const video = v();
          if (video) video.style.objectFit = zoomed ? "cover" : "contain";
        },
        isZoomedToFill: async () => zoomedRef.current,

        getTechnicalInfo: async (): Promise<TechnicalInfo> => {
          const video = v();
          const hls = hlsRef.current;
          const quality =
            typeof (video as any)?.getVideoPlaybackQuality === "function"
              ? (video as any).getVideoPlaybackQuality()
              : undefined;
          const level =
            hls && hls.currentLevel >= 0
              ? hls.levels[hls.currentLevel]
              : undefined;
          return {
            videoWidth: video?.videoWidth || undefined,
            videoHeight: video?.videoHeight || undefined,
            videoCodec: level?.videoCodec,
            audioCodec: level?.audioCodec,
            videoBitrate: level?.bitrate,
            cacheSeconds: video ? bufferedAhead(video) : undefined,
            droppedFrames: quality?.droppedVideoFrames,
            videoCodecs: level?.codecs,
          };
        },
      };
    }, []);

    return (
      <View style={style}>
        {/* biome-ignore lint/a11y/useMediaCaption: tracks are added at runtime
            from the Jellyfin item's subtitle streams. */}
        <video
          ref={videoRef}
          autoPlay={autoplay !== false}
          loop={Boolean(loop)}
          playsInline
          crossOrigin='anonymous'
          preload='auto'
          style={{
            width: "100%",
            height: "100%",
            backgroundColor: "#000",
            objectFit: "contain",
          }}
        />
      </View>
    );
  },
);

export default MpvPlayerViewWeb;
