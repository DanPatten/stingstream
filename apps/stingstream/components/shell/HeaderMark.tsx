import { Platform, View } from "react-native";
import { StingStreamMark } from "@/components/brand";

/**
 * The app's identity in a phone header.
 *
 * Dan's pass-01 note (F-13): "a standard app mark belongs in the top-left
 * corner, even if it is just the S for now" — every top-level screen on a phone
 * was headed by a bare word with nothing saying which app it belonged to. The
 * mark goes in `headerLeft` because that is the slot the platform lays out at
 * the leading edge, ahead of the title, on both iOS and Android; on web wide
 * the sidebar carries the wordmark instead and this never renders.
 *
 * Mono white rather than the teal gradient: a header already has an accent in
 * it (the back chevron, an action), and a second one at 28 px reads as a
 * sticker rather than as the app's name.
 */

/** F-13 asks for "~28 px"; the header is 56, so the mark is half its height. */
export const HEADER_MARK_SIZE = 28;

/**
 * Gap between the mark and the title.
 *
 * Same reason `HeaderButton` carries one on Android: react-native-screens
 * clears the Toolbar's `contentInsetStartWithNavigation` as soon as a left
 * subview is present, and react-native-web's header lays the two out as
 * neighbours in a row — so without this the title sits flush against the mark.
 * iOS mounts the title in its own centre view and needs nothing.
 */
const TITLE_GAP = 12;

/**
 * Leading inset, because the header does not supply one.
 *
 * A left subview costs the Android Toolbar its content inset, and the web
 * header never had one, so the mark would sit hard against the edge of the
 * screen — the one place in the app where nothing else does. 16 is the compact
 * gutter, which is where a header title starts when there is no left view at
 * all. iOS lays out bar button items against its own margin and needs nothing.
 */
const LEADING_INSET = 16;

export const HeaderMark: React.FC = () => (
  <View
    testID='header-mark'
    // Decorative: the screen title next to it already says where you are, and
    // a mark announced as "StingStream" on every screen is noise in a
    // screen reader.
    accessibilityElementsHidden
    importantForAccessibility='no-hide-descendants'
    style={{
      height: HEADER_MARK_SIZE,
      width: HEADER_MARK_SIZE,
      alignItems: "center",
      justifyContent: "center",
      marginLeft: Platform.OS === "ios" ? 0 : LEADING_INSET,
      marginRight: Platform.OS === "ios" ? 0 : TITLE_GAP,
    }}
  >
    <StingStreamMark size={HEADER_MARK_SIZE} variant='mono' />
  </View>
);

export default HeaderMark;
