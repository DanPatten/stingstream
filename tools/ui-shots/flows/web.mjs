// WP-TOOLS UI iterate loop: the 13 screens shots.mjs captures, in order, and how to reach each
// one from a fresh page. See docs/UI-LOOP.md.
//
// F-36 (pass-02 critique, 2026-09-06): WP3 landed the firstrun-*/login-* testID contract on
// master. Every auth interaction below is now driven by `[data-testid=...]`, not text/role/
// placeholder matching -- the old approach broke the moment two fields shared a fuzzy-matched
// accessible name ("Password" matches "Confirm password" too under Playwright's default substring
// name matching), which is exactly what pass-02's own sweep run hit ("the sign-in step matched two
// password fields"). Every navigate() function is still defensive: it throws a clear Error on
// failure rather than hanging, so shots.mjs can catch it, record "navigate-failed" as a finding,
// and move on to the next screen instead of losing the whole pass.
//
// Section routes (search/requests/sharing/manage/transfers/library) are NOT pinned to a URL here,
// on purpose, as of this pass: the pass-02 critique found `/requests`, `/groups` and (by
// construction) `/search`, `/manage`, `/downloads` now resolve to a library-by-id catch-all route
// that spins forever and hammers the server with a ~400-request storm in 3 seconds (F-21) --
// actively harmful to keep doing, not merely stale. WP1 has not landed real URLs for these
// sections yet (`/home`, `/search`, `/library`, `/requests`, `/sharing`, `/manage`, `/transfers`,
// `/settings` are the eventual set). Until it does, this file clicks the bottom tab bar's own
// testIDs instead -- which already exist today, but as `tab-(home)`, `tab-(search)`,
// `tab-(favorites)`, `tab-(libraries)`, `tab-(manage)`, `tab-(downloads)`, `tab-(requests)`
// (the literal Expo Router group names, parens included, auto-assigned by whatever tab component
// is in use -- not yet the clean `tab-home`/`tab-library`/... names this package's own testID
// contract in docs/UI-LOOP.md asks WP1 for). clickTabByTestId() below is a TODO by construction:
// re-pin every section to a real URL once WP1 lands one, and drop the `(parens)` tab-id lookup
// once WP1 renames them to match the contract.
//
// clickTabByTestId() ALSO verifies the URL actually changed after the click, and throws if not --
// confirmed live (2026-09-06): the tab bar's testIDs are real and clickable, but clicking one does
// not navigate anywhere (F-20, the plan's "the bottom tab bar is a JS stub" bug, still open on
// this pass). Without that check, a "successful" click that landed on the wrong page (still Home)
// would get screenshotted and labelled as the target screen -- a silent wrong-content bug worse
// than the honest navigate-failed finding this produces instead.
//
// "/settings" stays pinned to a direct URL: confirmed still reachable and rendering real content
// on this pass (unlike the six routes above), so there is no reason to make it worse by routing it
// through the same broken tab bar. Re-pin it too once WP1's own URL for it lands.

export const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "390x844", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2, hasTouch: true },
];

const TIMEOUT = 15000;

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

/** The literal Expo Router group names the tab bar's own testIDs use today -- see the file header
 * TODO. Not every plan-listed section has a bottom tab (Sharing and Settings do not). */
const TAB_TEST_IDS = {
  home: "tab-(home)",
  search: "tab-(search)",
  favorites: "tab-(favorites)",
  library: "tab-(libraries)",
  manage: "tab-(manage)",
  transfers: "tab-(downloads)",
  requests: "tab-(requests)",
};

/**
 * TODO(WP1): re-pin every one of these to a real URL once WP1 lands `/search`, `/library`,
 * `/requests`, `/manage`, `/transfers` (docs/UI-LOOP.md, "Pinned routes"). For now this clicks the
 * tab bar by its current (pre-contract) testID and verifies the URL actually changed -- confirmed
 * live that it does not yet (F-20), so this throws rather than silently screenshotting Home under
 * the wrong screen's name.
 */
async function clickTabByTestId(page, tabKey) {
  const testId = TAB_TEST_IDS[tabKey];
  if (!testId) throw new Error(`no known tab testID for "${tabKey}" (Sharing/Settings are not bottom tabs)`);
  const tab = byTestId(page, testId);
  await tab.waitFor({ state: "visible", timeout: TIMEOUT });
  const before = page.url();
  await tab.click({ timeout: TIMEOUT });
  await page.waitForTimeout(1000);
  if (page.url() === before) {
    throw new Error(`clicking ${testId} did not navigate (F-20: the tab bar is not wired up yet on this build)`);
  }
  await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
}

/**
 * Screen order matches docs/UI-LOOP.md / the plan's "iterate loop" list. `optional: true` means a
 * failure to reach it is recorded as a finding rather than aborting the run.
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
        await page.goto(base, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
      },
    },
    {
      id: "03-library",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        await clickTabByTestId(page, "library");
      },
    },
    {
      id: "04-library-movies",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        // Best-effort only: depends on 03-library having actually landed on a real library grid,
        // which it cannot while F-20 stands. No pinned selector exists for "the Movies library"
        // specifically yet.
        const link = page.getByText(/movies/i).first();
        await link.click({ timeout: TIMEOUT });
      },
    },
    {
      id: "05-details",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        // Click the first poster/card on whatever screen we are on (expected: Home, reached by a
        // previous screen in the same page session). Not pinned to a URL or a testID -- details
        // pages are keyed by item id, and library-card (docs/UI-LOOP.md's contract) does not exist
        // on cards yet.
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
      // Pinned: "/settings" -- confirmed live on this pass, still rendering real content even
      // though the tab bar has no Settings item at all and the six routes above now actively
      // hammer the server. Re-pin to WP1's own URL once it lands (see file header).
      id: "07-settings",
      requiresAuth: true,
      navigate: async (page) => {
        await page.goto(new URL("/settings", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      },
    },
    {
      id: "08-requests",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        await clickTabByTestId(page, "requests");
      },
    },
    {
      id: "09-sharing",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        // Sharing has no bottom tab (per the plan) and no pinned URL of its own -- reachable only
        // via Settings, which is itself still pinned above. Try the contract's settings-sharing
        // testID first (docs/UI-LOOP.md); it does not exist yet either, so fall back to a
        // best-effort text click on the still-current "Groups" wording (pre-WP8/WP11 rename).
        await page.goto(new URL("/settings", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        const byId = byTestId(page, "settings-sharing");
        if (await isVisibleSoon(byId, 3000)) {
          await byId.click({ timeout: TIMEOUT });
        } else {
          await page.getByText(/groups|sharing/i).first().click({ timeout: TIMEOUT });
        }
      },
    },
    {
      id: "10-search",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        await clickTabByTestId(page, "search");
      },
    },
    {
      id: "11-manage",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        await clickTabByTestId(page, "manage");
      },
    },
    {
      id: "12-transfers",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        await clickTabByTestId(page, "transfers");
      },
    },
  ];
}
