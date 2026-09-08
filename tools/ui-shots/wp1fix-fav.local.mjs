import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";
const BASE = "http://127.0.0.1:8843";
const creds = readCreds("E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/creds.json");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" })).newPage();
await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
await page.waitForTimeout(4000);
await page.goto(`${BASE}/favorites`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
console.log("TEXT:", JSON.stringify((await page.locator("body").innerText()).slice(0, 300)));
const fonts = await page.evaluate(() => {
  const out = [];
  for (const e of document.querySelectorAll("*")) {
    if (e.children.length !== 0) continue;
    const t = (e.textContent || "").trim();
    if (!t) continue;
    const r = e.getBoundingClientRect();
    if (r.top < 60 || r.top > 500) continue;
    out.push({ t: t.slice(0, 24), font: getComputedStyle(e).fontFamily.slice(0, 20) });
  }
  return out;
});
console.log("fonts:", JSON.stringify(fonts, null, 1));
await page.screenshot({ path: "E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/shots/390-favorites.png" });
await browser.close();
