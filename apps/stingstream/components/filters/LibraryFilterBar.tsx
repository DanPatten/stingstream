import { getFilterApi } from "@jellyfin/sdk/lib/utils/api";
import { LinearGradient } from "expo-linear-gradient";
import { useAtomValue } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  View,
} from "react-native";
import { rgba, tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  type FilterByOption,
  type SortByOption,
  type SortOrderOption,
  sortOptions,
  sortOrderOptions,
  useFilterOptions,
} from "@/utils/atoms/filters";
import { FilterButton } from "./FilterButton";
import { ResetFiltersButton } from "./ResetFiltersButton";

/** How much of the bar the fade covers at either end. */
const FADE_WIDTH = 28;
/** Ignore a pixel or two of rounding when deciding whether an end is reached. */
const SCROLL_EPSILON = 2;

export interface LibraryFilterBarProps {
  /** The library (or collection) these filters narrow. */
  libraryId: string;
  selectedGenres: string[];
  setGenres: (values: string[]) => void;
  selectedYears: string[];
  setYears: (values: string[]) => void;
  selectedTags: string[];
  setTags: (values: string[]) => void;
  sortBy: SortByOption[];
  setSortBy: (values: SortByOption[]) => void;
  sortOrder: SortOrderOption[];
  setSortOrder: (values: SortOrderOption[]) => void;
  filterBy: FilterByOption[];
  setFilter: (values: FilterByOption[]) => void;
}

/**
 * The library's filter and sort bar.
 *
 * On a phone the chips scroll sideways with a fade at whichever end still has
 * chips beyond it — the row used to run straight off the viewport with no
 * affordance at all, so "Sort by" was simply invisible and there was nothing on
 * screen to suggest swiping. From `medium` up there is room for the whole set,
 * so it wraps onto a second line instead of hiding anything behind a gesture
 * that a mouse does not have.
 */
export const LibraryFilterBar: React.FC<LibraryFilterBarProps> = ({
  libraryId,
  selectedGenres,
  setGenres,
  selectedYears,
  setYears,
  selectedTags,
  setTags,
  sortBy,
  setSortBy,
  sortOrder,
  setSortOrder,
  filterBy,
  setFilter,
}) => {
  const { t } = useTranslation();
  const api = useAtomValue(apiAtom);
  const user = useAtomValue(userAtom);
  const { isCompact, gutter } = useBreakpoint();
  const generalFilters = useFilterOptions();

  // The three value filters all come from the same endpoint; only the field
  // read off the response differs.
  const queryFilters = useCallback(
    async (field: "Genres" | "Years" | "Tags") => {
      if (!api) return null;
      const response = await getFilterApi(api).getQueryFiltersLegacy({
        userId: user?.Id,
        parentId: libraryId,
      });
      return response.data[field] || [];
    },
    [api, user?.Id, libraryId],
  );

  const chips = (
    <>
      <ResetFiltersButton libraryId={libraryId} />
      <FilterButton
        id={libraryId}
        queryKey='genreFilter'
        queryFn={() => queryFilters("Genres")}
        set={setGenres}
        values={selectedGenres}
        title={t("library.filters.genres")}
        renderItemLabel={(item) => item.toString()}
      />
      <FilterButton
        id={libraryId}
        queryKey='yearFilter'
        queryFn={() => queryFilters("Years")}
        set={setYears}
        values={selectedYears}
        title={t("library.filters.years")}
        renderItemLabel={(item) => item.toString()}
      />
      <FilterButton
        id={libraryId}
        queryKey='tagsFilter'
        queryFn={() => queryFilters("Tags")}
        set={setTags}
        values={selectedTags}
        title={t("library.filters.tags")}
        renderItemLabel={(item) => item.toString()}
      />
      <FilterButton
        id={libraryId}
        queryKey='filters'
        queryFn={async () => generalFilters.map((s) => s.key)}
        set={setFilter}
        values={filterBy}
        title={t("library.filters.filter_by")}
        renderItemLabel={(item) =>
          generalFilters.find((i) => i.key === item)?.value || ""
        }
      />
      <FilterButton
        id={libraryId}
        queryKey='sortBy'
        queryFn={async () => sortOptions.map((s) => s.key)}
        set={setSortBy}
        values={sortBy}
        title={t("library.filters.sort_by")}
        icon='sort'
        renderItemLabel={(item) =>
          sortOptions.find((i) => i.key === item)?.value || ""
        }
      />
      <FilterButton
        id={libraryId}
        queryKey='sortOrder'
        queryFn={async () => sortOrderOptions.map((s) => s.key)}
        set={setSortOrder}
        values={sortOrder}
        title={t("library.filters.sort_order")}
        icon='sort'
        renderItemLabel={(item) =>
          sortOrderOptions.find((i) => i.key === item)?.value || ""
        }
      />
    </>
  );

  // Opaque: on a wide browser the bar is the list's sticky header, and cards
  // scrolling visibly through it is worse than no sticky header at all.
  const background = tokens.color.bg["0"];

  if (!isCompact) {
    return (
      <View
        testID='library-filter-bar'
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          paddingHorizontal: gutter,
          paddingVertical: 12,
          backgroundColor: background,
        }}
      >
        {chips}
      </View>
    );
  }

  return (
    <ScrollingFilterBar background={background}>{chips}</ScrollingFilterBar>
  );
};

/**
 * The compact bar: one horizontal scroller, with a fade at each end that is
 * drawn only while there is something past it to scroll to.
 */
const ScrollingFilterBar: React.FC<
  React.PropsWithChildren<{ background: string }>
> = ({ background, children }) => {
  const { gutter } = useBreakpoint();
  const [offset, setOffset] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) =>
      setOffset(event.nativeEvent.contentOffset.x),
    [],
  );
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) =>
      setViewportWidth(event.nativeEvent.layout.width),
    [],
  );
  const handleContentSizeChange = useCallback(
    (width: number) => setContentWidth(width),
    [],
  );

  const fadeLeft = offset > SCROLL_EPSILON;
  const fadeRight = offset + viewportWidth < contentWidth - SCROLL_EPSILON;

  return (
    <View
      testID='library-filter-bar'
      style={{ backgroundColor: background, position: "relative" }}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        onLayout={handleLayout}
        onContentSizeChange={handleContentSizeChange}
        contentContainerStyle={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: gutter,
          paddingVertical: 12,
        }}
      >
        {children}
      </ScrollView>

      {fadeLeft && <EdgeFade side='left' color={background} />}
      {fadeRight && <EdgeFade side='right' color={background} />}
    </View>
  );
};

/** A chip half-under a fade is the affordance: there is more this way. */
const EdgeFade: React.FC<{ side: "left" | "right"; color: string }> = ({
  side,
  color,
}) => (
  <LinearGradient
    pointerEvents='none'
    // Two stops of the same colour, opaque to clear: fading to `transparent`
    // goes through transparent *black* on some engines and leaves a grey
    // smear over the chips.
    colors={side === "left" ? [color, rgba(color, 0)] : [rgba(color, 0), color]}
    start={{ x: 0, y: 0.5 }}
    end={{ x: 1, y: 0.5 }}
    style={{
      position: "absolute",
      top: 0,
      bottom: 0,
      width: FADE_WIDTH,
      ...(side === "left" ? { left: 0 } : { right: 0 }),
    }}
  />
);
