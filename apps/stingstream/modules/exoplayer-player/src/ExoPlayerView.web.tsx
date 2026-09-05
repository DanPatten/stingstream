/**
 * Web sibling for `ExoPlayerView` (StingStream M2).
 *
 * `ExoPlayerView.tsx` calls `requireNativeView("ExoPlayer")` at module scope,
 * which throws on import under react-native-web and blanks the page. ExoPlayer
 * is an Android-TV-only opt-in anyway (`settings.videoPlayer`), so on web the
 * setting simply falls back to the same `<video>`/hls.js backend the default
 * path uses. Both expose `MpvPlayerViewRef`, so `VideoPlayerView` needs no
 * change and native resolution is untouched.
 */
export { default } from "@/modules/mpv-player/src/MpvPlayerView";
