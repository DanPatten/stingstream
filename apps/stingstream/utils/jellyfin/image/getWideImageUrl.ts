import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";

/** The rough shape of a Thumb/Primary image on a wide card — see `CARD_LAYOUTS.wide`. */
const WIDE_ASPECT_RATIO = 16 / 9;

/**
 * Landscape (16:9-ish) image for an item, as used by the continue-watching
 * cards: the Thumb when the item has one, with a failover to Primary.
 *
 * @param useEpisodePoster - Prefer the episode's own still over the series
 *   Thumb for episodes (the `useEpisodeImagesForNextUp` setting).
 * @param width - The card's rendered width. When given, this replaces
 *   `fillHeight` (derived from the wide aspect ratio) so the requested image
 *   scales with the card instead of always coming back at a fixed size.
 */
export const getWideImageUrl = ({
  api,
  item,
  useEpisodePoster = false,
  fillHeight = 389,
  quality = 80,
  width,
}: {
  api?: Api | null;
  item?: BaseItemDto | null;
  useEpisodePoster?: boolean;
  fillHeight?: number;
  quality?: number;
  width?: number;
}): string | undefined => {
  if (!api || !item?.Id) return undefined;

  const resolvedFillHeight = width
    ? Math.round(width / WIDE_ASPECT_RATIO)
    : fillHeight;
  const primary = `${api.basePath}/Items/${item.Id}/Images/Primary?fillHeight=${resolvedFillHeight}&quality=${quality}`;
  const thumb = (itemId: string, tag: string) =>
    `${api.basePath}/Items/${itemId}/Images/Thumb?fillHeight=${resolvedFillHeight}&quality=${quality}&tag=${tag}`;

  if (item.Type === "Episode") {
    if (useEpisodePoster) return primary;

    // Matched pair: the parent that owns the Thumb (ParentThumbItemId), not the
    // backdrop owner — otherwise the Thumb tag is requested on the wrong item → black.
    if (item.ParentThumbItemId && item.ParentThumbImageTag) {
      return thumb(item.ParentThumbItemId, item.ParentThumbImageTag);
    }

    return primary;
  }

  if (item.ImageTags?.Thumb) {
    return thumb(item.Id, item.ImageTags.Thumb);
  }

  return primary;
};
