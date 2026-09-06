#!/usr/bin/env node
// Helper for tools/ui-startup.ps1's second-launch pass: an ordinary sign-in against a node that
// has already been through first-run once, timing how long it takes to reach Home with a real
// poster. Prints `UI_STARTUP_RESULT {json}` as its last line.
//
//   node drive-login.mjs --base http://127.0.0.1:8796 --out <dir> [--user stingstream]
//     --pass-file <path to runtime.json>

import path from "node:path";
import { chromium } from "playwright";
import { connectAndSignIn } from "../flows/web.mjs";
import { readAdminCredentials } from "../lib/authFile.mjs";

function parseArgs(argv) {
  const args = { base: null, out: null, user: null, passFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--user") args.user = argv[++i];
    else if (a === "--pass-file") args.passFile = argv[++i];
  }
  if (!args.base || !args.out || !args.passFile) {
    throw new Error("usage: drive-login.mjs --base <url> --out <dir> --pass-file <runtime.json> [--user <name>]");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = readAdminCredentials(args.passFile);
  const user = args.user || creds.username;

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
    const page = await context.newPage();

    const t0 = Date.now();
    await connectAndSignIn(page, { base: args.base, user, pass: creds.password });
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("img")).some((img) => img.complete && img.naturalWidth > 0),
      { timeout: 15000 },
    );
    const homeSeconds = (Date.now() - t0) / 1000;
    await page.screenshot({ path: path.join(args.out, "startup-05-second-launch-home.png") });
    console.log(`second-launch home reached after ${homeSeconds}s`);
    await context.close();
    console.log(`UI_STARTUP_RESULT ${JSON.stringify({ homeSeconds })}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
