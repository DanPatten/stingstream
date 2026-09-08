// A focused walk of the Sharing screens, which `shots.mjs` only reaches the top of.
//
//   node sharing-audit.local.mjs --base http://127.0.0.1:8848 --out <dir> [--first-run]
//
// Four places the standard sweep never gets to: creating a group, the invite that follows it, the
// Advanced section expanded, and one group's detail screen. Every one of them is checked at three
// widths for the two failures that keep recurring here — an element clipped by its container, and
// a raw i18n key on screen.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createFirstRunAccount, signIn, VIEWPORTS } from "./flows/web.mjs";
import { flattenKeys, sweepDom, watchPage } from "./sweep.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean),
);
const BASE = args.base ?? "http://127.0.0.1:8848";
const OUT = args.out ?? "../../.local/ui-loop/audit/sharing";
const FIRST_RUN = process.argv.includes("--first-run");
const USER = "reviewer";
const PASS = "StingStreamReview1";
const i18nKeys = flattenKeys(
  JSON.parse(
    fs.readFileSync(
      path.resolve("../../apps/stingstream/translations/en.json"),
      "utf8",
    ),
  ),
);

fs.mkdirSync(OUT, { recursive: true });

/**
 * Anything whose painted box escapes a parent that clips it — the class of bug that put half a
 * radio button outside the New group card. Passed as a real function rather than a string so
 * Playwright calls it instead of handing back the source.
 */
const clipped = () => {
  const bad = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const p = el.parentElement;
    if (!p) continue;
    const pr = p.getBoundingClientRect();
    if (pr.width < 4) continue;
    const right = r.right > pr.right + 1;
    const left = r.left < pr.left - 1;
    if (!right && !left) continue;
    if (getComputedStyle(p).overflowX === "visible") continue;
    bad.push({
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || "").trim().slice(0, 40),
      by: Math.round(right ? r.right - pr.right : pr.left - r.left),
    });
  }
  return bad.slice(0, 8);
};

const findings = [];
const note = (where, kind, detail) => {
  findings.push({ where, kind, detail });
  console.log(`  ${kind.padEnd(14)} ${where}  ${detail}`);
};

const steps = [
  {
    id: "sharing",
    go: async (page) => {
      await page.goto(`${BASE}/settings/groups`, { waitUntil: "networkidle" });
    },
  },
  {
    id: "sharing-advanced",
    go: async (page) => {
      await page.goto(`${BASE}/settings/groups`, { waitUntil: "networkidle" });
      const advanced = page.getByText(/^Advanced$/i).first();
      if (await advanced.count()) await advanced.click();
      await page.waitForTimeout(900);
    },
  },
  {
    id: "create-group",
    go: async (page) => {
      await page.goto(`${BASE}/settings/groups/create`, {
        waitUntil: "networkidle",
      });
      await page.waitForTimeout(600);
    },
  },
  {
    // The screen Dan actually complained about: it used to show a QR *and* a 250-character code.
    id: "invite",
    go: async (page) => {
      await page.goto(`${BASE}/settings/groups/create`, {
        waitUntil: "networkidle",
      });
      const name = page.getByPlaceholder(/group name/i).first();
      await name.fill(`Audit ${Date.now().toString().slice(-5)}`);
      await page.getByText(/^Create group$/).first().click();
      // Minting asks the node for an invite, which is a round trip through Jellyfin.
      await page
        .getByText(/join#/i)
        .first()
        .waitFor({ timeout: 30000 })
        .catch(() => {});
      await page.waitForTimeout(1500);
    },
  },
  {
    id: "join-group",
    go: async (page) => {
      await page.goto(`${BASE}/settings/groups/join`, {
        waitUntil: "networkidle",
      });
      await page.waitForTimeout(400);
    },
  },
];

const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    colorScheme: "dark",
    reducedMotion: "reduce",
    deviceScaleFactor: vp.deviceScaleFactor ?? 1,
    hasTouch: vp.hasTouch ?? false,
    isMobile: vp.isMobile ?? false,
  });
  const page = await ctx.newPage();
  let currentStep = "sign-in";
  const monitor = watchPage(page, {
    screen: () => currentStep,
    viewport: vp.name,
  });

  if (FIRST_RUN && vp === VIEWPORTS[0]) {
    await createFirstRunAccount(page, {
      base: BASE,
      username: USER,
      password: PASS,
    });
  } else {
    await signIn(page, { base: BASE, user: USER, pass: PASS });
  }

  for (const step of steps) {
    const where = `${step.id} @ ${vp.name}`;
    currentStep = step.id;
    try {
      await step.go(page);
    } catch (e) {
      note(where, "navigate", String(e).slice(0, 120));
      continue;
    }
    await page.screenshot({
      path: path.join(OUT, `${step.id}-${vp.name}.png`),
      fullPage: true,
    });

    const dom = await sweepDom(page, {
      screen: step.id,
      viewport: vp.name,
      viewportWidth: vp.width,
      isMobile: !!vp.isMobile,
      i18nKeys,
    });
    for (const f of dom) note(where, f.kind ?? "sweep", JSON.stringify(f).slice(0, 160));
    for (const c of await page.evaluate(clipped))
      note(where, "clipped", `${c.tag} "${c.text}" by ${c.by}px`);

    const body = await page.locator("body").innerText();
    if (/\bPublic\b|\bPrivate\b/.test(body)) {
      note(where, "stale-copy", "Public/Private still on screen");
    }
    if (/sharing\.[a-z_]+/.test(body)) note(where, "raw-i18n-key", "sharing.*");
  }

  for (const f of monitor.findings)
    note(`${f.screen ?? "?"} @ ${vp.name}`, f.kind ?? "page", JSON.stringify(f).slice(0, 160));
  monitor.dispose();
  await ctx.close();
}

await browser.close();

fs.writeFileSync(
  path.join(OUT, "findings.json"),
  `${JSON.stringify(findings, null, 2)}\n`,
);
console.log(`\n${findings.length} finding(s) -> ${OUT}`);
