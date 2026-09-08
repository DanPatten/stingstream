// Pass-03 probes: LAN-origin mount, details header images, unnamed OSD/topbar icons.
//   node pass03-probe.local.mjs --base http://127.0.0.1:8830 --lan http://192.168.0.16:8830 --creds <creds.json> --out <dir>
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readCreds } from "./lib/authFile.mjs";
import { signIn } from "./flows/web.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const base = args.base, lan = args.lan, out = args.out;
fs.mkdirSync(out, { recursive: true });
const creds = readCreds(args.creds);
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function main() {
  const browser = await chromium.launch();

  // 1. LAN origin: does React mount? capture console/pageerror for 20 s.
  for (const [label, origin] of [["lan", lan], ["loopback", base]]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
    const page = await ctx.newPage();
    const events = [];
    page.on("console", (m) => events.push(`${m.type()}: ${m.text().slice(0, 300)}`));
    page.on("pageerror", (e) => events.push(`PAGEERROR: ${String(e).slice(0, 400)}`));
    page.on("requestfailed", (r) => events.push(`REQFAILED: ${r.url().slice(0, 160)} ${r.failure()?.errorText}`));
    await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => events.push(`GOTO: ${e}`));
    await settle(20000);
    const state = await page.evaluate(() => ({ rootChildren: document.getElementById("root")?.children.length ?? -1, splashOpacity: getComputedStyle(document.getElementById("ss-splash") || document.body).opacity, title: document.title, secure: window.isSecureContext, marker: window.__STINGSTREAM_NODE__ || null, bodyText: document.body.innerText.slice(0, 200) }));
    await page.screenshot({ path: path.join(out, `probe-${label}-origin-20s.png`) });
    log(`\n=== ${label} origin ${origin} ===`); log(JSON.stringify(state, null, 1)); log("events:"); for (const e of events.slice(0, 40)) log("  " + e);
    await ctx.close();
  }

  // 2. Signed-in probes at 1440: details header images, player floating icon, topbar right icon.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url().slice(0, 160)}`); });
  await signIn(page, { base, user: creds.username, pass: creds.password });
  await page.goto(base + "/", { waitUntil: "networkidle" }); await settle(1500);
  const topbar = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="shell-topbar"] button, [data-testid="shell-topbar"] [role=button]')).map((b) => ({ label: b.getAttribute("aria-label"), text: b.innerText.slice(0, 30), w: b.getBoundingClientRect().width })));
  log("\n=== topbar controls ==="); log(JSON.stringify(topbar));
  await page.locator('[data-testid="library-card"]').first().click(); await settle(3000);
  const hdr = await page.evaluate(() => ({ url: location.href, imgs: Array.from(document.querySelectorAll("img")).slice(0, 12).map((i) => ({ src: i.currentSrc.slice(0, 140), nw: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height), alt: i.alt })), h1: Array.from(document.querySelectorAll('[data-testid="details-header"] *')).filter((e) => e.children.length === 0 && e.textContent.trim()).slice(0, 8).map((e) => e.textContent.trim().slice(0, 40)) }));
  log("\n=== details header ==="); log(JSON.stringify(hdr, null, 1));
  await page.screenshot({ path: path.join(out, "probe-details-1440.png") });
  await page.locator('[data-testid="details-play"]').first().click(); await settle(4000);
  const osd = await page.evaluate(() => Array.from(document.querySelectorAll("button, [role=button]")).map((b) => { const r = b.getBoundingClientRect(); return { label: b.getAttribute("aria-label"), testid: b.getAttribute("data-testid"), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((b) => b.w > 0));
  const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, wide: Array.from(document.querySelectorAll("*")).filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map((e) => e.tagName + "." + (e.className || "").toString().slice(0, 40) + " right=" + Math.round(e.getBoundingClientRect().right)) }));
  log("\n=== player OSD controls ==="); log(JSON.stringify(osd)); log("overflow:", JSON.stringify(overflow));
  await page.screenshot({ path: path.join(out, "probe-player-1440.png") });
  // 3. Library grid first-load timing: skeleton -> posters
  await page.goto(base + "/library", { waitUntil: "networkidle" }); await settle(1000);
  const t0 = Date.now();
  await page.locator('[data-testid="library-card"]').first().click().catch(() => {});
  let loaded = 0, elapsed = 0;
  for (let i = 0; i < 20; i++) { await settle(500); loaded = await page.evaluate(() => Array.from(document.querySelectorAll("img")).filter((i) => i.naturalWidth > 0 && i.getBoundingClientRect().height > 100).length); elapsed = Date.now() - t0; if (loaded >= 6) break; }
  log(`\n=== library grid: ${loaded} posters loaded after ${elapsed} ms (url ${page.url()}) ===`);
  await page.screenshot({ path: path.join(out, "probe-library-grid-1440.png") });
  log("\nerrors:", JSON.stringify(errs.slice(0, 20), null, 1));
  await ctx.close(); await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
