import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";
const BASE = "http://127.0.0.1:8843";
const creds = readCreds("E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/creds.json");
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
const msgs = [];
page.on("pageerror", (e) => msgs.push("pageerror: " + String(e).slice(0, 400)));
page.on("console", (m) => { if (m.type() === "error") msgs.push("console: " + m.text().slice(0, 300)); });
await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
await page.waitForTimeout(6000);
const ids = await page.evaluate(() =>
  [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")).slice(0, 40),
);
console.log("testids:", JSON.stringify(ids));
console.log("messages:\n  " + msgs.slice(0, 10).join("\n  "));
await page.screenshot({ path: "E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/shots/quick-1440.png" });
await browser.close();
