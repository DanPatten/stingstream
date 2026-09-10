import { Redirect } from "expo-router";

/**
 * Moved into Servers, which is now the one page about servers.
 *
 * It is a section of that page rather than a row beside it, and still ungated: the block is about
 * the server the *reader* runs, which is the one federation decision somebody on another person's
 * node makes for themselves.
 */
export default function Moved() {
  return <Redirect href='/settings/servers' />;
}
