import { describe, expect, test } from "bun:test";
import { KEYBOARD_SEEK_SECONDS, mapKeyToPlayerAction } from "./keyboardMap";

const web = { platform: "web", isTV: false, hasModifier: false };

describe("mapKeyToPlayerAction", () => {
  test("space and k both toggle playback", () => {
    for (const key of [" ", "Space", "Spacebar", "k", "K"]) {
      expect(mapKeyToPlayerAction(key, web)).toBe("togglePlay");
    }
  });

  test("the arrow keys seek", () => {
    expect(mapKeyToPlayerAction("ArrowLeft", web)).toBe("seekBack");
    expect(mapKeyToPlayerAction("ArrowRight", web)).toBe("seekForward");
  });

  test("f toggles fullscreen and m toggles mute, in either case", () => {
    expect(mapKeyToPlayerAction("f", web)).toBe("toggleFullscreen");
    expect(mapKeyToPlayerAction("F", web)).toBe("toggleFullscreen");
    expect(mapKeyToPlayerAction("m", web)).toBe("toggleMute");
    expect(mapKeyToPlayerAction("M", web)).toBe("toggleMute");
  });

  test("Escape leaves fullscreen rather than closing the player", () => {
    expect(mapKeyToPlayerAction("Escape", web)).toBe("exitFullscreen");
  });

  test("a key the player does not own is left to the browser", () => {
    for (const key of ["a", "Tab", "Enter", "ArrowUp", "ArrowDown", "1"]) {
      expect(mapKeyToPlayerAction(key, web)).toBeNull();
    }
  });

  test("nothing is claimed on television, where the arrows are the D-pad", () => {
    const tv = { platform: "android", isTV: true, hasModifier: false };
    for (const key of [
      " ",
      "k",
      "ArrowLeft",
      "ArrowRight",
      "f",
      "m",
      "Escape",
    ]) {
      expect(mapKeyToPlayerAction(key, tv)).toBeNull();
    }
  });

  test("nothing is claimed off the web, where there is no keyboard to speak of", () => {
    for (const platform of ["ios", "android", "macos", "windows"]) {
      expect(
        mapKeyToPlayerAction(" ", {
          platform,
          isTV: false,
          hasModifier: false,
        }),
      ).toBeNull();
    }
  });

  test("a modifier hands the key back to the browser", () => {
    // Ctrl+F is find, Cmd+M minimises: swallowing those makes the page feel broken.
    for (const key of [" ", "k", "f", "m", "ArrowLeft", "Escape"]) {
      expect(
        mapKeyToPlayerAction(key, { ...web, hasModifier: true }),
      ).toBeNull();
    }
  });

  test("the seek step matches the on-screen skip buttons", () => {
    expect(KEYBOARD_SEEK_SECONDS).toBe(10);
  });
});
