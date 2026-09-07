import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dimensions,
  Modal,
  Platform,
  Pressable,
  View,
  type ViewStyle,
} from "react-native";
import { Icon, type IconName } from "@/components/common/Icon";
import { Text } from "@/components/common/Text";
import { elevation, radius, tokens, webFocusRing } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useTheme } from "@/hooks/useTheme";
import { useJellyfin, userAtom } from "@/providers/JellyfinProvider";
import { useFocusVisible } from "./useFocusVisible";

const MENU_WIDTH = 248;
/** Enough to decide whether the card fits below its trigger before it renders. */
const MENU_HEIGHT_ESTIMATE = 200;
const AVATAR_SIZE = 32;

export type UserMenuVariant = "avatar" | "row";

interface Props {
  /** `avatar` in the top bar, `row` at the foot of the sidebar. */
  variant?: UserMenuVariant;
  /** The sidebar rail draws the avatar alone even in `row` form. */
  collapsed?: boolean;
}

/**
 * Who you are signed in as, and the two things you do about it.
 *
 * A popover rather than `Dialog`: signing out and opening settings are pointer
 * gestures anchored to an avatar, and a centred modal card over a dimmed page
 * for two rows reads as an interruption. It keeps `Dialog`'s manners though —
 * Escape closes, a click anywhere outside closes, the card is a bg1 panel with
 * e2 — and it is a `Modal` for the same reason `Dialog` is: nothing else in
 * React Native paints above a navigator.
 */
export const UserMenu: React.FC<Props> = ({
  variant = "avatar",
  collapsed = false,
}) => {
  const { t } = useTranslation();
  const user = useAtomValue(userAtom);
  const { logout } = useJellyfin();
  const router = useRouter();
  const { accent, accentName } = useTheme();

  const triggerRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<ViewStyle | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  const close = useCallback(() => setAnchor(null), []);

  const open = useCallback(() => {
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      const window = Dimensions.get("window");
      const below = y + height + 8;
      // The sidebar's copy sits at the bottom of the page, so the card has to
      // be able to open upwards; the top bar's has room underneath.
      const flip = below + MENU_HEIGHT_ESTIMATE > window.height;
      setAnchor({
        position: "absolute",
        width: MENU_WIDTH,
        top: flip ? undefined : below,
        bottom: flip ? window.height - y + 8 : undefined,
        left: Math.min(
          Math.max(12, x + width - MENU_WIDTH),
          Math.max(12, window.width - MENU_WIDTH - 12),
        ),
      });
    });
  }, []);

  // Escape closes, the way every other menu on the web does.
  useEffect(() => {
    if (!anchor || Platform.OS !== "web") return;
    const onKeyDown = (event: { key?: string }) => {
      if (event.key === "Escape") close();
    };
    const target = globalThis as unknown as {
      addEventListener?: (t: string, h: (e: never) => void) => void;
      removeEventListener?: (t: string, h: (e: never) => void) => void;
    };
    target.addEventListener?.("keydown", onKeyDown as (e: never) => void);
    return () =>
      target.removeEventListener?.("keydown", onKeyDown as (e: never) => void);
  }, [anchor, close]);

  const name = user?.Name ?? "";
  const serverName = nodeName();

  // `navigate`, not `push`: the menu lives in the top bar, outside the
  // navigator, and `useAppRouter`'s push guard only releases when the screen
  // that pushed regains focus — which a persistent chrome never does, so the
  // second push from here would be dropped. See `WebShellLayout`.
  const go = useCallback(
    (pathname: string) => {
      close();
      router.navigate(pathname as never);
    },
    [close, router],
  );

  const signOut = useCallback(() => {
    close();
    void logout();
  }, [close, logout]);

  return (
    <View>
      <Pressable
        ref={triggerRef}
        testID='shell-user-menu'
        accessibilityRole='button'
        accessibilityLabel={name || t("shell.account")}
        accessibilityState={{ expanded: Boolean(anchor) }}
        onPress={open}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={
          {
            flexDirection: "row",
            alignItems: "center",
            borderRadius: radius.sm,
            paddingVertical: 4,
            paddingHorizontal: variant === "row" && !collapsed ? 8 : 4,
            backgroundColor:
              hovered && variant === "row"
                ? tokens.color.bg["3"]
                : "transparent",
            ...(Platform.OS === "web"
              ? { cursor: "pointer", ...webFocusRing(showRing, accentName) }
              : null),
          } as ViewStyle
        }
      >
        <Avatar name={name} color={accent[500]} />
        {variant === "row" && !collapsed ? (
          <>
            <Text
              variant='caption'
              weight='medium'
              numberOfLines={1}
              style={{ marginLeft: 10, flex: 1 }}
            >
              {name}
            </Text>
            <Icon name='chevronUp' size={14} tone='tertiary' />
          </>
        ) : null}
      </Pressable>

      <Modal
        visible={Boolean(anchor)}
        transparent
        animationType='fade'
        onRequestClose={close}
      >
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={t("common.close")}
          onPress={close}
          style={{ flex: 1 }}
        >
          {/* A press on the card is not a press outside it. */}
          <Pressable
            testID='shell-user-menu-popover'
            onPress={() => {}}
            style={[
              anchor ?? {},
              {
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: tokens.color.border.subtle,
                backgroundColor: tokens.color.bg["1"],
                paddingVertical: 8,
              },
              elevation(2),
            ]}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 12,
                paddingVertical: 8,
              }}
            >
              <Avatar name={name} color={accent[500]} />
              <View style={{ marginLeft: 10, flex: 1 }}>
                <Text variant='body' weight='semibold' numberOfLines={1}>
                  {name}
                </Text>
                {serverName ? (
                  <Text variant='micro' tone='tertiary' numberOfLines={1}>
                    {serverName}
                  </Text>
                ) : null}
              </View>
            </View>

            <View
              style={{
                height: 1,
                backgroundColor: tokens.color.border.subtle,
                marginVertical: 6,
              }}
            />

            <MenuRow
              icon='settings'
              label={t("tabs.settings")}
              testID='shell-user-menu-settings'
              onPress={() => go("/(auth)/(tabs)/(home)/settings")}
            />
            <MenuRow
              icon='signOut'
              label={t("shell.sign_out")}
              testID='shell-user-menu-sign-out'
              danger
              onPress={signOut}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
};

