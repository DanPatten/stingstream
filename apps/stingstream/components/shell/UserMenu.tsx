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
import { elevation, radius, rgba, webFocusRing } from "@/constants/theme";
import useRouter from "@/hooks/useAppRouter";
import { useFocusVisible } from "@/hooks/useFocusVisible";
import { useServerName } from "@/hooks/useServerName";
import { useTheme } from "@/hooks/useTheme";
import { useJellyfin, userAtom } from "@/providers/JellyfinProvider";

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
 * Who you are signed in as, and the way out.
 *
 * A popover rather than `Dialog`: signing out is a pointer gesture anchored to
 * an avatar, and a centred modal card over a dimmed page for one row reads as
 * an interruption. It keeps `Dialog`'s manners though —
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
  const { accent, color } = useTheme();

  const router = useRouter();

  const triggerRef = useRef<View>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<ViewStyle | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  /**
   * Closing hides the card but keeps the last anchor.
   *
   * `animationType="fade"` keeps the card mounted for the length of the fade
   * out, and an anchor cleared on the way out took `position: absolute` with
   * it: for those few frames the card fell back into flow and painted at the
   * top of the scrim, which is the flash Dan saw when clicking away. The
   * position it had while it was open is the right one to fade out from, and
   * the next open overwrites it before anything is visible.
   */
  const close = useCallback(() => setIsOpen(false), []);

  /**
   * Where the card goes when nothing has been measured yet.
   *
   * The trigger is the row at the foot of the sidebar, so "just above the
   * bottom left corner" is right within a few pixels — and, unlike a measured
   * position, it always exists. `measureInWindow` can call back with four
   * zeros before the node is laid out, and when it did the card opened at
   * `top: 8, left: 12` and painted the account over the wordmark and the first
   * nav rows: exactly the overlap Dan photographed. Opening somewhere sensible
   * and *then* refining is the shape that cannot produce that frame.
   */
  const fallbackAnchor = useCallback(
    (): ViewStyle => ({
      position: "absolute",
      width: MENU_WIDTH,
      bottom: 12,
      left: 12,
    }),
    [],
  );

  const open = useCallback(() => {
    setAnchor(fallbackAnchor());
    setIsOpen(true);
    triggerRef.current?.measureInWindow((x, y, width, height) => {
      // Four zeros means "not laid out yet", not "the top left corner".
      if (width <= 0 || height <= 0) return;
      const window = Dimensions.get("window");
      const below = y + height + 8;
      // The sidebar's copy sits at the bottom of the page, so the card has to
      // be able to open upwards; a trigger with room underneath drops down.
      const flip = below + MENU_HEIGHT_ESTIMATE > window.height;
      setAnchor({
        position: "absolute",
        width: MENU_WIDTH,
        top: flip ? undefined : below,
        bottom: flip ? Math.max(12, window.height - y + 8) : undefined,
        left: Math.min(
          Math.max(12, x + width - MENU_WIDTH),
          Math.max(12, window.width - MENU_WIDTH - 12),
        ),
      });
    });
  }, [fallbackAnchor]);

  // Escape closes, the way every other menu on the web does.
  useEffect(() => {
    if (!isOpen || Platform.OS !== "web") return;
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
  }, [isOpen, close]);

  const name = user?.Name ?? "";
  const serverName = useServerName();

  const signOut = useCallback(() => {
    close();
    void logout();
  }, [close, logout]);

  // Who you are is also the way to the screen where you change it.
  const openProfile = useCallback(() => {
    close();
    router.push("/settings/profile");
  }, [close, router]);

  return (
    <View>
      <Pressable
        ref={triggerRef}
        testID='shell-user-menu'
        accessibilityRole='button'
        accessibilityLabel={name || t("shell.account")}
        accessibilityState={{ expanded: isOpen }}
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
              hovered && variant === "row" ? color.bg["3"] : "transparent",
            ...(Platform.OS === "web"
              ? { cursor: "pointer", ...webFocusRing(showRing, color) }
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
        visible={isOpen}
        transparent
        animationType='fade'
        onRequestClose={close}
      >
        <Pressable
          accessibilityRole='button'
          accessibilityLabel={t("common.close")}
          onPress={close}
          // A scrim, not clear glass: without it the card reads as text
          // floating over the navigation rather than as a menu in front of it.
          style={{ flex: 1, backgroundColor: rgba("#000000", 0.4) }}
        >
          {/* A press on the card is not a press outside it. */}
          <Pressable
            testID='shell-user-menu-popover'
            onPress={() => {}}
            style={[
              anchor ?? fallbackAnchor(),
              {
                borderRadius: radius.md,
                borderWidth: 1,
                // bg2 and the stronger border, not bg1: the sidebar this opens
                // over is bg1, and a card the same color as the thing behind
                // it is not a card.
                borderColor: color.border.strong,
                backgroundColor: color.bg["2"],
                paddingVertical: 8,
              },
              elevation(2),
            ]}
          >
            <IdentityRow
              name={name}
              serverName={serverName}
              accent={accent[500]}
              onPress={openProfile}
            />

            <View
              style={{
                height: 1,
                backgroundColor: color.border.subtle,
                marginVertical: 6,
              }}
            />

            {/*
              No Settings row (pass-03 F-74). Settings is a permanent row at the
              foot of the sidebar, two centimetres from this menu, and a second
              way in from a popover that exists to say who you are signed in as
              only made the menu look fuller than it is.
            */}
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
 * The identity at the head of the card: press it to open your profile.
 *
 * Nothing else here needs a label. An avatar, a name and a hover state over a
 * row in a menu is the pattern every account menu on the web shares, and a
 * reader arrives already knowing where it goes.
 */
const IdentityRow: React.FC<{
  name: string;
  serverName: string | undefined;
  accent: string;
  onPress: () => void;
}> = ({ name, serverName, accent, onPress }) => {
  const { t } = useTranslation();
  const { color } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showRing = useFocusVisible(focused);

  return (
    <Pressable
      testID='shell-user-menu-profile'
      accessibilityRole='menuitem'
      accessibilityLabel={name || t("shell.account")}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={
        {
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: hovered ? color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, color) }
            : null),
        } as ViewStyle
      }
    >
      <Avatar name={name} color={accent} />
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
      <Icon name='chevronRight' size={14} tone='tertiary' />
    </Pressable>
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
  const { color } = useTheme();
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
          backgroundColor: hovered ? color.bg["3"] : "transparent",
          ...(Platform.OS === "web"
            ? { cursor: "pointer", ...webFocusRing(showRing, color) }
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
