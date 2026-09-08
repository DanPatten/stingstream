// WP3 acceptance driver. Its own browser, so it does not fight the shared MCP one.
//   node wp3-drive.mjs --base http://127.0.0.1:8803 --lan http://192.168.0.16:8803 \
//     --out <shots dir> --user dan --pass hunter22 --phase firstrun|signin
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const BASE = args.base;
const LAN = args.lan;
const OUT = args.out;
const USER = args.user ?? "dan";
const PASS = args.pass ?? "hunter22";
const PHASE = args.phase ?? "firstrun";
fs.mkdirSync(OUT, { recursive: true });

const findings = [];
function watch(page, label) {
  page.on("console", (m) => {
    if (m.type() === "error") findings.push(`console ${label}: ${m.text()}`);
  });
  page.on("pageerror", (e) => findings.push(`pageerror ${label}: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) findings.push(`http ${label}: ${r.status()} ${r.url()}`);
  });
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

async function overflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const wide = d.scrollWidth > d.clientWidth + 1;
    const bad = [];
    for (const el of document.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.left < -1 || r.right > d.clientWidth + 1)) {
        bad.push(`${el.tagName}.${el.className}`.slice(0, 80));
      }
    }
    return { horizontalScroll: wide, overflowing: bad.slice(0, 5) };
  });
}

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

const browser = await chromium.launch();

// First run is a one-shot: creating the account ends it. So the phone width goes first and only
// the desktop pass actually submits.
const order = PHASE === "firstrun" ? [...VIEWPORTS].reverse() : VIEWPORTS;

for (const vp of order) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
    deviceScaleFactor: vp.deviceScaleFactor,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  watch(page, vp.name);

  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });

  if (PHASE === "firstrun") {
    await page.getByText(/create your stingstream account/i).first().waitFor({ timeout: 20000 });
    console.log(`[${vp.name}] setup screen after ${(Date.now() - t0) / 1000}s`);
    await shot(page, `${vp.name}-01-firstrun`);
    console.log(`[${vp.name}] overflow`, JSON.stringify(await overflow(page)));

    // Nothing typed -> inline validation, not a silent no-op.
    await page.locator('[data-testid="firstrun-submit"]').click();
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-02-firstrun-validation`);
    const errs = await page.locator('[role="alert"]').allInnerTexts();
    console.log(`[${vp.name}] validation messages:`, JSON.stringify(errs));
    if (errs.length === 0) findings.push(`${vp.name}: submitting an empty first-run form said nothing`);

    // A password that is too short, to prove the per-field rules.
    await page.locator('[data-testid="firstrun-username"]').fill("bad name");
    await page.locator('[data-testid="firstrun-password"]').fill("short");
    await page.locator('[data-testid="firstrun-confirm"]').fill("nope");
    await page.locator('[data-testid="firstrun-submit"]').click();
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-03-firstrun-badinput`);
    console.log(`[${vp.name}] bad-input messages:`, JSON.stringify(await page.locator('[role="alert"]').allInnerTexts()));

    if (vp.name === "1440") {
      await page.locator('[data-testid="firstrun-username"]').fill(USER);
      await page.locator('[data-testid="firstrun-password"]').fill(PASS);
      await page.locator('[data-testid="firstrun-confirm"]').fill(PASS);
      const tSubmit = Date.now();
      await page.locator('[data-testid="firstrun-submit"]').click();
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll("img")).some((i) => i.complete && i.naturalWidth > 0),
        { timeout: 60000 },
      );
      console.log(`[${vp.name}] home with a real poster ${(Date.now() - tSubmit) / 1000}s after submit`);
      await page.waitForTimeout(1500);
      await shot(page, `${vp.name}-04-home`);
    }
  } else {
    await page.getByText(/^sign in$/i).first().waitFor({ timeout: 20000 });
    console.log(`[${vp.name}] sign-in card after ${(Date.now() - t0) / 1000}s`);
    await shot(page, `${vp.name}-10-signin`);
    console.log(`[${vp.name}] overflow`, JSON.stringify(await overflow(page)));

    const codeLink = await page.locator('[data-testid="login-sign-in-with-code"]').count();
    console.log(`[${vp.name}] "Sign in with a code" present on web:`, codeLink);
    if (codeLink > 0) findings.push(`${vp.name}: the code link is on the web login`);

    await page.locator('[data-testid="login-username"]').fill(USER);
    await page.locator('[data-testid="login-password"]').fill("definitely-wrong");
    await page.locator('[data-testid="login-submit"]').click();
    await page.waitForSelector('[role="alert"]', { timeout: 20000 });
    await shot(page, `${vp.name}-11-signin-wrong`);
    console.log(`[${vp.name}] wrong-password message:`, JSON.stringify(await page.locator('[role="alert"]').allInnerTexts()));

    await page.locator('[data-testid="login-password"]').fill(PASS);
    const tSubmit = Date.now();
    await page.locator('[data-testid="login-submit"]').click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("img")).some((i) => i.complete && i.naturalWidth > 0),
      { timeout: 60000 },
    );
    console.log(`[${vp.name}] home ${(Date.now() - tSubmit) / 1000}s after sign in`);
    await page.waitForTimeout(1500);
    await shot(page, `${vp.name}-12-home`);
  }

  await ctx.close();
}

// The LAN case: same node, a browser that is not on its machine.
if (LAN) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  watch(page, "lan");
  await page.goto(LAN, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(6000);
  await shot(page, `lan-${PHASE}`);
  console.log("[lan] body text:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 220));
  await ctx.close();
}

await browser.close();
console.log("\n=== findings ===");
console.log(findings.length ? findings.join("\n") : "none");
