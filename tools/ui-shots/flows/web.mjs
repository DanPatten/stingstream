// WP-TOOLS UI iterate loop: the 13 screens shots.mjs captures, in order, and how to reach each
// one from a fresh page. See docs/UI-LOOP.md.
//
// The app has no testID contract yet (that lands with WP1/WP2/WP3/WP4/.../WP-TV-SHELL, per the
// docs/UI-LOOP.md contract this package defines but does not implement -- WP-TOOLS owns tooling,
// not app source). Every selector below is therefore text/role/URL, in that preference order, and
// every navigate() function is defensive: it throws a clear Error on failure rather than hanging,
// so shots.mjs can catch it, record "navigation failed" as a finding, and move on to the next
// screen instead of losing the whole pass. Once a screen's real testID lands, tighten its
// selector here -- that is the whole point of pinning against `data-testid` once it exists rather
// than only ever against copy that a rebrand/rewrite pass will change out from under this file.
//
// URLs are pinned from actually clicking through a running node (see docs/UI-LOOP.md, "Pinned
// routes") -- do not guess a route; if a screen's URL is not confirmed yet, its `path` is null and
// navigate() clicks through the UI instead of using page.goto() directly.
//
// Pinned against a live node on 2026-09-06 (WP-TOOLS pass-00, apps/stingstream/dist as built that
// day). Real, reproducible findings from doing this -- all already on the plan's own bug list, all
// left for their owning package to fix; this file works around them rather than papering over
// them, and docs/UI-LOOP.md records each one:
//   - The whole pre-connect/login flow lives at ONE url, "/login" (an expo-router SPA route; "/"
//     redirects there with nothing signed in). The server-connect and username/password steps are
//     the same route; which one renders is state, not URL.
//   - Typing the bare host:port (what the app's own /healthz banner prints, and what a first-time
//     user would naturally type) hangs the Connect step FOREVER with no visible error and no way
//     back: the app probes bare "<base>/System/Info/Public", gets a 404, and the "Connect" control
//     stays stuck in its pressed/loading state -- further input into the Server URL field stops
//     registering even if you then type the working "<base>/jellyfin" address, so there is no
//     in-page recovery, only a reload. connectAndSignIn() below goes straight to "<base>/jellyfin"
//     for exactly this reason -- not a retry-after-failure, a way to never trigger the hang at all.
//   - The desktop-width bottom tab bar (Home/Search/Favorites/Library/Manage/Downloads, all real
//     ARIA buttons with accessible names) does not actually navigate on click here -- confirmed by
//     clicking each one from a signed-in session and watching the URL never leave "/". This is the
//     plan's own "the bottom tab bar is a JS stub" bug, reproduced directly. Every reachable screen
//     below is therefore reached by page.goto() to a pinned URL, never by clicking the tab bar.
//   - Settings, Search, Requests, Groups (pre-rename "Sharing"), Downloads and Manage are all real,
//     directly-navigable routes even though the tab bar cannot reach them: "/settings", "/search",
//     "/requests", "/groups", "/downloads", "/manage". Library's real URL was NOT pinned -- the tab
//     click that would have confirmed it is exactly the broken one above, and "/library" and
//     "/libraries" both resolve without erroring but without distinguishing content either, so
//     which (if either) is real is still open; 03-library and 04-library-movies stay optional and
//     unpinned (best-effort text click) until someone confirms it by hand or WP1/WP2 land the
//     sidebar. Same for 05-details/06-player, which need a real item id.
// Also pinned: "Connect", the unlabelled Quick Connect icon and "Log in" are NOT real button-role
// elements (react-native-web Pressables render as a plain div/span here) -- only "Change server"
// is (and, it turns out, the tab bar buttons -- being a real <button> role is not the same as being
// wired up). Username/Password ARE real textboxes with accessible names "Username"/"Password"
// (Input sets both the placeholder and an aria label), which is why those two are matched by
// role+name below rather than by placeholder. Poster/backdrop <img> elements have NO alt text
// (confirmed empty), a real accessibility gap worth a line in the report even though it makes the
// brand-word img[alt] check permanently vacuous against this build.

