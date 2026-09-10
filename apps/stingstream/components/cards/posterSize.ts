/**
 * Asking a metadata provider for a poster the size we are actually going to draw.
 *
 * The arrs hand us whatever their lookup returned, which for TMDB is
 * `/t/p/original/` and for TVDB is the full-size banner. Measured over one
 * 40-result Requests search on a real node, that is 23,162 KB of poster to fill
 * 56x84 boxes: 579 KB each, for something drawn 168 pixels wide on a 3x screen.
 * The same posters at the right size are 1,567 KB, which is the whole point of
 * this module.
 *
 * Both providers expose smaller variants through the URL alone, so this is a
 * string rewrite and nothing else. No request, no cache, no state.
 *
 * It lives beside `CardArtwork` because that component is the one place that
 * knows how wide a poster is about to be drawn, and the answer differs per
 * screen: 56 in a Requests row, 220 in the details header. A rewrite on the
 * node side could not tell those apart.
 */

/**
 * The TMDB widths worth asking for, ascending.
 *
 * TMDB serves any documented size for any file path, so picking one is always
 * safe. These five cover everything the app draws; above the largest we fall
 * back to `original`, which is what a backdrop or a very wide tile wants.
 */
const TMDB_WIDTHS = [154, 185, 342, 500, 780] as const;

/**
 * Roughly how wide TVDB's `_t` thumbnail is.
 *
 * TVDB has no size ladder — there is the file and there is `_t`, and `_t` is
 * about 210px on the long edge for a poster. So the choice is binary: below
 * this, the thumbnail is enough and costs a fifth as much; above it, only the
 * full file will do.
 */
const TVDB_THUMB_WIDTH = 210;

const isTmdb = (host: string): boolean => host === "image.tmdb.org";

const isTvdb = (host: string): boolean =>
  host === "artworks.thetvdb.com" || host === "www.thetvdb.com";

/**
 * The poster URL to actually request, given how wide it will be drawn.
 *
 * Returns the input unchanged for anything it does not recognise, which
 * deliberately includes Jellyfin's own `/Items/{id}/Images/...` URLs: those
 * already carry `fillWidth` and are sized by the server, and a second opinion
 * here would only fight it. Same for `data:` URIs, relative paths, and any
 * provider we have not taught it about.
 *
 * Idempotent. A URL that has already been through this comes out the same, so
 * it is safe on a value that may or may not have been rewritten already, and
 * the result stays usable as an image cache key.
 *
 * @param url The provider URL, or null when the item has no artwork.
 * @param displayWidth Logical width the image will occupy, in points.
 * @param dpr Device pixel ratio, from `PixelRatio.get()`.
 */
export function sizedPosterUrl(
  url: string | null | undefined,
  displayWidth: number,
  dpr: number,
): string | null {
  if (!url) return null;

  // A poster is never drawn at zero, and a nonsense ratio should not silently
  // downgrade every image on the screen. Both fall back to "as given".
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  if (!Number.isFinite(displayWidth) || displayWidth <= 0) return url;
  const target = Math.ceil(displayWidth * scale);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL: a data: URI that failed to parse, a relative path,
    // or something malformed. Whatever it is, it is not ours to rewrite.
    return url;
  }

  if (isTmdb(parsed.hostname)) {
    return withTmdbWidth(parsed, target);
  }

  if (isTvdb(parsed.hostname)) {
    return withTvdbVariant(parsed, target);
  }

  return url;
}

/**
 * Swap the size segment of a TMDB path.
 *
 * The shape is `/t/p/{size}/{file}`, and the size segment is the only thing
 * that moves. Rewriting by segment index rather than by string replacement is
 * what keeps this idempotent: the incoming size may already be `w185`, and
 * matching on `original` alone would then quietly do nothing.
 */
function withTmdbWidth(parsed: URL, target: number): string {
  const segments = parsed.pathname.split("/");
  // ["", "t", "p", "{size}", "{file}"] — anything shorter is not an image path.
  if (segments.length < 5 || segments[1] !== "t" || segments[2] !== "p") {
    return parsed.toString();
  }

  const width = TMDB_WIDTHS.find((w) => w >= target);
  segments[3] = width ? `w${width}` : "original";
  parsed.pathname = segments.join("/");
  return parsed.toString();
}

/**
 * Add or remove TVDB's `_t` thumbnail suffix.
 *
 * Stripping an existing `_t` before deciding is what makes this idempotent in
 * both directions: the same URL asked for at 56px and then at 220px gives the
 * thumbnail and then the full file, rather than accumulating suffixes.
 */
function withTvdbVariant(parsed: URL, target: number): string {
  const match = parsed.pathname.match(/^(.*?)(_t)?(\.[A-Za-z0-9]+)$/);
  if (!match) return parsed.toString();

  const [, stem, , extension] = match;
  parsed.pathname =
    target <= TVDB_THUMB_WIDTH ? `${stem}_t${extension}` : `${stem}${extension}`;
  return parsed.toString();
}
