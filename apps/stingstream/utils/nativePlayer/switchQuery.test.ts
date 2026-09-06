import { describe, expect, test } from "bun:test";
import {
  LOCAL_SUBTITLE_INDEX_BASE,
  SUBTITLES_OFF,
} from "@/utils/subtitles/subtitleIndex";
import { buildSwitchQuery } from "./switchQuery";

const parse = (query: string) => new URLSearchParams(query);

describe("buildSwitchQuery", () => {
  test("carries the live position as ticks, not milliseconds", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 754_000,
      }),
    );
    expect(params.get("playbackPosition")).toBe("7540000000");
  });

  test("starts from the beginning when nothing has played yet", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 0,
      }),
    );
    expect(params.get("playbackPosition")).toBe("0");
  });

  test("replaces the media source and keeps the item", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-kitchen",
        progressMs: 1000,
      }),
    );
    expect(params.get("itemId")).toBe("item-1");
    expect(params.get("mediaSourceId")).toBe("ms-kitchen");
  });

  test("maps a client-side sidecar to the server's 'no subtitles'", () => {
    // The sidecar lives only on the mpv handle that is about to be destroyed.
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 0,
        subtitleIndex: LOCAL_SUBTITLE_INDEX_BASE,
      }),
    );
    expect(params.get("subtitleIndex")).toBe(String(SUBTITLES_OFF));
  });

  test("passes a real subtitle stream through untouched", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 0,
        subtitleIndex: 3,
      }),
    );
    expect(params.get("subtitleIndex")).toBe("3");
  });

  test("asks for no subtitles when nothing is selected", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 0,
      }),
    );
    expect(params.get("subtitleIndex")).toBe(String(SUBTITLES_OFF));
  });

  test("leaves audio and bitrate blank when the caller has no opinion", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 0,
      }),
    );
    expect(params.get("audioIndex")).toBe("");
    expect(params.get("bitrateValue")).toBe("");
  });

  test("carries audio and bitrate when it does", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 0,
        audioIndex: 2,
        bitrateValue: 8_000_000,
      }),
    );
    expect(params.get("audioIndex")).toBe("2");
    expect(params.get("bitrateValue")).toBe("8000000");
  });

  test("keeps an offline switch offline", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 0,
        offline: true,
      }),
    );
    expect(params.get("offline")).toBe("true");
  });

  test("never writes offline=false, which would read as offline elsewhere", () => {
    const params = parse(
      buildSwitchQuery({
        itemId: "item-1",
        mediaSourceId: "ms-b",
        progressMs: 0,
        offline: false,
      }),
    );
    expect(params.has("offline")).toBe(false);
  });
});
