import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { REQUEST_YEAR_FLOOR } from "@/constants/Requests";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import {
  DEFAULT_REQUEST_FILTERS,
  type RequestAvailability,
  type RequestFilterState,
  type RequestKind,
  type RequestOrder,
  type RequestSort,
  requestFiltersActive,
} from "@/lib/stingstream/requestsApi";
import { ClearFiltersChip } from "./ClearFiltersChip";
import { FilterButton } from "./FilterButton";
import { FilterChip } from "./FilterChip";
import { ScrollingFilterBar } from "./ScrollingFilterBar";

const KINDS: { key: RequestKind; labelKey: string }[] = [
  { key: "all", labelKey: "requests.filter_kind_all" },
  { key: "movie", labelKey: "requests.filter_kind_films" },
  { key: "series", labelKey: "requests.filter_kind_series" },
];

const SORTS: RequestSort[] = ["popular", "top_rated", "newest", "title"];
const ORDERS: RequestOrder[] = ["desc", "asc"];
const AVAILABILITY: RequestAvailability[] = ["held", "not_held", "requested"];

interface Props {
  state: RequestFilterState;
  set: (state: RequestFilterState) => void;
  /** The genres this kind can be filtered by, as the node's catalogue reported them. */
  genres: string[];
}

/**
 * Find's filter bar: the same controls a library has, over titles nobody owns yet.
 *
 * Deliberately the same components as `LibraryFilterBar` down to the sheet, because it is the same
 * gesture: press a chip naming a dimension, pick one value, watch the chip fill. Somebody who has
 * narrowed a library by genre has already learnt this bar.
 *
 * Three of the library's chips are not here and one is new, and each difference is a question the
 * catalogue cannot answer rather than a simplification:
 *
 * - **Tags** are a librarian's own labels on files they hold. A title nobody has yet has none.
 * - **Filter by** offers played, unplayed, favourite and resumable, all of which are facts about
 *   watching something. Its place is taken by **Availability**, which is this screen's real
 *   equivalent: whether the group already has it, and whether somebody already asked.
 * - **Sort by** is short here. A catalogue can be ordered by attention, by rating, by release and
 *   by name; it cannot be ordered by date added, play count or air time, because those are things a
 *   library knows about its own copy.
 *
 * The kind chips lead the bar rather than sitting in a sheet of their own. They are the one control
 * on it that is pressed on nearly every visit, and All / Movies / TV shows with exactly one filled
 * reads as the segmented control it is.
 */
export const RequestFilterBar: React.FC<Props> = ({ state, set, genres }) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { isCompact, gutter } = useBreakpoint();

  // Newest first: somebody filtering by year is far more often looking for something recent than
  // for something from 1912, and the sheet's own search box handles the far end.
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return Array.from({ length: now - REQUEST_YEAR_FLOOR + 1 }, (_, index) =>
      String(now - index),
    );
  }, []);

  const sortLabel = (sort: RequestSort) => t(`requests.sort_${sort}`);
  const orderLabel = (order: RequestOrder) =>
    t(order === "asc" ? "library.filters.asc" : "library.filters.desc");
  const availabilityLabel = (value: RequestAvailability) =>
    t(`requests.availability_${value}`);

  const chips = (
    <>
      <ClearFiltersChip
        visible={requestFiltersActive(state)}
        onPress={() => set(DEFAULT_REQUEST_FILTERS)}
      />

      {KINDS.map((entry) => (
        <FilterChip
          key={entry.key}
          label={t(entry.labelKey)}
          active={state.kind === entry.key}
          onPress={() => set({ ...state, kind: entry.key })}
        />
      ))}

      <FilterButton
        id='requests'
        // Keyed on both the kind and the length, because `FilterButton` fetches its own options and
        // would otherwise hold the first answer it got. The kind decides which genres exist at all
        // (there is no film called Sci-Fi & Fantasy), and the length changes from nought to a real
        // list the moment the first page of the feed lands.
        queryKey={`requestGenres:${state.kind}:${genres.length}`}
        queryFn={async () => genres}
        set={(values: string[]) => set({ ...state, genres: values })}
        values={state.genres}
        title={t("library.filters.genres")}
        renderItemLabel={(item) => item}
      />
      <FilterButton
        id='requests'
        queryKey='requestYears'
        queryFn={async () => years}
        set={(values: string[]) => set({ ...state, years: values })}
        values={state.years}
        title={t("library.filters.years")}
        renderItemLabel={(item) => item}
      />
      <FilterButton
        id='requests'
        queryKey='requestAvailability'
        queryFn={async () => AVAILABILITY}
        set={(values: RequestAvailability[]) =>
          set({ ...state, availability: values })
        }
        values={state.availability}
        title={t("requests.filter_availability")}
        renderItemLabel={availabilityLabel}
      />
      <FilterButton
        id='requests'
        queryKey='requestSortBy'
        queryFn={async () => SORTS}
        set={(values: RequestSort[]) => set({ ...state, sortBy: values })}
        values={state.sortBy}
        title={t("library.filters.sort_by")}
        icon='sort'
        // A list is always in some order, so "has a value" would mean this chip is filled from the
        // moment the screen opens. Filled means "you changed this".
        active={state.sortBy[0] !== DEFAULT_REQUEST_FILTERS.sortBy[0]}
        renderItemLabel={sortLabel}
      />
      <FilterButton
        id='requests'
        queryKey='requestSortOrder'
        queryFn={async () => ORDERS}
        set={(values: RequestOrder[]) => set({ ...state, sortOrder: values })}
        values={state.sortOrder}
        title={t("library.filters.sort_order")}
        icon='sort'
        active={state.sortOrder[0] !== DEFAULT_REQUEST_FILTERS.sortOrder[0]}
        renderItemLabel={orderLabel}
      />
    </>
  );

  const background = color.bg["0"];

  if (!isCompact) {
    return (
      <View
        testID='requests-filter-bar'
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          paddingVertical: 12,
          backgroundColor: background,
        }}
      >
        {chips}
      </View>
    );
  }

  // Bled out to the screen edges, the same way the grid below it is: the page container has
  // already paid the gutter, and a scroller that stopped short of the edge would clip its own chips
  // against an invisible margin instead of running under the fade.
  return (
    <View style={{ marginHorizontal: -gutter }}>
      <ScrollingFilterBar background={background} testID='requests-filter-bar'>
        {chips}
      </ScrollingFilterBar>
    </View>
  );
};