/**
 * The node's own name, from the marker the gateway splices into `index.html`.
 *
 * Read straight off `window`: the marker is a
 * synchronous fact about this request (see `gateway/web.rs`), it never changes
 * while the page lives, and `hooks/useNodeContext.ts` — WP3's file — does not
 * exist yet. When it does, this becomes one line calling it.
 */
const nodeName = (): string | undefined => {
  if (Platform.OS !== "web") return undefined;
  const marker = (globalThis as { __STINGSTREAM_NODE__?: unknown })
    .__STINGSTREAM_NODE__ as { nodeName?: unknown } | undefined;
  return typeof marker?.nodeName === "string" && marker.nodeName.length > 0
    ? marker.nodeName
    : undefined;
};

/** Initials on the accent — no avatar image, so no request and no broken box. */
const Avatar: React.FC<{ name: string; color: string }> = ({ name, color }) => (
  <View
    style={{
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: AVATAR_SIZE / 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: color,
    }}
  >
    <Text variant='caption' weight='bold' tone='onAccent'>
      {initials(name)}
    </Text>
  </View>
);

/** "Dan Patten" -> "DP", "dan" -> "D", "" -> "?". */
export const initials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
};

const MenuRow: React.FC<{
  icon: IconName;
  label: string;
  testID: string;
  danger?: boolean;
  onPress: () => void;
}> = ({ icon, label, testID, danger = false, onPress }) => {
  const { accentName } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  return (
    <Pressable
      testID={testID}
      accessibilityRole='menuitem'
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          flexDirection: "row",
          alignItems: "center",
          minHeight: 40,
          paddingHorizontal: 12,
          backgroundColor: hovered ? tokens.color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, accentName) }
            : null),
        } as ViewStyle
      }
    >
      <Icon name={icon} size={18} tone={danger ? "danger" : "secondary"} />
      <Text
        variant='body'
        tone={danger ? "danger" : "primary"}
        style={{ marginLeft: 10 }}
      >
        {label}
      </Text>
    </Pressable>
  );
};
