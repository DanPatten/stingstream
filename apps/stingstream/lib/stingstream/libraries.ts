import { getStingStreamApiBaseUrl } from "@stingstream/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { apiAtom } from "@/providers/JellyfinProvider";
import {
  createLibrary,
  deleteLibrary,
  fetchLibraries,
  fetchMediaFolder,
  type Library,
  type LibraryCreate,
  type LibraryUpdate,
  saveLibrary,
} from "./librariesApi";
import { useHealthz } from "./status";

/**
 * React Query over the libraries this server holds.
 *
 * The types and the plain-fetch half live in `./librariesApi` and are re-exported below, so a
 * non-React caller — and `bun:test` — never has to come through here. Same split as
 * `downloading.ts` / `downloadingApi.ts`.
 */

export * from "./librariesApi";

function useConnection() {
  const api = useAtomValue(apiAtom);
  const base = api?.basePath ? getStingStreamApiBaseUrl(api.basePath) : null;
  return { base, token: api?.accessToken ?? null };
}

const KEY = ["stingstream", "libraries"] as const;

/** Which manager answers for a library type, when one does. */
const CHILD_FOR: Record<string, string> = {
  movies: "radarr",
  tvshows: "sonarr",
};

/**
 * Every library on this server, in the order it lists them.
 *
 * `enabled` is for a screen a member can also see: the endpoint is administrator-only.
 */
export function useLibraries(enabled = true) {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: KEY,
    queryFn: () => fetchLibraries(base!, token),
    enabled: !!base && enabled,
    // The settings can also be edited on the server itself, and reconciliation rewrites parts of
    // each row on every start. Polling slowly means a screen left open does not quietly disagree.
    refetchInterval: 30000,
    retry: 1,
  });
}

/**
 * What is actually running behind a library, per `/healthz`.
 *
 * The switch is the **intent** and this is the **fact**, and they are genuinely different for
 * minutes at a time: the supervisor notices `config.toml` within five seconds, and a manager
 * starting for the first time then migrates its database before it answers anything. A screen
 * showing only the switch would claim a library was working the instant it was pressed; one
 * showing only this would snap the switch back under the reader's finger.
 *
 * `undefined` means there is nothing to say — healthz still loading, a node answering from off its
 * own machine (which does not list its children), or a library with no manager behind it at all,
 * which is Recordings.
 */
export function useLibraryHealth(library: Library | undefined): {
  state: string | undefined;
  error: string | undefined;
} {
  const healthz = useHealthz();
  // `managed` rather than the type: Recordings is a *movies* library holding peers' pointers, so
  // keying on the type alone put a Running pill on the one library with no process behind it.
  const name = library?.managed ? CHILD_FOR[library.type] : undefined;
  const child = healthz.data?.children.find((c) => c.name === name);
  if (!name || !healthz.data || healthz.data.redacted) {
    return { state: undefined, error: undefined };
  }
  return {
    // A child switched off in `config.toml` while its library is on is a real state, and the
    // honest thing to report is that nothing is running: the two can disagree when the file was
    // edited on the server rather than through here. Pressing the switch off and on again writes
    // the file, which is the way out and the reason the row must not hide this.
    state: child && !child.enabled ? "stopped" : child?.state,
    // The supervisor's own refusal — a manager whose binary is missing, most often — and the only
    // place that says why a switch that is on has nothing behind it. It survives until the next
    // successful probe, so a caller must check `state` before showing it.
    error: child?.last_error ?? undefined,
  };
}

/** Change one library: its folder, or whether this server runs it. */
export function useSaveLibrary() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, update }: { id: string; update: LibraryUpdate }) =>
      saveLibrary(base!, id, update, token),
    // A switch answers the moment it is pressed. The PUT only returns once the node has reconciled
    // its libraries and managers, which is seconds, and a switch that waited for that sat faded in
    // its old position and then jumped. Dan: *"just flip it ... do all work quietly in the
    // background"*. A refusal puts it back, and the caller toasts why.
    onMutate: async ({ id, update }) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const previous = queryClient.getQueryData<Library[]>(KEY);
      queryClient.setQueryData(KEY, (rows: Library[] | undefined) =>
        (rows ?? []).map((row) =>
          row.id === id
            ? {
                ...row,
                enabled: update.enabled ?? row.enabled,
                hidden: update.hidden ?? row.hidden,
                paths: update.paths ?? row.paths,
              }
            : row,
        ),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(KEY, context.previous);
    },
    onSuccess: (saved) => {
      // The row answers immediately from what the node confirmed it wrote, including the parts
      // reconciliation filled in. Everything downstream of a library — what the managers are
      // tracking, what the rail shows — catches up on its own next fetch.
      queryClient.setQueryData(KEY, (rows: Library[] | undefined) =>
        (rows ?? []).map((row) => (row.id === saved.id ? saved : row)),
      );
      queryClient.invalidateQueries({ queryKey: ["stingstream"] });
      queryClient.invalidateQueries({ queryKey: ["user-views"] });
    },
  });
}

/**
 * Everything that lists libraries, not only this screen: the sidebar reads the media server's views
 * (`useShellNavigation`), and invites and Grant access read `/invites/libraries`.
 */
function useInvalidateLibraries() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["stingstream"] });
    queryClient.invalidateQueries({ queryKey: ["user-views"] });
  };
}

/** Add a library. */
export function useCreateLibrary() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateLibraries();
  return useMutation({
    mutationFn: (create: LibraryCreate) => createLibrary(base!, create, token),
    onSuccess: (saved) => {
      queryClient.setQueryData(KEY, (rows: Library[] | undefined) => {
        const list = rows ?? [];
        return list.some((row) => row.id === saved.id)
          ? list.map((row) => (row.id === saved.id ? saved : row))
          : [...list, saved];
      });
      invalidate();
    },
  });
}

/** Remove a library. Its files stay where they are. */
export function useDeleteLibrary() {
  const { base, token } = useConnection();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateLibraries();
  return useMutation({
    mutationFn: (id: string) => deleteLibrary(base!, id, token),
    onSuccess: (_void, id) => {
      queryClient.setQueryData(KEY, (rows: Library[] | undefined) =>
        (rows ?? []).filter((row) => row.id !== id),
      );
      invalidate();
    },
  });
}

/** The node's media folder, the folder browser's home. */
export function useMediaFolder() {
  const { base, token } = useConnection();
  return useQuery({
    queryKey: [...KEY, "media-folder"],
    queryFn: () => fetchMediaFolder(base!, token),
    enabled: !!base,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}
