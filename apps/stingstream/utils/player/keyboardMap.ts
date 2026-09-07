/**
 * The player's keyboard shortcuts, as a pure lookup.
 *
 * Web is the only place these matter — a phone has no keyboard, and on a television the arrow keys
 * are the D-pad, so a key map that answered there would fight `useRemoteControl` for LEFT/RIGHT and
 * make focus navigation seek. Hence `isTV` short-circuits everything, and the caller passes the
 * platform in rather than reading it here, so the rule can be tested for every platform at once.
 *
 * Modifiers are excluded for the same reason every video site excludes them: Ctrl+F is find,
 * Cmd+M minimises, and a player that swallowed those would be a player people close.
 */

export type PlayerAction =
  | "togglePlay"
  | "seekBack"
  | "seekForward"
  | "toggleFullscreen"
  | "toggleMute"
  | "exitFullscreen";

/** How far the arrow keys move, in seconds. The same step the on-screen skip buttons use. */
export const KEYBOARD_SEEK_SECONDS = 10;

export interface KeyContext {
  /** `Platform.OS`. Only `"web"` has a keyboard worth mapping. */
  platform: string;
  isTV: boolean;
  /** Any of Ctrl, Alt, Meta or (for the letter keys) Shift was held. */
  hasModifier: boolean;
}

/**
 * `null` means "not ours" — the caller must let the event through so browser and screen-reader
 * shortcuts keep working.
 */
export const mapKeyToPlayerAction = (
  key: string,
  context: KeyContext,
): PlayerAction | null => {
  if (context.isTV || context.platform !== "web") return null;
  if (context.hasModifier) return null;

  switch (key) {
    // Both spellings: browsers report " ", older React Native Web reported "Spacebar".
    case " ":
    case "Space":
    case "Spacebar":
    case "k":
    case "K":
      return "togglePlay";
    case "ArrowLeft":
      return "seekBack";
    case "ArrowRight":
      return "seekForward";
    case "f":
    case "F":
      return "toggleFullscreen";
    case "m":
    case "M":
      return "toggleMute";
    // Escape leaves fullscreen rather than closing the player: the browser fires it for its own
    // fullscreen exit too, and a player that also navigated away would lose the user's place.
    case "Escape":
      return "exitFullscreen";
    default:
      return null;
  }
};
