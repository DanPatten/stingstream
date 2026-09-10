// Pass-03 review extras: what shots.mjs does not capture. Own chromium, one context per viewport.
//   node pass03-extras.local.mjs --base http://127.0.0.1:8830 --creds <creds.json> --out <dir>
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readCreds } from "./lib/authFile.mjs";
import { signIn } from "./flows/web.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const base = args.base || "http://127.0.0.1:8830";
const out = args.out || ".";
fs.mkdirSync(out, { recursive: true });
const creds = readCreds(args.creds);

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

const findings = [];
const note = (screen, vp, kind, detail) => { findings.push({ screen, vp, kind, detail }); console.log(`  ! [${screen}@${vp}] ${kind}: ${detail}`); };
const shot = async (page, name) => { const p = path.join(out, `${name}.png`); await page.screenshot({ path: p, fullPage: false }); console.log(`  shot ${name}`); return p; };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (page, id) => page.locator(`[data-testid="${id}"]`);

async function attachConsole(page, screenRef) {
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") note(screenRef.screen, screenRef.vp, `console-${m.type()}`, m.text().slice(0, 200)); });
  page.on("pageerror", (e) => note(screenRef.screen, screenRef.vp, "pageerror", String(e).slice(0, 200)));
  page.on("response", (r) => { if (r.status() >= 400) note(screenRef.screen, screenRef.vp, `http-${r.status()}`, r.url().slice(0, 160)); });
}

async function goto(page, ref, pathname, name) {
  ref.screen = name;
  await page.goto(new URL(pathname, base).toString(), { waitUntil: "networkidle", timeout: 60000 }).catch((e) => note(name, ref.vp, "goto", String(e).slice(0, 160)));
  await settle(1500);
}

