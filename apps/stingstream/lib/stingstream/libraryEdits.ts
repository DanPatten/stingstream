/**
 * The library edits this screen has sent and the node has not answered yet.
 *
 * Dan, 2026-09-22: toggling Movies or TV shows "flips randomly. It should literally just toggle a
 * boolean". The switch was drawn from the React Query cache, and three things wrote to that cache
 * behind the reader's back while a save was in flight: the 30 second poll, every
 * `invalidateQueries(["stingstream"])` anywhere in the app (the settings page does one on focus),
 * and the answer to an *earlier* press, which landed on top of a later one. Each of them carried the
 * value from before the latest press, so the switch jumped back and then forward again.
 *
 * So an edit is remembered here from the moment it is made until the node answers **that** edit,
 * and every list the node sends in the meantime has it laid over the top. An answer to an older
 * edit is an echo and changes nothing.
 *
 * No React, no providers: `bun:test` drives it directly (`libraryEdits.test.ts`).
 */

import type { Library, LibraryUpdate } from "./librariesApi";

/** One library row with an update applied. An omitted property is left alone. */
export const applyLibraryUpdate = (
  row: Library,
  update: LibraryUpdate,
): Library => ({
  ...row,
  enabled: update.enabled ?? row.enabled,
  hidden: update.hidden ?? row.hidden,
  paths: update.paths ?? row.paths,
});

interface Pending {
  /** The newest edit's number. Only its answer settles the entry. */
  seq: number;
  /** Every field sent while the entry was open, the newest value of each. */
  update: LibraryUpdate;
}

export class PendingLibraryEdits {
  private next = 0;
  private readonly edits = new Map<string, Pending>();

  /** Record an edit as it is sent. Returns its number, to hand back when it is answered. */
  begin(id: string, update: LibraryUpdate): number {
    const seq = ++this.next;
    const open = this.edits.get(id);
    this.edits.set(id, { seq, update: { ...open?.update, ...update } });
    return seq;
  }

  /** Whether this is the newest edit to its library still waiting for an answer. */
  isLatest(id: string, seq: number): boolean {
    return this.edits.get(id)?.seq === seq;
  }

  /**
   * The node answered an edit. Returns `true` when it was the newest one, which closes the entry;
   * an older edit's answer is an echo and leaves the newer edit in place.
   */
  settle(id: string, seq: number): boolean {
    if (!this.isLatest(id, seq)) return false;
    this.edits.delete(id);
    return true;
  }

  /** Whether any edit to this library is still waiting. */
  has(id: string): boolean {
    return this.edits.has(id);
  }

  /** A list as the node sent it, with every edit still waiting laid over it. */
  apply(rows: Library[]): Library[] {
    if (this.edits.size === 0) return rows;
    return rows.map((row) => {
      const open = this.edits.get(row.id);
      return open ? applyLibraryUpdate(row, open.update) : row;
    });
  }
}
