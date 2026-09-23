import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { Button } from "@/components/Button";
import { Icon } from "@/components/common/Icon";
import { ListGroup } from "@/components/list/ListGroup";
import { ListItem } from "@/components/list/ListItem";
import { rgba, space, tokens } from "@/constants/theme";
import { usePressableStates } from "@/hooks/usePressableStates";
import { useTheme } from "@/hooks/useTheme";

/**
 * A library's folders: one row each with a remove control, and an add button underneath.
 *
 * The rows are plain, not pressable, because the remove control lives on them and a pressable
 * `ListItem` is a real `<button>` on web that cannot hold another one.
 */
export function FolderList({
  paths,
  onAdd,
  onRemove,
  canRemove = () => true,
  addLabel,
  disabled = false,
}: {
  paths: string[];
  onAdd?: () => void;
  onRemove?: (path: string) => void;
  canRemove?: (path: string) => boolean;
  addLabel?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <View style={{ gap: space["3"] }}>
      {paths.length > 0 ? (
        <ListGroup>
          {paths.map((path) => (
            <ListItem
              key={path}
              title={path}
              icon='storage'
              iconAfter={
                onRemove ? (
                  <RemoveFolder
                    disabled={disabled || !canRemove(path)}
                    label={t("libraries.remove_folder")}
                    onPress={() => onRemove(path)}
                  />
                ) : null
              }
            />
          ))}
        </ListGroup>
      ) : null}
      {onAdd ? (
        <View style={{ alignItems: "flex-start" }}>
          <Button
            testID='library-add-folder'
            variant='secondary'
            size='sm'
            icon='storage'
            disabled={disabled}
            onPress={onAdd}
          >
            {addLabel ?? t("libraries.add_folder")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function RemoveFolder({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  const states = usePressableStates({ disabled });
  const active = states.hovered || states.pressed;

  return (
    <Pressable
      accessibilityRole='button'
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      {...states.handlers}
      style={[
        {
          width: tokens.control.minTouchTarget,
          height: tokens.control.minTouchTarget,
          borderRadius: tokens.control.minTouchTarget / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: active
            ? rgba(color.state.danger, 0.14)
            : "transparent",
          opacity: disabled ? tokens.control.disabledOpacity : 1,
        },
        states.webStyle,
      ]}
    >
      <Icon
        name='close'
        size={18}
        color={active ? color.state.danger : color.text.tertiary}
      />
    </Pressable>
  );
}
