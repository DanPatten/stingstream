import { Redirect } from "expo-router";

/**
 * "Server status" and the server log viewer are two tabs of one page now: nobody reads one without
 * wanting the other, since the status says a child is unhealthy and the log says why.
 */
export default function Moved() {
  return <Redirect href='/settings/diagnostics?tab=status' />;
}
