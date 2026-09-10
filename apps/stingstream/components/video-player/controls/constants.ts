import { Platform } from "react-native";
import { type ThemePalette, themePalette } from "@/constants/theme";

/**
 * The palette the over-video controls are drawn from, on every theme.
 *
 * The OSD is not a surface of the app: it is chrome laid over a film, and its
 * legibility comes from contrast against the picture rather than against a page.
 * The light theme's near-black ink on a translucent white chip is unreadable
 * over bright footage, and the theme a person picked for their library is not a
 * statement about what a player should look like.
 *
 * So the controls pin the dark palette and say so, rather than following
 * `useTheme()`. Anything drawn *outside* the video frame still follows the
 * theme like the rest of the app.
 */
export const PLAYER_PALETTE: ThemePalette = themePalette("dark");

/**
 * How long the OSD stays up with nothing happening, per surface.
 *
 * Three numbers rather than one because the cost of guessing wrong differs. On a phone the controls
 * are dismissed by tapping the video, so four seconds is a courtesy. On the web the pointer brings
 * them straight back, so they can go sooner and take the cursor with them. On a television getting
 * them back is a D-pad press that also moves focus, so five.
 */
export const CONTROLS_TIMEOUT_MS = {
  phone: 4000,
  web: 3000,
  tv: 5000,
} as const;

/** The one every surface's `useControlsTimeout` resolves to. */
export const controlsTimeoutForPlatform = (): number => {
  if (Platform.isTV) return CONTROLS_TIMEOUT_MS.tv;
  if (Platform.OS === "web") return CONTROLS_TIMEOUT_MS.web;
  return CONTROLS_TIMEOUT_MS.phone;
};

export const CONTROLS_CONSTANTS = {
  /** @deprecated Read `controlsTimeoutForPlatform()`, which is per-surface. */
  TIMEOUT: CONTROLS_TIMEOUT_MS.phone,
  // Media time left when the next episode button appears. The countdown fill
  // spans the same window, so both must move together.
  NEXT_EPISODE_COUNTDOWN_MS: 10000,
  SCRUB_INTERVAL_MS: 30 * 1000, // 30 seconds in ms
  SCRUB_INTERVAL_TICKS: 10 * 10000000, // 10 seconds in ticks
  TILE_WIDTH: 150,
  PROGRESS_UNIT_MS: 1000, // 1 second in ms
  PROGRESS_UNIT_TICKS: 10000000, // 1 second in ticks
  LONG_PRESS_INITIAL_SEEK: 30,
  LONG_PRESS_ACCELERATION: 1.2,
  LONG_PRESS_MAX_ACCELERATION: 4,
  LONG_PRESS_INTERVAL: 300,
  HOLD_SPEED_DELAY: 500,
  HOLD_SPEED_DIM_OPACITY: 0.2,
  HOLD_SPEED_DIM_DURATION: 300,
  CONTROLS_SCRIM_OPACITY: 0.75,
  SLIDER_DEBOUNCE_MS: 3,
  // Progress ticks arrive at most once per second, so the last one before EOF
  // can land anywhere inside the final second — 1.5s guarantees it's caught.
  STILL_WATCHING_EOF_WINDOW_MS: 1500,
} as const;

export const ICON_SIZES = {
  HEADER: 24,
  CENTER: 50,
} as const;

export const HEADER_LAYOUT = {
  CONTAINER_PADDING: 8, // p-2 = 8px (matches HeaderControls)
} as const;
