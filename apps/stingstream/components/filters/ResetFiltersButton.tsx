import { useTranslation } from "react-i18next";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon } from "@/components/common/Icon";
import { radius, tokens } from "@/constants/theme";
import { useFilterReset } from "@/hooks/useFilterReset";

interface Props extends Omit<PressableProps, "children" | "style"> {
  libraryId: string;
  style?: StyleProp<ViewStyle>;
}

export const ResetFiltersButton: React.FC<Props> = ({
  libraryId,
  style,
  ...props
}) => {
  const { t } = useTranslation();
  const { hasActiveFilters, resetAllFilters } = useFilterReset(libraryId);

  if (!hasActiveFilters) {
    return null;
  }

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={t("library.filters.reset")}
      style={[
        {
          width: 32,
          height: 32,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: tokens.color.bg["3"],
          marginRight: 4,
        },
        style,
      ]}
      {...props}
      // After the spread so a forwarded onPress can't disable the reset.
      onPress={resetAllFilters}
    >
      <Icon name='close' size={16} tone='secondary' />
    </Pressable>
  );
};
