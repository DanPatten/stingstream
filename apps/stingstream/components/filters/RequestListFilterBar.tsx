import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { Text } from "@/components/common/Text";
import {
  DEFAULT_REQUEST_LIST_FILTERS,
  DIMENSION_LABEL_KEYS,
  REQUEST_LIST_DIMENSIONS,
  type RequesterOption,
  type RequestListDimension,
  type RequestListFilters,
  type RequestListSection,
  requestListChipLabel,
  requestListDimensionActive,
  requestListFiltersActive,
  requestListOptionLabel,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  type Translate,
  TYPE_OPTIONS,
} from "@/components/stingstream/requests/requestListFilters";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import { useTheme } from "@/hooks/useTheme";
import { ClearFiltersChip } from "./ClearFiltersChip";
import { FilterButton } from "./FilterButton";
import { ScrollingFilterBar } from "./ScrollingFilterBar";

interface Props {
  section: RequestListSection;
  filters: RequestListFilters;
  set: (filters: RequestListFilters) => void;
  /** Who has a request in this list. Only read when the section offers "Requested by". */
  requesters?: RequesterOption[];
  /** Rows shown and rows in the list, for the count beside the chips while anything narrows it. */
  shown?: number;
  total?: number;
}

/**
 * The filter bar over a request list: My requests, Approvals, Wanted.
 *
 * The same pieces as the library's bar and Discover's (`FilterButton`, its sheet, `FilterChip`, the
 * Clear chip, `ScrollingFilterBar`), because it is the same gesture. One difference, asked for: a
 * chip that has been set reads its value, "Status: Waiting", so the bar says exactly what the list
 * under it is filtered by without opening anything. A library's bar has six dimensions and would
 * not fit its values; this one has at most three.
 *
 * Which chips appear is `REQUEST_LIST_DIMENSIONS`, and the rules behind every label are pure and
 * tested in `requestListFilters.ts`.
 */
export const RequestListFilterBar: React.FC<Props> = ({
  section,
  filters,
  set,
  requesters = [],
  shown,
  total,
}) => {
  const { color } = useTheme();
  const { t } = useTranslation();
  const { isCompact, gutter } = useBreakpoint();
  const active = requestListFiltersActive(filters);
  const tr: Translate = (key, options) => String(t(key, options as never));

  const chip = (dimension: RequestListDimension) => {
    const common = {
      id: `requests-${section}`,
      title: tr(DIMENSION_LABEL_KEYS[dimension]),
      label: requestListChipLabel(dimension, filters, tr, requesters),
      active: requestListDimensionActive(dimension, filters),
      icon: dimension === "sort" ? ("sort" as const) : ("filter" as const),
      renderItemLabel: (value: string) =>
        requestListOptionLabel(dimension, value, tr, requesters),
    };
    switch (dimension) {
      case "status":
        return (
          <FilterButton<string>
            key={dimension}
            {...common}
            queryKey='requestListStatus'
            queryFn={async () => [...STATUS_OPTIONS]}
            values={[filters.status]}
            set={([value]) =>
              set({
                ...filters,
                status: (value ??
                  DEFAULT_REQUEST_LIST_FILTERS.status) as RequestListFilters["status"],
              })
            }
          />
        );
      case "type":
        return (
          <FilterButton<string>
            key={dimension}
            {...common}
            queryKey='requestListType'
            queryFn={async () => [...TYPE_OPTIONS]}
            values={[filters.type]}
            set={([value]) =>
              set({
                ...filters,
                type: (value ??
                  DEFAULT_REQUEST_LIST_FILTERS.type) as RequestListFilters["type"],
              })
            }
          />
        );
      case "requester":
        return (
          <FilterButton<string>
            key={dimension}
            {...common}
            // Keyed on the people, because `FilterButton` caches the options it fetched and the list
            // under it changes as requests arrive and are decided.
            queryKey={`requestListRequester:${requesters.map((r) => r.id).join(",")}`}
            // "" is Everyone: the sheet is single-select and cannot be emptied, so going back to
            // everybody has to be an option of its own.
            queryFn={async () => ["", ...requesters.map((r) => r.id)]}
            values={[filters.requester ?? ""]}
            set={([value]) => set({ ...filters, requester: value || null })}
          />
        );
      default:
        return (
          <FilterButton<string>
            key={dimension}
            {...common}
            queryKey='requestListSort'
            queryFn={async () => [...SORT_OPTIONS]}
            values={[filters.sort]}
            set={([value]) =>
              set({
                ...filters,
                sort: (value ??
                  DEFAULT_REQUEST_LIST_FILTERS.sort) as RequestListFilters["sort"],
              })
            }
          />
        );
    }
  };

  // Clear leads on a phone and trails on a wide screen, for the reason `RequestFilterBar` gives:
  // wherever it appears, it must not push the chip the reader just pressed out from under them.
  const clear = (
    <ClearFiltersChip
      visible={active}
      onPress={() => set(DEFAULT_REQUEST_LIST_FILTERS)}
    />
  );

  const count =
    active && shown !== undefined && total !== undefined ? (
      <Text variant='caption' tone='secondary' testID='requests-filter-count'>
        {t("requests.list_filtered_count", { shown, total })}
      </Text>
    ) : null;

  const chips = (
    <>
      {isCompact ? clear : null}
      {REQUEST_LIST_DIMENSIONS[section].map(chip)}
      {isCompact ? null : clear}
      {count}
    </>
  );

  const background = color.bg["0"];

  if (!isCompact) {
    return (
      <View
        testID='requests-list-filter-bar'
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          paddingVertical: 12,
          backgroundColor: background,
        }}
      >
        {chips}
      </View>
    );
  }

  // Bled to the screen edges, as Discover's bar is: the page container has already paid the gutter.
  return (
    <View style={{ marginHorizontal: -gutter }}>
      <ScrollingFilterBar
        background={background}
        testID='requests-list-filter-bar'
      >
        {chips}
      </ScrollingFilterBar>
    </View>
  );
};
