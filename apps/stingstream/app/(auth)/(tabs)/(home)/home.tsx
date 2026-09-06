import { Redirect } from "expo-router";

/**
 * `/home` — an alias for `/`.
 *
 * Home is the one section whose address is the root, and it has to stay there:
 * `(home)/index` is what a bare launch resolves to, and its `anchor` is what
 * keeps the app booting into Home rather than into the library (see the note in
 * `_layout.tsx`). So unlike the other sections this one redirects rather than
 * rendering, and `/home` is a synonym somebody can type.
 */
export default function HomeAlias() {
  return <Redirect href='/' />;
}
