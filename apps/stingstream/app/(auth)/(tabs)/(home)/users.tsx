import { Redirect } from "expo-router";

/**
 * `/users` is Settings -> Users & access now.
 *
 * It was promoted to a section of its own when it stopped being a tab inside Sharing, and that was
 * right at the time: who can sign in is the question administrators arrive with most. It is still
 * that question, but it is a question about configuring the server rather than about browsing it,
 * and a sidebar row a member never sees is a row that only says "you are not an administrator".
 *
 * The address stays as a redirect because it has been in the sidebar, in the phone's More list and
 * in the screenshot flows, and a URL that used to work should not simply stop.
 */
export default function UsersMoved() {
  return <Redirect href='/settings/users' />;
}
