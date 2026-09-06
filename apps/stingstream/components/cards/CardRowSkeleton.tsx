import { View } from "react-native";
import { tokens } from "@/constants/theme";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import type { CardKind } from "./CardData";
import { useCardLayout } from "./useCardLayout";

/**
 * Placeholder cards shown while a row loads, sized like the real ones —
 * including the room the row reserves under each card for its title, so the
 * page does not jump by two text lines the moment the row arrives.
 */
export const CardRowSkeleton: React.FC<{
  kind: CardKind;
  count?: number;
  /** What the row reserves under each card. See `CardRow`'s `footerHeight`. */
  belowArtwork?: number;
}> = ({ kind, count = 3, belowArtwork = 0 }) => {
  const layout = useCardLayout(kind);
  const { gutter } = useBreakpoint();

  return (
    <View
      style={{
        flexDirection: "row",
        gap: layout.spacing,
        // The page's gutter, the same inset the loaded row uses.
        paddingHorizontal: gutter,
        paddingVertical: layout.verticalPadding,
        paddingBottom: layout.verticalPadding + belowArtwork,
      }}
    >
      {Array.from({ length: count }, (_, i) => i).map((i) => (
        <View
          key={i}
          style={{
            width: layout.cardWidth,
            height: layout.cardWidth / layout.aspectRatio,
            borderRadius: layout.cornerRadius,
            backgroundColor: tokens.color.bg["1"],
          }}
        />
      ))}
    </View>
  );
};
