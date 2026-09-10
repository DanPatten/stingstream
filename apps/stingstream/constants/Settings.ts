/**
 * The Settings screen's own layout policy.
 *
 * Shared by `components/settings/SettingsShell.tsx`, `SettingsNav.tsx` and
 * their test, which is the first half of the constants rule; the width is also
 * a decision rather than a layout detail, which is the second.
 */

/**
 * Where Settings becomes two panes.
 *
 * Not the app's own 768 px `isWebWide` floor. At 768 the window already holds a
 * 240 px application sidebar, and a 264 px settings column on top of that
 * leaves 264 px for a form whose readable measure is 960 — three columns in
 * less than half the room any of them wants. 1024 is the first width where the
 * sidebar, the category column and a real form all fit at once.
 */
export const SETTINGS_TWO_PANE_MIN_WIDTH = 1024;

/**
 * The category column, in dp.
 *
 * Wider than the application sidebar's 240 because these rows carry a second
 * line: "Transcoding & hardware" over "Hardware acceleration, and the ceiling
 * on what a remote viewer may stream". At 240 the longer labels wrapped to
 * three lines and the column stopped scanning as a list.
 *
 * 264 was the second try and it was 24 px short: the screenshot sweep reported
 * "Network & remote access" overflowing its own box on every settings screen at
 * every viewport, because the label had nowhere left to go.
 */
export const SETTINGS_NAV_WIDTH = 288;

/**
 * How long a control the search jumped to stays highlighted.
 *
 * Long enough to find with the eye after the scroll settles, short enough that
 * it has faded before you start reading. Held still under reduced motion — see
 * `FocusTarget`.
 */
export const SETTINGS_FOCUS_HIGHLIGHT_MS = 1600;

/**
 * Whether Settings draws its category column beside the page.
 *
 * Pure so the threshold can be pinned without rendering: `useBreakpoint` reads
 * a module-scope `Dimensions` listener, which a plain `bun test` spec has no
 * way to drive.
 */
export const settingsTwoPane = (width: number, isWebWide: boolean): boolean =>
  isWebWide && width >= SETTINGS_TWO_PANE_MIN_WIDTH;
