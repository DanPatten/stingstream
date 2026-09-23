import { describe, expect, test } from "bun:test";
import {
  activeRoot,
  addableFolder,
  backTarget,
  DRIVES,
  folderConflict,
  folderName,
  isAbsoluteFolder,
  matchSuggestions,
  normalizeFolder,
  parentPath,
  relateFolders,
  rootLabel,
  sidebarRoots,
  suggestionSource,
} from "./folderBrowser";

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

describe("isAbsoluteFolder", () => {
  test("drive, UNC and POSIX paths are full paths", () => {
    expect(isAbsoluteFolder("D:\\Media")).toBe(true);
    expect(isAbsoluteFolder("d:/media")).toBe(true);
    expect(isAbsoluteFolder("D:")).toBe(true);
    expect(isAbsoluteFolder("\\\\nas\\media")).toBe(true);
    expect(isAbsoluteFolder("/srv/media")).toBe(true);
  });

  test("relative and drive-relative paths are not", () => {
    expect(isAbsoluteFolder("media\\Movies")).toBe(false);
    expect(isAbsoluteFolder("D:media")).toBe(false);
    expect(isAbsoluteFolder("")).toBe(false);
  });
});

describe("normalizeFolder", () => {
  test("drops a trailing separator but keeps a root whole", () => {
    expect(normalizeFolder(" D:\\Media\\ ")).toBe("D:\\Media");
    expect(normalizeFolder("D:")).toBe("D:\\");
    expect(normalizeFolder("d:/")).toBe("d:\\");
    expect(normalizeFolder("/srv/media/")).toBe("/srv/media");
    expect(normalizeFolder("/")).toBe("/");
    expect(normalizeFolder("  ")).toBe(DRIVES);
  });
});

describe("suggestionSource", () => {
  test("a half-typed name looks in its parent", () => {
    expect(suggestionSource("D:\\Media\\Mo")).toEqual({
      parent: "D:\\Media",
      prefix: "Mo",
    });
    expect(suggestionSource("/srv/me")).toEqual({
      parent: "/srv",
      prefix: "me",
    });
    expect(suggestionSource("/sr")).toEqual({ parent: "/", prefix: "sr" });
  });

  test("a trailing separator lists everything in that folder", () => {
    expect(suggestionSource("D:\\Media\\")).toEqual({
      parent: "D:\\Media",
      prefix: "",
    });
  });

  test("a bare drive letter looks at the drive list", () => {
    expect(suggestionSource("D")).toEqual({ parent: DRIVES, prefix: "D" });
  });
});

describe("matchSuggestions", () => {
  const entries = [
    { Name: "Movies", Path: "D:\\Media\\Movies" },
    { Name: "Movies 4K", Path: "D:\\Media\\Movies 4K" },
    { Name: "TV", Path: "D:\\Media\\TV" },
  ];

  test("matches the start of the name, whatever the case", () => {
    expect(matchSuggestions(entries, "mov").map((e) => e.Name)).toEqual([
      "Movies",
      "Movies 4K",
    ]);
    expect(matchSuggestions(entries, "").length).toBe(3);
    expect(matchSuggestions(entries, "x")).toEqual([]);
  });
});

describe("relateFolders", () => {
  test("a sibling that shares a prefix is not an overlap", () => {
    expect(relateFolders("D:\\Movies2", "D:\\Movies")).toBe("none");
    expect(relateFolders("D:\\Media\\Movies 4K", "D:\\Media\\Movies")).toBe(
      "none",
    );
  });

  test("case, separators and a trailing separator do not matter", () => {
    expect(relateFolders("d:/media/movies/", "D:\\Media\\Movies")).toBe("same");
  });

  test("inside and containing are told apart", () => {
    expect(relateFolders("D:\\Media\\Movies\\4K", "D:\\Media\\Movies")).toBe(
      "inside",
    );
    expect(relateFolders("D:\\Media", "D:\\Media\\Movies")).toBe("contains");
    expect(relateFolders("D:\\", "D:\\Media")).toBe("contains");
  });

  test("different drives never overlap", () => {
    expect(relateFolders("E:\\Media\\Movies", "D:\\Media\\Movies")).toBe(
      "none",
    );
  });
});

