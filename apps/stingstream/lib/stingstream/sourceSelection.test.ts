import { describe, expect, test } from "bun:test";
import type { SourcePin } from "@/utils/sourcePinMemory";
import type { SourceChoice, SourceChoiceLabels } from "./sourceChooser";
import {
  AUTO_KEY,
  buildSourceMenu,
  formatAutoTarget,
  resolveSourceSelection,
  selectionLabel,
} from "./sourceSelection";

// Pure, like `sourceChooser`: choices in, a decision out. No storage and no react-native.

const LABELS: SourceChoiceLabels = {
  direct: "Direct",
  relayed: "Relayed",
  connecting: "Connecting",
  offline: "Offline",
  recommended: "Recommended",
  sameFile: "Same file",
  playing: "Playing",
};

const choice = (
  over: Partial<SourceChoice> & { mediaSourceId: string },
): SourceChoice => ({
  node: null,
  nodeName: "This server",
  local: false,
  online: true,
  recommended: false,
  current: false,
  sameFileAsCurrent: false,
  disabled: false,
  route: "direct",
  resolution: "1080p",
  height: 1080,
  bitrate: 8_000_000,
  rttMs: 20,
  fileHash: null,
  ...over,
});

const local = choice({
  mediaSourceId: "local",
  node: null,
  nodeName: "This server",
  local: true,
  route: "local",
  rttMs: null,
});

const attic = choice({
  mediaSourceId: "attic",
  node: "AAAA",
  nodeName: "Attic PC",
  resolution: "2160p",
  height: 2160,
  rttMs: 18,
});

const pin = (over: Partial<SourcePin> = {}): SourcePin => ({
  node: "AAAA",
  nodeName: "Attic PC",
  updatedAt: 0,
  ...over,
});

describe("resolveSourceSelection", () => {
  test("with no pin, Auto is the recommended row", () => {
    const choices = [{ ...local, recommended: true }, attic];
    const resolved = resolveSourceSelection(choices, undefined);

    expect(resolved.mode).toBe("auto");
    expect(resolved.selected?.mediaSourceId).toBe("local");
    expect(resolved.autoChoice?.mediaSourceId).toBe("local");
    expect(resolved.pinnedChoice).toBeNull();
    expect(resolved.pinnedName).toBeNull();
  });

  test("a pin that resolves is what plays, even when Auto disagrees", () => {
    // The whole point of pinning: the scorer would have taken the local file, and the person said
    // no. If Auto could override that, the control would be a lie.
    const choices = [{ ...local, recommended: true }, attic];
    const resolved = resolveSourceSelection(choices, pin());

    expect(resolved.mode).toBe("pinned");
    expect(resolved.selected?.mediaSourceId).toBe("attic");
    expect(resolved.autoChoice?.mediaSourceId).toBe("local");
  });

  test("a pinned holder that is switched off still plays, via Auto", () => {
    // The movie has to start. What must not happen is silently playing something else with no
    // explanation, which is why the mode is distinct from `auto`.
    const offline = { ...attic, online: false, disabled: true };
    const choices = [{ ...local, recommended: true }, offline];
    const resolved = resolveSourceSelection(choices, pin());

    expect(resolved.mode).toBe("pinned-offline");
    expect(resolved.selected?.mediaSourceId).toBe("local");
    expect(resolved.pinnedChoice?.mediaSourceId).toBe("attic");
    expect(resolved.pinnedName).toBe("Attic PC");
  });

  test("a pinned holder that no longer has the title falls back and keeps its name", () => {
    const choices = [{ ...local, recommended: true }];
    const resolved = resolveSourceSelection(choices, pin());

    expect(resolved.mode).toBe("pinned-missing");
    expect(resolved.selected?.mediaSourceId).toBe("local");
    expect(resolved.pinnedChoice).toBeNull();
    // Read off the pin, because there is no row left to read it from — and "a server you chose"
    // is not a sentence worth showing anybody.
    expect(resolved.pinnedName).toBe("Attic PC");
  });

  test("a pin on this server finds the local row", () => {
    const choices = [attic, { ...local, recommended: true }];
    const resolved = resolveSourceSelection(
      choices,
      pin({ node: null, nodeName: "This server" }),
    );

    expect(resolved.mode).toBe("pinned");
    expect(resolved.selected?.local).toBe(true);
  });

  test("two local cuts are told apart by hash", () => {
    // A folder holding a 1080p and a 720p gives two rows that both mean "this server", and there
    // is no node id to separate them.
    const hd = { ...local, mediaSourceId: "hd", fileHash: "aaa" };
    const sd = { ...local, mediaSourceId: "sd", fileHash: "bbb" };
    const resolved = resolveSourceSelection(
      [hd, sd],
      pin({ node: null, fileHash: "BBB" }),
    );

    expect(resolved.selected?.mediaSourceId).toBe("sd");
  });

  test("a local pin whose exact file has gone still means this server", () => {
    const hd = {
      ...local,
      mediaSourceId: "hd",
      fileHash: "aaa",
      recommended: true,
    };
    const resolved = resolveSourceSelection(
      [hd],
      pin({ node: null, fileHash: "gone" }),
    );

    expect(resolved.mode).toBe("pinned");
    expect(resolved.selected?.mediaSourceId).toBe("hd");
  });

  test("node ids match without regard to case", () => {
    const resolved = resolveSourceSelection([attic], pin({ node: "aaaa" }));
    expect(resolved.mode).toBe("pinned");
  });

  test("an offline recommendation is not what Auto resolves to", () => {
    // `recommended` is decided over playable rows, but a stale list could carry it on a disabled
    // one; Auto must never hand the play button something that cannot serve.
    const choices = [
      { ...attic, online: false, disabled: true, recommended: true },
    ];
    const resolved = resolveSourceSelection(choices, undefined);

    expect(resolved.autoChoice).toBeNull();
    expect(resolved.selected).toBeNull();
  });

  test("nothing to play is not a crash", () => {
    const resolved = resolveSourceSelection([], pin());
    expect(resolved.mode).toBe("pinned-missing");
    expect(resolved.selected).toBeNull();
  });
});

