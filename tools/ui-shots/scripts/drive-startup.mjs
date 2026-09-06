#!/usr/bin/env node
// Helper for tools/ui-startup.ps1 -DriveUi: one Playwright pass over a freshly-started node --
// first-contentful-paint, the first-run "Create your StingStream account" screen when present
// (falling back to an ordinary sign-in with the runtime.json admin credentials until WP3 builds
// it), and a wait for Home to show a real poster. Prints one line, `UI_STARTUP_RESULT {json}`,
// which the calling PowerShell parses; everything else on stdout is just progress logging.
//
//   node drive-startup.mjs --base http://127.0.0.1:8796 --out <dir> [--user stingstream]
//     --pass-file <path to runtime.json> [--lan http://192.168.0.16:8796]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { connectAndSignIn } from "../flows/web.mjs";
import { readAdminCredentials } from "../lib/authFile.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { base: null, out: null, user: null, passFile: null, lan: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--user") args.user = argv[++i];
    else if (a === "--pass-file") args.passFile = argv[++i];
    else if (a === "--lan") args.lan = argv[++i];
  }
  if (!args.base || !args.out || !args.passFile) {
    throw new Error("usage: drive-startup.mjs --base <url> --out <dir> --pass-file <runtime.json> [--user <name>] [--lan <url>]");
  }
  return args;
}

async function measureFcpSeconds(page) {
  const fcpMs = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const existing = performance.getEntriesByName("first-contentful-paint")[0];
        if (existing) return resolve(existing.startTime);
        try {
          const obs = new PerformanceObserver((list) => {
            const entry = list.getEntriesByName("first-contentful-paint")[0];
            if (entry) {
              resolve(entry.startTime);
              obs.disconnect();
            }
          });
          obs.observe({ type: "paint", buffered: true });
        } catch {
          resolve(null);
        }
        setTimeout(() => resolve(null), 5000);
      }),
  );
  return fcpMs == null ? null : fcpMs / 1000;
}

async function waitForHomePoster(page, timeoutMs) {
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("img")).some((img) => img.complete && img.naturalWidth > 0),
    { timeout: timeoutMs },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = readAdminCredentials(args.passFile);
  const user = args.user || creds.username;

  const browser = await chromium.launch();
  const result = { fcpSeconds: null, setupSeconds: null, homeSeconds: null, lan: null };

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
    const page = await context.newPage();

    const t0 = Date.now();
    await page.goto(args.base, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.screenshot({ path: path.join(args.out, "startup-01-initial.png") });

    result.fcpSeconds = await measureFcpSeconds(page);
    console.log(`FCP: ${result.fcpSeconds}`);

    // First-run "Create your StingStream account" (WP3) if it exists yet; otherwise ordinary
    // sign-in with the seeded admin account. Text-matched, not testID-matched -- see
    // docs/UI-LOOP.md's testID contract and flows/web.mjs's file-header note on why.
    // waitFor (not isVisible, which does not retry and races the SPA's own hydration -- see
    // flows/web.mjs's isVisibleSoon note) so a slow-to-hydrate page is not mistaken for "no setup
    // screen exists".
    const setupHeading = page.getByText(/create your stingstream account/i).first();
    const hasSetupScreen = await setupHeading.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false);
    if (hasSetupScreen) {
      console.log("first-run setup screen found -- WP3 has landed");
      const tSetup = Date.now();
      await page.screenshot({ path: path.join(args.out, "startup-02-setup.png") });
      const usernameField = page.getByRole("textbox", { name: /username/i }).first();
      const passwordField = page.getByRole("textbox", { name: /^password$/i }).first();
      const confirmField = page.getByRole("textbox", { name: /confirm/i }).first();
      await usernameField.fill(user).catch(() => {});
      await passwordField.fill(creds.password).catch(() => {});
      if (await confirmField.waitFor({ state: "visible", timeout: 2000 }).then(() => true).catch(() => false)) {
        await confirmField.fill(creds.password).catch(() => {});
      }
      result.setupSeconds = (Date.now() - tSetup) / 1000;
      const submit = page.getByRole("button", { name: /create|continue|sign up|submit/i }).first();
      await submit.click({ timeout: 10000 }).catch(() => {});
      await page.screenshot({ path: path.join(args.out, "startup-03-submitted.png") });
    } else {
      console.log("no first-run setup screen yet (pre-WP3 build) -- falling back to sign-in");
      await connectAndSignIn(page, { base: args.base, user, pass: creds.password });
      await page.screenshot({ path: path.join(args.out, "startup-03-submitted.png") });
    }

    await waitForHomePoster(page, 20000);
    result.homeSeconds = (Date.now() - t0) / 1000;
    await page.screenshot({ path: path.join(args.out, "startup-04-home.png") });
    console.log(`home reached with a real poster after ${result.homeSeconds}s`);

    await context.close();

    if (args.lan) {
      const lanContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
      const lanPage = await lanContext.newPage();
      try {
        await lanPage.goto(args.lan, { waitUntil: "domcontentloaded", timeout: 15000 });
        const html = await lanPage.content();
        const hasMarker = html.includes('name="stingstream-node"');
        if (hasMarker) {
          const loopbackFalse = /"loopback":\s*false/.test(html);
          result.lan = loopbackFalse ? "marker present, loopback:false as expected" : "marker present but loopback was not false";
        } else {
          const sawFinishSetup = /finish setup on the computer/i.test(await lanPage.innerText("body").catch(() => ""));
          result.lan = sawFinishSetup
            ? "no marker yet (pre-WP-GATE); saw the finish-setup-elsewhere message"
            : "no marker yet (pre-WP-GATE); page loaded, no finish-setup message found (may be pre-WP-CORE too)";
        }
        await lanPage.screenshot({ path: path.join(args.out, "startup-lan.png") });
      } catch (err) {
        result.lan = `could not load --lan URL: ${err.message}`;
      } finally {
        await lanContext.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`UI_STARTUP_RESULT ${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
