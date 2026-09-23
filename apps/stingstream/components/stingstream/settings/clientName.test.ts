import { describe, expect, test } from "bun:test";
import {
  isAutomaticClientName,
  nameForType,
  suggestClientName,
} from "./clientName";

const LABELS = ["qBittorrent", "Transmission", "SABnzbd", "NZBGet"];

describe("download client names", () => {
  test("an empty name takes the type's label", () => {
    expect(nameForType("", "qBittorrent", LABELS, [])).toBe("qBittorrent");
  });

  test("a name the form wrote follows the type", () => {
    expect(nameForType("qBittorrent", "SABnzbd", LABELS, [])).toBe("SABnzbd");
    expect(nameForType("qBittorrent 2", "NZBGet", LABELS, [])).toBe("NZBGet");
  });

  test("a name the reader typed is kept", () => {
    expect(nameForType("Seedbox", "SABnzbd", LABELS, [])).toBe("Seedbox");
    expect(nameForType("qBittorrent at home", "SABnzbd", LABELS, [])).toBe(
      "qBittorrent at home",
    );
  });

  test("a taken name gets the next free number", () => {
    expect(suggestClientName("qBittorrent", ["qbittorrent"])).toBe(
      "qBittorrent 2",
    );
    expect(
      suggestClientName("qBittorrent", ["qBittorrent", "qBittorrent 2"]),
    ).toBe("qBittorrent 3");
  });

  test("labels with regex characters are matched literally", () => {
    expect(isAutomaticClientName("a.b", ["a+b"])).toBe(false);
    expect(isAutomaticClientName("a+b 4", ["a+b"])).toBe(true);
  });
});
