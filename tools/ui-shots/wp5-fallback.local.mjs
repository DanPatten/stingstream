// F-50's other half: what the details header draws when the artwork does NOT arrive.
//
//   node wp5-fallback.local.mjs --base http://127.0.0.1:8841 --creds <creds.json> --out <dir>
//
// The seeded node has real TMDB artwork for everything, so the happy path can never exercise
// the case pass-03 actually shipped: a poster URL that 404s and a logo that never lays out.
// This aborts every Primary/Logo image request and asserts the header still shows a title and
// a placeholder tile rather than two empty grey boxes.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { readCreds } from "./lib/authFile.mjs";
import { signIn } from "./flows/web.mjs";

const args = {};
for (let i = 0; i < process.argv.length - 2; i++) {
  const a = process.argv[i + 2];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 3];
}
const base = args.base || "http://127.0.0.1:8841";
const out = args.out || ".";
fs.mkdirSync(out, { recursive: true });

const findings = [];
const note = (kind, detail) => {
  findings.push({ kind, detail });
  console.log(`  ! ${kind}: ${detail}`);
};

async function main() {
  const creds = readCreds(args.creds);

  const auth = await fetch(`${base}/jellyfin/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        'MediaBrowser Client="wp5-fallback", Device="node", DeviceId="wp5-fallback", Version="0.0.1"',
    },
    body: JSON.stringify({ Username: creds.username, Pw: creds.password }),
  }).then((r) => r.json());

  const items = await fetch(
    `${base}/jellyfin/Users/${auth.User.Id}/Items?Recursive=true&IncludeItemTypes=Movie&Limit=50`,
    { headers: { Authorization: `MediaBrowser Token="${auth.AccessToken}"` } },
  ).then((r) => r.json());
  const movie = items.Items[0];
  console.log(`movie: ${movie.Name} (${movie.Id})`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await signIn(page, { base, user: creds.username, pass: creds.password });

    // Every poster and every wordmark fails from here on.
    await page.route("**/Images/Primary*", (route) => route.abort());
    await page.route("**/Images/Logo*", (route) => route.abort());

    await page.goto(`${base}/items/page?id=${movie.Id}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(out, "wp5-fallback-1440x900.png") });

    const header = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="details-header"]');
      if (!root) return null;
      const read = (id) => {
        const el = root.querySelector(`[data-testid="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          text: el.innerText.trim(),
        };
      };
      return { title: read("details-title"), poster: read("details-poster") };
    });

    if (!header) {
      note("no-header", "details-header is not on the page");
    } else {
      const { title, poster } = header;
      if (!title || !title.text)
        note("no-title", `no words in the header with the logo blocked: ${JSON.stringify(title)}`);
      else console.log(`  title: ${JSON.stringify(title.text.slice(0, 60))}`);

      if (!poster) note("no-poster", "details-poster is missing");
      else if (!poster.text)
        note("empty-poster", `the poster box is an empty ${poster.w}x${poster.h} box`);
      else console.log(`  poster placeholder: ${JSON.stringify(poster.text)} (${poster.w}x${poster.h})`);
    }

    await context.close();
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(out, "wp5-fallback-findings.json"), JSON.stringify(findings, null, 2));
  console.log(`\n${findings.length} finding(s). -> ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
