import type { components } from "@stingstream/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArrMovie, ArrQueueItem, ArrSeries } from "./arr-types";
import { useStingStreamClient } from "./client";
import { unwrap } from "./unwrap";

export type SharedSettings = components["schemas"]["SharedSettings"];
export type IndexerSettings = components["schemas"]["IndexerSettings"];
export type DownloadClientSettings =
  components["schemas"]["DownloadClientSettings"];
export type RootFolderSettings = components["schemas"]["RootFolderSettings"];
export type NamingSettings = components["schemas"]["NamingSettings"];
export type NotificationSettings =
  components["schemas"]["NotificationSettings"];
export type ExtraWebhook = components["schemas"]["ExtraWebhook"];
export type SyncStatus = components["schemas"]["SyncStatus"];
export type NodeStatus = components["schemas"]["NodeStatus"];
export type MeshStatus = components["schemas"]["MeshStatus"];
export type LookupResult = components["schemas"]["LookupResult"];
export type CalendarEntry = components["schemas"]["CalendarEntry"];
export type HistoryPage = components["schemas"]["HistoryPage"];
export type HistoryRecord = components["schemas"]["HistoryRecord"];
export type DownloadsView = components["schemas"]["DownloadsView"];
export type DownloadItem = components["schemas"]["DownloadItem"];
export type QualityProfileView = components["schemas"]["QualityProfileView"];
export type QualityProfileItemView =
  components["schemas"]["QualityProfileItemView"];
export type QualityVocabulary = components["schemas"]["QualityVocabulary"];
export type QualityProfileWriteResult =
  components["schemas"]["QualityProfileWriteResult"];
export type ConnectivityTestResult =
  components["schemas"]["ConnectivityTestResult"];
export type ExternalDownloadClientSettings =
  components["schemas"]["ExternalDownloadClientSettings"];

const keys = {
  status: ["stingstream", "status"] as const,
  settings: ["stingstream", "settings"] as const,
  indexers: ["stingstream", "indexers"] as const,
  externalClients: ["stingstream", "external-download-clients"] as const,
  movies: ["stingstream", "movies"] as const,
  series: ["stingstream", "series"] as const,
  queue: ["stingstream", "queue"] as const,
  sync: ["stingstream", "sync"] as const,
  meshStatus: ["stingstream", "mesh-status"] as const,
  qualityProfiles: ["stingstream", "quality-profiles"] as const,
  qualityVocabulary: ["stingstream", "quality-vocabulary"] as const,
  calendar: ["stingstream", "calendar"] as const,
  history: ["stingstream", "history"] as const,
  downloads: ["stingstream", "downloads"] as const,
};

/**
 * This node's mesh identity/addresses/group count, through
 * `/stingstream/api/v1/mesh/status` (Jellyfin-authenticated). The raw
 * `/stingstream/mesh/*` the mesh child itself answers on is deliberately
 * localhost-only as of M3b (it can create groups and mint invite codes with
 * no auth of its own) — this is the one the app should call. A 503 means
 * this node has no mesh or it isn't answering, which M3 nodes running ahead
 * of the mesh work may hit; that's not a bug in this screen.
 */
export function useMeshStatus() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.meshStatus,
    queryFn: async () => {
      return unwrap(
        await client!.GET("/stingstream/api/v1/Mesh/status"),
        "GET /mesh/status",
      );
    },
    enabled: !!client,
    refetchInterval: 10000,
    retry: 1,
  });
}

/** Everything about this node's StingStream half — the Node status screen's main source. */
export function useNodeStatus() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.status,
    queryFn: async () => {
      return unwrap(
        await client!.GET("/stingstream/api/v1/Status"),
        "GET /status",
      );
    },
    enabled: !!client,
    refetchInterval: 10000,
  });
}

export function useSharedSettings() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () => {
      return unwrap(
        await client!.GET("/stingstream/api/v1/Settings"),
        "GET /settings",
      );
    },
    enabled: !!client,
  });
}