describe("buildSourceMenu", () => {
  test("Auto leads, and is selected when there is no pin", () => {
    const choices = [{ ...local, recommended: true }, attic];
    const rows = buildSourceMenu(
      choices,
      resolveSourceSelection(choices, undefined),
    );

    expect(rows[0].key).toBe(AUTO_KEY);
    expect(rows[0].choice).toBeNull();
    expect(rows[0].selected).toBe(true);
    expect(rows.map((r) => r.key)).toEqual([AUTO_KEY, "local", "attic"]);
  });

  test("exactly one row is selected, and it is the pinned one", () => {
    const choices = [{ ...local, recommended: true }, attic];
    const rows = buildSourceMenu(
      choices,
      resolveSourceSelection(choices, pin()),
    );

    expect(rows.filter((r) => r.selected).map((r) => r.key)).toEqual(["attic"]);
  });

  test("an offline pin stays selected, because it is still what was chosen", () => {
    const offline = { ...attic, online: false, disabled: true };
    const choices = [{ ...local, recommended: true }, offline];
    const rows = buildSourceMenu(
      choices,
      resolveSourceSelection(choices, pin()),
    );

    expect(rows.filter((r) => r.selected).map((r) => r.key)).toEqual(["attic"]);
  });
});

describe("labels", () => {
  test("Auto reads as what it currently resolves to", () => {
    expect(formatAutoTarget(attic, LABELS)).toBe(
      "Attic PC · 2160p · 8.0 Mb/s · 18 ms · Direct",
    );
  });

  test("Auto with nothing to resolve to says nothing", () => {
    expect(formatAutoTarget(null, LABELS)).toBeNull();
  });

  test("the collapsed control says Auto, or the server that was chosen", () => {
    const choices = [{ ...local, recommended: true }, attic];
    expect(
      selectionLabel(resolveSourceSelection(choices, undefined), "Auto"),
    ).toBe("Auto");
    expect(selectionLabel(resolveSourceSelection(choices, pin()), "Auto")).toBe(
      "Attic PC",
    );
  });

  test("a pin that cannot be honoured still reads as the server that was chosen", () => {
    // Flipping the label back to "Auto" would look like the choice had been thrown away. The
    // line underneath is what explains that it is not being used right now.
    const resolved = resolveSourceSelection(
      [{ ...local, recommended: true }],
      pin(),
    );
    expect(selectionLabel(resolved, "Auto")).toBe("Attic PC");
  });
});
