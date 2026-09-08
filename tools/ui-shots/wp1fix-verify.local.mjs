// pass-03 shell fixes: F-52, F-54, F-55, F-58, F-70, F-72, F-74.
import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";

const BASE = "http://127.0.0.1:8843";
const ROOT = "E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1";
const SHOTS = `${ROOT}/shots`;
const creds = readCreds(`${ROOT}/creds.json`);

const results = [];
const check = (ok, name, detail) => results.push({ ok, name, detail });
const errors = [];

function smallTargets() {
  const out = [];
  for (const e of document.querySelectorAll('button,a,[role="button"]')) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || (r.width >= 40 && r.height >= 40)) continue;
    out.push({
      label:
        e.getAttribute("aria-label") || (e.textContent || "").trim().slice(0, 22),
      testid: e.getAttribute("data-testid"),
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
    });
  }
  return out;
}

function headerActions() {
  const out = [];
  for (const b of document.querySelectorAll("button")) {
    const r = b.getBoundingClientRect();
    if (r.top >= 70 || r.width === 0 || r.x <= 100) continue;
    out.push({ label: b.getAttribute("aria-label"), w: Math.round(r.width) });
  }
  return out;
}

function sidebarWidth() {
  const el = document.querySelector('[data-testid="shell-sidebar"]');
  return el ? Math.round(el.getBoundingClientRect().width) : 0;
}

function activeTabs() {
  const out = [];
  const sel = '[data-testid="shell-tabbar"] [role="tab"]';
  for (const t of document.querySelectorAll(sel)) {
    if (t.getAttribute("aria-selected") === "true") {
      out.push(t.getAttribute("data-testid"));
    }
  }
  return out;
}

function emptyStateFonts() {
  const out = [];
  for (const e of document.querySelectorAll("*")) {
    if (e.children.length !== 0) continue;
    const txt = (e.textContent || "").trim();
    if (!/No favorites yet|Items you mark/.test(txt)) continue;
    out.push({ txt: txt.slice(0, 20), font: getComputedStyle(e).fontFamily });
  }
  return out;
}

const browser = await chromium.launch();
const watch = (page) => {
  page.on("pageerror", (e) =>
    errors.push("pageerror: " + String(e).slice(0, 160)),
  );
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = `${m.text().slice(0, 90)} @ ${m.location()?.url ?? ""}`;
    if (
      /Streamyfin\/config|Images\/Primary|favicon|api\/v1\/(series|movies)|SyncPlay/.test(
        t,
      )
    )
      return;
    errors.push("console: " + t);
  });
};

// ------------------------------------------------------------------ 390
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  watch(page);
  await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
  await page.waitForTimeout(4500);

  const small = await page.evaluate(smallTargets);
  const inHeader = small.filter((b) => b.top < 70);
  check(
    inHeader.length === 0,
    "F-52 390 home: no sub-40 px header target",
    JSON.stringify(inHeader),
  );

  const actions = await page.evaluate(headerActions);
  const labels = actions.map((a) => a.label);
  check(
    actions.length <= 3,
    "F-52 390 home: at most three header actions",
    JSON.stringify(labels),
  );
  check(
    !labels.some((l) => /download|cast/i.test(l ?? "")),
    "F-52 390 home: no download or cast on web",
    JSON.stringify(labels),
  );
  check(
    labels.every((l) => (l ?? "").length > 0),
    "F-52 390 home: every header action is named",
    JSON.stringify(labels),
  );
  await page.screenshot({ path: `${SHOTS}/390-home.png` });

  for (const [path, label] of [
    ["/favorites", "Favorites"],
    ["/manage", "Manage"],
    ["/transfers", "Transfers"],
  ]) {
    await page.goto(new URL(path, BASE).toString(), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3000);
    const active = await page.evaluate(activeTabs);
    check(
      active.length === 1 && active[0] === "tab-more",
      `F-58 390 ${label}: More stays lit`,
      JSON.stringify(active),
    );
    const tiny = (await page.evaluate(smallTargets)).filter((b) => b.top < 70);
    check(
      tiny.length === 0,
      `F-52 390 ${label}: the back chevron is a 44 px target`,
      JSON.stringify(tiny),
    );
  }

  await ctx.close();
}