/** Replaces the whole shared settings document (the Omniarr model). */
export function useUpdateSharedSettings() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: SharedSettings) => {
      const { data, error } = await client!.PUT(
        "/stingstream/api/v1/Settings",
        {
          params: { query: { sync: true } },
          body: settings,
        },
      );
      if (error) throw error;
      return data as SharedSettings;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(keys.settings, data);
      queryClient.invalidateQueries({ queryKey: keys.sync });
    },
  });
}

export function useIndexers() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.indexers,
    queryFn: async () => {
      const { data, error } = await client!.GET(
        "/stingstream/api/v1/Settings/indexers",
      );
      if (error) throw error;
      return data;
    },
    enabled: !!client,
  });
}

export function useAddIndexer() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (indexer: IndexerSettings) => {
      const { data, error } = await client!.POST(
        "/stingstream/api/v1/Settings/indexers",
        { params: { query: { sync: true } }, body: indexer },
      );
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.indexers });
      queryClient.invalidateQueries({ queryKey: keys.sync });
    },
  });
}

export function useDeleteIndexer() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await client!.DELETE(
        "/stingstream/api/v1/Settings/indexers/{id}",
        { params: { path: { id } } },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.indexers });
    },
  });
}

export function useSyncStatus() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.sync,
    queryFn: async () => {
      const { data, error } = await client!.GET("/stingstream/api/v1/sync");
      if (error) throw error;
      return data as SyncStatus[];
    },
    enabled: !!client,
  });
}

export function useRunSync() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error } = await client!.POST("/stingstream/api/v1/sync", {
        params: { query: { waitSeconds: 10 } },
      });
      if (error) throw error;
      return data as SyncStatus[];
    },
    onSuccess: (data) => {
      queryClient.setQueryData(keys.sync, data);
    },
  });
}

export function useMovies() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.movies,
    queryFn: async () => {
      const { data, error, response } = await client!.GET(
        "/stingstream/api/v1/movies",
      );
      if (error) throw error;
      // No response schema is published for this endpoint (Core proxies
      // Radarr's own JSON verbatim) — see lib/stingstream/arr-types.ts.
      return ((data ?? (await response.json())) as ArrMovie[]) ?? [];
    },
    enabled: !!client,
  });
}

export interface AddMovieInput {
  tmdbId: number;
  monitored?: boolean;
  searchOnAdd?: boolean;
  qualityProfileName?: string;
  rootFolderPath?: string;
  minimumAvailability?: string;
}

export function useAddMovie() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddMovieInput) => {
      const { data, error } = await client!.POST("/stingstream/api/v1/movies", {
        body: {
          TmdbId: input.tmdbId,
          Monitored: input.monitored ?? true,
          SearchOnAdd: input.searchOnAdd ?? false,
          QualityProfileName: input.qualityProfileName || undefined,
          RootFolderPath: input.rootFolderPath || undefined,
          MinimumAvailability: input.minimumAvailability || undefined,
        },
      });
      if (error) throw error;
      return data as unknown as ArrMovie;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.movies });
      queryClient.invalidateQueries({ queryKey: keys.queue });
    },
  });
}

export function useSeries() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.series,
    queryFn: async () => {
      const { data, error, response } = await client!.GET(
        "/stingstream/api/v1/series",
      );
      if (error) throw error;
      return ((data ?? (await response.json())) as ArrSeries[]) ?? [];
    },
    enabled: !!client,
  });
}

export interface AddSeriesInput {
  tvdbId: number;
  monitored?: boolean;
  searchOnAdd?: boolean;
  qualityProfileName?: string;
  rootFolderPath?: string;
  seasonFolder?: boolean;
  seriesType?: string;
  monitor?: string;
}

