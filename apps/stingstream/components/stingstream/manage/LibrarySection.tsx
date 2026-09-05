import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { toast } from "sonner-native";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { Colors } from "@/constants/Colors";
import type { ArrMovie, ArrSeries } from "@/lib/stingstream/arr-types";
import { formatBytes, posterUrl } from "@/lib/stingstream/arr-types";
import {
  type LookupResult,
  useAddMovie,
  useAddSeries,
  useDeleteLibraryItem,
  useMovies,
  useQualityProfiles,
  useSeries,
  useTitleLookup,
  useUpdateLibraryItem,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";
import { EmptyState, QueryState } from "../shared/ScreenState";

/**
 * Manage → Movies and Manage → Series, which are the same screen twice.
 *
 * They were one file each in M2 because they only listed and added by id. Now
 * that both do search-as-you-type, a monitor toggle, a quality-profile change
 * and a delete, the only real differences left are four words and which id a
 * title is keyed on — so they are one component with a `kind`, and the two old
 * files are thin wrappers that keep the screen map in docs/UI.md honest.
 */
export function LibrarySection({ kind }: { kind: "movie" | "series" }) {
  const isMovie = kind === "movie";
  const movies = useMovies();
  const series = useSeries();
  const query = isMovie ? movies : series;
  const [addOpen, setAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const rows = (query.data ?? []) as (ArrMovie | ArrSeries)[];

  return (
    <View>
      <View className='flex-row items-center justify-between mb-2'>
        <Text className='text-white text-lg font-semibold'>
          {isMovie ? "Movies" : "Series"}
        </Text>
        <TouchableOpacity onPress={() => setAddOpen((v) => !v)}>
          <Text className='text-[#0584FE] font-semibold'>
            {addOpen ? "Cancel" : "+ Add"}
          </Text>
        </TouchableOpacity>
      </View>

      {addOpen && <AddForm kind={kind} onDone={() => setAddOpen(false)} />}

      <QueryState
        isLoading={query.isLoading}
        error={query.error}
        onRetry={query.refetch}
      >
        {rows.length === 0 ? (
          <EmptyState
            title={isMovie ? "No movies yet" : "No series yet"}
            detail='Press "+ Add" and search for a title.'
          />
        ) : (
          <ListGroup>
            {rows.map((row) => {
              const providerId = isMovie
                ? ((row as ArrMovie).tmdbId ?? 0)
                : ((row as ArrSeries).tvdbId ?? 0);
              const open = expanded === providerId;
              return (
                <View key={row.id}>
                  <ListItem
                    title={`${row.title}${row.year ? ` (${row.year})` : ""}`}
                    subtitle={describe(row, isMovie)}
                    onPress={() => setExpanded(open ? null : providerId)}
                    showArrow
                  >
                    {posterUrl(row.images) ? (
                      <Image
                        source={{ uri: posterUrl(row.images) }}
                        style={{ width: 32, height: 48, borderRadius: 4 }}
                      />
                    ) : null}
                  </ListItem>
                  {open && providerId > 0 && (
                    <ItemActions
                      kind={kind}
                      providerId={providerId}
                      title={row.title ?? ""}
                      monitored={row.monitored ?? false}
                      onDone={() => setExpanded(null)}
                    />
                  )}
                </View>
              );
            })}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}

function describe(row: ArrMovie | ArrSeries, isMovie: boolean): string {
  const size = isMovie
    ? (row as ArrMovie).sizeOnDisk
    : (row as ArrSeries).statistics?.sizeOnDisk;
  const have = isMovie
    ? (row as ArrMovie).hasFile
      ? "Downloaded"
      : undefined
    : (row as ArrSeries).statistics
      ? `${(row as ArrSeries).statistics?.episodeFileCount ?? 0}/${(row as ArrSeries).statistics?.episodeCount ?? 0} episodes`
      : undefined;
  return [
    have,
    row.monitored ? "Monitored" : "Unmonitored",
    size ? formatBytes(size) : null,
  ]
    .filter(Boolean)
    .join(" • ");
}

/**
 * The per-title actions: monitor, profile, delete.
 *
 * Inline under the row rather than on a detail page, because all three are
 * one-tap decisions a person makes while scanning a list — pushing a route for
 * "stop monitoring this" would be three navigations for something that is one.
 */
function ItemActions({
  kind,
  providerId,
  title,
  monitored,
  onDone,
}: {
  kind: "movie" | "series";
  providerId: number;
  title: string;
  monitored: boolean;
  onDone: () => void;
}) {
  const update = useUpdateLibraryItem(kind);
  const remove = useDeleteLibraryItem(kind);
  const profiles = useQualityProfiles();
  const [showProfiles, setShowProfiles] = useState(false);

  const toggle = async () => {
    try {
      await update.mutateAsync({ providerId, monitored: !monitored });
      toast.success(
        monitored ? `Stopped monitoring ${title}` : `Monitoring ${title}`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not change monitoring",
      );
    }
  };

  const setProfile = async (name: string) => {
    try {
      await update.mutateAsync({ providerId, qualityProfileName: name });
      toast.success(`${title} is now on ${name}`);
      setShowProfiles(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not change the profile",
      );
    }
  };

  const del = async (deleteFiles: boolean) => {
    const ok = await confirmDestructive(
      `Delete ${title}?`,
      deleteFiles
        ? "The title and its files on disk are both deleted. This cannot be undone."
        : "The title is removed from the library. Files already on disk are left where they are.",
      deleteFiles ? "Delete with files" : "Delete",
    );
    if (!ok) return;
    try {
      await remove.mutateAsync({ providerId, deleteFiles });
      toast.success(`Deleted ${title}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  };

  return (
    <View className='bg-neutral-800 px-4 py-3'>
      <View className='flex-row flex-wrap gap-2'>
        <Action
          label={monitored ? "Stop monitoring" : "Monitor"}
          busy={update.isPending}
          onPress={toggle}
        />
        <Action
          label='Quality profile'
          onPress={() => setShowProfiles((v) => !v)}
        />
        <Action label='Delete' tone='red' onPress={() => void del(false)} />
        <Action
          label='Delete + files'
          tone='red'
          busy={remove.isPending}
          onPress={() => void del(true)}
        />
      </View>

      {showProfiles && (
        <View className='mt-3'>
          {profiles.isLoading && (
            <ActivityIndicator size='small' color='#9899A1' />
          )}
          {(profiles.data ?? []).map((p) => (
            <TouchableOpacity
              key={p.Name}
              className='py-2'
              onPress={() => void setProfile(p.Name ?? "")}
            >
              <Text className='text-[#0584FE]'>
                {p.Name}
                {p.InSync === false ? " (apps disagree)" : ""}
              </Text>
            </TouchableOpacity>
          ))}
          {profiles.data?.length === 0 && (
            <Text className='text-[#9899A1] text-xs'>
              Neither app has a quality profile. Create one in Server settings.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function Action({
  label,
  onPress,
  tone,
  busy,
}: {
  label: string;
  onPress: () => void;
  tone?: "red";
  busy?: boolean;
}) {
  return (
    <TouchableOpacity
      disabled={busy}
      onPress={onPress}
      className='rounded-lg px-3 py-2'
      style={{
        backgroundColor: tone === "red" ? "#3f1d1d" : "#2a2a2a",
        opacity: busy ? 0.5 : 1,
      }}
    >
      <Text className={tone === "red" ? "text-red-400" : "text-white"}>
        {busy ? "Working…" : label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * Search by title, then add. Gap 1 closed.
 *
 * The id field stays, below the search results rather than instead of them: a
 * lookup depends on a metadata provider being reachable, and "type the TMDB id"
 * is the escape hatch that used to be the only route. It costs six lines.
 */
function AddForm({
  kind,
  onDone,
}: {
  kind: "movie" | "series";
  onDone: () => void;
}) {
  const isMovie = kind === "movie";
  const [term, setTerm] = useState("");
  const [profile, setProfile] = useState("");
  const [searchOnAdd, setSearchOnAdd] = useState(true);
  const lookup = useTitleLookup(kind, term);
  const addMovie = useAddMovie();
  const addSeries = useAddSeries();
  const profiles = useQualityProfiles();
  const pending = addMovie.isPending || addSeries.isPending;

  const add = async (result: LookupResult) => {
    try {
      if (isMovie) {
        const added = await addMovie.mutateAsync({
          tmdbId: result.TmdbId ?? 0,
          monitored: true,
          searchOnAdd,
          qualityProfileName: profile || undefined,
        });
        toast.success(`Added ${added.title ?? result.Title}`);
      } else {
        const added = await addSeries.mutateAsync({
          tvdbId: result.TvdbId ?? 0,
          monitored: true,
          searchOnAdd,
          qualityProfileName: profile || undefined,
        });
        toast.success(`Added ${added.title ?? result.Title}`);
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add");
    }
  };

  const addById = async () => {
    const id = Number.parseInt(term, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error(isMovie ? "Enter a valid TMDB id" : "Enter a valid TVDB id");
      return;
    }
    await add(
      isMovie
        ? ({ TmdbId: id, Title: `#${id}` } as LookupResult)
        : ({ TvdbId: id, Title: `#${id}` } as LookupResult),
    );
  };

  return (
    <View className='rounded-xl bg-neutral-900 p-4 mb-3'>
      <TextInput
        placeholder={
          isMovie ? "Search films by title" : "Search series by title"
        }
        placeholderTextColor='#5A5960'
        autoCapitalize='none'
        autoCorrect={false}
        value={term}
        onChangeText={setTerm}
        className='bg-neutral-800 text-white rounded-lg px-3 py-2 mb-2'
      />

      {term.trim().length >= 2 && (
        <View className='mb-2'>
          {lookup.isFetching && (
            <View className='flex-row items-center py-2'>
              <ActivityIndicator size='small' color='#9899A1' />
              <Text className='text-[#9899A1] text-xs ml-2'>Searching…</Text>
            </View>
          )}
          {lookup.error && (
            <Text className='text-red-500 text-xs py-2'>
              {lookup.error instanceof Error
                ? lookup.error.message
                : "The lookup failed"}
            </Text>
          )}
          {(lookup.data ?? []).slice(0, 12).map((r) => (
            <TouchableOpacity
              key={`${r.TmdbId}-${r.TvdbId}-${r.Title}`}
              disabled={pending || r.ExistsInLibrary === true}
              onPress={() => void add(r)}
              className='flex-row items-center py-2'
              style={{ opacity: r.ExistsInLibrary ? 0.45 : 1 }}
            >
              {r.PosterUrl ? (
                <Image
                  source={{ uri: r.PosterUrl }}
                  style={{
                    width: 32,
                    height: 48,
                    borderRadius: 4,
                    marginRight: 10,
                  }}
                />
              ) : (
                <View style={{ width: 32, height: 48, marginRight: 10 }} />
              )}
              <View className='flex-1'>
                <Text className='text-white'>
                  {r.Title}
                  {r.Year ? ` (${r.Year})` : ""}
                </Text>
                <Text className='text-[#9899A1] text-xs' numberOfLines={2}>
                  {r.ExistsInLibrary
                    ? "Already in your library"
                    : (r.Overview ?? "")}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
          {!lookup.isFetching && lookup.data?.length === 0 && (
            <Text className='text-[#9899A1] text-xs py-2'>
              Nothing found. The id below still works if you have one.
            </Text>
          )}
        </View>
      )}

      {profiles.data && profiles.data.length > 0 && (
        <View className='flex-row flex-wrap gap-2 mb-2'>
          <ProfileChip
            label='Default profile'
            on={profile === ""}
            onPress={() => setProfile("")}
          />
          {profiles.data.map((p) => (
            <ProfileChip
              key={p.Name}
              label={p.Name ?? ""}
              on={profile === p.Name}
              onPress={() => setProfile(p.Name ?? "")}
            />
          ))}
        </View>
      )}

      <TouchableOpacity
        onPress={() => setSearchOnAdd((v) => !v)}
        className='flex-row items-center mb-3'
      >
        <View
          className='w-5 h-5 rounded mr-2 items-center justify-center'
          style={{ backgroundColor: searchOnAdd ? Colors.primary : "#1f1f1f" }}
        >
          {searchOnAdd && <Text className='text-white text-xs'>{"✓"}</Text>}
        </View>
        <Text className='text-white'>Search for it immediately</Text>
      </TouchableOpacity>

      <TouchableOpacity
        disabled={pending}
        onPress={() => void addById()}
        className='rounded-lg py-2 items-center bg-neutral-800'
      >
        <Text className='text-white'>
          {pending
            ? "Adding…"
            : `Add by ${isMovie ? "TMDB" : "TVDB"} id instead`}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function ProfileChip({
  label,
  on,
  onPress,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      className='rounded-full px-3 py-1'
      style={{ backgroundColor: on ? Colors.primary : "#2a2a2a" }}
    >
      <Text className='text-white text-xs'>{label}</Text>
    </TouchableOpacity>
  );
}