async function run() {
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1, colorScheme: "dark", reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const ref = { screen: "signin", vp: vp.name };
    await attachConsole(page, ref);
    console.log(`\n=== viewport ${vp.name} ===`);
    try { await signIn(page, { base, user: creds.username, pass: creds.password }); } catch (e) { note("signin", vp.name, "signin-failed", String(e).slice(0, 200)); }
    await settle(2000);

    // Home: hover + keyboard focus
    await goto(page, ref, "/", "home");
    await shot(page, `home-${vp.name}`);
    if (vp.name === "1440") {
      const card = t(page, "library-card").first();
      if (await card.count()) { await card.hover(); await settle(400); await shot(page, `home-hover-card-${vp.name}`); } else note("home", vp.name, "missing", "no library-card on Home");
      await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await settle(300);
      await shot(page, `home-tab-focus-${vp.name}`);
      const focused = await page.evaluate(() => { const el = document.activeElement; if (!el) return null; const cs = getComputedStyle(el); return { tag: el.tagName, testid: el.getAttribute("data-testid"), label: el.getAttribute("aria-label"), outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor }; });
      console.log("  focused:", JSON.stringify(focused));
      if (!focused || focused.outline.startsWith("none")) note("home", vp.name, "focus", `no visible focus ring on Tab: ${JSON.stringify(focused)}`);
    }
    // raw Tailwind class names surviving on the DOM (NativeWind inert check)
    const rawTw = await page.evaluate(() => Array.from(document.querySelectorAll("[class]")).map((e) => e.className).filter((c) => typeof c === "string" && /(^|\s)(mt|mb|px|py|flex|bg|text)-[a-z0-9-]+/.test(c)).slice(0, 5));
    if (rawTw.length) note("home", vp.name, "raw-tailwind", rawTw.join(" | ").slice(0, 200));

    if (vp.name === "390") { await goto(page, ref, "/more", "more"); await shot(page, `more-${vp.name}`); }

    // Settings + Appearance accent swatches
    await goto(page, ref, "/settings", "settings"); await shot(page, `settings-${vp.name}`);
    const appearance = page.getByText(/^Appearance$/).first();
    if (await appearance.count()) {
      await appearance.click().catch(() => {}); await settle(1500); await shot(page, `settings-appearance-${vp.name}`);
      const violet = t(page, "settings-accent-violet");
      if (await violet.count()) { await violet.click(); await settle(800); await shot(page, `settings-appearance-violet-${vp.name}`); await t(page, "settings-accent-teal").click().catch(() => {}); await settle(500); } else note("settings", vp.name, "missing", "settings-accent-violet not found");
    } else note("settings", vp.name, "missing", "Appearance row not found");

    // Sharing create/join
    await goto(page, ref, "/sharing", "sharing"); await shot(page, `sharing-${vp.name}`);
    if (await t(page, "sharing-create").count()) { await t(page, "sharing-create").first().click(); await settle(1200); await shot(page, `sharing-create-${vp.name}`); await page.goBack().catch(() => {}); await settle(800); }
    if (await t(page, "sharing-join").count()) { await t(page, "sharing-join").first().click(); await settle(1200); await shot(page, `sharing-join-${vp.name}`); }

    // Requests: My requests, then Find -- the catalogue feed, its filter bar, and a search.
    // `?tab=find` on purpose: a bare /requests opens on My requests, which has no search box, so
    // this step used to report "requests-search not found" on every run.
    await goto(page, ref, "/requests", "requests"); await shot(page, `requests-${vp.name}`);
    await goto(page, ref, "/requests?tab=find", "requests-find"); await settle(4000); await shot(page, `requests-discover-${vp.name}`);
    if (!(await t(page, "requests-filter-bar").count())) note("requests", vp.name, "missing", "requests-filter-bar not found");
    const dc = t(page, "requests-card").first();
    if (await dc.count()) { await dc.click(); await settle(1500); await shot(page, `requests-sheet-${vp.name}`); await page.keyboard.press("Escape"); await settle(600); }
    else note("requests", vp.name, "missing", "no requests-card on the feed (no outbound internet? the catalogue is upstream)");
    const rs = t(page, "requests-search");
    if (await rs.count()) { await rs.first().fill("Sintel"); await settle(4000); await shot(page, `requests-results-${vp.name}`); if (!(await t(page, "requests-result-row").count())) note("requests", vp.name, "missing", "no requests-result-row after search (arrs off? expected: search needs a manager)"); } else note("requests", vp.name, "missing", "requests-search not found");

    // Admin surfaces (arrs off -> not-set-up states)
    for (const [p, n] of [["/manage", "manage"], ["/transfers", "transfers"], ["/settings/server", "server-settings"], ["/settings/admin", "users-libraries"], ["/settings/node", "server-status"]]) { await goto(page, ref, p, n); await shot(page, `${n}-${vp.name}`); }

    // Search
    await goto(page, ref, "/search", "search"); const si = t(page, "search-input"); if (await si.count()) { await si.first().fill("Nosferatu"); await settle(3000); } else if (vp.name === "1440") { const top = t(page, "shell-search"); if (await top.count()) { await top.first().fill("Nosferatu"); await page.keyboard.press("Enter"); await settle(3000); } }
    await shot(page, `search-results-${vp.name}`);

    // Library grid + details + player OSD
    await goto(page, ref, "/library", "library"); await shot(page, `library-${vp.name}`);
    await goto(page, ref, "/", "home");
    const first = t(page, "library-card").first();
    if (await first.count()) {
      await first.click(); await settle(2500); ref.screen = "details"; await shot(page, `details-${vp.name}`);
      const play = t(page, "details-play").first();
      if (await play.count()) {
        await play.click(); ref.screen = "player"; await settle(4000); await shot(page, `player-osd-shown-${vp.name}`);
        const pill = await t(page, "player-source-pill").count(); console.log(`  source pill present: ${pill > 0}`);
        await settle(5500); await shot(page, `player-osd-hidden-${vp.name}`);
        await page.mouse.move(vp.width / 2, vp.height / 2); await settle(600); await shot(page, `player-osd-reshown-${vp.name}`);
        await page.keyboard.press("Escape").catch(() => {});
      } else note("details", vp.name, "missing", "details-play not found");
    }
    await ctx.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(out, "extras-findings.json"), JSON.stringify(findings, null, 2));
  console.log(`\n${findings.length} findings -> ${path.join(out, "extras-findings.json")}`);
}
run().catch((e) => { console.error(e); process.exit(1); });
