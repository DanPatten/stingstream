import { chromium } from "playwright";
const origin = process.argv[2]; const out = process.argv[3];
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" }); const page = await ctx.newPage();
const ev = []; page.on("console", (m) => ev.push(`${m.type()}: ${m.text().slice(0, 240)}`)); page.on("pageerror", (e) => ev.push(`PAGEERROR: ${String(e).slice(0, 400)}`)); page.on("requestfailed", (r) => ev.push(`REQFAILED: ${r.url().slice(0, 140)} ${r.failure()?.errorText}`));
await page.goto(origin + "/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => ev.push("GOTO " + e));
for (const s of [3, 8, 15, 25]) { await new Promise((r) => setTimeout(r, s === 3 ? 3000 : 5000 * (s === 8 ? 1 : s === 15 ? 1.4 : 2))); const st = await page.evaluate(() => ({ rootChildren: document.getElementById("root")?.children.length ?? -1, splash: (() => { const e = document.getElementById("ss-splash"); return e ? getComputedStyle(e).opacity : "gone"; })(), secure: window.isSecureContext, text: document.body.innerText.replace(/\s+/g, " ").slice(0, 120) })); console.log(`t≈${s}s`, JSON.stringify(st)); }
await page.screenshot({ path: out });
console.log("events:"); for (const e of ev.filter((x) => !x.startsWith("log:"))) console.log("  " + e);
await b.close();
