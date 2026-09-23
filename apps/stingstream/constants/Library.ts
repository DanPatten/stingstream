/**
 * How the app follows a library scan, and how it asks for posters.
 *
 * Both are about the same moment: somebody has just added a folder of movies and
 * is watching the home page fill in.
 */

/**
 * How often scan state is read while a scan is running.
 *
 * Fast enough that the percentage moves while you watch it. The two endpoints
 * behind it (`/Library/VirtualFolders`, `/ScheduledTasks`) read in-memory state
 * on the server and cost nothing next to the scan itself.
 */
export const SCAN_POLL_ACTIVE_MS = 2_000;

/**
 * How often scan state is read while nothing is scanning.
 *
 * A scan starting is also pushed over the socket (`RefreshProgress`, sent to
 * administrators only), which refetches at once, so this is the fallback for a
 * socket that is down rather than the way a scan is noticed.
 */
export const SCAN_POLL_IDLE_MS = 30_000;

/**
 * How often the item lists are refetched while a scan is running.
 *
 * The server's own `LibraryChanged` push cannot be relied on for this. It is
 * debounced by `LibraryUpdateDuration` (30 s) and the timer restarts on every
 * change (`LibraryChangedNotifier.OnLibraryChange`), so during a scan that keeps
 * finding things it does not fire until the scan is over. That is why posters
 * seemed to arrive all at once, minutes late.
 */
export const SCAN_REFRESH_ITEMS_MS = 6_000;

/**
 * The widths a server poster is requested at, ascending.
 *
 * The media server resizes each poster once per distinct size and caches the
 * result. Measured on node 1 through the gateway: a cold resize took about
 * 85 ms at 240 wide, 120 ms at 330, 350 ms at 630 and 500 ms at 1100, and
 * slower with the CPU busy (570 ms at 650 with builds running beside it); a
 * warm one about 10 ms. Asking
 * for exactly twice the card's width meant a library grid, whose cards are the
 * window width divided by the column count, asked for a new size at nearly
 * every window width, and never for the size the home rows had already warmed.
 * Rounding up to a short ladder makes every screen share a few sizes.
 */
export const POSTER_REQUEST_WIDTHS = [
  240, 320, 400, 480, 640, 800, 1000, 1280, 1600, 1920,
] as const;
