/**
 * Walking a server's folders, as the Browse dialog does.
 *
 * The listing itself is the media server's own `/Environment/Drives` and
 * `/Environment/DirectoryContents`, which answer with full paths, so the only
 * arithmetic this side does is "one level up". That is pure and lives here, because
 * the server may be Windows, Linux or a UNC share whatever the browser is running on,
 * and a regex that only knew one of them sent the Up button somewhere nonsensical.
 *
 * No React here, so `bun:test` can load it.
 */

/** The empty path means "above every drive": the dialog lists drives there. */
export const DRIVES = "";

const DRIVE_ROOT = /^[a-zA-Z]:[\\/]?$/;
const DRIVE = /^[a-zA-Z]:$/;
const UNC_SHARE = /^\\\\[^\\/]+[\\/][^\\/]+[\\/]?$/;

/** The folder one level above `input`, or {@link DRIVES} when it is already a root. */
export function parentPath(input: string): string {
  const path = input.trim();
  if (!path || path === "/" || DRIVE_ROOT.test(path) || UNC_SHARE.test(path)) {
    return DRIVES;
  }

  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (cut < 0) return DRIVES;

  const head = trimmed.slice(0, cut);
  if (DRIVE.test(head)) return `${head}\\`;
  if (head === "") return "/";
  return head;
}

/** The last segment of a path, for a row label. A root is its own name. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  const leaf = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  return leaf || path;
}

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/;
const UNC_ABSOLUTE = /^\\\\[^\\/]+[\\/][^\\/]+/;

/**
 * Whether the server could take this as a folder without guessing a working directory.
 *
 * Mirrors the node's `Path.IsPathFullyQualified` closely enough to decide what to say under the
 * field: `D:\x`, `\\nas\share` and `/srv` are, `media\Movies` and the drive-relative `D:x` are not.
 * The node has the last word either way.
 */
export function isAbsoluteFolder(input: string): boolean {
  const path = input.trim();
  if (DRIVE.test(path)) return true;
  return (
    WINDOWS_ABSOLUTE.test(path) ||
    UNC_ABSOLUTE.test(path) ||
    (path.startsWith("/") && !path.startsWith("//"))
  );
}

/**
 * A typed path tidied into the one spelling the dialog navigates by and adds.
 *
 * A trailing separator is dropped (`D:\Media\` is `D:\Media`), except where it is the whole
 * root: `D:` becomes `D:\` rather than the drive-relative `D:`, and `/` stays `/`.
 */
export function normalizeFolder(input: string): string {
  const path = input.trim();
  if (!path) return DRIVES;
  if (DRIVE.test(path)) return `${path}\\`;
  if (DRIVE_ROOT.test(path)) return `${path.slice(0, 2)}\\`;
  if (/^[\\/]+$/.test(path)) return path.startsWith("\\") ? path : "/";
  return path.replace(/[\\/]+$/, "");
}

/**
 * Where to look for type-ahead suggestions while a path is being typed.
 *
 * `D:\Media\Mo` looks in `D:\Media` for names starting `Mo`; `D:\Media\` looks in `D:\Media` for
 * everything; a bare `D` looks at the drive list.
 */
export function suggestionSource(input: string): {
  parent: string;
  prefix: string;
} {
  const path = input.trim();
  if (!path) return { parent: DRIVES, prefix: "" };
  if (/[\\/]$/.test(path) && !/^[\\/]+$/.test(path)) {
    return { parent: normalizeFolder(path), prefix: "" };
  }
  if (!/[\\/]/.test(path)) return { parent: DRIVES, prefix: path };
  return { parent: parentPath(path), prefix: folderName(path) };
}

/** The entries whose name starts with what has been typed of the last segment. */
export function matchSuggestions<
  T extends { Name?: string | null; Path?: string | null },
>(entries: readonly T[], prefix: string): T[] {
  const wanted = prefix.trim().toLowerCase();
  if (!wanted) return [...entries];
  return entries.filter((entry) => {
    const name = (entry.Name || folderName(entry.Path ?? "")).toLowerCase();
    return name.startsWith(wanted);
  });
}

/** How folder `a` stands to folder `b`. */
export type FolderRelation = "none" | "same" | "inside" | "contains";

const segments = (path: string): string[] => {
  const out: string[] = [];
  for (const part of path.trim().replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part.toLowerCase());
  }
  return out;
};

/**
 * The same rule the node applies (`LibraryPathValidator.Relate`): segment by segment and without
 * regard to case or separator, so `D:\Movies2` is not inside `D:\Movies` and `d:/movies/` is the
 * same folder as `D:\Movies`.
 */
export function relateFolders(a: string, b: string): FolderRelation {
  const left = segments(a);
  const right = segments(b);
  if (left.length === 0 || right.length === 0) return "none";
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    if (left[i] !== right[i]) return "none";
  }
  if (left.length === right.length) return "same";
  return left.length > right.length ? "inside" : "contains";
}

/**
 * Whether a folder about to be added collides with one the library already has, and with which.
 *
 * Checked on this side as well as the node's because the node quietly drops a folder the list
 * already holds, which answered "added" to an add that changed nothing.
 */
export function folderConflict(
  existing: readonly string[],
  candidate: string,
): { relation: Exclude<FolderRelation, "none">; path: string } | null {
  for (const path of existing) {
    const relation = relateFolders(candidate, path);
    if (relation !== "none") return { relation, path };
  }
  return null;
}

/** What the dialog found at the typed path, once the listing has answered. */
export type FolderLookup =
  /** Still asking. */
  | "loading"
  /** Listed: the folder is there. */
  | "listed"
  /** Not there, but its parent is, so adding it creates it. */
  | "missing"
  /** Neither it nor its parent is there. */
  | "missing_parent";

/**
 * What the Add button adds, or why it cannot.
 *
 * **The folder in the path field**, not the last folder the list was showing. The old dialog
 * added `path`, the last folder navigated to, and ignored what had been typed since, so typing
 * `D:\Media\TV` into a dialog that had opened on `D:\Media\Movies` added Movies a second time
 * (a silent no-op), and going Up first added `D:\Media`, which the node rightly called an overlap.
 * That was the v0.2.0 report "couldn't add it ... said it overlapped when it 100% did not".
 */
export function addableFolder(
  draft: string,
  lookup: FolderLookup,
): {
  path: string | null;
  reason: "choose" | "not_absolute" | "not_found" | null;
} {
  const path = normalizeFolder(draft);
  if (path === DRIVES) return { path: null, reason: "choose" };
  if (!isAbsoluteFolder(path)) return { path: null, reason: "not_absolute" };
  if (lookup === "missing_parent") return { path: null, reason: "not_found" };
  return { path, reason: null };
}
