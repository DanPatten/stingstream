import { describe, expect, test } from "bun:test";
import type { MediaSourceInfo } from "@jellyfin/sdk/lib/generated-client/models";
import { pickNegotiatedSource } from "./pickNegotiatedSource";

const source = (id: string): MediaSourceInfo => ({ Id: id });

describe("pickNegotiatedSource", () => {
  test("takes the source that was asked for, wherever it sits in the list", () => {
    // The case that matters once several servers hold one title: PlaybackInfo hands back a
    // *ranked* list, so position means "what the scorer preferred", not "what you chose".
    const chosen = pickNegotiatedSource(
      [source("attic"), source("loft"), source("local")],
      "local",
    );

    expect(chosen?.Id).toBe("local");
  });

  test("falls back to the first when nothing was asked for", () => {
    // The live-channel and no-id paths, where the ranked first really is the answer.
    expect(pickNegotiatedSource([source("a"), source("b")], null)?.Id).toBe(
      "a",
    );
    expect(pickNegotiatedSource([source("a")], undefined)?.Id).toBe("a");
  });

  test("falls back to the first when the id is not in the list", () => {
    // A stale id from a library that has rescanned. Playing the best copy beats not playing.
    expect(pickNegotiatedSource([source("a"), source("b")], "gone")?.Id).toBe(
      "a",
    );
  });

  test("has nothing to offer for an empty answer", () => {
    expect(pickNegotiatedSource([], "a")).toBeUndefined();
    expect(pickNegotiatedSource(null, "a")).toBeUndefined();
    expect(pickNegotiatedSource(undefined, "a")).toBeUndefined();
  });
});
