import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";
const BASE = "http://127.0.0.1:8843";
const creds = readCreds("E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/creds.json");
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
const page = await ctx.newPage();
await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
await page.waitForTimeout(4000);
async function visit(tag) {
  await page.goto(BASE + "/favorites", { waitUntil: "domcontentloaded" });
  for (let i = 1; i <= 6; i++) {
    await page.waitForTimeout(3000);
    const has = await page.evaluate(() => /No favorites yet/.test(document.body.innerText));
    if (has) { console.log(`${tag}: present after ${i * 3}s`); return; }
  }
  console.log(`${tag}: never appeared (18s)`);
}
await visit("A first");
await visit("B second");
await page.goto(BASE + "/manage", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await visit("C after manage");
await browser.close();
