import { Redirect } from "expo-router";

/**
 * Domains is part of Remote access now.
 *
 * It was a page of its own beside Network & remote access until 2026-09-13, and the two answered
 * one question: how anybody reaches this server. Kept as a redirect so bookmarks and older invite
 * links still arrive somewhere.
 */
export default function Moved() {
  return <Redirect href='/settings/network' />;
}
