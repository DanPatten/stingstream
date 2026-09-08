// WP5 details verification: its own chromium, its own contexts, no shared MCP browser.
//
//   node wp5-details.mjs --base http://127.0.0.1:8825 --creds <creds.json> --out <dir>
//
// Signs in through the real login form, asks the node which items exist, then walks the
// movie / series / episode details pages at three widths, screenshotting each and recording
// every console error and every button with no accessible name.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readCreds, writeCreds } from "./lib/authFile.mjs";
import { createFirstRunAccount, signIn } from "./flows/web.mjs";

const args = {};
for (let i = 0; i < process.argv.length - 2; i++) {
  const a = process.argv[i + 2];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 3];
}
const base = args.base || "http://127.0.0.1:8825";
const out = args.out || ".";
fs.mkdirSync(out, { recursive: true });

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

const findings = [];
const note = (kind, detail, extra = {}) => {
  findings.push({ kind, detail, ...extra });
  console.log(`  ! ${kind}: ${detail}`);
};

async function jellyfin(pathname, token) {
  const res = await fetch(`${base}/jellyfin${pathname}`, {
    headers: { Authorization: `MediaBrowser Token="${token}"` },
  });
  if (!res.ok) throw new Error(`${res.status} ${pathname}`);
  return res.json();
}

/**
 * F-50: the header must show a title and a poster, never an empty box.
 *
 * Pass-03's regression was invisible to a screenshot diff and obvious to this:
 * the logo `<img>` had a natural width of 714 and laid out at 0x0, so the header
 * rendered no title at all. So the assertion is about *laid-out* pixels and
 * visible text, not about whether an element exists.
 */
async function probeHeader(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="details-header"]');
    if (!root) return null;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    // expo-image renders either an <img> or a div carrying a background-image;
    // both count as "artwork actually drawn" only if they occupy real pixels.
    const painted = (el) =>
      [...el.querySelectorAll("img")]
        .map((img) => ({ ...box(img), nw: img.naturalWidth, kind: "img" }))
        .concat(
          [...el.querySelectorAll("div")]
            .filter((d) => {
              const bg = getComputedStyle(d).backgroundImage;
              return bg && bg !== "none" && bg.includes("url(");
            })
            .map((d) => ({ ...box(d), nw: 1, kind: "bg" })),
        )
        .filter((c) => c.w > 8 && c.h > 8 && c.nw > 0);

    const titleEl = root.querySelector('[data-testid="details-title"]');
    const posterEl = root.querySelector('[data-testid="details-poster"]');
    return {
      title: titleEl
        ? {
            ...box(titleEl),
            text: titleEl.innerText.trim(),
            art: painted(titleEl),
          }
        : null,
      poster: posterEl
        ? {
            ...box(posterEl),
            text: posterEl.innerText.trim(),
            art: painted(posterEl),
          }
        : null,
    };
  });
}

/** F-57: nothing in a cast tile may be wider than the tile it sits in. */
async function probeCast(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="details-cast"]');
    if (!row) return { tiles: 0, overflows: [] };
    const tiles = [...row.querySelectorAll('[data-testid="cast-tile"]')];
    const overflows = [];
    for (const tile of tiles) {
      const t = tile.getBoundingClientRect();
      for (const el of tile.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.right > t.right + 1 || r.left < t.left - 1) {
          overflows.push(
            `${(el.innerText || el.tagName).trim().slice(0, 40)} ` +
              `${Math.round(r.width)}px in a ${Math.round(t.width)}px tile`,
          );
        }
      }
    }
    return { tiles: tiles.length, overflows };
  });
}

