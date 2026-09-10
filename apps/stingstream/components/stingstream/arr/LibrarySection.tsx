import { Image } from "expo-image";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, View, type ViewStyle } from "react-native";
import { toast } from "sonner-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { Input } from "@/components/common/Input";
import { SettingSwitch } from "@/components/common/SettingSwitch";
import { Skeleton, SkeletonText } from "@/components/common/Skeleton";
import { Text } from "@/components/common/Text";
import { ListGroup } from "@/components/list/ListGroup";
import { motion, radius } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import type { ArrMovie, ArrSeries } from "@/lib/stingstream/arr-types";
import { formatBytes, posterUrl } from "@/lib/stingstream/arr-types";
import {
  type LookupResult,
  useAddMovie,
  useAddSeries,
  useArrReady,
  useDeleteLibraryItem,
  useMovies,
  useQualityProfiles,
  useSeries,
  useTitleLookup,
  useUpdateLibraryItem,
} from "@/lib/stingstream/hooks";
import { confirmDestructive } from "../shared/confirm";
import { ScreenHeaderRow } from "../shared/ScreenHeaderRow";
import { EmptyState, QueryState } from "../shared/ScreenState";

/**
 * The Radarr and Sonarr library, which is the same screen twice.
 *
 * They were one file each in M2 because they only listed and added by id. Now
 * that both do search-as-you-type, a monitor toggle, a quality-profile change
 * and a delete, the only real differences left are four words and which id a
 * title is keyed on — so they are one component with a `kind`. The two wrappers
 * that used to name them are gone with the Manage tab: `/settings/library`
 * switches `kind` directly.
 */
