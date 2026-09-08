import { chromium } from "playwright";
import { signIn } from "./flows/web.mjs";
import { readCreds } from "./lib/authFile.mjs";

const BASE = "http://127.0.0.1:8843";
const creds = readCreds("E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/creds.json");
const browser = await chromium.launch();

function smallTargets() {
  const out = [];
  for (const e of document.querySelectorAll('button,a,[role="button"]')) {
    const r = e.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.width >= 40 && r.height >= 40) continue;
    out.push({
      tag: e.tagName.toLowerCase(),
      label: e.getAttribute("aria-label") || (e.textContent || "").trim().slice(0, 24),
      testid: e.getAttribute("data-testid"),
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
    });
  }
  return out;
}

function topText() {
  const out = [];
  for (const e of document.querySelectorAll("*")) {
    if (e.children.length !== 0) continue;
    const txt = (e.textContent || "").trim();
    if (!txt) continue;
    const r = e.getBoundingClientRect();
    if (r.top > 130 || r.width === 0) continue;
    const cs = getComputedStyle(e);
    out.push({ text: txt.slice(0, 28), y: Math.round(r.top), size: cs.fontSize, font: cs.fontFamily.slice(0, 22) });
  }
  return out;
}

{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
  await page.waitForTimeout(4000);
  for (const [name, path] of [["home", "/"], ["favorites", "/favorites"], ["manage", "/manage"], ["transfers", "/transfers"], ["requests", "/requests"]]) {
    await page.goto(new URL(path, BASE).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const small = await page.evaluate(smallTargets);
    console.log(`\n[390 ${name}] small targets: ${small.length}`);
    for (const s of small) console.log("   ", JSON.stringify(s));
  }
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  await signIn(page, { base: BASE, user: creds.username, pass: creds.password });
  await page.waitForTimeout(4000);
  const brand = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="shell-brand"]');
    const svg = b && b.querySelector("svg");
    const home = document.querySelector('[data-testid="tab-home"]');
    const glyph = home && home.querySelector("svg");
    return {
      brand: b && b.getBoundingClientRect().toJSON(),
      svg: svg && svg.getBoundingClientRect().toJSON(),
      homeRow: home && home.getBoundingClientRect().toJSON(),
      homeGlyph: glyph && glyph.getBoundingClientRect().toJSON(),
    };
  });
  console.log("\n[1440] brand:", JSON.stringify(brand, null, 1));
  for (const [name, path] of [["settings", "/settings"], ["sharing", "/sharing"]]) {
    await page.goto(new URL(path, BASE).toString(), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    console.log(`\n[1440 ${name}] text in the top 130 px:`);
    for (const h of await page.evaluate(topText)) console.log("   ", JSON.stringify(h));
  }
  await ctx.close();
}
await browser.close();
