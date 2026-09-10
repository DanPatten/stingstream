// WP-TOOLS UI iterate loop: the 15 screens shots.mjs captures, in order, and how to reach each
// one from a fresh page. See docs/UI-LOOP.md.
//
// F-36 (pass-02 critique, 2026-09-06): WP3 landed the firstrun-*/login-* testID contract on
// master. Every auth interaction below is driven by `[data-testid=...]`, not text/role/
// placeholder matching -- the old approach broke the moment two fields shared a fuzzy-matched
// accessible name ("Password" matches "Confirm password" too under Playwright's default substring
// name matching). Every navigate() function is still defensive: it throws a clear Error on
// failure rather than hanging, so shots.mjs can catch it, record "navigate-failed" as a finding,
// and move on to the next screen instead of losing the whole pass.
//
// TODO(WP1): RESOLVED (2026-09-06, master dbdee21). WP1 landed real per-section URLs and a clean
// testID contract, replacing both of the things pass-02's TODO was waiting on:
//   - Every section now has its own URL, not just Home and Settings: `/`, `/search`, `/library`,
//     `/favorites`, `/watchlists`, `/requests`, `/transfers`, `/links`, `/more`,
//     `/settings` (and its categories, `/settings/<key>`), `/sessions`. `/home` redirects to
//     `/`, and so do `/manage` (folded into Requests) and `/users` (a settings category since
//     the sidebar's three bands landed). Every route group's `index`
//     used to collide at `/` (F-20/F-21: `/requests` etc. fell through to a `(libraries)/[id]`
//     catch-all and spun, hammering the server with a ~400-request storm) -- confirmed live this
//     pass that direct navigation to all of the above now lands on the right screen, not the
//     catch-all.
//   - The tab bar's testIDs are the clean, stable contract docs/UI-LOOP.md always asked for:
//     `tab-home|tab-search|tab-library|tab-requests|tab-more` inside `shell-tabbar` (the compact,
//     <768px navigator). The `tab-(home)`-style parenthesized ids (the literal Expo Router group
//     names) are gone -- confirmed live; querying for one now finds nothing.
//   - `tabTestID()` (apps/stingstream/components/shell/tabIcons.ts) is shared between the compact
//     tab bar AND the >=768px desktop sidebar, so the same `[data-testid="tab-requests"]` selector
//     finds the right clickable element at every viewport this file drives -- it is just a
//     different container (`shell-tabbar` vs the sidebar) depending on width. Read
//     apps/stingstream/components/shell/buildSidebarItems.ts (buildSidebarItems, read-only) to
//     confirm this before relying on it elsewhere: `tabItem()` is the one place both navigators'
//     rows come from.
//   - Settings and Sessions are not tab-group members (no `/(auth)/(tabs)/(x)` of their own), so
//     they get their own testIDs instead of a shared `tabTestID()`: `tab-settings` and
//     `more-sessions`, both of which appear in the desktop sidebar (buildSidebarItems, >=768px)
//     AND in the compact "More" screen (buildMoreItems, reached via `tab-more` -> `more-screen`,
//     <768px). Favorites/Watchlists/Custom-links/Transfers DO share `tabTestID()` with the
//     sidebar even inside the More screen (`tab-favorites`, `tab-watchlists`,
//     `tab-custom-links`, `tab-transfers`). See NAV, below, for the concrete map.
//   - `tab-users` and `more-users` are **gone**, and querying for either now finds nothing.
//     Users is a settings category (`settings-nav-users`, `/settings/users`); `/users` is kept
//     as a redirect. The desktop sidebar's own bands are browse (unlabelled), Requests (a rule,
//     no heading) and an administrator-only "Server" band holding Transfers and Sessions -- a
//     member's sidebar is browse and Requests and nothing else.
//   - The settings navigation has a testID per category, `settings-nav-<key>`, and it is the
//     same id in the >=1024px category column and in the compact settings list. See
//     SETTINGS_NAV, below.
//
// The breakpoint that decides sidebar-vs-compact-bar is 768px (apps/stingstream/hooks/
// useBreakpoint.ts: `compact` < 768 <= `medium` < 1280 <= `expanded`) -- so of this file's three
// VIEWPORTS, 1440 and 1024 get the sidebar (`isWebWide`) and 390 gets the compact bar + More
// screen. navByNav() below reads viewportWidth for exactly this reason.

export const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "390x844", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2, hasTouch: true },
];

const TIMEOUT = 15000;
const WEB_WIDE_MIN = 768; // apps/stingstream/hooks/useBreakpoint.ts: compact < 768 <= medium.