export function useAddSeries() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddSeriesInput) => {
      const { data, error } = await client!.POST("/stingstream/api/v1/series", {
        body: {
          TvdbId: input.tvdbId,
          Monitored: input.monitored ?? true,
          SearchOnAdd: input.searchOnAdd ?? false,
          QualityProfileName: input.qualityProfileName || undefined,
          RootFolderPath: input.rootFolderPath || undefined,
          SeasonFolder: input.seasonFolder ?? true,
          SeriesType: input.seriesType || undefined,
          Monitor: input.monitor || undefined,
        },
      });
      if (error) throw error;
      return data as unknown as ArrSeries;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.series });
      queryClient.invalidateQueries({ queryKey: keys.queue });
    },
  });
}

export interface QueueByApp {
  radarr: ArrQueueItem[];
  sonarr: ArrQueueItem[];
}

export function useQueue() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.queue,
    queryFn: async () => {
      const { data, error } = await client!.GET("/stingstream/api/v1/queue");
      if (error) throw error;
      return (data as unknown as QueueByApp) ?? { radarr: [], sonarr: [] };
    },
    enabled: !!client,
    refetchInterval: 5000,
  });
}

// --- M4.5: the ten gaps -------------------------------------------------
//
// Everything below closes an entry in docs/UI-API-GAPS.md. The pattern is the
// one the rest of this file already uses — react-query, `enabled: !!client`,
// invalidate the right keys on mutation — and the one thing worth saying about
// all of them at once is that Core answers **PascalCase** (Jellyfin's own
// serializer configures the whole process, and StingStream's controllers are
// hosted inside it), which is why every property read below is capitalised.

/**
 * Title search for the add form. Gap 1.
 *
 * `enabled` on a trimmed term of two characters or more, not one: every
 * keystroke is a round trip to a metadata provider through the arr, and a
 * single letter matches everything ever released. `placeholderData` keeps the
 * previous list on screen while the next one loads, so results do not blink out
 * between keystrokes.
 */
export function useTitleLookup(kind: "movie" | "series", term: string) {
  const client = useStingStreamClient();
  const trimmed = term.trim();
  return useQuery({
    queryKey: ["stingstream", "lookup", kind, trimmed],
    queryFn: async () => {
      const { data, error } = await client!.GET(
        kind === "movie"
          ? "/stingstream/api/v1/movies/lookup"
          : "/stingstream/api/v1/series/lookup",
        { params: { query: { term: trimmed } } },
      );
      if (error) throw error;
      return (data ?? []) as LookupResult[];
    },
    enabled: !!client && trimmed.length >= 2,
    placeholderData: (previous: LookupResult[] | undefined) => previous,
    staleTime: 60_000,
  });
}

export interface UpdateLibraryItemInput {
  /** TMDB id for a film, TVDB id for a series. */
  providerId: number;
  monitored?: boolean;
  qualityProfileName?: string;
  searchNow?: boolean;
}

/** Monitor toggle and per-item quality profile. Gaps 2 and 4. */
export function useUpdateLibraryItem(kind: "movie" | "series") {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateLibraryItemInput) => {
      const body = {
        Monitored: input.monitored,
        QualityProfileName: input.qualityProfileName || undefined,
        SearchNow: input.searchNow ?? false,
      };
      if (kind === "movie") {
        const { data, error } = await client!.PATCH(
          "/stingstream/api/v1/movies/{tmdbId}",
          { params: { path: { tmdbId: input.providerId } }, body },
        );
        if (error) throw error;
        return data;
      }
      const { data, error } = await client!.PATCH(
        "/stingstream/api/v1/series/{tvdbId}",
        { params: { path: { tvdbId: input.providerId } }, body },
      );
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: kind === "movie" ? keys.movies : keys.series,
      });
      queryClient.invalidateQueries({ queryKey: keys.queue });
    },
  });
}

