import { Redirect } from "expo-router";

/**
 * "Server settings" is gone, and it is the row this whole restructure was about.
 *
 * One click hid six unrelated pages, and its own subtitle had to list all six -- "Indexers,
 * download clients, quality profiles, root folders, naming, notifications". They are five
 * categories with addresses of their own now: Media services (indexers and download clients),
 * Quality & formats, Storage & libraries (root folders), Files & naming, and Notifications.
 * Indexers is the one most people came here for, so that is where this lands.
 */
export default function Moved() {
  return <Redirect href='/settings/services' />;
}
