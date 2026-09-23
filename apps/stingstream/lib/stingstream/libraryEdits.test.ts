import { describe, expect, test } from "bun:test";
import type { Library } from "./librariesApi";
import { applyLibraryUpdate, PendingLibraryEdits } from "./libraryEdits";

const movies = (enabled: boolean): Library => ({
  id: "movies",
  name: "Movies",
  type: "movies",
  paths: ["D:\\Movies"],
  enabled,
  hidden: false,
  builtin: true,
  managed: true,
  jellyfinItemId: "abc",
});

const tv: Library = {
  ...movies(true),
  id: "tv",
  name: "TV Shows",
  type: "tvshows",
};

const enabledOf = (rows: Library[], id = "movies") =>
  rows.find((row) => row.id === id)?.enabled;

describe("the switch stays where it was put", () => {
  test("a poll that answers while the save is in flight cannot put it back", () => {
    const edits = new PendingLibraryEdits();
    // Movies is on. The reader switches it off.
    edits.begin("movies", { enabled: false });

    // The 30 second poll lands before the node has saved: it still says on.
    const polled = edits.apply([movies(true), tv]);

    expect(enabledOf(polled)).toBe(false);
    // Nothing else in the list is touched.
    expect(enabledOf(polled, "tv")).toBe(true);
  });

  test("an answer to an earlier press is an echo, not the new value", () => {
    const edits = new PendingLibraryEdits();
    const off = edits.begin("movies", { enabled: false });
    const on = edits.begin("movies", { enabled: true });

    // The first press's answer arrives after the second press. It must not settle anything.
    expect(edits.settle("movies", off)).toBe(false);
    expect(enabledOf(edits.apply([movies(false)]))).toBe(true);

    // The second press's answer does.
    expect(edits.settle("movies", on)).toBe(true);
    expect(edits.has("movies")).toBe(false);
  });

  test("pressed off, on, off in a row: every fetch meanwhile shows the last press", () => {
    const edits = new PendingLibraryEdits();
    const seqs = [
      edits.begin("movies", { enabled: false }),
      edits.begin("movies", { enabled: true }),
      edits.begin("movies", { enabled: false }),
    ];

    for (const server of [true, false, true]) {
      expect(enabledOf(edits.apply([movies(server)]))).toBe(false);
    }

    // Answers arriving out of order.
    expect(edits.settle("movies", seqs[1])).toBe(false);
    expect(edits.settle("movies", seqs[0])).toBe(false);
    expect(edits.isLatest("movies", seqs[2])).toBe(true);
    expect(edits.settle("movies", seqs[2])).toBe(true);
  });

  test("once the newest edit is answered, the node's list is shown as it is", () => {
    const edits = new PendingLibraryEdits();
    const seq = edits.begin("movies", { enabled: false });
    edits.settle("movies", seq);

    const rows = [movies(true)];
    expect(edits.apply(rows)).toBe(rows);
  });

  test("a refused save closes the entry, so the next fetch shows what the node holds", () => {
    const edits = new PendingLibraryEdits();
    const seq = edits.begin("movies", { enabled: false });

    // onError settles the newest edit and then refetches.
    expect(edits.settle("movies", seq)).toBe(true);
    expect(enabledOf(edits.apply([movies(true)]))).toBe(true);
  });

  test("a switch pressed while a folder change is in flight keeps both", () => {
    const edits = new PendingLibraryEdits();
    edits.begin("movies", { paths: ["D:\\Movies", "E:\\More"] });
    edits.begin("movies", { enabled: false });

    const [row] = edits.apply([movies(true)]);
    expect(row.enabled).toBe(false);
    expect(row.paths).toEqual(["D:\\Movies", "E:\\More"]);
  });

  test("edits to two libraries are independent", () => {
    const edits = new PendingLibraryEdits();
    const m = edits.begin("movies", { enabled: false });
    const t = edits.begin("tv", { enabled: false });

    expect(edits.settle("movies", m)).toBe(true);
    const rows = edits.apply([movies(true), tv]);
    expect(enabledOf(rows)).toBe(true);
    expect(enabledOf(rows, "tv")).toBe(false);
    expect(edits.settle("tv", t)).toBe(true);
  });
});

describe("applyLibraryUpdate", () => {
  test("changes only what the update names", () => {
    const row = movies(true);
    expect(applyLibraryUpdate(row, { hidden: true })).toEqual({
      ...row,
      hidden: true,
    });
    expect(applyLibraryUpdate(row, {})).toEqual(row);
  });
});
