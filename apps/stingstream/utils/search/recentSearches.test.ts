import { beforeEach, describe, expect, test } from "bun:test";
import { clearMmkv, stubMmkv } from "@/test-utils/mmkv";

stubMmkv();

const { addRecentSearch, clearRecentSearches, getRecentSearches } =
  await import("./recentSearches");

beforeEach(() => {
  clearMmkv();
});

describe("recentSearches", () => {
  test("starts empty", () => {
    expect(getRecentSearches()).toEqual([]);
  });

  test("records a search, newest first", () => {
    addRecentSearch("Nosferatu");
    const next = addRecentSearch("Sintel");
    expect(next).toEqual(["Sintel", "Nosferatu"]);
  });

  test("re-searching an existing query moves it to the front instead of duplicating it", () => {
    addRecentSearch("Nosferatu");
    addRecentSearch("Sintel");
    const next = addRecentSearch("nosferatu");
    expect(next).toEqual(["nosferatu", "Sintel"]);
  });

  test("blank input changes nothing", () => {
    addRecentSearch("Nosferatu");
    const next = addRecentSearch("   ");
    expect(next).toEqual(["Nosferatu"]);
  });

  test("caps at the configured maximum, dropping the oldest", () => {
    for (let i = 0; i < 10; i++) addRecentSearch(`query-${i}`);
    const list = getRecentSearches();
    expect(list.length).toBe(8);
    expect(list[0]).toBe("query-9");
    expect(list).not.toContain("query-0");
    expect(list).not.toContain("query-1");
  });

  test("clear empties the list", () => {
    addRecentSearch("Nosferatu");
    expect(clearRecentSearches()).toEqual([]);
    expect(getRecentSearches()).toEqual([]);
  });
});
