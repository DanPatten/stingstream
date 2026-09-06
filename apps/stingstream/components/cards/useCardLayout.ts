import { Platform } from "react-native";
import { useBreakpointName } from "@/hooks/useBreakpoint";
import {
  CARD_LAYOUTS,
  type CardKind,
  type ResolvedCardLayout,
} from "./CardData";

/**
 * Resolves a card kind's geometry for the current window.
 *
 * `cardWidth` and `gridMinCardWidth` grow with the breakpoint (a card on a
 * 1440px browser tab is not the same size as one on a phone); everything else
 * in `CARD_LAYOUTS[kind]` is already a single number and passes through
 * unchanged.
 *
 * TV defensively resolves to `compact` rather than following
 * `useBreakpointName()` (which reports `expanded` for every television, since
 * a 10-foot UI is the most spacious layout this app has). TV never renders
 * these cards — it has its own `constants/TVCardLayouts.ts` — so this is a
 * fallback for an accidental import, not a real code path.
 */
export function useCardLayout(kind: CardKind): ResolvedCardLayout {
  const windowBreakpoint = useBreakpointName();
  const breakpoint = Platform.isTV ? "compact" : windowBreakpoint;
  const layout = CARD_LAYOUTS[kind];

  return {
    ...layout,
    cardWidth: layout.cardWidth[breakpoint],
    gridMinCardWidth: layout.gridMinCardWidth[breakpoint],
  };
}
