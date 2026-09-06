import { useTranslation } from "react-i18next";
import type { StyleProp, ViewStyle } from "react-native";
import { useFilterReset } from "@/hooks/useFilterReset";
import { FilterChip } from "./FilterChip";

interface Props {
  libraryId: string;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

/**
 * "Clear" — the chip that undoes every filter and sort on this library.
 *
 * It says what it does. The bar used to open with a bare round × at its
 * leading edge, permanently, with nothing to say what it would clear or
 * whether there was anything to clear at all: an unlabelled destructive
 * control in front of the controls it destroys. It appears only once a filter
 * is actually active, and reads as a chip like everything beside it.
 */
export const ResetFiltersButton: React.FC<Props> = ({
  libraryId,
  style,
  className,
}) => {
  const { t } = useTranslation();
  const { hasActiveFilters, resetAllFilters } = useFilterReset(libraryId);

  if (!hasActiveFilters) {
    return null;
  }

  return (
    <FilterChip
      label={t("library.filters.clear")}
      icon='close'
      onPress={resetAllFilters}
      style={style}
      className={className}
    />
  );
};
