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
//     `/favorites`, `/watchlists`, `/requests`, `/manage`, `/transfers`, `/links`, `/more`,
//     `/sharing`, `/settings`, `/sessions`. `/home` redirects to `/`. Every route group's `index`
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
//   - Sharing and Settings are not tab-group members (no `/(auth)/(tabs)/(x)` of their own), so
//     they get their own testIDs per surface instead of a shared `tabTestID()`: the desktop
//     sidebar's rows are `tab-sharing`/`tab-settings` (buildSidebarItems, visible at
//     `isWebWide` i.e. >=768px); the compact "More" screen's rows are `more-sharing`/
//     `more-settings`/`more-sessions` (buildMoreItems, reached via `tab-more` -> `more-screen`,
//     <768px only -- Sessions has no sidebar row at all; on web wide it is a header button
//     instead, out of scope for this pass). Favorites/Watchlists/Custom-links/Manage/Transfers DO
//     share `tabTestID()` with the sidebar even inside the More screen (`tab-favorites`,
//     `tab-watchlists`, `tab-custom-links`, `tab-manage`, `tab-transfers`) -- only Sharing/
//     Settings/Sessions get the `more-*` prefix, because only those three are not one of the ten
//     TAB_KEYS. See NAV, below, for the concrete map this file uses.
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

/** The server-address step (testIDs login-server-url/login-connect), when the app is not being
 * served by a node with auto-connect wired up (or when something has gone wrong with it). Confirmed
 * live both ways on this pass: a stale supervisor build skipped the node marker entirely and showed
 * this step; a current build injects the marker and auto-connects straight to firstrun/login with
 * no server step at all. Handles both without caring which one this particular node does. */
async function connectIfNeeded(page, base) {
  const serverInput = byTestId(page, "login-server-url");
  if (await isVisibleSoon(serverInput, 6000)) {
    // <base>/jellyfin, not the bare origin: docs/UI-LOOP.md records a real bug where the bare
    // host:port hangs this step forever with no way back. Not this pass's bug to re-litigate.
    await serverInput.fill(new URL("/jellyfin", base).toString());
    await byTestId(page, "login-connect").click({ timeout: TIMEOUT }).catch(() => {});
  }
}

const DEFAULT_FIRSTRUN_USERNAME = "reviewer";
const DEFAULT_FIRSTRUN_PASSWORD = "StingStreamReview1"; // >= 8 chars, per setup.password_hint

/**
 * Drives the first-run "Create your StingStream account" screen (testID firstrun-create-account)
 * to completion. Per the plan, a successful submit signs the app straight in (no separate login
 * step) -- confirmed live. Returns the credentials used, so the caller can persist them (--creds)
 * for a later run against the same, now-set-up node.
 */
export async function createFirstRunAccount(page, { base, username = DEFAULT_FIRSTRUN_USERNAME, password = DEFAULT_FIRSTRUN_PASSWORD } = {}) {
  await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
  await connectIfNeeded(page, base);

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
  await byTestId(page, "firstrun-confirm").fill(password);
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
 * plus Sharing/Settings/Sessions which are not tab groups). `/home` also exists, as a redirect to
 * `/` -- `/` is used directly since that is where a bare launch lands.
 */
const URLS = {
  home: "/",
  search: "/search",
  library: "/library",
  favorites: "/favorites",
  watchlists: "/watchlists",
  requests: "/requests",
  manage: "/manage",
  transfers: "/transfers",
  links: "/links",
  more: "/more",
  sharing: "/sharing",
  settings: "/settings",
  sessions: "/sessions",
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
  manage: { more: "tab-manage", wide: "tab-manage" },
  transfers: { more: "tab-transfers", wide: "tab-transfers" },
  sharing: { more: "more-sharing", wide: "tab-sharing" },
  settings: { more: "more-settings", wide: "tab-settings" },
  sessions: { more: "more-sessions" }, // web-wide: a header button, not a sidebar row -- not driven here.
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
 * just that the URL resolves (see 08-requests/09-sharing in buildScreens). */
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
      id: "00-first-run-local",
      optional: true,
      navigate: async (page) => {
        await page.goto(firstRunUrl || base, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
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
      id: "05-details",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        // Click the first poster/card on whatever screen we are on (expected: the Movies library,
        // reached by the previous screen in the same page session). Not pinned to a URL or a
        // testID -- details pages are keyed by item id, and library-card (docs/UI-LOOP.md's
        // contract) does not exist on cards yet.
        const card = page.locator("img").first();
        await card.click({ timeout: TIMEOUT });
      },
    },
    {
      id: "06-player",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        const playButton = page.getByRole("button", { name: /play|resume/i }).first();
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
      // Same "both paths" treatment as Requests. Sharing has no compact-bar tab of its own: at
      // <768px it is reached via tab-more -> more-sharing; at >=768px it is a direct sidebar row
      // (tab-sharing). navigateViaNav() picks the right one for this viewport.
      id: "09-sharing",
      requiresAuth: true,
      navigate: async (page, ctx) => {
        await gotoUrl(page, base, "sharing");
        await navigateViaNav(page, base, ctx.viewportWidth, "sharing");
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
      id: "11-manage",
      requiresAuth: true,
      navigate: async (page) => {
        await gotoUrl(page, base, "manage");
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