/** WP3's testID contract renders as `data-testid` on web (react-native-web's createDOMProps maps
 * `testID` -> `data-testid` directly onto the underlying DOM node) -- confirmed by reading
 * react-native-web's own source, not assumed. */
function byTestId(page, id) {
  return page.locator(`[data-testid="${id}"]`);
}

/** locator.isVisible() does NOT wait -- it is a synchronous, immediate check, unlike every other
 * Playwright action -- so calling it right after goto() races the SPA's own hydration and false-
 * negatives constantly (confirmed live, 2026-09-06). Use this instead of
 * `locator.isVisible({timeout})` anywhere a screen is optional. */
async function isVisibleSoon(locator, timeoutMs) {
  return locator.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true).catch(() => false);
}

/** Wait out whatever stands between `/login` and a card that can be driven.
 *
 * On a node-served page that is the **starting** card and nothing else: Part 6 made the address
 * step unreachable when the node marker is present (`components/login/loginPhase.ts`), so the only
 * thing to do is let the node finish coming up — which it says it is doing, and which on a fresh
 * install with the download managers on can take a minute or two.
 *
 * The address step is still handled, because this same flow is pointed at builds served by
 * something that is not a node. If it appears on a node-served page, that is the regression Part 6
 * exists to prevent, and `sweep.mjs` will see the wrong screen in the screenshot. */
async function connectIfNeeded(page, base) {
  const starting = byTestId(page, "login-server-starting");
  if (await isVisibleSoon(starting, 4000)) {
    // Generous: the app's own budget is 90 s, and giving up sooner would screenshot a card that
    // was about to move on by itself.
    await starting.waitFor({ state: "hidden", timeout: 120_000 }).catch(() => {});
  }

  const serverInput = byTestId(page, "login-server-url");
  if (await isVisibleSoon(serverInput, 4000)) {
    // <base>/jellyfin, not the bare origin: docs/UI-LOOP.md records a real bug where the bare
    // host:port hangs this step forever with no way back. Not this pass's bug to re-litigate.
    await serverInput.fill(new URL("/jellyfin", base).toString());
    await byTestId(page, "login-connect").click({ timeout: TIMEOUT }).catch(() => {});
  }
}

const DEFAULT_FIRSTRUN_USERNAME = "reviewer";
const DEFAULT_FIRSTRUN_PASSWORD = "StingStreamReview1"; // >= 8 chars, per setup.password_hint

/**
 * Clicks past the first-run welcome page, if one is showing.
 *
 * First run is two pages now: a welcome, then the admin-account form. Tolerant of both shapes on
 * purpose -- this file drives nodes built from older commits too, and "no welcome" is a node that
 * predates it rather than a failure.
 */
export async function dismissFirstRunWelcome(page) {
  const start = byTestId(page, "firstrun-welcome-start");
  if (!(await isVisibleSoon(start, 4000))) return false;
  await start.click({ timeout: TIMEOUT });
  return true;
}

/**
 * Drives the first-run screens (welcome, then testID firstrun-create-account) to completion. Per
 * the plan, a successful submit signs the app straight in (no separate login step) -- confirmed
 * live. Returns the credentials used, so the caller can persist them (--creds) for a later run
 * against the same, now-set-up node.
 */