export const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "390x844", width: 390, height: 844, isMobile: true, deviceScaleFactor: 2, hasTouch: true },
];

const TIMEOUT = 15000;

/** "Connect" (and, later, "Log in" and the Quick Connect icon) are Pressables that render as a
 * plain div/span on web today, not an ARIA button -- see the file header note. Match by exact
 * visible text instead of role. */
function clickableText(page, text) {
  return page.locator("div, span").filter({ hasText: new RegExp(`^${text}$`) }).last();
}

const usernameField = (page) => page.getByRole("textbox", { name: "Username" });
const passwordField = (page) => page.getByRole("textbox", { name: "Password" });
const serverUrlField = (page) => page.getByRole("textbox", { name: "Server URL" });

/** locator.isVisible() does NOT wait -- it is a synchronous, immediate check, unlike every other
 * Playwright action -- so calling it right after goto() races the SPA's own hydration and false-
 * negatives constantly (confirmed live, 2026-09-06: connectAndSignIn skipped the whole
 * server-address step this way, every few runs, because isVisible() ran before React had mounted
 * the form). Use this instead of `locator.isVisible({timeout})` anywhere a screen is optional. */
async function isVisibleSoon(locator, timeoutMs) {
  return locator.waitFor({ state: "visible", timeout: timeoutMs }).then(() => true).catch(() => false);
}

/** True once the login form (server-address step or username/password step) is gone. Used as the
 * "we got past login" signal since the app's post-login landing URL is not guaranteed stable
 * (expo-router web SPA routing, "/" before and after login in the old UI). */
async function waitPastLogin(page) {
  await passwordField(page).waitFor({ state: "detached", timeout: TIMEOUT }).catch(() => {});
}

/**
 * Old-UI login, at the one pinned route "/login": server-address step (if shown) then username/
 * password. Goes straight to "<base>/jellyfin" for the server address -- NOT a retry-after-failure
 * strategy, on purpose. The bare host:port (what a first-time user would naturally type, and what
 * the app's own /healthz banner prints) was confirmed live (2026-09-06) to hang the Connect step
 * forever with no visible error AND no way back: the "Connect" control stays in its pressed/
 * loading state and further input into the Server URL field stops registering, so a retry-with-
 * "/jellyfin" AFTER an attempt at the bare URL does not recover either -- both attempts have to
 * share one page, and the first one never lets go. See the file-header bug note and
 * docs/UI-LOOP.md; this is deliberately worked around here rather than "fixed" (fixing it is
 * WP3/WP-GATE's auto-connect work, not this tool's).
 */
export async function connectAndSignIn(page, { base, user, pass }) {
  // Up to two attempts at the connect step: this is a shared, often-loaded dev machine (several
  // nodes/builds running at once is normal here -- docs/CONTRIBUTING.md), and an occasional slow
  // hydration is machine contention, not a real bug, worth one retry before this screen's whole
  // capture is written off as a navigate-failed finding.
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });

    const serverInput = serverUrlField(page);
    if (await isVisibleSoon(serverInput, 8000)) {
      await serverInput.fill(new URL("/jellyfin", base).toString());
      await clickableText(page, "Connect").click({ timeout: TIMEOUT }).catch(() => {});
    }

    const reachedUsername = await isVisibleSoon(usernameField(page), attempt === 1 ? 10000 : TIMEOUT);
    if (reachedUsername) break;
    if (attempt === 2) {
      // Let the final wait below throw with Playwright's own descriptive timeout error.
      break;
    }
  }

  await usernameField(page).waitFor({ state: "visible", timeout: TIMEOUT });
  await usernameField(page).fill(user);
  await passwordField(page).fill(pass);
  await clickableText(page, "Log in").click({ timeout: TIMEOUT });
  await waitPastLogin(page);
  await page.waitForLoadState("networkidle", { timeout: TIMEOUT }).catch(() => {});
}

