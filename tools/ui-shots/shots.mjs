#!/usr/bin/env node
// WP-TOOLS UI iterate loop: screenshot every screen at every viewport, sweep each one for
// findings, and write a report. See docs/UI-LOOP.md.
//
//   node shots.mjs --base http://127.0.0.1:8795 --out ..\.win-temp\ui-loop\pass-00\web \
//     --pass-file ..\.win-temp\ui-loop\data\runtime.json [--user stingstream] \
//     [--first-run] [--lan http://192.168.0.16:8795] [--only 02-home,05-details]
//
// One browser, one fresh context per viewport (dark, reduced-motion, per the plan), one page per
// context walked through every screen IN ORDER so a screen that depends on a prior action (Details
// after clicking a poster on Home, the player after Details) actually has something to click.
// Every screen's navigate() is wrapped in try/catch: a screen this build cannot reach yet records
// a "navigate-failed" finding and the loop moves on, rather than losing the rest of the pass.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { VIEWPORTS, buildScreens, connectAndSignIn } from "./flows/web.mjs";
import { watchPage, sweepDom, flattenKeys } from "./sweep.mjs";
import { buildReport } from "./report.mjs";
import { readAdminCredentials } from "./lib/authFile.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  const args = { base: null, out: null, user: null, passFile: null, firstRun: false, lan: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--user") args.user = argv[++i];
    else if (a === "--pass-file") args.passFile = argv[++i];
    else if (a === "--first-run") args.firstRun = true;
    else if (a === "--lan") args.lan = argv[++i];
    else if (a === "--only") args.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.base) throw new Error("--base is required");
  if (!args.out) throw new Error("--out is required");
  return args;
}

function loadI18nKeys() {
  const enPath = path.join(REPO_ROOT, "apps/stingstream/translations/en.json");
  try {
    const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
    return flattenKeys(en);
  } catch (err) {
    console.warn(`could not load ${enPath} for the i18n-key check: ${err.message}`);
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });

  let user = args.user;
  let pass = null;
  if (args.passFile) {
    const creds = readAdminCredentials(args.passFile);
    user = user || creds.username;
    pass = creds.password;
  }

  const i18nKeys = loadI18nKeys();
  const allScreens = buildScreens({ base: args.base, user, pass, firstRunUrl: args.base, lanUrl: args.lan });
  const screens = args.only ? allScreens.filter((s) => args.only.includes(s.id)) : allScreens;
  if (screens.length === 0) {
    throw new Error(`--only matched no screens (have: ${allScreens.map((s) => s.id).join(", ")})`);
  }

  const allFindings = [];
  const browser = await chromium.launch();

  try {
    for (const viewport of VIEWPORTS) {
      console.log(`\n=== viewport ${viewport.name} ===`);
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: !!viewport.isMobile,
        hasTouch: !!viewport.hasTouch,
        deviceScaleFactor: viewport.deviceScaleFactor || 1,
        colorScheme: "dark",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();

      let currentScreenId = "(startup)";
      const monitor = watchPage(page, { screen: () => currentScreenId, viewport: viewport.name });

      let signedIn = false;
      for (const screen of screens) {
        currentScreenId = screen.id;
        const requiresAuth = !!screen.requiresAuth;
        try {
          if (requiresAuth && !signedIn) {
            if (!pass) throw new Error("this screen needs sign-in but no --pass-file was given");
            await connectAndSignIn(page, { base: args.base, user, pass });
            signedIn = true;
          }
          await screen.navigate(page, { base: args.base });
          await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

          const shotPath = path.join(args.out, `${screen.id}-${viewport.name}.png`);
          await page.screenshot({ path: shotPath, fullPage: false });
          console.log(`  ${screen.id.padEnd(20)} ok -> ${path.basename(shotPath)}`);

          const domFindings = await sweepDom(page, {
            screen: screen.id,
            viewport: viewport.name,
            viewportWidth: viewport.width,
            isMobile: !!viewport.isMobile,
            i18nKeys,
            checkHomeStructure: screen.id === "02-home" && viewport.width >= 1440,
          });
          allFindings.push(...domFindings);
        } catch (err) {
          const detail = err && err.message ? err.message : String(err);
          if (screen.optional) {
            console.log(`  ${screen.id.padEnd(20)} skip (${detail})`);
          } else {
            console.log(`  ${screen.id.padEnd(20)} FAIL (${detail})`);
          }
          allFindings.push({
            screen: screen.id,
            viewport: viewport.name,
            kind: "navigate-failed",
            severity: screen.optional ? "warning" : "error",
            detail,
          });
        }
      }

      allFindings.push(...monitor.findings);
      monitor.dispose();
      await context.close();
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(args.out, "findings.json"), JSON.stringify(allFindings, null, 2));
  const { json, md } = buildReport(allFindings, {
    title: `UI loop screenshots -- ${args.base}`,
    screens: screens.map((s) => s.id),
    viewports: VIEWPORTS.map((v) => v.name),
  });
  fs.writeFileSync(path.join(args.out, "report.json"), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(args.out, "report.md"), md);

  console.log(`\n${allFindings.length} finding(s) across ${screens.length} screen(s) x ${VIEWPORTS.length} viewport(s).`);
  console.log(`report: ${path.join(args.out, "report.md")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
