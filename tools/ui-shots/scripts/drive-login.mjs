#!/usr/bin/env node
// Helper for tools/ui-startup.ps1's second-launch pass: an ordinary sign-in against a node that
// has already been through first-run once, timing how long it takes to reach Home with a real
// poster. Prints `UI_STARTUP_RESULT {json}` as its last line.
//
// F-36 follow-up (WP2, 2026-09-06): this used to read admin credentials out of runtime.json
// (--pass-file). WP-CORE's setup renames the bootstrap admin and scrubs the generated password
// from runtime.json once setup completes -- by the time this script runs (always AFTER
// drive-startup.mjs has already driven first-run to completion on the same data dir), that read
// throws. --creds is the account drive-startup.mjs itself created and wrote, the same file format
// (and the same lib/authFile.mjs helpers) tools/ui-shots/shots.mjs's own --creds uses.
//
//   node drive-login.mjs --base http://127.0.0.1:8796 --out <dir> --creds <path to a
//     {username,password} JSON file>

import path from "node:path";
import { chromium } from "playwright";
import { signIn } from "../flows/web.mjs";
import { readCreds } from "../lib/authFile.mjs";

function parseArgs(argv) {
  const args = { base: null, out: null, creds: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") args.base = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--creds") args.creds = argv[++i];
  }
  if (!args.base || !args.out || !args.creds) {
    throw new Error("usage: drive-login.mjs --base <url> --out <dir> --creds <path to {username,password} JSON>");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = readCreds(args.creds);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
    const page = await context.newPage();

    const t0 = Date.now();
    await signIn(page, { base: args.base, user: creds.username, pass: creds.password });
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
