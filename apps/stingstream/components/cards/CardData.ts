import type { Api } from "@jellyfin/sdk";
import type { BaseItemDto } from "@jellyfin/sdk/lib/generated-client/models";
import { getItemProgressPercentage } from "@/components/common/ProgressBar";
import { type BreakpointName, typeStyle } from "@/constants/theme";
import { getPortraitImageUrl } from "@/utils/jellyfin/image/getPortraitImageUrl";
import { getWideImageUrl } from "@/utils/jellyfin/image/getWideImageUrl";

/** One card. Everything is prebuilt here; the card view is presentational. */
export type CardData = {
  /** Item id, handed back by the press handlers. */
  id: string;
  title: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  /**
   * Screen-reader label for the artwork — "Title" or "Title (Year)". Falls
   * back to `title` at the render site when unset, so every caller that
   * doesn't go through `buildItemCards` still gets an accessible image
   * instead of a silently blank `alt` on web.
   */
  imageAlt?: string | null;
  /** Watch progress in 0...1. Draws the progress bar when > 0. */
  progress?: number;
  /**
   * Episodes left on a series/box set — draws the count badge when > 0.
   *
   * Deliberately only aggregates. A single unwatched movie used to draw a bare
   * accent dot in the same corner, which said nothing a viewer could read (a
   * whole library of films is unwatched; a dot on every poster is noise). A
   * count on a series does say something: how much of it is left.
   */
  unplayedCount?: number;
  /**
   * Text for the corner pill when it isn't an unplayed count — the number of
   * downloaded episodes, say. Takes precedence over `unplayedCount`.
   */
  badgeLabel?: string | null;
  /**
   * A third line, after the subtitle — a runtime, a file size. Only a string
   * derivable from the item belongs here; anything that has to subscribe to
   * something is a slot the screen fills in.
   */
  detail?: string | null;
  /** Faded back because another card in the row is the current one. */
  dimmed?: boolean;
  /**
   * Overrides the kind's aspect ratio, for items whose artwork isn't the shape
   * the container expects — an album among posters, say.
   */
  aspectRatio?: number;
  /**
   * What to draw when there is no artwork — see `CardPlaceholder`. Defaults to
   * `unknown`, which still gets a real tile rather than an empty rectangle.
   */
  placeholder?: CardPlaceholder;
};

export type CardKind = "wide" | "portrait" | "rowWide";

/**
 * The shape of thing a card stands for, for the tile drawn when its artwork is
 * missing. Coarser than `BaseItemDto["Type"]` on purpose: the placeholder only
 * has room for one glyph, and "which kind of media is this" is all a viewer can
 * read off it at 118 px wide.
 */
export type CardPlaceholder =
  | "movie"
  | "series"
  | "episode"
  | "person"
  | "music"
  | "collection"
  | "playlist"
  | "folder"
  | "photo"
  | "book"
  | "unknown";

/**
 * Per-item extras a screen hangs on a card. The card never knows what they
 * mean — it only reserves the space. Memoize these at the call site: a new
 * function identity re-renders every cell in the list.
 */
export type CardSlots = {
  /** Layer over the artwork: a play glyph, a status icon. */
  overlay?: (card: CardData) => React.ReactNode;
  /** The right-hand end of a list row: a download button, a menu. */
  trailing?: (card: CardData) => React.ReactNode;
  /** Below the metadata: an overview, a file size. */
  footer?: (card: CardData) => React.ReactNode;
};

/** Breathing room above/below the cards so their shadow isn't clipped. */
export const CARD_VERTICAL_PADDING = 6;

/** A size that changes with the window — compact phone, medium tablet, expanded desktop. */
export type CardWidthByBreakpoint = {
  compact: number;
  medium: number;
  expanded: number;
};

/**
 * Card geometry — the single source of truth for every kind of row, so a card
 * and the space reserved for it can never drift apart.
 *
 * `cardWidth` and `gridMinCardWidth` are per breakpoint: a fixed row grows its
 * cards at wider windows instead of just showing more of the same size, and a
 * grid's minimum cell shrinks a little less than the row card does, so a grid
 * fills the page with whole cards rather than leaving a half-column gap.
 * Resolve either one for the current window with `useCardLayout` — reading
 * `CARD_LAYOUTS[kind].cardWidth` directly gets you the breakpoint object, not
 * a number.
 */
export const CARD_LAYOUTS: Record<
  CardKind,
  {
    cardWidth: CardWidthByBreakpoint;
    gridMinCardWidth: CardWidthByBreakpoint;
    aspectRatio: number;
    cornerRadius: number;
    spacing: number;
    contentInset: number;
    frostFraction: number;
    verticalPadding: number;
  }
