import { LibrarySection } from "./LibrarySection";

/**
 * Manage → Movies.
 *
 * The screen itself is `LibrarySection`: since M4.5 both halves of Manage do
 * search-as-you-type, a monitor toggle, a quality-profile change and a delete,
 * and the only differences left are four words and whether a title is keyed on
 * a TMDB or a TVDB id. This wrapper stays so the file map in `docs/UI.md` still
 * points at something.
 */
export function MoviesSection() {
  return <LibrarySection kind='movie' />;
}
