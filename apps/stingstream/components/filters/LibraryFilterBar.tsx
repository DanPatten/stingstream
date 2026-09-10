import { getFilterApi } from "@jellyfin/sdk/lib/utils/api";
import { useAtomValue } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { apiAtom, userAtom } from "@/providers/JellyfinProvider";
import {
  type FilterByOption,
  SortByOption,
  SortOrderOption,
  sortOptions,
  sortOrderOptions,
  useFilterOptions,
} from "@/utils/atoms/filters";
import { FilterButton } from "./FilterButton";
import { ResetFiltersButton } from "./ResetFiltersButton";
import { ScrollingFilterBar } from "./ScrollingFilterBar";

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
  const { color } = useTheme();
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
        // A list is always in some order, so "has a value" would mean this chip
        // is filled from the moment the screen opens. Filled means "you changed
        // this" — the same comparison `useFilterReset` makes to decide whether
        // there is anything to clear.
        active={sortBy[0] !== SortByOption.SortName}
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
        active={sortOrder[0] !== SortOrderOption.Ascending}
        renderItemLabel={(item) =>
          sortOrderOptions.find((i) => i.key === item)?.value || ""
        }
      />
    </>
  );

  // Opaque: on a wide browser the bar is the list's sticky header, and cards
  // scrolling visibly through it is worse than no sticky header at all.
  const background = color.bg["0"];

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
    <ScrollingFilterBar background={background} testID='library-filter-bar'>
      {chips}
    </ScrollingFilterBar>
  );
};
