import { Redirect } from "expo-router";

/**
 * Folded into Playback & subtitles, which gathered the four playback pages into one page of
 * sections. Nothing about the controls changed; they are one click closer.
 */
export default function Moved() {
  return <Redirect href='/settings/playback' />;
}
