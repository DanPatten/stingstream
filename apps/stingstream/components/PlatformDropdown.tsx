import { Ionicons } from "@expo/vector-icons";
import React, {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  Pressable,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnchoredMenu, MenuItem, MenuSection } from "@/components/common/Menu";
import { SheetScrollView } from "@/components/common/Sheet";
import { Text } from "@/components/common/Text";
import { useTheme } from "@/hooks/useTheme";
import { useGlobalModal } from "@/providers/GlobalModalProvider";

// @expo/ui's SwiftUI native module (ExpoUI) does not exist in tvOS builds.
// A static top-level import evaluates requireNativeModule('ExpoUI') at module
// load and crashes the entire route tree on tvOS (expo-router requires every
// route file). Load it lazily and only off-TV; TV never renders these.
const { Button, Host, Menu } = Platform.isTV
  ? ({} as typeof import("@expo/ui/swift-ui"))
  : require("@expo/ui/swift-ui");
const { disabled } = Platform.isTV
  ? ({} as typeof import("@expo/ui/swift-ui/modifiers"))
  : require("@expo/ui/swift-ui/modifiers");

// Option types
export type RadioOption<T = any> = {
  type: "radio";
  label: string;
  value: T;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
};

export type ToggleOption = {
  type: "toggle";
  label: string;
  value: boolean;
  onToggle: () => void;
  disabled?: boolean;
};

export type ActionOption = {
  type: "action";
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

export type Option = RadioOption | ToggleOption | ActionOption;

// Option group structure
export type OptionGroup = {
  title?: string;
  options: Option[];
};

interface PlatformDropdownProps {
  trigger?: React.ReactNode;
  /**
   * Opens from this control instead of drawing a trigger of its own, and only through `open`.
   * For a picker reached from a menu row: the row is the control, so a second button beside it
   * would say the same thing twice (the details page "...", Dan 2026-09-22). On a device the
   * choices are the bottom sheet either way.
   */
  anchorRef?: RefObject<View | null>;
  title?: string;
  groups: OptionGroup[];
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOptionSelect?: (value?: any) => void;
  expoUIConfig?: {
    hostStyle?: any;
  };
  bottomSheetConfig?: {
    enableDynamicSizing?: boolean;
    enablePanDownToClose?: boolean;
  };
}

const ToggleSwitch: React.FC<{ value: boolean }> = ({ value }) => {
  const { color } = useTheme();

  return (
    <View
      style={{ backgroundColor: value ? color.accent[500] : color.bg["3"] }}
      className='w-12 h-7 rounded-full flex-row items-center'
    >
      <View
        style={{ backgroundColor: color.text.primary }}
        className={`w-5 h-5 rounded-full shadow-md transform transition-transform ${value ? "translate-x-6" : "translate-x-1"}`}
      />
    </View>
  );
};

const OptionItem: React.FC<{ option: Option; isLast?: boolean }> = ({
  option,
  isLast,
}) => {
  const { color } = useTheme();
  const isToggle = option.type === "toggle";
  const isAction = option.type === "action";
  const handlePress = isToggle
    ? option.onToggle
    : (option as RadioOption | ActionOption).onPress;

  return (
    <>
      <TouchableOpacity
        onPress={handlePress}
        disabled={option.disabled}
        className={`px-4 py-3 flex flex-row items-center justify-between ${option.disabled ? "opacity-50" : ""}`}
      >
        <Text className='flex-1'>{option.label}</Text>
        {isToggle ? (
          <ToggleSwitch value={option.value} />
        ) : isAction ? null : (option as RadioOption).selected ? (
          <Ionicons name='checkmark-circle' size={24} color='#9333ea' />
        ) : (
          <Ionicons name='ellipse-outline' size={24} color='#6b7280' />
        )}
      </TouchableOpacity>
      {!isLast && (
        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: color.bg["3"],
          }}
          className='mx-4'
        />
      )}
    </>
  );
};

const OptionGroupComponent: React.FC<{ group: OptionGroup }> = ({ group }) => {
  const { color } = useTheme();

  return (
    <View className='mb-6'>
      {group.title && (
        <Text tone='secondary' className='text-lg font-semibold mb-3'>
          {group.title}
        </Text>
      )}
      <View
        style={{
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: color.bg["2"],
        }}
        className='rounded-xl overflow-hidden'
      >
        {group.options.map((option, index) => (
          <OptionItem
            key={index}
            option={option}
            isLast={index === group.options.length - 1}
          />
        ))}
      </View>
    </View>
  );
};

