import { chromium } from "playwright";
const base = process.argv[2], out = process.argv[3];
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" }); const page = await ctx.newPage();
const ev = []; page.on("console", (m) => { if (m.type() !== "log") ev.push(`${m.type()}: ${m.text().slice(0, 200)}`); }); page.on("pageerror", (e) => ev.push("PAGEERROR " + String(e).slice(0, 300)));
for (const p of ["/login", "/"]) { await page.goto(base + p, { waitUntil: "domcontentloaded" }); await new Promise((r) => setTimeout(r, 8000)); const st = await page.evaluate(() => ({ url: location.href, firstrun: !!document.querySelector('[data-testid="firstrun-username"]'), login: !!document.querySelector('[data-testid="login-username"]'), serverForm: !!document.querySelector('[data-testid="login-server-url"]'), setupElsewhere: !!document.querySelector('[data-testid="setup-elsewhere"]'), text: document.body.innerText.replace(/\s+/g, " ").slice(0, 160) })); console.log(p, JSON.stringify(st)); await page.screenshot({ path: `${out}/probe-restart${p.replace("/", "-") || "-root"}.png` }); }
console.log("events:", JSON.stringify(ev.slice(0, 15)));
await b.close();