// -------------------------------------------------- 390, a fresh browser
//
// Its own context on purpose. `components/home/Favorites.tsx` only decides it
// is empty while its six queries run, and on any load after the first in a
// browser session they do not — so the screen comes up blank whatever font it
// would have used. That is a defect in the screen, reported separately; the
// font is what F-58 asks this script to prove, and the first load is where it
// can be seen.
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  watch(page);
  await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
  await page.waitForTimeout(3500);
  await page.goto(new URL("/favorites", BASE).toString(), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(5000);
  const fonts = await page.evaluate(emptyStateFonts);
  check(
    fonts.length > 0 && fonts.every((f) => /Inter/.test(f.font)),
    "F-58 390 Favorites: the empty state is Inter",
    JSON.stringify(fonts),
  );
  await page.screenshot({ path: `${SHOTS}/390-favorites.png` });
  await ctx.close();
}

// ----------------------------------------------------------------- 1440
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  watch(page);
  await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
  await page.waitForTimeout(4500);

  const lockup = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="shell-brand"] svg');
    return svg ? Math.round(svg.getBoundingClientRect().height) : 0;
  });
  check(lockup === 40, "F-54 1440: the lockup is 40 px tall", lockup);

  check(
    (await page.locator('[data-testid="shell-watch-together"]').count()) === 1,
    "F-72 1440: Watch together is in the top bar",
  );
  check(
    (await page.locator('[data-testid="shell-sessions"]').count()) === 0,
    "F-72 1440: the Sessions button is gone",
  );
  check(
    (await page.locator('[data-testid="more-sessions"]').count()) === 1,
    "F-72 1440: Sessions is a sidebar row",
  );

  // The dialog first: both of these are `Modal`s with a full-screen scrim, and
  // a scrim left open hides whatever the next step wants to click.
  await page.locator('[data-testid="shell-watch-together"]').click();
  await page.waitForTimeout(2000);
  const body = await page.locator("body").innerText();
  check(/Watch together/.test(body), "F-72 1440: the dialog opens");
  check(
    !/SyncPlay/i.test(body) && !/Jellyfin/i.test(body),
    "F-72 1440: it never says SyncPlay or Jellyfin",
  );
  await page.screenshot({ path: `${SHOTS}/1440-watch-together.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);

  // One account control, in the sidebar. Dan's screenshot had two.
  check(
    (await page
      .locator('[data-testid="shell-topbar"] [data-testid="shell-user-menu"]')
      .count()) === 0,
    "Dan-1 1440: no avatar in the top-right cluster",
  );
  check(
    (await page
      .locator('[data-testid="shell-sidebar"] [data-testid="shell-user-menu"]')
      .count()) === 1,
    "Dan-1 1440: the account row is the sidebar's",
  );

  await page
    .locator('[data-testid="shell-sidebar"] [data-testid="shell-user-menu"]')
    .click();
  await page.waitForTimeout(1200);
  const popover = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="shell-user-menu-popover"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      top: Math.round(r.top),
      left: Math.round(r.left),
      bottom: Math.round(r.bottom),
      bg: cs.backgroundColor,
      opacity: cs.opacity,
    };
  });
  check(popover !== null, "Dan-3 1440: the account menu renders");
  check(
    popover !== null && !/rgba\(0, 0, 0, 0\)|transparent/.test(popover.bg),
    "Dan-3 1440: it is an opaque surface",
    popover && popover.bg,
  );
  check(
    popover !== null && popover.top > 200,
    "Dan-3 1440: it opens at the account row, not the top-left corner",
    popover && `top=${popover.top} left=${popover.left}`,
  );
  check(
    (await page.locator('[data-testid="shell-user-menu-settings"]').count()) ===
      0,
    "F-74 1440: no Settings row in the account menu",
  );
  check(
    (await page.locator('[data-testid="shell-user-menu-sign-out"]').count()) ===
      1,
    "F-74 1440: Sign out stays",
  );
  await page.screenshot({ path: `${SHOTS}/1440-user-menu.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);

  // Dan-2: nothing in the sidebar header may overlap anything else.
  const overlap = await page.evaluate(() => {
    const head = document.querySelector('[data-testid="shell-sidebar"]');
    if (!head) return "no sidebar";
    const boxes = [];
    for (const e of head.querySelectorAll("*")) {
      if (e.children.length !== 0) continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.top > 80) continue;
      const txt = (e.textContent || "").trim();
      boxes.push({ txt: txt.slice(0, 16), ...r.toJSON() });
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const hit =
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        if (hit) return `${a.txt} over ${b.txt}`;
      }
    }
    return "";
  });
  check(overlap === "", "Dan-2 1440: nothing overlaps in the sidebar header", overlap);

  for (const [path, title] of [
    ["/settings", "Settings"],
    ["/sharing", "Sharing"],
  ]) {
    await page.goto(new URL(path, BASE).toString(), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3000);
    const count = await page.evaluate((wanted) => {
      let n = 0;
      for (const e of document.querySelectorAll("*")) {
        if (e.children.length !== 0) continue;
        if ((e.textContent || "").trim() !== wanted) continue;
        const r = e.getBoundingClientRect();
        if (r.top < 130 && r.left > 240) n++;
      }
      return n;
    }, title);
    check(
      count === 1,
      `F-55 1440 ${title}: the title appears once above the fold`,
      count,
    );
    check(
      (await page.locator('[data-testid="shell-back"]').count()) === 1,
      `F-55 1440 ${title}: the top bar carries the back chevron`,
    );
  }
  await page.screenshot({ path: `${SHOTS}/1440-settings.png` });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const w0 = await page.evaluate(sidebarWidth);
  check(w0 === 240, "F-70 1440: the sidebar starts at 240", w0);
  await page.locator('[data-testid="shell-sidebar-toggle"]').click();
  await page.waitForTimeout(900);
  const w1 = await page.evaluate(sidebarWidth);
  check(w1 === 72, "F-70 1440: the toggle collapses it to the rail", w1);
  await page.screenshot({ path: `${SHOTS}/1440-rail.png` });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const w2 = await page.evaluate(sidebarWidth);
  check(w2 === 72, "F-70 1440: the choice survives a reload", w2);
  await page.locator('[data-testid="shell-sidebar-toggle"]').click();
  await page.waitForTimeout(900);
  const w3 = await page.evaluate(sidebarWidth);
  check(w3 === 240, "F-70 1440: and it expands again", w3);
  await page.screenshot({ path: `${SHOTS}/1440-home.png` });
  await ctx.close();
}

// ----------------------------------------------------------------- 1024
{
  const ctx = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  watch(page);
  await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
  await page.waitForTimeout(4500);
  const w = await page.evaluate(sidebarWidth);
  check(w === 72, "F-70 1024: still the rail by default", w);
  await page.locator('[data-testid="shell-sidebar-toggle"]').click();
  await page.waitForTimeout(900);
  const w2 = await page.evaluate(sidebarWidth);
  check(w2 === 240, "F-70 1024: and the reader may open it anyway", w2);
  await page.screenshot({ path: `${SHOTS}/1024-home.png` });
  await ctx.close();
}

check(
  errors.length === 0,
  "no console errors of our own",
  errors.slice(0, 5).join(" | "),
);
await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  const detail = r.detail === undefined ? "" : `  — ${r.detail}`;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${detail}`);
}
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
