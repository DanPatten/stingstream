import { useTranslation } from "react-i18next";
import type { StyleProp, ViewStyle } from "react-native";
import { FilterChip } from "./FilterChip";

interface Props {
  /** Whether anything is actually narrowing the list. Nothing is drawn when false. */
  visible: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

/**
 * "Clear" — the chip that undoes every filter and sort on the bar it sits in.
 *
 * It says what it does. A bar used to open with a bare round × at its leading
 * edge, permanently, with nothing to say what it would clear or whether there
 * was anything to clear at all: an unlabelled destructive control in front of
 * the controls it destroys. It appears only once something is actually active,
 * and reads as a chip like everything beside it.
 *
 * Knows nothing about what it is clearing, so the library bar and the requests
 * bar clear through one control rather than two that drift.
 */
export const ClearFiltersChip: React.FC<Props> = ({
  visible,
  onPress,
  style,
  className,
}) => {
  const { t } = useTranslation();

  if (!visible) {
    return null;
  }

  return (
    <FilterChip
      label={t("library.filters.clear")}
      icon='close'
      onPress={onPress}
      style={style}
      className={className}
    />
  );
};
