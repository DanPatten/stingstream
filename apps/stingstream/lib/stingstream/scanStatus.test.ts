import { describe, expect, test } from "bun:test";
import en from "@/translations/en.json";
import {
  holdHighest,
  IDLE_SCAN,
  libraryScanLabel,
  SCAN_TASK_KEY,
  scanPillLabel,
  summarizeScan,
  toPercent,
} from "./scanStatus";

/** i18next's own interpolation, near enough, over the real catalogue. */
const t = (key: string, options?: Record<string, unknown>): string => {
  const [section, name] = key.split(".");
  const catalogue = en as unknown as Record<string, Record<string, string>>;
  const template = catalogue[section]?.[name];
  if (template === undefined) throw new Error(`missing key ${key}`);
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(options?.[k]));
};

const MOVIES = "f137a2dd21bbc1b99aa5c0f6bf02a805";
const TV = "a1b2c3";

const idleFolders = [
  { ItemId: MOVIES, Name: "Movies", RefreshStatus: "Idle", RefreshProgress: null },
  { ItemId: TV, Name: "TV Shows", RefreshStatus: "Idle", RefreshProgress: null },
];
const idleTask = [{ Key: SCAN_TASK_KEY, State: "Idle" }];

describe("summarizeScan", () => {
  test("nothing scanning is idle", () => {
    expect(summarizeScan(idleFolders, idleTask)).toEqual(IDLE_SCAN);
    expect(summarizeScan(undefined, undefined)).toEqual(IDLE_SCAN);
  });

  test("one library refreshing on its own shows as that library, with its progress", () => {
    // The shape node 1 returned after POST /Items/{movies}/Refresh.
    const summary = summarizeScan(
      [
        { ...idleFolders[0], RefreshStatus: "Active", RefreshProgress: 42.7 },
        idleFolders[1],
      ],
      idleTask,
    );
    expect(summary.active).toBe(true);
    expect(summary.wholeServer).toBe(false);
    expect(summary.percent).toBe(42);
    expect(summary.libraries).toEqual([
      { id: MOVIES, name: "Movies", state: "scanning", percent: 42 },
    ]);
  });

  test("the server-wide task gives the overall number", () => {
    const summary = summarizeScan(
      [{ ...idleFolders[0], RefreshStatus: "Active", RefreshProgress: 80 }],
      [{ Key: SCAN_TASK_KEY, State: "Running", CurrentProgressPercentage: 12.5 }],
    );
    expect(summary.wholeServer).toBe(true);
    expect(summary.percent).toBe(12);
  });

  test("a queued library counts as not started", () => {
    const summary = summarizeScan(
      [
        { ...idleFolders[0], RefreshStatus: "Active", RefreshProgress: 60 },
        { ...idleFolders[1], RefreshStatus: "Queued" },
      ],
      idleTask,
    );
    expect(summary.percent).toBe(30);
    expect(summary.libraries[1]).toEqual({
      id: TV,
      name: "TV Shows",
      state: "queued",
      percent: null,
    });
  });

  test("an unrelated task running is not a scan", () => {
    expect(
      summarizeScan(idleFolders, [
        { Key: "RefreshPeople", State: "Running", CurrentProgressPercentage: 5 },
      ]).active,
    ).toBe(false);
  });
});

describe("toPercent", () => {
  test("whole numbers, never 100 while running", () => {
    expect(toPercent(99.9)).toBe(99);
    expect(toPercent(100)).toBe(99);
    expect(toPercent(-3)).toBe(0);
    expect(toPercent(null)).toBeNull();
    expect(toPercent(Number.NaN)).toBeNull();
  });
});

describe("holdHighest", () => {
  test("a library's number never goes backwards within one scan", () => {
    // Node 1, four polls a second apart: 50, 97, 97, 50.
    const highest = new Map<string, number>();
    const seen = [50, 97, 97, 50].map(
      (p) =>
        holdHighest(
          summarizeScan(
            [{ ...idleFolders[0], RefreshStatus: "Active", RefreshProgress: p }],
            idleTask,
          ),
          highest,
        ).libraries[0].percent,
    );
    expect(seen).toEqual([50, 97, 97, 97]);
  });

  test("the next scan starts from zero again", () => {
    const highest = new Map<string, number>();
    const active = (p: number) =>
      summarizeScan(
        [{ ...idleFolders[0], RefreshStatus: "Active", RefreshProgress: p }],
        idleTask,
      );
    holdHighest(active(90), highest);
    holdHighest(IDLE_SCAN, highest);
    expect(holdHighest(active(10), highest).percent).toBe(10);
  });
});

describe("labels", () => {
  const scanning = summarizeScan(
    [
      { ...idleFolders[0], RefreshStatus: "Active", RefreshProgress: 42 },
      { ...idleFolders[1], RefreshStatus: "Queued" },
    ],
    idleTask,
  );

  test("a library row says scanning, or waiting, or nothing", () => {
    expect(libraryScanLabel(scanning, MOVIES, t)).toBe("Scanning, 42%");
    expect(libraryScanLabel(scanning, TV, t)).toBe("Waiting to scan");
    expect(libraryScanLabel(IDLE_SCAN, MOVIES, t)).toBeNull();
    expect(libraryScanLabel(scanning, "", t)).toBeNull();
  });

  test("the pill names the one library scanning", () => {
    const one = summarizeScan(
      [{ ...idleFolders[0], RefreshStatus: "Active", RefreshProgress: 42 }],
      idleTask,
    );
    expect(scanPillLabel(one, t)).toBe("Scanning Movies, 42%");
    expect(scanPillLabel(IDLE_SCAN, t)).toBeNull();
  });

  test("the whole-server scan speaks of libraries", () => {
    const all = summarizeScan(idleFolders, [
      { Key: SCAN_TASK_KEY, State: "Running", CurrentProgressPercentage: 7 },
    ]);
    expect(scanPillLabel(all, t)).toBe("Scanning libraries, 7%");
    // On a library's own page the server-wide scan still covers it.
    expect(scanPillLabel(all, t, MOVIES)).toBe("Scanning libraries, 7%");
  });

  test("a library page ignores another library's scan", () => {
    const tvOnly = summarizeScan(
      [idleFolders[0], { ...idleFolders[1], RefreshStatus: "Active", RefreshProgress: 5 }],
      idleTask,
    );
    expect(scanPillLabel(tvOnly, t, MOVIES)).toBeNull();
    expect(scanPillLabel(tvOnly, t, TV)).toBe("Scanning TV Shows, 5%");
  });

  test("no number yet reads as scanning, not zero", () => {
    const unknown = summarizeScan(
      [{ ...idleFolders[0], RefreshStatus: "Active", RefreshProgress: null }],
      idleTask,
    );
    expect(scanPillLabel(unknown, t)).toBe("Scanning Movies…");
    expect(libraryScanLabel(unknown, MOVIES, t)).toBe("Scanning…");
  });

  test("the copy has no em dash and names no child application", () => {
    const strings = Object.values(
      (en as unknown as Record<string, Record<string, string>>).scan_status,
    );
    for (const s of strings) {
      expect(s).not.toContain("—");
      expect(s).not.toMatch(/jellyfin|radarr|sonarr/i);
    }
  });
});
