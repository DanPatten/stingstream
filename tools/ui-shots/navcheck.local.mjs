import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";

/**
 * Local, throwaway: how long a settings navigation takes, and how many screens
 * the stack is holding while it happens. Dan reported "lag when clicking on
 * settings or away from settings"; the suspicion is the stack growing one
 * screen per category click, so this counts both.
 */

const base = process.argv[2] ?? "http://127.0.0.1:8799";
const credsPath = process.argv[3];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  reducedMotion: "reduce",
});
const page = await ctx.newPage();
page.on("response", (r) => {
  if (r.status() >= 400) console.log(`  HTTP ${r.status()} ${r.url()}`);
});

const creds = readCreds(credsPath);
await signIn(page, { base, user: creds.username, pass: creds.password });

/** Click something and wait for the URL to actually change. */
const timedClick = async (label, locator, expectPath) => {
  const before = page.url();
  const t0 = Date.now();
  await locator.click();
  try {
    await page.waitForURL((u) => u.pathname === expectPath, { timeout: 15000 });
  } catch {
    console.log(`  ${label}: URL never became ${expectPath} (still ${page.url()})`);
    return;
  }
  const settled = Date.now() - t0;
  const nodes = await page.locator('[data-testid="settings-nav"]').count();
  const domNodes = await page.evaluate(() => document.querySelectorAll("*").length);
  console.log(
    `  ${label}: ${settled}ms   nav columns mounted: ${nodes}   DOM nodes: ${domNodes}`,
  );
  if (before === page.url()) console.log("    (url did not change!)");
};

const visible = async (testId) => {
  const all = page.locator(`[data-testid="${testId}"]`);
  const n = await all.count();
  for (let i = 0; i < n; i++) {
    if (await all.nth(i).isVisible()) return all.nth(i);
  }
  return null;
};

console.log("\n— into settings from Home —");
await page.goto(new URL("/", base).toString(), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await timedClick("Home -> Settings", await visible("tab-settings"), "/settings");

console.log("\n— category to category —");
for (const [id, path] of [
  ["settings-nav-transcoding", "/settings/transcoding"],
  ["settings-nav-network", "/settings/network"],
  ["settings-nav-profile", "/settings/profile"],
  ["settings-nav-servers", "/settings/servers"],
  ["settings-nav-users", "/settings/users"],
  ["settings-nav-playback", "/settings/playback"],
  ["settings-nav-storage", "/settings/storage"],
]) {
  const target = await visible(id);
  if (!target) {
    console.log(`  ${id}: not visible`);
    continue;
  }
  await timedClick(id.replace("settings-nav-", ""), target, path);
}

console.log("\n— out of settings —");
await timedClick("Settings -> Home", await visible("tab-home"), "/");
await timedClick("Home -> Requests", await visible("tab-requests"), "/requests");

await browser.close();
