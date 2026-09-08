// One shot of the Requests empty state, which only exists when nothing has been asked for.
import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith("--") ? next : true;
}
const base = args.base;
const creds = readCreds(args.creds);
const browser = await chromium.launch();
for (const v of [
  { id: "1440x900", width: 1440, height: 900 },
  { id: "390x844", width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
]) {
  const context = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.deviceScaleFactor ?? 1,
    isMobile: v.isMobile ?? false,
    hasTouch: v.hasTouch ?? false,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log(`  console-error: ${m.text().slice(0, 200)}`); });
  await signIn(page, { base, user: creds.username, pass: creds.password });
  await page.goto(`${base}/requests`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${args.out}/requests-empty-${v.id}.png` });
  console.log(v.id, JSON.stringify(await page.evaluate(() => {
    const t = document.querySelector('[data-testid="requests-tabs"]');
    return { tabs: t ? t.innerText.replace(/\n/g, " / ") : null, body: document.body.innerText.slice(0, 300) };
  })));
  // The empty state's own action must actually reach Search. Located by its
  // label rather than by role: react-native-web puts the accessible name on the
  // Pressable and the text in a child div, so getByRole(name:) misses it.
  const box = await page.evaluate(() => {
    for (const e of document.querySelectorAll("div")) {
      if ((e.innerText || "").trim() !== "Search") continue;
      const r = e.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return null;
  });
  if (box) {
    await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
    await page.waitForTimeout(2500);
    console.log(`  ${v.id} -> after pressing Search: ${page.url()}`);
  } else {
    console.log(`  ${v.id} -> no Search button on the empty state`);
  }
  await context.close();
}
await browser.close();
