import type { components } from "@stingstream/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ArrMovie, ArrQueueItem, ArrSeries } from "./arr-types";
import { useStingStreamClient } from "./client";

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

const keys = {
  status: ["stingstream", "status"] as const,
  settings: ["stingstream", "settings"] as const,
  indexers: ["stingstream", "indexers"] as const,
  movies: ["stingstream", "movies"] as const,
  series: ["stingstream", "series"] as const,
  queue: ["stingstream", "queue"] as const,
  sync: ["stingstream", "sync"] as const,
  meshStatus: ["stingstream", "mesh-status"] as const,
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
      const { data, error } = await client!.GET(
        "/stingstream/api/v1/Mesh/status",
      );
      if (error) throw error;
      return data as MeshStatus;
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
      const { data, error } = await client!.GET("/stingstream/api/v1/Status");
      if (error) throw error;
      return data as NodeStatus;
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
      const { data, error } = await client!.GET("/stingstream/api/v1/Settings");
      if (error) throw error;
      return data as SharedSettings;
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
