import { Redirect } from "expo-router";

/**
 * "Libraries & transcoding" held three unrelated things and is split in three: libraries are
 * Storage & libraries, transcoding is Transcoding & hardware, and the server's log files are Logs
 * & status. This lands on the first of them.
 */
export default function Moved() {
  return <Redirect href='/settings/storage' />;
}
