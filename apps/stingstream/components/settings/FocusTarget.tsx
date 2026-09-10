import { useLocalSearchParams } from "expo-router";
import { type PropsWithChildren, useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { SETTINGS_FOCUS_HIGHLIGHT_MS } from "@/constants/Settings";
import { radius } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

/**
 * The block the settings search just sent you to.
 *
 * `?focus=<id>` arrives on the URL from `settingsSearchIndex`; the block whose
 * id matches scrolls itself into view and wears an accent ring for a moment.
 * Landing on the right *page* is only half of "typing transcode takes you to
 * the hardware-acceleration toggle" — on a page with five groups of rows, the
 * other half is saying which one.
 *
 * A screen can also point at its own block, which is what `?focusNonce=` is
 * for — see the comment on `targetToken` below.
 *
 * ## Why it scrolls itself instead of being scrolled
 *
 * The alternative is threading a `ScrollView` ref from `RefreshScreen` down
 * through every pane to every block, and measuring each block against it. On
 * web there is already a correct answer for this: react-native-web's `View` ref
 * *is* the DOM node, so `scrollIntoView` does the measuring, honours whichever
 * scroller actually contains the block, and cannot disagree with the layout.
 *
 * On a phone the ring appears without the scroll. That is the honest trade: the
 * search box at that width is on the settings list itself, so a result already
 * opens the page it lives on, and a page there is short enough that the block
 * is usually on screen. Threading the ref is what to do if that stops being
 * true.
 *
 * The ring is drawn and then removed rather than faded, because the app has no
 * color-transition primitive and a hand-rolled one here would be a third
 * animation vocabulary for a 1.6-second effect. It holds still either way,
 * which is what a reduced-motion setting asks for.
 */
export const FocusTarget: React.FC<
  PropsWithChildren<{
    /**
     * The `settingsSearchIndex` control ids this block holds.
     *
     * Several, usually. A block is a card of rows, and the search indexes the
     * rows — "encoder threads" and "hardware acceleration" are two things to
     * look for and one place to land.
     */
    id: string | readonly string[];
  }>
> = ({ id, children }) => {
  const { accent } = useTheme();
  const { focus, focusNonce } = useLocalSearchParams<{
    focus?: string;
    focusNonce?: string;
  }>();
  const ref = useRef<View>(null);
  const [lit, setLit] = useState(false);

  const targeted =
    focus !== undefined &&
    (Array.isArray(id) ? id.includes(focus) : id === focus);

  // One value standing for "this run of being targeted", so the effect below has a single
  // dependency that changes when it should re-fire. Arriving from the settings search sets
  // `?focus=` once and never touches it again, so `focus` alone is enough there. A button on the
  // *same* page as its target is the case that needs the nonce: pressing it a second time asks for
  // the same id, which does not change `focus`, so without this the ring and the scroll happen once
  // and every later press does nothing.
  const targetToken = targeted ? (focusNonce ?? "1") : null;

  useEffect(() => {
    if (targetToken === null) return;

    setLit(true);
    if (Platform.OS === "web") {
      const node = ref.current as unknown as HTMLElement | null;
      // Not every ref is a DOM node with this method — a test renderer's is
      // not — and a missing scroll is worse handled by throwing than by simply
      // not scrolling.
      node?.scrollIntoView?.({ block: "center" });
    }

    const timeout = setTimeout(
      () => setLit(false),
      SETTINGS_FOCUS_HIGHLIGHT_MS,
    );
    return () => clearTimeout(timeout);
  }, [targetToken]);

  return (
    <View
      ref={ref}
      testID={`settings-focus-${Array.isArray(id) ? id[0] : id}`}
      style={
        lit
          ? {
              borderWidth: 2,
              borderColor: accent[400],
              borderRadius: radius.md,
              // Cancels the border's own contribution to the layout, so a block
              // does not jump 2 px when the ring appears.
              margin: -2,
            }
          : null
      }
    >
      {children}
    </View>
  );
};
