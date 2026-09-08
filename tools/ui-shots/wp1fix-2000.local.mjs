// Dan's screenshot was ~2000 px wide: the same three checks at that width.
import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";
const BASE = "http://127.0.0.1:8843";
const SHOTS = "E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/shots";
const creds = readCreds("E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/creds.json");
const results = [];
const check = (ok, name, detail) => results.push({ ok, name, detail });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 2000, height: 1100 }, colorScheme: "dark" });
const page = await ctx.newPage();
await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
await page.waitForTimeout(5000);

check((await page.locator('[data-testid="shell-topbar"] [data-testid="shell-user-menu"]').count()) === 0, "Dan-1 2000: no avatar in the top-right cluster");
check((await page.locator('[data-testid="shell-sidebar"] [data-testid="shell-user-menu"]').count()) === 1, "Dan-1 2000: one account row, in the sidebar");

const overlap = await page.evaluate(() => {
  const bar = document.querySelector('[data-testid="shell-sidebar"]');
  const boxes = [];
  for (const e of bar.querySelectorAll("*")) {
    if (e.children.length !== 0) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.top > 90) continue;
    boxes.push({ txt: (e.textContent || "").trim().slice(0, 16), ...r.toJSON() });
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
        return `${a.txt} over ${b.txt}`;
    }
  return "";
});
check(overlap === "", "Dan-2 2000: nothing overlaps in the sidebar header", overlap);
await page.screenshot({ path: `${SHOTS}/2000-home.png` });

await page.locator('[data-testid="shell-sidebar"] [data-testid="shell-user-menu"]').click();
await page.waitForTimeout(1500);
const pop = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="shell-user-menu-popover"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { top: Math.round(r.top), left: Math.round(r.left), bg: cs.backgroundColor, opacity: cs.opacity };
});
check(pop !== null, "Dan-3 2000: the account menu renders");
check(pop !== null && !/rgba\(0, 0, 0, 0\)/.test(pop.bg) && pop.opacity === "1", "Dan-3 2000: opaque", pop && `${pop.bg} @ ${pop.opacity}`);
check(pop !== null && pop.top > 200, "Dan-3 2000: at the account row, not the corner", pop && `top=${pop.top}`);
await page.screenshot({ path: `${SHOTS}/2000-user-menu.png` });
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);

await page.locator('[data-testid="shell-sidebar-toggle"]').click();
await page.waitForTimeout(1000);
const w = await page.evaluate(() => Math.round(document.querySelector('[data-testid="shell-sidebar"]').getBoundingClientRect().width));
check(w === 72, "F-70 2000: the toggle still collapses", w);
await page.screenshot({ path: `${SHOTS}/2000-rail.png` });
const railOverlap = await page.evaluate(() => {
  const bar = document.querySelector('[data-testid="shell-sidebar"]');
  const boxes = [];
  for (const e of bar.querySelectorAll("*")) {
    if (e.children.length !== 0) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.top > 90) continue;
    boxes.push({ txt: (e.textContent || "").trim().slice(0, 16), ...r.toJSON() });
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
        return `${a.txt} over ${b.txt}`;
    }
  return "";
});
check(railOverlap === "", "Dan-2 2000 collapsed: nothing overlaps", railOverlap);
await browser.close();
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail !== undefined ? "  — " + r.detail : ""}`);
}
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