async function gotoOrClick(page, { base, path, linkNamePattern }) {
  if (path) {
    await page.goto(new URL(path, base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    return;
  }
  const link = page.getByRole("link", { name: linkNamePattern }).or(page.getByText(linkNamePattern)).first();
  await link.click({ timeout: TIMEOUT });
}

/**
 * Screen order matches docs/UI-LOOP.md / the plan's "iterate loop" list. `optional: true` means a
 * failure to reach it is recorded as a finding rather than aborting the run -- most of these are
 * genuinely not reachable yet on the pre-WP1 UI (e.g. Sharing is still called "Groups" and lives
 * behind a settings sub-page, not a tab).
 */
export function buildScreens({ base, user, pass, firstRunUrl, lanUrl }) {
  return [
    {
      id: "00-first-run-local",
      optional: true,
      navigate: async (page) => {
        await page.goto(firstRunUrl || base, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
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
        await page.goto(new URL("/login", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        // Deliberately does NOT sign in -- this screen IS the login/server-connect step. Goes
        // straight to "<base>/jellyfin" rather than reproducing the bare-host hang (see the file
        // header bug note): the screenshot is meant to show the sign-in form, not the bug.
        const serverInput = serverUrlField(page);
        if (await isVisibleSoon(serverInput, 6000)) {
          await serverInput.fill(new URL("/jellyfin", base).toString());
          await clickableText(page, "Connect").click({ timeout: TIMEOUT }).catch(() => {});
        }
        await usernameField(page).waitFor({ state: "visible", timeout: TIMEOUT });
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
        // NOT pinned -- see the file header. "/library" answers without erroring but its content
        // was never distinguished from "/libraries" or from the tab-bar-stub no-op; try the tab
        // text as a last resort (also likely to no-op, recorded as a finding if so).
        await gotoOrClick(page, { base, path: null, linkNamePattern: /librar(y|ies)/i });
      },
    },
    {
      id: "04-library-movies",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        await gotoOrClick(page, { base, path: null, linkNamePattern: /movies/i });
      },
    },
    {
      id: "05-details",
      requiresAuth: true,
      optional: true,
      navigate: async (page) => {
        // Click the first poster/card on whatever screen we are on (expected: Home or a library
        // grid, reached by a previous screen in the same page session). Not pinned to a URL --
        // details pages are keyed by item id, which this flow does not know in advance.
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
      // Pinned: "/settings" -- confirmed live, reachable directly even though the tab bar cannot
      // reach it (the tab bar has no Settings item at all at this viewport -- see docs/UI-LOOP.md).
      id: "07-settings",
      requiresAuth: true,
      navigate: async (page) => {
        await page.goto(new URL("/settings", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      },
    },
    {
      // Pinned: "/requests" -- confirmed live.
      id: "08-requests",
      requiresAuth: true,
      navigate: async (page) => {
        await page.goto(new URL("/requests", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      },
    },
    {
      // Pinned: "/groups" -- confirmed live. Still called "Groups" pre-WP8/WP11 -- see
      // docs/UI-LOOP.md wording table ("Sharing" is the future name, not the current route).
      id: "09-sharing",
      requiresAuth: true,
      navigate: async (page) => {
        await page.goto(new URL("/groups", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      },
    },
    {
      // Pinned: "/search" -- confirmed live.
      id: "10-search",
      requiresAuth: true,
      navigate: async (page) => {
        await page.goto(new URL("/search", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      },
    },
    {
      // Pinned: "/manage" -- confirmed live.
      id: "11-manage",
      requiresAuth: true,
      navigate: async (page) => {
        await page.goto(new URL("/manage", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      },
    },
    {
      // Pinned: "/downloads" -- confirmed live, and confirmed to render real content ("Engine
      // health", "No active downloads"). Still called "Downloads" pre-WP9/WP11 -- see
      // docs/UI-LOOP.md wording table ("Transfers" is the future name, not the current route).
      id: "12-transfers",
      requiresAuth: true,
      navigate: async (page) => {
        await page.goto(new URL("/downloads", base).toString(), { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      },
    },
  ];
}