> = {
  // Landscape stills.
  wide: {
    cardWidth: { compact: 200, medium: 260, expanded: 300 },
    gridMinCardWidth: { compact: 110, medium: 140, expanded: 160 },
    aspectRatio: 16 / 9,
    cornerRadius: 14,
    spacing: 10,
    contentInset: 16,
    frostFraction: 0.45,
    verticalPadding: CARD_VERTICAL_PADDING,
  },
  // Portrait posters. The title sits *below* the artwork (see
  // `defaultTextPlacement`), so the poster is never painted over; the frost
  // fraction only applies to a caller that forces `textPlacement="over"`.
  portrait: {
    cardWidth: { compact: 118, medium: 150, expanded: 170 },
    gridMinCardWidth: { compact: 110, medium: 140, expanded: 160 },
    aspectRatio: 10 / 15,
    cornerRadius: 12,
    spacing: 10,
    contentInset: 16,
    frostFraction: 0.33,
    verticalPadding: CARD_VERTICAL_PADDING,
  },
  // The thumbnail on a list row, where the text sits beside the artwork
  // rather than on it — so no frost band.
  rowWide: {
    cardWidth: { compact: 128, medium: 144, expanded: 160 },
    gridMinCardWidth: { compact: 110, medium: 140, expanded: 160 },
    aspectRatio: 16 / 9,
    cornerRadius: 8,
    spacing: 12,
    contentInset: 16,
    frostFraction: 0,
    verticalPadding: 0,
  },
};

/** A kind's geometry with `cardWidth`/`gridMinCardWidth` resolved to one number — see `useCardLayout`. */
export type ResolvedCardLayout = Omit<
  (typeof CARD_LAYOUTS)[CardKind],
  "cardWidth" | "gridMinCardWidth"
> & {
  cardWidth: number;
  gridMinCardWidth: number;
};

/**
 * Height a row of this kind occupies at its resolved width, shadow padding
 * included. `below` is whatever the card draws under its artwork — the title
 * block of a `textPlacement="below"` card, plus anything a footer slot adds.
 */
export const cardRowHeight = (layout: ResolvedCardLayout, below = 0) => {
  const { cardWidth, aspectRatio, verticalPadding } = layout;
  return cardWidth / aspectRatio + verticalPadding * 2 + below;
};

/**
 * Where a kind puts its title.
 *
 * Posters get it **below** the artwork, on the page surface: a poster already
 * has the title painted into the bitmap, so a second title over the art was two
 * overlapping text layers, and grey secondary text on an arbitrary photograph
 * has no contrast guarantee at all. Landscape stills keep the frosted band —
 * a still is not self-labelling, and a band on 16:9 art covers a third of a
 * shot rather than a third of a face.
 */
export const defaultTextPlacement = (kind: CardKind): "over" | "below" =>
  kind === "portrait" ? "below" : "over";

/** Gap between the artwork and the title below it. */
export const CARD_TEXT_GAP = 6;

/** How many lines a below-artwork title may wrap to before it ellipses. */
export const CARD_TITLE_LINES = 2;

/**
 * Height of the title block a `textPlacement="below"` card draws: the gap, two
 * lines of `caption` title, and one line of `micro` subtitle.
 *
 * A row has to reserve this before it renders — a horizontal `FlashList` is
 * given one height for every cell and cannot measure the text inside them — so
 * it is computed from the same type scale `Text` resolves at that breakpoint
 * rather than guessed at as a magic constant. Two title lines are always
 * reserved whether or not this particular title wraps, so a row of cards does
 * not jog up and down as one of them happens to be long.
 */
export const cardTextBlockHeight = (breakpoint: BreakpointName): number =>
  CARD_TEXT_GAP +
  typeStyle("caption", breakpoint).lineHeight * CARD_TITLE_LINES +
  typeStyle("micro", breakpoint).lineHeight;

/**
 * How many columns of at least `minCardWidth` fit in `availableWidth`, the
 * way CSS grid's `repeat(auto-fill, minmax(minCardWidth, 1fr))` would.
 *
 * Pulled out of `useCardGrid` so it's testable as plain arithmetic — no
 * window, no React — and so `cardLayout.test.ts` can pin the exact formula
 * bug 4 replaces (a hard-coded `screenWidth` switch that returned *fewer*
 * columns at >= 1500px than it did at 1000–1500px, because each branch's
 * threshold was picked independently rather than derived from one rule).
 * Never returns fewer than one column, even narrower than the minimum.
 */
export const autoGridColumns = (
  availableWidth: number,
  minCardWidth: number,
  spacing: number,
): number =>
  Math.max(
    1,
    Math.floor((availableWidth + spacing) / (minCardWidth + spacing)),
  );

/**
 * The second line under a title: which episode this is, or when it came out.
 * Exported so anything building cards outside `buildItemCards` — the offline
 * downloads, say — labels an item the same way.
 */
export const cardSubtitle = (item: BaseItemDto): string | null => {
  if (item.Type === "Episode") {
    return `S${item.ParentIndexNumber}:E${item.IndexNumber} - ${item.SeriesName ?? ""}`;
  }
  return item.ProductionYear ? String(item.ProductionYear) : null;
};