async function main() {
  let creds;
  if (args["first-run"]) {
    // A fresh node has no account yet: create one through the real form in its
    // own short-lived browser, then carry on exactly as a --creds run would.
    const setup = await chromium.launch();
    try {
      const context = await setup.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
      });
      const page = await context.newPage();
      creds = await createFirstRunAccount(page, { base });
      writeCreds(args.creds, creds);
      console.log(`created the first-run account -> ${args.creds}`);
      await context.close();
    } finally {
      await setup.close();
    }
  } else {
    creds = readCreds(args.creds);
  }

  // Authenticate over HTTP once, purely to look up item ids; the browser signs in for real.
  const auth = await fetch(`${base}/jellyfin/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        'MediaBrowser Client="wp5-verify", Device="node", DeviceId="wp5-verify", Version="0.0.1"',
    },
    body: JSON.stringify({ Username: creds.username, Pw: creds.password }),
  }).then((r) => r.json());
  const token = auth.AccessToken;
  const userId = auth.User.Id;

  const items = await jellyfin(
    `/Users/${userId}/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=Overview&Limit=200`,
    token,
  );
  const movie =
    items.Items.find((i) => /nosferatu/i.test(i.Name ?? "")) ||
    items.Items.find((i) => i.Type === "Movie");
  const series =
    items.Items.find((i) => /hillbillies/i.test(i.Name ?? "")) ||
    items.Items.find((i) => i.Type === "Series");
  const episodes = series
    ? await jellyfin(`/Shows/${series.Id}/Episodes?userId=${userId}&Limit=1`, token)
    : { Items: [] };
  const episode = episodes.Items?.[0];

  console.log(`movie:   ${movie?.Name} (${movie?.Id})`);
  console.log(`series:  ${series?.Name} (${series?.Id})`);
  console.log(`episode: ${episode?.Name} (${episode?.Id})`);

  const pages = [
    movie && { id: "movie", url: `${base}/items/page?id=${movie.Id}` },
    series && { id: "series", url: `${base}/series/${series.Id}` },
    episode && { id: "episode", url: `${base}/items/page?id=${episode.Id}` },
  ].filter(Boolean);

  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      const label = `${viewport.width}x${viewport.height}`;
      console.log(`\n=== ${label} ===`);
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: !!viewport.isMobile,
        hasTouch: !!viewport.hasTouch,
        deviceScaleFactor: viewport.deviceScaleFactor || 1,
        colorScheme: "dark",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      let screen = "(signin)";
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        // WP4 owns the plugin probe (F-23); it is not this package's finding.
        if (text.includes("Streamyfin/config")) return;
        if (text.includes("status of 404")) return;
        note("console", text.slice(0, 240), { screen, viewport: label });
      });
      page.on("pageerror", (err) =>
        note("pageerror", String(err).slice(0, 240), { screen, viewport: label }),
      );

      await signIn(page, { base, user: creds.username, pass: creds.password });

      // Home too, since the hero's runtime badge comes from the same formatter
      // the details page uses (WP5 follow-up: one `formatRuntimeTicks`).
      screen = "home";
      await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(4500);
      await page.screenshot({ path: path.join(out, `wp5-home-${label}.png`) });
      const heroText = await page.evaluate(() => document.body.innerText.slice(0, 400));
      if (/0m/.test(heroText)) note("zero-runtime", "a badge still reads 0m", { screen, viewport: label });

      for (const target of pages) {
        screen = target.id;
        console.log(`  ${target.id}`);
        await page.goto(target.url, { waitUntil: "domcontentloaded" });
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(4500);

        await page.screenshot({
          path: path.join(out, `wp5-${target.id}-${label}.png`),
          fullPage: false,
        });
        await page.screenshot({
          path: path.join(out, `wp5-${target.id}-${label}-full.png`),
          fullPage: true,
        });

        // Every button with no accessible name (F-24) and anything that overflows the viewport.
        const dom = await page.evaluate(() => {
          const nameOf = (el) =>
            (
              el.getAttribute("aria-label") ||
              el.getAttribute("title") ||
              el.textContent ||
              ""
            ).trim();
          const unnamed = [...document.querySelectorAll('[role="button"], button, a')]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 8 && r.height > 8 && !nameOf(el);
            })
            .map((el) => {
              const r = el.getBoundingClientRect();
              return `${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)},${Math.round(r.y)}`;
            });
          const ids = [
            "details-header",
            "details-play",
            "details-more",
            "details-cast",
            "details-episodes",
            "details-technical",
          ].filter((id) => document.querySelector(`[data-testid="${id}"]`));
          return {
            unnamed,
            testIds: ids,
            horizontalOverflow:
              document.documentElement.scrollWidth > window.innerWidth + 1,
            title: document.title,
          };
        });
        console.log(`    testIDs: ${dom.testIds.join(", ") || "(none)"}`);

        // F-50, the pass-03 regression: a header with no title and an empty
        // grey box where the poster belongs.
        const header = await probeHeader(page);
        if (!header) {
          note("no-header", "details-header is not on the page", { screen, viewport: label });
        } else {
          const t = header.title;
          if (!t) {
            note("no-title", "details-title is missing from the header", { screen, viewport: label });
          } else {
            const logo = t.art.find((a) => a.w > 8 && a.h > 8);
            if (!t.text && !logo)
              note("no-title", `the header shows no title: box ${t.w}x${t.h}, no logo drawn`, { screen, viewport: label });
            else
              console.log(`    title: ${logo ? `logo ${logo.w}x${logo.h}` : `text ${JSON.stringify(t.text.slice(0, 48))}`}`);
            if (t.text && logo)
              note("double-title", "both the logo and the words are drawn", { screen, viewport: label });
          }
          // The poster box only exists at >=768; at 390 the artwork is the
          // page's own parallax header, so its absence there is correct.
          const p = header.poster;
          if (p) {
            const art = p.art.find((a) => a.w > 8 && a.h > 8);
            if (!art && !p.text)
              note("empty-poster", `the poster box is empty: ${p.w}x${p.h}`, { screen, viewport: label });
            else
              console.log(`    poster: ${art ? `${art.kind} ${art.w}x${art.h}` : `placeholder ${JSON.stringify(p.text)}`}`);
          } else if (viewport.width >= 768) {
            note("no-poster", "no details-poster at a width that should have one", { screen, viewport: label });
          }
        }
        // Episode rows carry a runtime detail line: it must never end in a
        // pointless "0s", and never read "0h 0m" for a title with no runtime.
        const runtimeText = await page.evaluate(() => document.body.innerText);
        if (/\d+m 0s/.test(runtimeText))
          note("zero-seconds", "a runtime still reads 'Xm 0s'", { screen, viewport: label });
        if (/0h 0m/.test(runtimeText))
          note("zero-runtime", "a runtime still reads '0h 0m'", { screen, viewport: label });
        for (const u of dom.unnamed)
          note("unnamed-control", u, { screen, viewport: label });
        if (dom.horizontalOverflow)
          note("h-overflow", "the page scrolls horizontally", {
            screen,
            viewport: label,
          });

        // The body: scroll to the technical disclosure, open it, and capture the
        // sections between here and there (cast, episodes, related).
        const technical = page.locator('[data-testid="details-technical"]');
        if (await technical.count()) {
          await technical.first().scrollIntoViewIfNeeded();
          await page.waitForTimeout(1200);
          await page.screenshot({
            path: path.join(out, `wp5-${target.id}-${label}-body.png`),
          });
          await technical.first().click();
          await page.waitForTimeout(600);
          await technical.first().scrollIntoViewIfNeeded();
          await page.waitForTimeout(400);
          await page.screenshot({
            path: path.join(out, `wp5-${target.id}-${label}-technical.png`),
          });
        }
        const cast = page.locator('[data-testid="details-cast"]');
        if (await cast.count()) {
          await cast.first().scrollIntoViewIfNeeded();
          await page.waitForTimeout(1200);
          await page.screenshot({
            path: path.join(out, `wp5-${target.id}-${label}-cast.png`),
          });
          // F-57: a role caption that measured wider than its 112px tile.
          const tiles = await probeCast(page);
          console.log(`    cast: ${tiles.tiles} tile(s)`);
          for (const o of tiles.overflows)
            note("cast-overflow", o, { screen, viewport: label });
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);

        // The "…" menu, where the rest of the actions live.
        const more = page.locator('[data-testid="details-more"]');
        if (await more.count()) {
          await more.first().click();
          await page.waitForTimeout(700);
          await page.screenshot({
            path: path.join(out, `wp5-${target.id}-${label}-more.png`),
          });
          await page.keyboard.press("Escape");
          await page.waitForTimeout(400);
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(
    path.join(out, "wp5-findings.json"),
    JSON.stringify(findings, null, 2),
  );
  console.log(`\n${findings.length} finding(s). -> ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
