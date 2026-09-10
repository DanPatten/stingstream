import {
  type SharedSettings,
  useSharedSettings,
  useUpdateSharedSettings,
} from "@/lib/stingstream/hooks";

/**
 * One field of the server's shared settings document, for a pane that owns it.
 *
 * `PUT /Settings` replaces the whole document — there is no patch — so every
 * section that saves has to spread the settings it read and change one key.
 * Five panes doing that by hand is five chances to spread a stale copy and
 * silently reset a neighbouring section, which is exactly the failure
 * `ui-startup.ps1` hit against Jellyfin's `LibraryOptions` and had to be caught
 * before it shipped (see `docs/UI-LOOP.md`).
 *
 * The panes that read this used to be six tabs of one Server settings screen,
 * which held the wiring once for all of them. Splitting them into pages meant
 * either repeating it or naming it; this is the name.
 */
export function useSharedSettingsField<K extends keyof SharedSettings>(key: K) {
  const query = useSharedSettings();
  const update = useUpdateSharedSettings();

  return {
    /** Pass straight to `QueryState`. */
    query,
    /** The current value, or `undefined` while the document is in flight. */
    value: query.data?.[key],
    saving: update.isPending,
    /**
     * Save this one field. Refuses rather than guessing if the document has not
     * arrived: writing `{ [key]: next }` alone would blank every other section.
     */
    save: async (next: SharedSettings[K]): Promise<void> => {
      const settings = query.data;
      if (!settings) return;
      await update.mutateAsync({ ...settings, [key]: next });
    },
  };
}