/**
 * The artwork's screen-reader label — "Title" or "Title (Year)". Exported so
 * anything building cards outside `buildItemCards` labels its artwork the
 * same way `Card`'s default (`card.imageAlt ?? card.title`) would.
 */
export const cardImageAlt = (item: BaseItemDto): string =>
  item.ProductionYear
    ? `${item.Name ?? ""} (${item.ProductionYear})`
    : (item.Name ?? "");

const isAggregate = (item: BaseItemDto) =>
  item.Type === "Series" || item.Type === "BoxSet";

/**
 * Which placeholder tile stands in for an item with no artwork.
 *
 * Exported alongside `cardSubtitle` and `cardImageAlt` so anything building
 * cards outside `buildItemCards` — the offline downloads, say — falls back to
 * the same tile rather than an empty rectangle.
 */
export const cardPlaceholder = (item: BaseItemDto): CardPlaceholder => {
  switch (item.Type) {
    case "Movie":
      return "movie";
    case "Series":
    case "Season":
      return "series";
    case "Episode":
      return "episode";
    case "Person":
      return "person";
    case "MusicAlbum":
    case "MusicArtist":
    case "Audio":
    case "MusicVideo":
      return "music";
    case "BoxSet":
      return "collection";
    case "Playlist":
      return "playlist";
    case "Folder":
    case "CollectionFolder":
    case "UserView":
      return "folder";
    case "Photo":
    case "PhotoAlbum":
      return "photo";
    case "Book":
    case "AudioBook":
      return "book";
    default:
      return "unknown";
  }
};

/** Anything that holds other items rather than being watchable itself. */
const isContainer = (item: BaseItemDto) =>
  item.Type === "Series" ||
  item.Type === "Season" ||
  item.Type === "BoxSet" ||
  item.Type === "Playlist" ||
  item.Type === "Folder" ||
  item.Type === "CollectionFolder" ||
  item.Type === "UserView" ||
  item.Type === "MusicAlbum" ||
  item.Type === "MusicArtist";

/**
 * Watch progress in 0...1, or 0 for anything that isn't a single watchable
 * thing. A container's PlayedPercentage describes some episode inside it, so a
 * bar across a series card would be claiming something it can't know — how far
 * through the series you are. The unplayed-episode badge says that instead.
 */
export const itemProgressFraction = (item: BaseItemDto): number =>
  isContainer(item) ? 0 : getItemProgressPercentage(item) / 100;

/**
 * Only these have a poster; an episode borrows its series', and a person has a
 * portrait headshot. Everything else a library can hold — albums, artists,
 * playlists, folders — has square artwork, and stretching it to 10:15 would
 * crop the cover.
 */
const hasPortraitArtwork = (item: BaseItemDto) =>
  item.Type === "Movie" ||
  item.Type === "Series" ||
  item.Type === "BoxSet" ||
  item.Type === "Episode" ||
  item.Type === "Person";

type BuildOptions = {
  api?: Api | null;
  kind: CardKind;
  /** Prefer the episode's own still over the series thumbnail. */
  useEpisodePoster?: boolean;
  /** Item to keep at full opacity; every other card is faded back. */
  selectedId?: string | null;
  /**
   * The width the card will actually render at, so the image request matches
   * it (capped at 2x for pixel density) instead of always asking for a fixed
   * default size regardless of how big the card ends up being. Omit to keep
   * the helpers' own defaults.
   */
  cardWidth?: number;
};

/** Never request more image than 2x the card's own rendered width. */
const imageRequestWidth = (cardWidth: number | undefined) =>
  cardWidth ? Math.round(cardWidth * 2) : undefined;

/**
 * `BaseItemDto` → card. The one place the labels, image selection and badge
 * rules live, so every row says the same thing about the same item.
 */
export function buildItemCards(
  items: BaseItemDto[],
  { api, kind, useEpisodePoster = false, selectedId, cardWidth }: BuildOptions,
): CardData[] {
  if (!api) return [];

  const width = imageRequestWidth(cardWidth);

  return items.flatMap((item) => {
    if (!item.Id) return [];

    const subtitle = cardSubtitle(item);

    const unplayed = item.UserData?.UnplayedItemCount ?? 0;
    const imageUrl =
      kind === "portrait"
        ? getPortraitImageUrl({ api, item, width })
        : getWideImageUrl({ api, item, useEpisodePoster, width });

    const progress = itemProgressFraction(item);
    const unplayedCount =
      isAggregate(item) && !item.UserData?.Played ? unplayed : 0;
    const dimmed = selectedId != null && item.Id !== selectedId;
    // Only portrait rows and grids mix in items without a poster.
    const aspectRatio =
      kind === "portrait" && !hasPortraitArtwork(item) ? 1 : undefined;

    return [
      {
        id: item.Id,
        title: item.Name ?? "",
        subtitle,
        imageUrl,
        imageAlt: cardImageAlt(item),
        progress,
        unplayedCount,
        dimmed,
        aspectRatio,
        placeholder: cardPlaceholder(item),
      },
    ];
  });
}
