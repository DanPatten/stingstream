// WP4 hero + rows verification. Own chromium, own context — the shared MCP
// browser is being driven by several agents at once.
//
//   node verify.mjs --base http://127.0.0.1:8874 --out <dir> [--creds <file>] [--first-run]
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const BASE = arg("base", "http://127.0.0.1:8874");
const OUT = arg("out", "./shots");
const CREDS = arg("creds", null);
const TIMEOUT = 30000;

fs.mkdirSync(OUT, { recursive: true });

const byTestId = (page, id) => page.locator(`[data-testid="${id}"]`);
const seen = async (loc, ms = 8000) =>
  loc
    .first()
    .waitFor({ state: "visible", timeout: ms })
    .then(() => true)
    .catch(() => false);

const consoleErrors = [];
const netFailures = [];

const run = async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error")
      consoleErrors.push(`${page.url().replace(BASE, "")} :: ${msg.text()}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400)
      netFailures.push(`${res.status()} ${res.url().replace(BASE, "")}`);
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: TIMEOUT });

  // --- auth ---------------------------------------------------------------
  let creds = CREDS && fs.existsSync(CREDS) ? JSON.parse(fs.readFileSync(CREDS, "utf8")) : null;
  if (await seen(byTestId(page, "firstrun-username"), 15000)) {
    creds = creds ?? { username: "wp4", password: "wp4-password" };
    await byTestId(page, "firstrun-username").fill(creds.username);
    await byTestId(page, "firstrun-password").fill(creds.password);
    await byTestId(page, "firstrun-confirm").fill(creds.password);
    await byTestId(page, "firstrun-submit").click({ timeout: TIMEOUT });
    await byTestId(page, "firstrun-create-account")
      .waitFor({ state: "detached", timeout: TIMEOUT })
      .catch(() => {});
    if (CREDS) fs.writeFileSync(CREDS, JSON.stringify(creds, null, 2));
    console.log("signed up as", creds.username);
  } else if (await seen(byTestId(page, "login-username"), 5000)) {
    if (!creds) throw new Error("login screen but no --creds file");
    await byTestId(page, "login-username").fill(creds.username);
    await byTestId(page, "login-password").fill(creds.password);
    await byTestId(page, "login-submit").click({ timeout: TIMEOUT });
    await byTestId(page, "login-password")
      .waitFor({ state: "detached", timeout: TIMEOUT })
      .catch(() => {});
    console.log("signed in as", creds.username);
  } else {
    console.log("already signed in");
  }

  await page.waitForTimeout(6000);

  // --- per viewport -------------------------------------------------------
  const results = [];
  for (const vp of [
    { w: 1440, h: 900 },
    { w: 1024, h: 768 },
    { w: 390, h: 844 },
  ]) {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.waitForTimeout(3500);

    const hero = byTestId(page, "home-hero");
    const play = byTestId(page, "home-hero-play");
    const info = byTestId(page, "home-hero-info");
    const rows = byTestId(page, "home-row");
    const seeAll = byTestId(page, "home-row-see-all");

    const activeSlideText = () =>
      page.evaluate(() => {
        const hero = document.querySelector('[data-testid="home-hero"]');
        if (!hero) return null;
        const play = [...hero.querySelectorAll('[data-testid="home-hero-play"]')]
          .filter((e) => !e.closest('[aria-hidden="true"]'))[0];
        if (!play) return null;
        let el = play;
        while (el && el.parentElement !== hero) el = el.parentElement;
        return el ? el.innerText.slice(0, 90) : null;
      });

    const facts = {
      viewport: `${vp.w}x${vp.h}`,
      hero: await seen(hero, 10000),
      heroBox: await hero.first().boundingBox().catch(() => null),
      play: await seen(play, 5000),
      playLabel: await play.first().innerText().catch(() => null),
      info: await seen(info, 5000),
      infoLabel: await info.first().innerText().catch(() => null),
      rows: await rows.count(),
      seeAll: await seeAll.count(),
      activeSlide: await activeSlideText(),
      exposedPlayButtons: await page.evaluate(
        () =>
          [...document.querySelectorAll('[data-testid="home-hero-play"]')].filter(
            (el) => !el.closest('[aria-hidden="true"]'),
          ).length,
      ),
      dots: await page.locator('[aria-label^="Show item"]').count(),
    };

    // Structural heuristic the sweep uses: horizontally scrollable containers
    // holding >= 4 loaded posters.
    facts.posterRows = await page.evaluate(() => {
      let rows = 0;
      for (const el of document.querySelectorAll("*")) {
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        let loaded = 0;
        for (const img of el.querySelectorAll("img"))
          if (img.complete && img.naturalWidth > 0) loaded++;
        if (loaded >= 4) rows++;
      }
      return rows;
    });

    // Unnamed buttons, the F-24 check.
    facts.unnamedButtons = await page.evaluate(() =>
      [...document.querySelectorAll('[role="button"],button')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const name =
            el.getAttribute("aria-label") || el.innerText?.trim() || "";
          return name.length === 0;
        })
        .slice(0, 8)
        .map((el) => el.outerHTML.slice(0, 120)),
    );

    await page.screenshot({
      path: path.join(OUT, `home-${vp.w}.png`),
      fullPage: false,
    });
    results.push(facts);
    console.log(JSON.stringify(facts, null, 1));
  }

  // --- hover pause + arrows (1440 only) -----------------------------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(2500);
  const hero = byTestId(page, "home-hero").first();
  const active = () =>
    page.evaluate(() => {
      const h = document.querySelector('[data-testid="home-hero"]');
      if (!h) return null;
      const dots = [...h.querySelectorAll('[aria-label^="Show item"]')];
      const i = dots.findIndex((d) => d.getAttribute("aria-current") === "true");
      const shown = [...h.querySelectorAll('[data-testid="home-hero-play"]')]
        .filter((e) => !e.closest('[aria-hidden="true"]'))
        .map((e) => e.closest("div").parentElement.parentElement)
        .map((e) => e.innerText.split(String.fromCharCode(10)).slice(0, 3).join(" | "))
        .filter(Boolean)[0];
      return { dot: i, text: shown ?? null };
    });
  const before = await byTestId(page, "home-hero-play").first().innerText().catch(() => "");
  const beforeTitle = JSON.stringify(await active());
  await hero.hover();
  await page.screenshot({ path: path.join(OUT, "home-1440-hover.png") });
  await page.waitForTimeout(11000);
  const afterTitle = JSON.stringify(await active());
  const pausedOnHover = beforeTitle === afterTitle;
  console.log("hovered, before:", beforeTitle, "after:", afterTitle);
  console.log("auto-advance paused on hover:", pausedOnHover);

  // Arrow click advances.
  const nextArrow = page.locator('[aria-label="Next item"]');
  const arrowCount =
    (await nextArrow.count()) +
    (await page.locator('[aria-label="Previous item"]').count());
  if (arrowCount > 0) {
    await nextArrow.first().click();
    await page.waitForTimeout(1500);
  }
  const afterArrow = JSON.stringify(await active());
  console.log("arrows present:", arrowCount, "advanced:", afterArrow !== afterTitle);
  await page.screenshot({ path: path.join(OUT, "home-1440-after-arrow.png") });

  // Auto-advance runs when the pointer is elsewhere.
  await page.mouse.move(10, 880);
  const parked = JSON.stringify(await active());
  await page.waitForTimeout(11000);
  const moved = JSON.stringify(await active());
  console.log("off-hover, before:", parked, "after:", moved);
  console.log("auto-advance runs off-hover:", parked !== moved);

  // Continue-watching hero: label, chip and progress bar.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(8000);
  const resumeFacts = await page.evaluate(() => {
    const h = document.querySelector('[data-testid="home-hero"]');
    if (!h) return null;
    const play = [...h.querySelectorAll('[data-testid="home-hero-play"]')].filter(
      (e) => !e.closest('[aria-hidden="true"]'),
    )[0];
    let shown = play;
    while (shown && shown.parentElement !== h) shown = shown.parentElement;
    return {
      firstSlide: shown ? shown.innerText.slice(0, 160) : null,
      progressBars: [...h.querySelectorAll('[role="progressbar"]')].filter(
        (e) => !e.closest('[aria-hidden="true"]'),
      ).length,
    };
  });
  console.log("resume slide:", JSON.stringify(resumeFacts, null, 1));
  await page.screenshot({ path: path.join(OUT, "home-1440-resume.png") });

  fs.writeFileSync(
    path.join(OUT, "facts.json"),
    JSON.stringify(
      {
        results,
        pausedOnHover,
        arrowCount,
        autoAdvances: parked !== moved,
        resumeFacts,
        consoleErrors,
        netFailures: [...new Set(netFailures)],
      },
      null,
      1,
    ),
  );

  console.log("\n--- console errors:", consoleErrors.length);
  for (const e of consoleErrors.slice(0, 20)) console.log("  ", e);
  console.log("--- >=400 responses:", new Set(netFailures).size);
  for (const e of [...new Set(netFailures)].slice(0, 20)) console.log("  ", e);
  console.log("play label was:", before);

  await browser.close();
};

run().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
