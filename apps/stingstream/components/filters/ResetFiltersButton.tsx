import type { StyleProp, ViewStyle } from "react-native";
import { useFilterReset } from "@/hooks/useFilterReset";
import { ClearFiltersChip } from "./ClearFiltersChip";

interface Props {
  libraryId: string;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

/**
 * The library bar's Clear chip: the shared control, wired to this library's
 * own filter state and to the per-library preferences it also has to forget.
 */
export const ResetFiltersButton: React.FC<Props> = ({
  libraryId,
  style,
  className,
}) => {
  const { hasActiveFilters, resetAllFilters } = useFilterReset(libraryId);

  return (
    <ClearFiltersChip
      visible={hasActiveFilters}
      onPress={resetAllFilters}
      style={style}
      className={className}
    />
  );
};