const BottomSheetContent: React.FC<{
  title?: string;
  groups: OptionGroup[];
  onOptionSelect?: (value?: any) => void;
  onClose?: () => void;
}> = ({ title, groups, onOptionSelect, onClose }) => {
  const insets = useSafeAreaInsets();

  // Wrap the groups to call onOptionSelect when an option is pressed
  const wrappedGroups = groups.map((group) => ({
    ...group,
    options: group.options.map((option) => {
      if (option.type === "radio") {
        return {
          ...option,
          onPress: () => {
            option.onPress();
            onOptionSelect?.(option.value);
            onClose?.();
          },
        };
      }
      if (option.type === "toggle") {
        return {
          ...option,
          onToggle: () => {
            option.onToggle();
            onOptionSelect?.(option.value);
          },
        };
      }
      if (option.type === "action") {
        return {
          ...option,
          onPress: () => {
            option.onPress();
            onClose?.();
          },
        };
      }
      return option;
    }),
  }));

  return (
    <SheetScrollView
      className='px-4 pb-8 pt-2'
      style={{
        paddingLeft: Math.max(16, insets.left),
        paddingRight: Math.max(16, insets.right),
      }}
    >
      {title && <Text className='font-bold text-2xl mb-6'>{title}</Text>}
      {wrappedGroups.map((group, index) => (
        <OptionGroupComponent key={index} group={group} />
      ))}
    </SheetScrollView>
  );
};

/**
 * The browser's version: a menu anchored under its trigger, like every desktop app's "...".
 *
 * Dan, 2026-09-14, pointing at Plex's library menu: a menu rather than a modal wherever a list of
 * choices is all there is. It used to be `showModal`, a centred card with a title for what is often
 * three lines. Android keeps the bottom sheet below, its own menu at thumb reach, and iOS keeps the
 * native menu above.
 */
const WebDropdown: React.FC<PlatformDropdownProps> = ({
  trigger,
  anchorRef,
  title,
  groups,
  disabled: isDisabled,
  open: controlledOpen,
  onOpenChange,
  onOptionSelect,
}) => {
  const { t } = useTranslation();
  const anchor = useRef<View>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = (controlledOpen ?? uncontrolledOpen) && !isDisabled;

  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);

  return (
    <>
      {anchorRef ? null : (
        <Pressable
          ref={anchor}
          onPress={() => setOpen(true)}
          disabled={isDisabled}
          accessibilityState={{ expanded: open, disabled: isDisabled }}
        >
          {trigger || <Text>{t("common.open_menu")}</Text>}
        </Pressable>
      )}
      <AnchoredMenu
        visible={open}
        onClose={close}
        anchorRef={anchorRef ?? anchor}
        title={title}
      >
        {groups.map((group, groupIndex) => (
          <MenuSection
            key={groupIndex}
            title={group.title}
            divider={groupIndex > 0}
          >
            {group.options.map((option, optionIndex) => (
              <MenuItem
                key={optionIndex}
                label={option.label}
                disabled={option.disabled}
                selected={
                  option.type === "radio"
                    ? option.selected
                    : option.type === "toggle"
                      ? option.value
                      : undefined
                }
                onPress={() => {
                  // A toggle stays open, so several can be flipped in one visit.
                  if (option.type === "toggle") {
                    option.onToggle();
                    onOptionSelect?.(option.value);
                    return;
                  }
                  // Closed first: an action that opens a dialog of its own must not open it
                  // underneath this menu.
                  close();
                  option.onPress();
                  if (option.type === "radio") onOptionSelect?.(option.value);
                }}
              />
            ))}
          </MenuSection>
        ))}
      </AnchoredMenu>
    </>
  );
};

