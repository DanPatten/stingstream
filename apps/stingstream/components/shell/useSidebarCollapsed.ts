import { useCallback, useSyncExternalStore } from "react";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { storage } from "@/utils/mmkv";

/**
 * Whether the desktop sidebar is the 72 px rail or the 240 px column.
 *
 * Until somebody touches the toggle this follows the window, exactly as it
 * always has: the rail between 768 and 1279 px, the labelled column at 1280 and
 * up. The first press of the toggle is a decision, and from then on it is
 * theirs at every width — a person who wants their posters wider on a 1440 px
 * screen, or the labels back on a 1024 px one, should not have to say so again
 * on the next page (pass-03 F-70).
 *
 * MMKV rather than a settings atom: this is a per-browser layout preference,
 * not an account setting to sync, and `utils/atoms/settings.ts` is shared by
 * every package under an append-only rule. On web MMKV is backed by
 * `localStorage`, so the choice survives a reload and never leaves the machine.
 */
const KEY = "shell.sidebarCollapsed";

const listeners = new Set<() => void>();

/**
 * `undefined` means "nobody has chosen; follow the window".
 *
 * Read once at module load — the value cannot change from outside this module,
 * and reading storage on every render of a chrome that renders constantly is
 * not free.
 */
let choice: boolean | undefined = readStored();

function readStored(): boolean | undefined {
  try {
    return storage.getBoolean(KEY);
  } catch {
    // A browser with site data blocked, or a platform where MMKV is not ready
    // at import time. A layout preference is not worth an exception.
    return undefined;
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => choice;

/** Remember a choice and tell every sidebar on screen about it. */
export function setSidebarCollapsed(next: boolean): void {
  if (next === choice) return;
  choice = next;
  try {
    storage.set(KEY, next);
  } catch {
    // Remembering is a nicety; collapsing has to work either way.
  }
  for (const listener of listeners) listener();
}

export interface SidebarCollapse {
  /** What the sidebar should render right now. */
  collapsed: boolean;
  toggle: () => void;
}

export const useSidebarCollapsed = (): SidebarCollapse => {
  const { isExpanded } = useBreakpoint();
  const stored = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const collapsed = stored ?? !isExpanded;
  const toggle = useCallback(
    () => setSidebarCollapsed(!collapsed),
    [collapsed],
  );

  return { collapsed, toggle };
};