export function LibrarySection({ kind }: { kind: "movie" | "series" }) {
  const { t } = useTranslation();
  const router = useRouter();
  const isMovie = kind === "movie";
  // /healthz already knows whether this node runs a movie manager or a series
  // manager; waiting on it rather than firing the list call anyway means a node
  // with neither never sends a request that can only 503 (see hooks.ts).
  const arrReady = useArrReady(isMovie ? "radarr" : "sonarr");
  const movies = useMovies();
  const series = useSeries();
  const query = isMovie ? movies : series;
  const [addOpen, setAddOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  const rows = (query.data ?? []) as (ArrMovie | ArrSeries)[];

  if (arrReady === "off") {
    return (
      <View testID={isMovie ? "arr-movies" : "arr-series"}>
        <ScreenHeaderRow
          title={isMovie ? t("manage.movies_title") : t("manage.series_title")}
        />
        <EmptyState
          icon='download'
          title={t("manage.not_set_up_title")}
          detail={t("manage.not_set_up_detail")}
          // The switch that fixes this is on Downloading, which is a page of its
          // own now — so this navigates rather than scrolling to a section that
          // used to sit above this list on the same screen.
          //
          // No button on a television, matching `RequestsNotSetUp`: the TV
          // settings tree does not carry this page.
          action={
            Platform.isTV
              ? undefined
              : {
                  label: t("manage.not_set_up_action"),
                  onPress: () => router.push("/settings/downloading"),
                }
          }
        />
      </View>
    );
  }

  return (
    <View testID={isMovie ? "arr-movies" : "arr-series"}>
      <ScreenHeaderRow
        title={isMovie ? t("manage.movies_title") : t("manage.series_title")}
        accessory={
          <Button
            variant='secondary'
            size='sm'
            icon={addOpen ? "close" : "add"}
            onPress={() => setAddOpen((v) => !v)}
          >
            {addOpen ? t("common.cancel") : t("manage.add_action")}
          </Button>
        }
      />

      {addOpen && <AddForm kind={kind} onDone={() => setAddOpen(false)} />}

      <QueryState
        // `starting` is a loading state, not an error one: the manager is coming
        // up and the healthz poll turns the query on by itself a few seconds
        // later, so the skeleton stays and nobody has to press Try again.
        isLoading={
          query.isLoading || arrReady === undefined || arrReady === "starting"
        }
        error={query.error}
        onRetry={query.refetch}
      >
        {rows.length === 0 ? (
          <EmptyState
            title={
              isMovie
                ? t("manage.empty_movies_title")
                : t("manage.empty_series_title")
            }
            detail={t("manage.empty_detail")}
          />
        ) : (
          <ListGroup>
            {rows.map((row) => (
              <LibraryRow
                key={row.id}
                row={row}
                isMovie={isMovie}
                expanded={expanded}
                onToggle={(id) =>
                  setExpanded((current) => (current === id ? null : id))
                }
              />
            ))}
          </ListGroup>
        )}
      </QueryState>
    </View>
  );
}

/**
 * A poster-led row, matching the small poster the Requests screens use — a
 * remote TMDB/TVDB image where there is one, a lettered tile derived from the
 * title where there is not, so a row with no artwork yet still reads as one.
 */
function PosterThumb({
  url,
  title,
  size = 40,
}: {
  url?: string | null;
  title: string;
  size?: number;
}) {
  const { color } = useTheme();
  const height = Math.round(size * 1.5);
  if (!url) {
    return (
      <View
        style={{
          width: size,
          height,
          borderRadius: radius.sm,
          backgroundColor: color.bg["3"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text variant='body' weight='semibold' tone='tertiary'>
          {(title.trim()[0] ?? "?").toUpperCase()}
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: url }}
      contentFit='cover'
      transition={120}
      style={{ width: size, height, borderRadius: radius.sm }}
    />
  );
}

function LibraryRow({
  row,
  isMovie,
  expanded,
  onToggle,
}: {
  row: ArrMovie | ArrSeries;
  isMovie: boolean;
  expanded: number | null;
  onToggle: (providerId: number) => void;
}) {
  const { t } = useTranslation();
  const { color, accent } = useTheme();
  const update = useUpdateLibraryItem(isMovie ? "movie" : "series");
  const providerId = isMovie
    ? ((row as ArrMovie).tmdbId ?? 0)
    : ((row as ArrSeries).tvdbId ?? 0);
  const open = expanded === providerId;

  // The monitor state is a switch right on the row — spec calls for it, and it
  // is the one thing here somebody changes often enough to want with no extra
  // tap. It is a sibling of the expand toggle rather than nested inside it: two
  // `Pressable`s (or a `Switch` and a `Pressable`) sharing one touch target is
  // an old, well-known React Native gotcha (see the `switch-pointerevents-
  // ignored` learned fact) and this sidesteps it entirely.
  const toggleMonitored = async (next: boolean) => {
    try {
      await update.mutateAsync({ providerId, monitored: next });
      toast.success(
        next
          ? t("manage.monitor_started_toast", { title: row.title ?? "" })
          : t("manage.monitor_stopped_toast", { title: row.title ?? "" }),
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("manage.monitor_error"),
      );
    }
  };

  return (
    <View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          minHeight: 44,
          paddingVertical: 8,
          paddingHorizontal: 16,
          backgroundColor: color.bg["1"],
        }}
      >
        <Pressable
          onPress={() => onToggle(providerId)}
          style={[
            { flex: 1, flexDirection: "row", alignItems: "center" },
            Platform.OS === "web"
              ? ({
                  cursor: "pointer",
                  transitionDuration: `${motion.fast}ms`,
                } as ViewStyle)
              : null,
          ]}
        >
          <PosterThumb url={posterUrl(row.images)} title={row.title ?? ""} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text numberOfLines={1}>
              {row.title}
              {row.year ? ` (${row.year})` : ""}
            </Text>
            <Text
              variant='caption'
              tone='secondary'
              numberOfLines={1}
              style={{ marginTop: 2 }}
            >
              {describe(t, row, isMovie)}
            </Text>
          </View>
        </Pressable>
        <SettingSwitch
          value={row.monitored ?? false}
          disabled={update.isPending}
          onValueChange={(next) => void toggleMonitored(next)}
          trackColor={{ true: accent[500] }}
        />
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={
            open ? t("manage.collapse_action") : t("manage.expand_action")
          }
          hitSlop={8}
          onPress={() => onToggle(providerId)}
          style={{ marginLeft: 6, padding: 4 }}
        >
          <Icon
            name={open ? "chevronUp" : "chevronDown"}
            size={18}
            tone='tertiary'
          />
        </Pressable>
      </View>
      {open && providerId > 0 && (
        <ItemActions
          kind={isMovie ? "movie" : "series"}
          providerId={providerId}
          title={row.title ?? ""}
          onDone={() => onToggle(providerId)}
        />
      )}
    </View>
  );
}

function describe(
  t: TFunction,
  row: ArrMovie | ArrSeries,
  isMovie: boolean,
): string {
  const size = isMovie
    ? (row as ArrMovie).sizeOnDisk
    : (row as ArrSeries).statistics?.sizeOnDisk;
  const have = isMovie
    ? (row as ArrMovie).hasFile
      ? t("manage.downloaded")
      : undefined
    : (row as ArrSeries).statistics
      ? t("manage.episodes_progress", {
          have: (row as ArrSeries).statistics?.episodeFileCount ?? 0,
          total: (row as ArrSeries).statistics?.episodeCount ?? 0,
        })
      : undefined;
  return [have, size ? formatBytes(size) : null].filter(Boolean).join(" • ");
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
  onDone,
}: {
  kind: "movie" | "series";
  providerId: number;
  title: string;
  onDone: () => void;
}) {
  const { color } = useTheme();
  const { t } = useTranslation();
  const update = useUpdateLibraryItem(kind);
  const remove = useDeleteLibraryItem(kind);
  const profiles = useQualityProfiles();
  const [showProfiles, setShowProfiles] = useState(false);

  const setProfile = async (name: string) => {
    try {
      await update.mutateAsync({ providerId, qualityProfileName: name });
      toast.success(t("manage.profile_set_toast", { title, profile: name }));
      setShowProfiles(false);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("manage.profile_error"),
      );
    }
  };

  const del = async (deleteFiles: boolean) => {
    const ok = await confirmDestructive(
      t("manage.delete_confirm_title", { title }),
      deleteFiles
        ? t("manage.delete_confirm_message_files")
        : t("manage.delete_confirm_message"),
      deleteFiles ? t("manage.delete_with_files_action") : t("common.delete"),
    );
    if (!ok) return;
    try {
      await remove.mutateAsync({ providerId, deleteFiles });
      toast.success(t("manage.deleted_toast", { title }));
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("manage.delete_error"),
      );
    }
  };

  return (
    <View
      style={{
        backgroundColor: color.bg["2"],
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button
          variant='secondary'
          size='sm'
          onPress={() => setShowProfiles((v) => !v)}
        >
          {t("manage.quality_profile_action")}
        </Button>
        <Button variant='danger' size='sm' onPress={() => void del(false)}>
          {t("common.delete")}
        </Button>
        <Button
          variant='danger'
          size='sm'
          loading={remove.isPending}
          onPress={() => void del(true)}
        >
          {t("manage.delete_with_files_action")}
        </Button>
      </View>

      {showProfiles && (
        <View style={{ marginTop: 12 }}>
          {profiles.isLoading && <SkeletonText lines={2} lastLineWidth='40%' />}
          {(profiles.data ?? []).map((p) => (
            <Pressable
              key={p.Name}
              onPress={() => void setProfile(p.Name ?? "")}
              style={{ paddingVertical: 8 }}
            >
              <Text tone='accent' weight='semibold'>
                {p.Name}
                {p.InSync === false ? t("manage.out_of_sync_suffix") : ""}
              </Text>
            </Pressable>
          ))}
          {profiles.data?.length === 0 && (
            <Text variant='caption' tone='secondary'>
              {t("manage.no_profiles_hint")}
            </Text>
          )}
        </View>
      )}
    </View>
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
  const { t } = useTranslation();
  const { color, accent } = useTheme();
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
        toast.success(
          t("manage.added_toast", { title: added.title ?? result.Title }),
        );
      } else {
        const added = await addSeries.mutateAsync({
          tvdbId: result.TvdbId ?? 0,
          monitored: true,
          searchOnAdd,
          qualityProfileName: profile || undefined,
        });
        toast.success(
          t("manage.added_toast", { title: added.title ?? result.Title }),
        );
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("manage.add_error"));
    }
  };

  const addById = async () => {
    const id = Number.parseInt(term, 10);
    if (!Number.isFinite(id) || id <= 0) {
      toast.error(
        isMovie
          ? t("manage.enter_valid_tmdb_id")
          : t("manage.enter_valid_tvdb_id"),
      );
      return;
    }
    await add(
      isMovie
        ? ({ TmdbId: id, Title: `#${id}` } as LookupResult)
        : ({ TvdbId: id, Title: `#${id}` } as LookupResult),
    );
  };

  return (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: color.bg["1"],
        padding: 16,
        marginBottom: 12,
      }}
    >
      <Input
        icon='search'
        placeholder={
          isMovie
            ? t("manage.search_movies_placeholder")
            : t("manage.search_series_placeholder")
        }
        autoCapitalize='none'
        autoCorrect={false}
        value={term}
        onChangeText={setTerm}
      />

      {term.trim().length >= 2 && (
        <View style={{ marginTop: 8 }}>
          {lookup.isFetching && (
            <View>
              {[0, 1].map((i) => (
                <View
                  key={i}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    paddingVertical: 8,
                  }}
                >
                  <Skeleton width={32} height={48} radius={radius.sm} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Skeleton width='70%' height={12} />
                    <Skeleton
                      width='45%'
                      height={10}
                      style={{ marginTop: 6 }}
                    />
                  </View>
                </View>
              ))}
            </View>
          )}
          {lookup.error && (
            <Text
              variant='caption'
              tone='danger'
              style={{ paddingVertical: 8 }}
            >
              {lookup.error instanceof Error
                ? lookup.error.message
                : t("manage.lookup_failed")}
            </Text>
          )}
          {(lookup.data ?? []).slice(0, 12).map((r) => (
            <Pressable
              key={`${r.TmdbId}-${r.TvdbId}-${r.Title}`}
              disabled={pending || r.ExistsInLibrary === true}
              onPress={() => void add(r)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingVertical: 8,
                opacity: r.ExistsInLibrary ? 0.45 : 1,
              }}
            >
              <PosterThumb url={r.PosterUrl} title={r.Title ?? ""} size={32} />
              <View style={{ flex: 1, marginLeft: 10 }}>
                <Text numberOfLines={1}>
                  {r.Title}
                  {r.Year ? ` (${r.Year})` : ""}
                </Text>
                <Text variant='caption' tone='secondary' numberOfLines={2}>
                  {r.ExistsInLibrary
                    ? t("manage.already_in_library")
                    : (r.Overview ?? "")}
                </Text>
              </View>
            </Pressable>
          ))}
          {!lookup.isFetching && lookup.data?.length === 0 && (
            <Text
              variant='caption'
              tone='secondary'
              style={{ paddingVertical: 8 }}
            >
              {t("manage.nothing_found")}
            </Text>
          )}
        </View>
      )}

      {profiles.data && profiles.data.length > 0 && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            marginTop: 8,
          }}
        >
          <ProfileChip
            label={t("manage.default_profile_chip")}
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

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 12,
          marginBottom: 4,
        }}
      >
        <Text>{t("manage.search_on_add")}</Text>
        <SettingSwitch
          value={searchOnAdd}
          onValueChange={setSearchOnAdd}
          trackColor={{ true: accent[500] }}
        />
      </View>

      <Button
        variant='secondary'
        size='sm'
        loading={pending}
        onPress={() => void addById()}
        style={{ marginTop: 8, alignSelf: "flex-start" }}
      >
        {isMovie ? t("manage.add_by_id_movie") : t("manage.add_by_id_series")}
      </Button>
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
  const { color, accent } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: radius.pill,
        backgroundColor: on ? accent[500] : color.bg["3"],
      }}
    >
      <Text
        variant='caption'
        weight='semibold'
        tone={on ? "onAccent" : "secondary"}
      >
        {label}
      </Text>
    </Pressable>
  );
}