const PlatformDropdownComponent = ({
  trigger,
  anchorRef,
  title,
  groups,
  disabled: isDisabled,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  onOptionSelect,
  expoUIConfig,
  bottomSheetConfig,
}: PlatformDropdownProps) => {
  const { t } = useTranslation();
  const { showModal, hideModal, isVisible } = useGlobalModal();

  // iOS's native menu can only be opened by pressing its own label, so a dropdown with no trigger
  // of its own takes the bottom sheet there too.
  const sheetControlled =
    Platform.OS === "android" || (Platform.OS === "ios" && Boolean(anchorRef));

  // Handle controlled open state for the bottom sheet
  useEffect(() => {
    if (sheetControlled && controlledOpen === true && !isDisabled) {
      showModal(
        <BottomSheetContent
          title={title}
          groups={groups}
          onOptionSelect={onOptionSelect}
          onClose={() => {
            hideModal();
            controlledOnOpenChange?.(false);
          }}
        />,
        {
          // No snap points: sized to its options, so a two-entry dropdown
          // opens small and a long one stops at the shared ceiling.
          enablePanDownToClose: bottomSheetConfig?.enablePanDownToClose ?? true,
        },
      );
    }
  }, [controlledOpen, isDisabled]);

  // Watch for modal dismissal on Android (e.g., swipe down, backdrop tap)
  // and sync the controlled open state
  useEffect(() => {
    if (sheetControlled && controlledOpen === true && !isVisible) {
      controlledOnOpenChange?.(false);
    }
  }, [sheetControlled, isVisible, controlledOpen, controlledOnOpenChange]);

  if (Platform.OS === "ios" && !Platform.isTV && !anchorRef) {
    // @expo/ui's <Host> can't size to content, so an in-flow invisible copy of
    // the trigger sizes the wrapper while the Host overlays the real Menu.
    return (
      <View pointerEvents={isDisabled ? "none" : "auto"}>
        <View pointerEvents='none' aria-hidden style={{ opacity: 0 }}>
          {trigger}
        </View>
        <Host style={[StyleSheet.absoluteFill, expoUIConfig?.hostStyle as any]}>
          <Menu label={trigger}>
            {groups.flatMap((group, groupIndex) => {
              // Check if this group has radio options
              const radioOptions = group.options.filter(
                (opt) => opt.type === "radio",
              ) as RadioOption[];
              const toggleOptions = group.options.filter(
                (opt) => opt.type === "toggle",
              ) as ToggleOption[];
              const actionOptions = group.options.filter(
                (opt) => opt.type === "action",
              ) as ActionOption[];

              const items = [];

              // Group radio options under a submenu ONLY if there's a title
              // Otherwise render as individual buttons
              if (radioOptions.length > 0) {
                if (group.title) {
                  // Use a nested Menu as a submenu for grouped options. This
                  // reads as "Title: Selected" and expands to the choices on
                  // tap, keeping the nested look while staying a dropdown.
                  // (Menu opens on a single tap and nests cleanly; ContextMenu
                  // would require a long-press and read as a context menu.)
                  const selectedOption = radioOptions.find(
                    (opt) => opt.selected,
                  );
                  const displayTitle = selectedOption
                    ? `${group.title}: ${selectedOption.label}`
                    : group.title;
                  items.push(
                    <Menu key={`submenu-${groupIndex}`} label={displayTitle}>
                      {radioOptions.map((option, optionIndex) => (
                        <Button
                          key={`radio-${groupIndex}-${optionIndex}`}
                          label={option.label}
                          systemImage={
                            option.selected ? "checkmark.circle.fill" : "circle"
                          }
                          modifiers={
                            option.disabled ? [disabled(true)] : undefined
                          }
                          onPress={() => {
                            option.onPress();
                            onOptionSelect?.(option.value);
                          }}
                        />
                      ))}
                    </Menu>,
                  );
                } else {
                  // Render radio options as direct buttons
                  radioOptions.forEach((option, optionIndex) => {
                    items.push(
                      <Button
                        key={`radio-${groupIndex}-${optionIndex}`}
                        label={option.label}
                        systemImage={
                          option.selected ? "checkmark.circle.fill" : "circle"
                        }
                        modifiers={
                          option.disabled ? [disabled(true)] : undefined
                        }
                        onPress={() => {
                          option.onPress();
                          onOptionSelect?.(option.value);
                        }}
                      />,
                    );
                  });
                }
              }

              // Add Buttons for toggle options
              toggleOptions.forEach((option, optionIndex) => {
                items.push(
                  <Button
                    key={`toggle-${groupIndex}-${optionIndex}`}
                    label={option.label}
                    systemImage={
                      option.value ? "checkmark.circle.fill" : "circle"
                    }
                    modifiers={option.disabled ? [disabled(true)] : undefined}
                    onPress={() => {
                      option.onToggle();
                      onOptionSelect?.(option.value);
                    }}
                  />,
                );
              });

              // Add Buttons for action options (no icon)
              actionOptions.forEach((option, optionIndex) => {
                items.push(
                  <Button
                    key={`action-${groupIndex}-${optionIndex}`}
                    label={option.label}
                    modifiers={option.disabled ? [disabled(true)] : undefined}
                    onPress={() => {
                      option.onPress();
                    }}
                  />,
                );
              });

              return items;
            })}
          </Menu>
        </Host>
      </View>
    );
  }

  if (Platform.OS === "web" && !Platform.isTV) {
    return (
      <WebDropdown
        trigger={trigger}
        anchorRef={anchorRef}
        title={title}
        groups={groups}
        disabled={isDisabled}
        open={controlledOpen}
        onOpenChange={controlledOnOpenChange}
        onOptionSelect={onOptionSelect}
      />
    );
  }

  // Opened only through `open`, by the effect above.
  if (anchorRef) return null;

  // Android: Direct modal trigger
  const handlePress = () => {
    showModal(
      <BottomSheetContent
        title={title}
        groups={groups}
        onOptionSelect={onOptionSelect}
        onClose={hideModal}
      />,
      {
        // No snap points: sized to its options, so a two-entry dropdown opens
        // small and a long one stops at the shared ceiling.
        enablePanDownToClose: bottomSheetConfig?.enablePanDownToClose ?? true,
      },
    );
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.7}
      disabled={isDisabled}
    >
      {trigger || <Text>{t("common.open_menu")}</Text>}
    </TouchableOpacity>
  );
};

// Memoize to prevent unnecessary re-renders when parent re-renders
export const PlatformDropdown = React.memo(
  PlatformDropdownComponent,
  (prevProps, nextProps) => {
    // Custom comparison - only re-render if these props actually change
    return (
      prevProps.title === nextProps.title &&
      prevProps.open === nextProps.open &&
      prevProps.disabled === nextProps.disabled &&
      prevProps.groups === nextProps.groups && // Reference equality (works because we memoize groups in caller)
      prevProps.trigger === nextProps.trigger && // Reference equality
      prevProps.anchorRef === nextProps.anchorRef
    );
  },
);
