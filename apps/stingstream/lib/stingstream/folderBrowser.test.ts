import { describe, expect, test } from "bun:test";
import { DRIVES, folderName, parentPath } from "./folderBrowser";

describe("parentPath", () => {
  test("a Windows folder goes up one level, and a drive goes up to the drive list", () => {
    expect(parentPath("D:\\media\\Movies")).toBe("D:\\media");
    expect(parentPath("D:\\media")).toBe("D:\\");
    expect(parentPath("D:\\")).toBe(DRIVES);
    expect(parentPath("D:")).toBe(DRIVES);
  });

  test("a POSIX folder goes up to / and then to the drive list", () => {
    expect(parentPath("/srv/media/tv")).toBe("/srv/media");
    expect(parentPath("/srv")).toBe("/");
    expect(parentPath("/")).toBe(DRIVES);
  });

  test("a trailing separator does not count as a level", () => {
    expect(parentPath("/srv/media/")).toBe("/srv");
    expect(parentPath("D:\\media\\")).toBe("D:\\");
  });

  test("a UNC share is a root of its own", () => {
    expect(parentPath("\\\\nas\\media\\Movies")).toBe("\\\\nas\\media");
    expect(parentPath("\\\\nas\\media")).toBe(DRIVES);
  });

  test("nothing is already the top", () => {
    expect(parentPath("")).toBe(DRIVES);
    expect(parentPath("   ")).toBe(DRIVES);
  });
});

describe("folderName", () => {
  test("names the last segment, and a root by itself", () => {
    expect(folderName("D:\\media\\Movies")).toBe("Movies");
    expect(folderName("/srv/media/")).toBe("media");
    expect(folderName("D:\\")).toBe("D:");
    expect(folderName("/")).toBe("/");
  });
});