describe("folderConflict", () => {
  test("names the folder it collides with", () => {
    expect(
      folderConflict(["C:\\Data\\Movies", "D:\\Media"], "d:\\media\\TV"),
    ).toEqual({ relation: "inside", path: "D:\\Media" });
  });

  test("a second folder elsewhere is fine", () => {
    expect(folderConflict(["C:\\Data\\Movies"], "D:\\Media\\TV")).toBeNull();
  });
});

describe("addableFolder", () => {
  test("adds the folder in the field, tidied", () => {
    expect(addableFolder("D:\\Media\\TV\\", "listed")).toEqual({
      path: "D:\\Media\\TV",
      reason: null,
    });
  });

  test("a folder that is not there yet can still be added", () => {
    expect(addableFolder("D:\\Media\\New", "missing").path).toBe(
      "D:\\Media\\New",
    );
    expect(addableFolder("D:\\Media\\New", "loading").path).toBe(
      "D:\\Media\\New",
    );
  });

  test("says why when there is nothing to add", () => {
    expect(addableFolder("", "listed").reason).toBe("choose");
    expect(addableFolder("media\\TV", "missing").reason).toBe("not_absolute");
    expect(addableFolder("Q:\\nope\\deeper", "missing_parent").reason).toBe(
      "not_found",
    );
  });
});

describe("activeRoot", () => {
  const home = "C:\\ProgramData\\StingStream\\media";
  const roots = [home, "C:\\", "D:\\"];

  test("a path inside home lights home, not its drive", () => {
    expect(activeRoot(`${home}\\Movies`, roots)).toBe(home);
    expect(activeRoot(home, roots)).toBe(home);
  });

  test("anything else lights its drive", () => {
    expect(activeRoot("C:\\Users\\dan", roots)).toBe("C:\\");
    expect(activeRoot("d:/media/tv", roots)).toBe("D:\\");
  });

  test("nothing matches a drive that is not listed", () => {
    expect(activeRoot("Q:\\x", roots)).toBeNull();
  });
});

describe("backTarget", () => {
  const home = "C:\\ProgramData\\StingStream\\media";
  const roots = [home, "C:\\", "D:\\"];

  test("steps up one level inside a root", () => {
    expect(backTarget(`${home}\\Movies\\Old`, roots)).toBe(`${home}\\Movies`);
    expect(backTarget(`${home}\\Movies`, roots)).toBe(home);
    expect(backTarget("D:\\TV\\Shows", roots)).toBe("D:\\TV");
    expect(backTarget("D:\\TV", roots)).toBe("D:\\");
  });

  test("stops at the root the path is under", () => {
    expect(backTarget(home, roots)).toBeNull();
    expect(backTarget("C:\\", roots)).toBeNull();
    expect(backTarget("d:/", roots)).toBeNull();
  });

  test("a path under no root still steps up, as far as its own root", () => {
    expect(backTarget("\\\\nas\\share\\films", roots)).toBe("\\\\nas\\share");
    expect(backTarget("\\\\nas\\share", roots)).toBeNull();
    expect(backTarget("/srv/media", ["/"])).toBe("/srv");
    expect(backTarget("/", ["/"])).toBeNull();
  });
});

describe("sidebarRoots", () => {
  test("drives on Windows", () => {
    expect(sidebarRoots(["C:\\", "D:\\"], "C:\\data\\media")).toEqual([
      "C:\\",
      "D:\\",
    ]);
  });

  test("only / on a POSIX server, whatever it mounts", () => {
    expect(sidebarRoots(["/", "/boot", "/mnt/nas"], "/srv/media")).toEqual([
      "/",
    ]);
  });

  test("labels a drive by its letter", () => {
    expect(rootLabel("c:\\")).toBe("C:");
    expect(rootLabel("/")).toBe("/");
  });
});
