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