export async function createFirstRunAccount(page, { base, username = DEFAULT_FIRSTRUN_USERNAME, password = DEFAULT_FIRSTRUN_PASSWORD } = {}) {
  await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await connectIfNeeded(page, base);
  await dismissFirstRunWelcome(page);

  const reached = await isVisibleSoon(byTestId(page, "firstrun-username"), TIMEOUT);
  if (!reached) {
    const alreadySetUp = await isVisibleSoon(byTestId(page, "login-username"), 2000);
    throw new Error(
      alreadySetUp
        ? "this node has already been set up (the login screen shows, not first-run) -- use --creds instead of --first-run"
        : "the first-run screen (firstrun-username) did not appear",
    );
  }

  await byTestId(page, "firstrun-username").fill(username);
  await byTestId(page, "firstrun-password").fill(password);
  // No confirm field: it was removed in Part 7 (7a38f62), and this line was still filling one.
  await byTestId(page, "firstrun-submit").click({ timeout: TIMEOUT });
  await byTestId(page, "firstrun-create-account").waitFor({ state: "detached", timeout: TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
  return { username, password };
}

/**
 * Signs in with an existing account (testIDs login-username/login-password/login-submit) --
 * for a node whose first-run setup is already complete. Throws a clear, distinguishing error if
 * the first-run screen shows instead, so a caller that meant --first-run finds out why rather than
 * timing out on the wrong locator.
 */
export async function signIn(page, { base, user, pass }) {
  await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await connectIfNeeded(page, base);

  const reached = await isVisibleSoon(byTestId(page, "login-username"), TIMEOUT);
  if (!reached) {
    const isFirstRun = await isVisibleSoon(byTestId(page, "firstrun-username"), 2000);
    throw new Error(
      isFirstRun
        ? "this node has not been set up yet (the first-run screen shows, not login) -- use --first-run instead of --creds"
        : "the login screen (login-username) did not appear",
    );
  }

  await byTestId(page, "login-username").fill(user);
  await byTestId(page, "login-password").fill(pass);
  await byTestId(page, "login-submit").click({ timeout: TIMEOUT });
  await byTestId(page, "login-password").waitFor({ state: "detached", timeout: TIMEOUT }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
}

// Kept as an alias: tools/ui-shots/scripts/drive-login.mjs and drive-startup.mjs (and
// tools/ui-startup.ps1, which shells out to both) call this name.
export const connectAndSignIn = signIn;

/**
 * Every section's real URL, per WP1 (apps/stingstream/components/shell/tabIcons.ts TAB_PATHS,
 * plus Users/Settings/Sessions which are not tab groups). `/home` also exists, as a redirect to
 * `/` -- `/` is used directly since that is where a bare launch lands.
 */
const URLS = {
  home: "/",
  search: "/search",
  library: "/library",
  favorites: "/favorites",
  watchlists: "/watchlists",
  requests: "/requests",
  transfers: "/transfers",
  links: "/links",
  more: "/more",
  settings: "/settings",
  sessions: "/sessions",
  // Settings categories. Users moved here from `/users` (still a redirect) when the sidebar's
  // three bands landed: it is something an administrator configures, not something a viewer
  // browses, and a sidebar row a member never sees only ever says "you are not an administrator".
  settingsUsers: "/settings/users",
  settingsProfile: "/settings/profile",
  settingsPlayback: "/settings/playback",
  settingsServers: "/settings/servers",
  settingsTranscoding: "/settings/transcoding",
  settingsNetwork: "/settings/network",
};

/**
 * The nav testIDs a screenshot pass actually needs to click through, rather than every row
 * buildSidebarItems.ts/buildMoreItems() can produce. `compact` is the five-item bottom bar
 * (`shell-tabbar`, <768px); `wide` is the desktop sidebar's row for a destination that is not one
 * of the five (>=768px, `isWebWide`); `more` is the phone-only "More" screen's row for the same
 * destination (buildMoreItems, reached via `tab-more`). A destination missing a `wide` or `more`
 * entry does not have that surface -- e.g. Requests has no `more` row because it is already one
 * of the five compact-bar tabs, so it never gets pushed into More.
 */
const NAV = {
  home: { compact: "tab-home", wide: "tab-home" },
  search: { compact: "tab-search", wide: "tab-search" },
  library: { compact: "tab-library", wide: "tab-library" },
  requests: { compact: "tab-requests", wide: "tab-requests" },
  more: { compact: "tab-more" },
  favorites: { more: "tab-favorites", wide: "tab-favorites" },
  watchlists: { more: "tab-watchlists", wide: "tab-watchlists" },
  transfers: { more: "tab-transfers", wide: "tab-transfers" },
  settings: { more: "more-settings", wide: "tab-settings" },
  // A sidebar row at every width since pass-03 F-72, and a More row on a phone; the desktop
  // sidebar's own admin band carries it beside Transfers.
  sessions: { more: "more-sessions", wide: "more-sessions" },
};

/**
 * The settings category column (>=1024px), and the same categories as rows on the compact
 * settings list. Both are built by `buildSettingsCategories`, so the testID is the same at every
 * width: `settings-nav-<key>`.
 */
const SETTINGS_NAV = {
  settingsProfile: "settings-nav-profile",
  settingsPlayback: "settings-nav-playback",
  settingsServers: "settings-nav-servers",
  settingsUsers: "settings-nav-users",
  settingsTranscoding: "settings-nav-transcoding",
  settingsNetwork: "settings-nav-network",
};

const isWebWide = (viewportWidth) => viewportWidth >= WEB_WIDE_MIN;

/**
 * Clicks a nav element by testID and confirms the URL actually changed to the expected pathname --
 * throws rather than silently screenshotting the wrong screen under the target's name. Confirmed
 * live (2026-09-06, post-WP1) that every id in NAV both exists and navigates correctly; this check
 * stays because a silent wrong-content bug is worse than an honest navigate-failed finding.
 */
async function clickNav(page, testId, expectedPath) {
  const el = byTestId(page, testId);
  await el.waitFor({ state: "visible", timeout: TIMEOUT });
  const before = page.url();
  await el.click({ timeout: TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
  const after = page.url();
  if (after === before) {
    throw new Error(`clicking ${testId} did not navigate`);
  }
  if (expectedPath && new URL(after).pathname !== expectedPath) {
    throw new Error(`clicking ${testId} navigated to ${new URL(after).pathname}, expected ${expectedPath}`);
  }
}

/** Reaches `key` (a NAV entry) by clicking through the nav surface this viewport actually shows --
 * the desktop sidebar (`wide`, >=768px) or the phone bottom bar + More screen (`compact`/`more`,
 * <768px) -- rather than by URL. Used where a pass wants to confirm the *click* path works, not
 * just that the URL resolves (see 08-requests/09-users in buildScreens). */
async function navigateViaNav(page, base, viewportWidth, key) {
  const entry = NAV[key];
  if (!entry) throw new Error(`no NAV entry for "${key}"`);
  await page.goto(base, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
  if (isWebWide(viewportWidth)) {
    if (!entry.wide) throw new Error(`"${key}" has no desktop sidebar row at ${viewportWidth}px`);
    await clickNav(page, entry.wide, URLS[key]);
    return;
  }
  if (entry.compact) {
    await clickNav(page, entry.compact, URLS[key]);
    return;
  }
  if (!entry.more) throw new Error(`"${key}" has no compact-bar tab or More row at ${viewportWidth}px`);
  await clickNav(page, NAV.more.compact, URLS.more);
  await clickNav(page, entry.more, URLS[key]);
}

async function gotoUrl(page, base, key) {
  await page.goto(new URL(URLS[key], base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
}

/**
 * Screen order matches docs/UI-LOOP.md / the plan's "iterate loop" list. `optional: true` means a
 * failure to reach it is recorded as a finding rather than aborting the run. `onlyViewports`, when
 * present, is a list of `${width}x${height}` labels (VIEWPORTS' `name`s) -- shots.mjs skips the
 * screen entirely (no attempt, no finding) at any other viewport, for a screen that only exists at
 * one width (13-more: the "More" screen is a compact-only concept, per NAV above -- there is
 * nothing to screenshot for it at 1024/1440, where the sidebar shows the same rows directly).
 */
export function buildScreens({ base, user, pass, firstRunUrl, lanUrl }) {
  return [
    {
      // The welcome, which is what a fresh node actually opens on.
      id: "00-first-run-welcome",
      optional: true,
      navigate: async (page) => {
        await page.goto(firstRunUrl || base, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        await byTestId(page, "firstrun-welcome").waitFor({ state: "visible", timeout: TIMEOUT });
      },
    },
    {
      id: "00-first-run-local",
      optional: true,
      navigate: async (page) => {
        await page.goto(firstRunUrl || base, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        await dismissFirstRunWelcome(page);
        await byTestId(page, "firstrun-create-account").waitFor({ state: "visible", timeout: TIMEOUT });
      },
    },
    {
      id: "00b-first-run-lan",
      optional: true,
      navigate: async (page) => {
        if (!lanUrl) throw new Error("no --lan URL given");
        await page.goto(lanUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      },
    },
    {
      id: "01-login",
      navigate: async (page) => {
        // Deliberately does NOT sign in -- this screen IS the auth step, whichever variant this
        // node currently shows (first-run create-account, or returning-user sign-in).
        await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        await connectIfNeeded(page, base);
        const firstRun = byTestId(page, "firstrun-username");
        const login = byTestId(page, "login-username");
        await Promise.race([
          firstRun.waitFor({ state: "visible", timeout: TIMEOUT }),
          login.waitFor({ state: "visible", timeout: TIMEOUT }),
        ]);
      },
    },
    {
      id: "02-home",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "home");
      },
    },
    {
      id: "03-library",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "library");
      },
    },
    {
      id: "04-library-movies",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        // Best-effort only: no pinned selector exists for "the Movies library" specifically yet.
        const link = page.getByText(/movies/i).first();
        await link.click({ timeout: TIMEOUT });
      },
    },
    {
      // `library-card` (WP2/WP5, landed) is on every item card (components/cards/Card.tsx) --
      // but ALSO on the Libraries screen's own "Movies"/"TV Shows" tiles
      // (components/library/LibraryItemCard.tsx uses the identical testID). Clicking "the first
      // library-card" from wherever 04-library-movies's best-effort text click left us could
      // therefore land on a library tile, not an item -- confirmed live (2026-09-08): the old
      // `page.locator("img").first()` selector hit exactly this, clicking the Libraries screen's
      // own "Movies" tile image and bouncing straight back to Library instead of opening a
      // details page. Starting from Home instead of trusting 04's outcome sidesteps the ambiguity
      // outright: Home's rows are real item cards only, never a library tile.
      id: "05-details",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "home");
        const before = page.url();
        const card = byTestId(page, "library-card").first();
        await card.waitFor({ state: "visible", timeout: TIMEOUT });
        await card.click({ timeout: TIMEOUT });
        await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
        // Assert we actually reached an item's own route, not a bounce back to Home or (had a
        // library tile been clicked instead) a library's route -- neither is one of the fixed
        // section URLs above, so a real item id in the path is the one thing that distinguishes
        // them from every pinned screen this file already knows about.
        const after = page.url();
        const afterPath = new URL(after).pathname;
        if (after === before || Object.values(URLS).includes(afterPath)) {
          throw new Error(`clicking the first library-card did not reach an item route (still at ${afterPath})`);
        }
        // networkidle alone still caught this mid-skeleton (confirmed live, 2026-09-08 -- the
        // details page's own data fetch finishes after the network settles). details-play is the
        // one element 06-player also needs, so waiting for it here doubles as "the details page
        // has real content, not placeholders" -- non-fatal: a details page with no Play button at
        // all (unlikely, but not this screen's job to assume) should still get a screenshot.
        await byTestId(page, "details-play").waitFor({ state: "visible", timeout: TIMEOUT }).catch(() => {});
      },
    },
    {
      id: "06-player",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        // details-play (components/PlayButton.tsx, landed) -- the details page's own Play/Resume
        // button, not a text/role guess across the whole page.
        const playButton = byTestId(page, "details-play");
        await playButton.waitFor({ state: "visible", timeout: TIMEOUT });
        await playButton.click({ timeout: TIMEOUT });
        await page.locator("video").first().waitFor({ state: "attached", timeout: TIMEOUT });
        await page.waitForFunction(() => {
          const v = document.querySelector("video");
          return !!v && v.readyState >= 2;
        }, { timeout: TIMEOUT }).catch(() => {});
      },
    },
    {
      id: "07-settings",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "settings");
      },
    },
    {
      // Both navigation paths, on purpose (coordinator, 2026-09-06): Requests is the section
      // pass-02's F-20/F-21 hit hardest (the catch-all storm), so this screen confirms the direct
      // URL AND the nav click both land on it, not just one.
      id: "08-requests",
      requiresAuth: true,
      navigate: async (page, ctx) => {
        await gotoUrl(page, base, "requests");
        await navigateViaNav(page, base, ctx.viewportWidth, "requests");
      },
    },
    {
      // Users is a settings category now (`/settings/users`), not a section of its own, so the
      // "both paths" treatment is a direct URL plus a click on its row in the settings navigation
      // -- the category column at >=1024px, the settings list below that. Same testID either way.
      // `/users` is kept as a redirect and is checked separately, below.
      id: "09-users",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "settingsUsers");
        await gotoUrl(page, base, "settings");
        await clickNav(page, SETTINGS_NAV.settingsUsers, URLS.settingsUsers);
      },
    },
    {
      id: "10-search",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "search");
      },
    },
    {
      // The old `/manage` tab, replaced by the settings categories that took its place: the two
      // panes worth shooting are the one people confuse with a client setting (Transcoding &
      // hardware, badged "Whole server") and the one that gained real controls (Network & remote
      // access).
      id: "11-settings-transcoding",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "settingsTranscoding");
      },
    },
    {
      id: "11b-settings-network",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "settingsNetwork");
      },
    },
    {
      // Playback & subtitles: the four playback pages gathered into one, and the pane that carries
      // the "This device" badge the whole scope-isolation change is about.
      id: "11c-settings-playback",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "settingsPlayback");
      },
    },
    {
      // Servers: the three old Sharing rows folded into one page.
      id: "11d-settings-servers",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "settingsServers");
      },
    },
    {
      id: "12-transfers",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "transfers");
      },
    },
    {
      // Compact-only: the "More" screen is what the phone bottom bar's fifth tab opens (NAV.more);
      // at >=768px the same rows are direct sidebar items and there is no "More" screen to shoot.
      id: "13-more",
      requiresAuth: true,
      onlyViewports: ["390x844"],
      navigate: async (page) => {
        await gotoUrl(page, base, "more");
        await byTestId(page, "more-screen").waitFor({ state: "visible", timeout: TIMEOUT });
      },
    },
    {
      id: "14-favorites",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "favorites");
      },
    },
  ];
}
