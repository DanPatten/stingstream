import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";
const BASE = "http://127.0.0.1:8843";
const creds = readCreds("E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/creds.json");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" })).newPage();
await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
await page.waitForTimeout(4000);
for (const [n, path] of [[1, "/favorites"], [2, "/manage"], [3, "/transfers"], [4, "/favorites"]]) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  for (const wait of [4000, 4000]) {
    await page.waitForTimeout(wait);
    const has = await page.evaluate(() => /No favorites yet/.test(document.body.innerText));
    if (path === "/favorites") console.log(`visit ${n} ${path}: empty state present = ${has}`);
    if (has) break;
  }
}
await browser.close();
