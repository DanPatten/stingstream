import { LibrarySection } from "./LibrarySection";

/** Manage → Series. See `MoviesSection` for why this is a wrapper. */
export function SeriesSection() {
  return <LibrarySection kind='series' />;
}
