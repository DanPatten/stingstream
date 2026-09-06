import { useQuery } from "@tanstack/react-query";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Icon } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { radius, rgba, tokens } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useGlobalModal } from "@/providers/GlobalModalProvider";
import { FilterSheetContent } from "./FilterSheetContent";

interface FilterButtonProps<T>
  extends Omit<PressableProps, "children" | "style"> {
  id: string;
  queryKey: string;
  values: T[];
  title: string;
  set: (value: T[]) => void;
  queryFn: (params: any) => Promise<any>;
  renderItemLabel: (item: T) => string;
  multiple?: boolean;
  icon?: "filter" | "sort";
  style?: StyleProp<ViewStyle>;
}

/**
 * One chip in the library filter/sort bar. Visually a `Pill` (rounded, tinted
 * when a value is selected) that is actually pressable — `Pill` itself is a
 * static display component, so this borrows its palette rather than wrapping
 * it in a second touchable.
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
  style,
  ...props
}: FilterButtonProps<T>) => {
  const { showModal, hideModal } = useGlobalModal();
  const { accent } = useTheme();
  const active = values.length > 0;

  const { data: filters } = useQuery<T[]>({
    queryKey: ["filters", title, queryKey, id],
    queryFn,
    staleTime: 0,
    enabled: !!id && !!queryFn && !!queryKey,
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
    <Pressable
      onPress={openSheet}
      disabled={disabled}
      accessibilityRole='button'
      accessibilityLabel={title}
      accessibilityState={{ selected: active, disabled }}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: radius.pill,
          backgroundColor: active
            ? rgba(accent[500], 0.16)
            : tokens.color.bg["2"],
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
      {...props}
    >
      <Text
        variant='caption'
        weight='semibold'
        tone={active ? "accent" : "secondary"}
        numberOfLines={1}
      >
        {title}
      </Text>
      <Icon name={icon} size={14} tone={active ? "accent" : "secondary"} />
    </Pressable>
  );
};
