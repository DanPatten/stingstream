/**
 * Heartbeat cadence, in ms, for the periodic playback progress report. The
 * players tick once a second, but the server only needs the position often
 * enough for Now Playing and resume: pause, resume and seeks report on their
 * own in both players, and the JS player also reports track and mute changes
 * at once. Shared by the JS and native players so the server sees one cadence.
 */
export const PROGRESS_REPORT_INTERVAL = 10_000;

/**
 * A ceiling on the stream the server is asked for. `undefined` is "no ceiling" — the source as it
 * is, direct-played where the device can.
 *
 * Lives here rather than beside the picker that renders it because half its readers are not
 * components: `utils/atoms/settings.ts` holds the default, `utils/jellyfin/getDefaultPlaySettings`
 * resolves it, `utils/nativePlayer/buildNativePlayerConfig` hands it to the native player. Reaching
 * into `components/BitrateSelector` for it made `settings.ts` depend on a component, which depends
 * on `common/Text`, which reads `settings.ts` again — a require cycle whose only symptom is an
 * occasional undefined at module scope, in whichever of the three happens to load first.
 * `constants/` is the layer everything may depend on and which depends on nothing.
 */
export type Bitrate = {
  key: string;
  value: number | undefined;
  /** The height the ladder rung is meant for, where it is meant for one. */
  height?: number;
};

/** Highest first, so the first entry is "Max" and index 0 is the default everywhere. */
export const BITRATES: Bitrate[] = [
  { key: "Max", value: undefined },
  { key: "8 Mb/s", value: 8000000, height: 1080 },
  { key: "4 Mb/s", value: 4000000, height: 1080 },
  { key: "2 Mb/s", value: 2000000 },
  { key: "1 Mb/s", value: 1000000 },
  { key: "500 Kb/s", value: 500000 },
  { key: "250 Kb/s", value: 250000 },
].sort(
  (a, b) =>
    (b.value || Number.POSITIVE_INFINITY) -
    (a.value || Number.POSITIVE_INFINITY),
);
