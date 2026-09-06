import { useQuery } from "@tanstack/react-query";
import type { StyleProp, ViewStyle } from "react-native";
import { useGlobalModal } from "@/providers/GlobalModalProvider";
import { FilterChip } from "./FilterChip";
import { FilterSheetContent } from "./FilterSheetContent";

interface FilterButtonProps<T> {
  id: string;
  queryKey: string;
  values: T[];
  title: string;
  set: (value: T[]) => void;
  queryFn: (params: any) => Promise<any>;
  renderItemLabel: (item: T) => string;
  multiple?: boolean;
  icon?: "filter" | "sort";
  /**
   * Overrides "filled when anything is selected".
   *
   * A sort chip always has a value — a list is always in *some* order — so
   * "selected" is not the same as "changed from the default", and without this
   * the bar opened with Sort by and Sort order filled while nothing had been
   * chosen at all. Pass the same comparison the Clear chip uses.
   */
  active?: boolean;
  style?: StyleProp<ViewStyle>;
  /** For the screens whose own bar still spaces its chips with a utility class. */
  className?: string;
}

/**
 * One filter or sort chip in the library bar: press it, pick values in a
 * sheet, and the chip fills in while it is narrowing the list.
 *
 * The chip shows the *dimension* ("Genres", "Sort by"), not the values chosen
 * — a bar of chips reading "Action, Comedy, Documentary • Release date •
 * Descending" is wider than any phone and tells you nothing you can act on
 * until you open it anyway. Filled-vs-plain is what carries "this one is on".
 */
export const FilterButton = <T,>({
  id,
  queryFn,
  queryKey,
  set,
  values, // selected values
  title,
  renderItemLabel,
  multiple = false,
  icon = "filter",
  active: activeOverride,
  style,
  className,
}: FilterButtonProps<T>) => {
  const { showModal, hideModal } = useGlobalModal();
  const active = activeOverride ?? values.length > 0;

  const { data: filters } = useQuery<T[]>({
    queryKey: ["filters", title, queryKey, id],
    queryFn,
    staleTime: 0,
    enabled: !!id && !!queryFn && !!queryKey,
    // A bar is six of these. When the parent id is wrong the server says so
    // on the first ask and will say the same thing on the fourth, so the
    // default three retries turned one bad screen into a burst of two dozen
    // failed requests. A chip with no values just disables itself.
    retry: false,
  });

  const disabled = filters?.length === 0;

  const openSheet = () => {
    if (!filters?.length) return;
    showModal(
      <FilterSheetContent<T>
        title={title}
        data={filters}
        initialValues={values}
        set={set}
        renderItemLabel={renderItemLabel}
        multiple={multiple}
        onClose={hideModal}
      />,
      // No snap points: the sheet grows with its options and stops at the
      // shared ceiling, so a two-entry sort order opens small.
    );
  };

  return (
    <FilterChip
      label={title}
      icon={icon}
      active={active}
      disabled={disabled}
      onPress={openSheet}
      style={style}
      className={className}
    />
  );
};