/** Delete a title, with or without its files. Gap 3. */
export function useDeleteLibraryItem(kind: "movie" | "series") {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { providerId: number; deleteFiles: boolean }) => {
      if (kind === "movie") {
        const { error } = await client!.DELETE(
          "/stingstream/api/v1/movies/{tmdbId}",
          {
            params: {
              path: { tmdbId: input.providerId },
              query: { deleteFiles: input.deleteFiles },
            },
          },
        );
        if (error) throw error;
        return;
      }
      const { error } = await client!.DELETE(
        "/stingstream/api/v1/series/{tvdbId}",
        {
          params: {
            path: { tvdbId: input.providerId },
            query: { deleteFiles: input.deleteFiles },
          },
        },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: kind === "movie" ? keys.movies : keys.series,
      });
    },
  });
}

/** Every quality profile either app has, merged by name. Gap 4. */
export function useQualityProfiles() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.qualityProfiles,
    queryFn: async () => {
      const { data, error } = await client!.GET(
        "/stingstream/api/v1/qualityprofiles",
      );
      if (error) throw error;
      return (data ?? []) as QualityProfileView[];
    },
    enabled: !!client,
  });
}

/**
 * What qualities each app understands, for the profile editor's checkboxes.
 *
 * Long `staleTime`: an app's quality definition list changes when the app is
 * upgraded, which is not something a settings screen needs to poll for.
 */
export function useQualityVocabulary() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.qualityVocabulary,
    queryFn: async () => {
      return unwrap(
        await client!.GET("/stingstream/api/v1/qualityprofiles/schema"),
        "GET /qualityprofiles/schema",
        { Apps: {}, Shared: [] },
      );
    },
    enabled: !!client,
    staleTime: 10 * 60_000,
  });
}

/** Create or replace a profile in both apps. Gap 4. */
export function useSaveQualityProfile() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      profile: QualityProfileView;
      isNew: boolean;
    }) => {
      if (input.isNew) {
        const { data, error } = await client!.POST(
          "/stingstream/api/v1/qualityprofiles",
          { body: input.profile },
        );
        if (error) throw error;
        return data as QualityProfileWriteResult;
      }
      const { data, error } = await client!.PUT(
        "/stingstream/api/v1/qualityprofiles/{name}",
        {
          params: { path: { name: input.profile.Name ?? "" } },
          body: input.profile,
        },
      );
      if (error) throw error;
      return data as QualityProfileWriteResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.qualityProfiles });
    },
  });
}

/** Remove a profile from both apps. Gap 4. */
export function useDeleteQualityProfile() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await client!.DELETE(
        "/stingstream/api/v1/qualityprofiles/{name}",
        { params: { path: { name } } },
      );
      if (error) throw error;
      return data as QualityProfileWriteResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.qualityProfiles });
    },
  });
}

/** The merged calendar, in a date window. Gap 5. */
export function useCalendar(start: string, end: string) {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: [...keys.calendar, start, end],
    queryFn: async () => {
      const { data, error } = await client!.GET(
        "/stingstream/api/v1/calendar",
        {
          params: { query: { start, end } },
        },
      );
      if (error) throw error;
      return (data ?? []) as CalendarEntry[];
    },
    enabled: !!client,
  });
}

/** Merged grab/import history, newest first. Gap 6. */
export function useHistory(page: number, pageSize = 25) {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: [...keys.history, page, pageSize],
    queryFn: async () => {
      return unwrap(
        await client!.GET("/stingstream/api/v1/history", {
          params: { query: { page, pageSize } },
        }),
        "GET /history",
        { Total: 0, Page: page, PageSize: pageSize, Records: [] },
      );
    },
    enabled: !!client,
    placeholderData: (previous: HistoryPage | undefined) => previous,
  });
}

/**
 * Every download, across the torrent engine, NZBGet and both arr queues. Gap 7.
 *
 * Polled at three seconds rather than the five the arr queue uses: this is the
 * screen somebody watches a download on, and a progress bar that moves in
 * five-second jumps reads as stuck.
 */
export function useDownloads() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.downloads,
    queryFn: async () => {
      return unwrap(
        await client!.GET("/stingstream/api/v1/downloads"),
        "GET /downloads",
        { Items: [], Engines: {}, TotalDownloadRate: 0, TotalUploadRate: 0 },
      );
    },
    enabled: !!client,
    refetchInterval: 3000,
  });
}

