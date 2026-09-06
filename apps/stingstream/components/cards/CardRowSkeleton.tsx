import { SkeletonRow } from "@/components/common/Skeleton";
import { type CardKind, defaultTextPlacement } from "./CardData";

/**
 * Placeholder cards shown while a row loads, sized like the real ones.
 *
 * A thin wrapper over WP0's `SkeletonRow` so a row's loading state and its
 * loaded state agree on one thing: a card that puts its title under the artwork
 * reserves the text lines here too, or the page jumps by that much the moment
 * the cards arrive.
 */
export const CardRowSkeleton: React.FC<{
  kind: CardKind;
  count?: number;
}> = ({ kind, count = 3 }) => (
  <SkeletonRow
    kind={kind}
    count={count}
    withLabels={defaultTextPlacement(kind) === "below"}
  />
);
