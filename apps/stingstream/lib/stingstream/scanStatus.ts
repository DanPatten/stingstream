/**
 * What the media server says about a library scan, reduced to what a screen shows.
 *
 * Two sources, because there are two kinds of scan. "Scan now" on the Libraries page runs the
 * server-wide "Scan Media Library" task, which reports its progress on `/ScheduledTasks`. A single
 * library's "Scan library files", or the scan that follows adding a folder, is a refresh of that one
 * library and never touches the task: it shows only on `/Library/VirtualFolders`, as that library's
 * `RefreshStatus` and `RefreshProgress`. The task also drives each library's own progress as it
 * reaches it, so reading both covers every case.
 *
 * Plain functions, no React, so `bun:test` can pin them. The hook is `hooks/useScanStatus.ts`.
 */

/** The scheduled task's key. Stable across versions and languages, unlike its name. */
export const SCAN_TASK_KEY = "RefreshLibrary";

/** The part of a `VirtualFolderInfo` this reads. */
export interface ScanFolder {
  ItemId?: string | null;
  Name?: string | null;
  RefreshStatus?: string | null;
  RefreshProgress?: number | null;
}

/** The part of a `TaskInfo` this reads. */
export interface ScanTask {
  Key?: string | null;
  State?: string | null;
  CurrentProgressPercentage?: number | null;
}

export interface LibraryScan {
  /** The media server's id for the library, `Library.jellyfinItemId` on our side. */
  id: string;
  name: string;
  state: "scanning" | "queued";
  /** Whole percent, or null when the server has not said yet. */
  percent: number | null;
}

export interface ScanSummary {
  active: boolean;
  /** Whole percent across everything scanning, or null when unknown. */
  percent: number | null;
  /** Libraries scanning or waiting to, in the server's order. */
  libraries: LibraryScan[];
  /** Whether the server-wide task is the one running. */
  wholeServer: boolean;
}

export const IDLE_SCAN: ScanSummary = {
  active: false,
  percent: null,
  libraries: [],
  wholeServer: false,
};

/**
 * A percentage fit to print while a scan is still going.
 *
 * Capped at 99: the server reports 100 for a moment before it marks the scan finished, and
 * "Scanning, 100%" reads as a scan that is stuck.
 */
export const toPercent = (value: number | null | undefined): number | null => {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(99, Math.max(0, Math.floor(value)));
};

/** Reduce the two answers to one summary. Either may be missing. */
export function summarizeScan(
  folders: readonly ScanFolder[] | null | undefined,
  tasks: readonly ScanTask[] | null | undefined,
): ScanSummary {
  const task = (tasks ?? []).find((t) => t.Key === SCAN_TASK_KEY);
  const wholeServer = task?.State === "Running";

  const libraries: LibraryScan[] = [];
  for (const folder of folders ?? []) {
    if (!folder.ItemId) continue;
    const status = folder.RefreshStatus;
    if (status !== "Active" && status !== "Queued") continue;
    libraries.push({
      id: folder.ItemId,
      name: folder.Name ?? "",
      state: status === "Active" ? "scanning" : "queued",
      percent: status === "Active" ? toPercent(folder.RefreshProgress) : null,
    });
  }

  const active = wholeServer || libraries.length > 0;
  if (!active) return IDLE_SCAN;

  let percent: number | null = null;
  if (wholeServer) {
    percent = toPercent(task?.CurrentProgressPercentage);
  } else {
    const known = libraries
      .filter((l) => l.state === "scanning" && l.percent != null)
      .map((l) => l.percent as number);
    // A queued library has not started, so it counts as zero towards the whole.
    const queued = libraries.filter((l) => l.state === "queued").length;
    if (known.length > 0) {
      const total = known.reduce((sum, p) => sum + p, 0);
      percent = toPercent(total / (known.length + queued));
    }
  }

  return { active, percent, libraries, wholeServer };
}

/**
 * Keep every percentage from going backwards within one scan.
 *
 * The server's number for a library is the progress of whichever folder inside it reported last,
 * so it jumps: measured on node 1 it went 50, 97, 97, 50 over four seconds. A bar that shrinks
 * reads as something going wrong. `highest` is carried between polls and cleared when the scan
 * ends; it is mutated and returned.
 */
export function holdHighest(
  summary: ScanSummary,
  highest: Map<string, number>,
): ScanSummary {
  if (!summary.active) {
    highest.clear();
    return summary;
  }

  const hold = (key: string, value: number | null): number | null => {
    if (value == null) return highest.get(key) ?? null;
    const kept = Math.max(value, highest.get(key) ?? 0);
    highest.set(key, kept);
    return kept;
  };

  const libraries = summary.libraries.map((library) =>
    library.state === "scanning"
      ? { ...library, percent: hold(library.id, library.percent) }
      : library,
  );
  // Keyed apart from any library id, and on the kind of scan, so a library scan followed by a
  // whole-server one does not start the second at the first one's number.
  const percent = hold(
    summary.wholeServer ? "\u0000server" : "\u0000libraries",
    summary.percent,
  );

  return { ...summary, libraries, percent };
}

/** What one library's row says, or null when it is not scanning. */
export function libraryScanLabel(
  summary: ScanSummary,
  libraryId: string | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (!libraryId) return null;
  const library = summary.libraries.find((l) => l.id === libraryId);
  if (!library) return null;
  if (library.state === "queued") return t("scan_status.queued");
  return library.percent == null
    ? t("scan_status.scanning")
    : t("scan_status.scanning_percent", { percent: library.percent });
}

/**
 * The sentence for the page-level indicator.
 *
 * Names the library when exactly one is scanning and the page is not already about a different
 * one, and otherwise speaks of libraries in general. `forLibraryId` narrows it to one library's
 * page, where another library's scan is not news.
 */
export function scanPillLabel(
  summary: ScanSummary,
  t: (key: string, options?: Record<string, unknown>) => string,
  forLibraryId?: string | null,
): string | null {
  if (!summary.active) return null;

  if (forLibraryId) {
    const library = summary.libraries.find((l) => l.id === forLibraryId);
    if (!library) {
      // The whole-server task covers this library too, even before it gets there.
      if (!summary.wholeServer) return null;
      return summary.percent == null
        ? t("scan_status.pill_all")
        : t("scan_status.pill_all_percent", { percent: summary.percent });
    }
    if (library.state === "queued") return t("scan_status.queued");
    return library.percent == null
      ? t("scan_status.pill_one", { name: library.name })
      : t("scan_status.pill_one_percent", {
          name: library.name,
          percent: library.percent,
        });
  }

  const scanning = summary.libraries.filter((l) => l.state === "scanning");
  if (!summary.wholeServer && scanning.length === 1 && scanning[0].name) {
    const [only] = scanning;
    const percent = summary.percent ?? only.percent;
    return percent == null
      ? t("scan_status.pill_one", { name: only.name })
      : t("scan_status.pill_one_percent", { name: only.name, percent });
  }
  return summary.percent == null
    ? t("scan_status.pill_all")
    : t("scan_status.pill_all_percent", { percent: summary.percent });
}
