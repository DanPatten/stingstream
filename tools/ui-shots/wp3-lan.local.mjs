// The one case a loopback browser can never show: a fresh node, seen from another machine.
import { chromium } from "playwright";
const [, , lan, out] = process.argv;
const findings = [];
const browser = await chromium.launch();
for (const vp of [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
]) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor,
    colorScheme: "dark", reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") findings.push(`console ${vp.name}: ${m.text()}`); });
  page.on("pageerror", (e) => findings.push(`pageerror ${vp.name}: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400) findings.push(`http ${vp.name}: ${r.status()} ${r.url()}`); });
  await page.goto(lan, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator('[data-testid="setup-elsewhere"]').waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${out}/${vp.name}-05-setup-elsewhere.png` });
  console.log(`[${vp.name}]`, (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200));
  const ov = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  console.log(`[${vp.name}] horizontal scroll:`, ov);
  await ctx.close();
}
await browser.close();
console.log("\n=== findings ===\n" + (findings.length ? findings.join("\n") : "none"));