export interface DownloadActionInput {
  action: "pause" | "resume" | "remove";
  engine: string;
  id: string;
  deleteFiles?: boolean;
  blocklist?: boolean;
}

/**
 * Pause, resume or remove one download. Gap 7.
 *
 * The list is invalidated rather than optimistically edited: pause is a round
 * trip to another process, and a row that flips to "paused" and then flips back
 * three seconds later is worse than one that takes a moment to change.
 */
export function useDownloadAction() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DownloadActionInput) => {
      const path = { engine: input.engine, id: input.id };
      if (input.action === "remove") {
        const { data, error } = await client!.DELETE(
          "/stingstream/api/v1/downloads/{engine}/{id}",
          {
            params: {
              path,
              query: {
                deleteFiles: input.deleteFiles ?? false,
                blocklist: input.blocklist ?? false,
              },
            },
          },
        );
        if (error) throw error;
        return data;
      }
      if (input.action === "pause") {
        const { data, error } = await client!.POST(
          "/stingstream/api/v1/downloads/{engine}/{id}/pause",
          { params: { path } },
        );
        if (error) throw error;
        return data;
      }
      const { data, error } = await client!.POST(
        "/stingstream/api/v1/downloads/{engine}/{id}/resume",
        { params: { path } },
      );
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.downloads });
      queryClient.invalidateQueries({ queryKey: keys.queue });
    },
  });
}

/** Download clients somebody else runs, pushed into both arrs. Gap 8. */
export function useExternalDownloadClients() {
  const client = useStingStreamClient();
  return useQuery({
    queryKey: keys.externalClients,
    queryFn: async () => {
      const { data, error } = await client!.GET(
        "/stingstream/api/v1/Settings/downloadclients",
      );
      if (error) throw error;
      return (data ?? []) as ExternalDownloadClientSettings[];
    },
    enabled: !!client,
  });
}

export function useAddExternalDownloadClient() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (external: ExternalDownloadClientSettings) => {
      const { data, error } = await client!.POST(
        "/stingstream/api/v1/Settings/downloadclients",
        { params: { query: { sync: true } }, body: external },
      );
      if (error) throw error;
      return data as ExternalDownloadClientSettings;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.externalClients });
      queryClient.invalidateQueries({ queryKey: keys.sync });
    },
  });
}

export function useDeleteExternalDownloadClient() {
  const client = useStingStreamClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await client!.DELETE(
        "/stingstream/api/v1/Settings/downloadclients/{id}",
        { params: { path: { id } } },
      );
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: keys.externalClients });
      queryClient.invalidateQueries({ queryKey: keys.sync });
    },
  });
}

/**
 * Ask the arrs whether a download client is reachable. Gap 8.
 *
 * Not a query: a test is an action somebody takes, it has a side effect on
 * somebody else's server, and running it because a component re-rendered would
 * be wrong.
 */
export function useTestExternalDownloadClient() {
  const client = useStingStreamClient();
  return useMutation({
    mutationFn: async (external: ExternalDownloadClientSettings) => {
      const { data, error } = await client!.POST(
        "/stingstream/api/v1/Settings/downloadclients/test",
        { body: external },
      );
      if (error) throw error;
      return data as ConnectivityTestResult;
    },
  });
}

/**
 * Ask the arrs whether an indexer actually works. Gap 9.
 *
 * `Ok: false` is a *successful* call with a bad indexer, so the failure lives in
 * the result rather than in a thrown error — the mutation only rejects when the
 * request itself could not be made.
 */
export function useTestIndexer() {
  const client = useStingStreamClient();
  return useMutation({
    mutationFn: async (indexer: IndexerSettings) => {
      const { data, error } = await client!.POST(
        "/stingstream/api/v1/Settings/indexers/test",
        { body: indexer },
      );
      if (error) throw error;
      return data as ConnectivityTestResult;
    },
  });
}
