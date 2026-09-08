// WP-SEARCH-REQ (F-73) verification: its own chromium, its own contexts, no shared MCP browser.
//
//   node wp-search-req.local.mjs --base http://127.0.0.1:8844 --creds <creds.json> --out <dir> [--first-run]
//
// Drives the one thing F-73 asks for end to end: type one title into one box, get the library
// results and the catalogue results as two sections, press Request on something the server does
// not have, and find it on Requests -> My requests afterwards. Two widths, every console message
// recorded.

import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { createFirstRunAccount, signIn } from "./flows/web.mjs";
import { readCreds, writeCreds } from "./lib/authFile.mjs";

// A bare flag (`--first-run`) is `true`, not "whatever came next" — which is
// `undefined` when it is the last argument, and the next flag's name when it
// is not.
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args[a.slice(2)] = next && !next.startsWith("--") ? next : true;
}
const base = args.base || "http://127.0.0.1:8844";
const out = args.out || ".";
fs.mkdirSync(out, { recursive: true });

/** In the library on a seeded node. */
const IN_LIBRARY = args.have || "Sintel";
/** Not in the library, and something both arrs will find. */
const NOT_IN_LIBRARY = args.want || "Alien";
/** Nothing anywhere: no library row, no catalogue result, no second section. */
const NONSENSE = args.nothing || "zzqqxyzzyplugh";

const VIEWPORTS = [
  { id: "1440x900", width: 1440, height: 900 },
  {
    id: "390x844",
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  },
];

const findings = [];
const note = (kind, detail) => {
  findings.push({ kind, detail });
  console.log(`  ! ${kind}: ${detail}`);
};
const ok = (detail) => console.log(`  . ${detail}`);

const testId = (page, id) => page.locator(`[data-testid="${id}"]`);
const shot = (page, name) =>
  page.screenshot({ path: path.join(out, `${name}.png`), fullPage: false });

const visibleSoon = async (locator, timeout = 30000) => {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
};

/** What the two sections actually contain, read off the DOM rather than off a screenshot. */
async function readSections(page) {
  return page.evaluate(() => {
    const one = (id) => document.querySelector(`[data-testid="${id}"]`);
    const text = (el) => (el ? el.innerText.trim() : null);
    const library = one("search-library-section");
    const request = one("search-request-section");
    const cards = request
      ? [...request.querySelectorAll("[role=button]")]
          .map((b) => b.getAttribute("aria-label"))
          .filter(Boolean)
      : [];
    return {
      library: library ? { text: text(library).slice(0, 400) } : null,
      request: request
        ? { text: text(request).slice(0, 200), cards: cards.slice(0, 24) }
        : null,
      empty: !!one("search-empty"),
    };
  });
}

/** Any element wider than the window is a horizontal scrollbar somebody has to explain. */
const pageOverflow = (page) =>
  page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));

async function search(page, term) {
  await page.goto(`${base}/search?q=${encodeURIComponent(term)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
}

async function run(context, viewport) {
  const page = await context.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
    if (message.type() === "warning") consoleWarnings.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

  await signIn(page, { base, user: creds.username, pass: creds.password });
  ok(`signed in at ${viewport.id}`);

  // --- 0. a title nobody has -----------------------------------------------
  //
  // The "no second section" path, which is the same one a server without the
  // requests feature takes: nothing found either side, so neither section is
  // drawn and the empty state says so in one line.
  await search(page, NONSENSE);
  await page.waitForTimeout(4000);
  const nothing = await readSections(page);
  await shot(page, `search-nothing-${viewport.id}`);
  if (nothing.request) note("empty-box", "a request section for a term nothing matched");
  if (nothing.library) note("empty-box", "a library section for a term nothing matched");
  if (!nothing.empty) note("empty-state", "no search-empty for a term nothing matched");
  else ok(`nothing found -> one empty state, no sections`);

  // --- 1. a title the server has -----------------------------------------
  await search(page, IN_LIBRARY);
  await visibleSoon(testId(page, "search-library-section"), 30000);
  const have = await readSections(page);
  await shot(page, `search-have-${viewport.id}`);
  if (!have.library) note("missing-section", `"${IN_LIBRARY}": no search-library-section`);
  else ok(`"${IN_LIBRARY}" -> library section present`);
  if (have.request) {
    ok(`"${IN_LIBRARY}" -> request section also present (${have.request.cards.length} cards)`);
    // The dedupe rule: a title the server holds must not also be offered as one to ask for.
    for (const label of have.request.cards) {
      if (label && label.toLowerCase().startsWith(IN_LIBRARY.toLowerCase())) {
        note("dedupe", `"${label}" is in the library and still offered to request`);
      }
    }
  }

  // --- 2. a title it does not ---------------------------------------------
  await search(page, NOT_IN_LIBRARY);
  const gotRequest = await visibleSoon(testId(page, "search-request-section"), 45000);
  const want = await readSections(page);
  await shot(page, `search-want-${viewport.id}`);
  if (!gotRequest) {
    note("missing-section", `"${NOT_IN_LIBRARY}": no search-request-section`);
    await page.close();
    return { consoleErrors, consoleWarnings };
  }
  ok(`"${NOT_IN_LIBRARY}" -> ${want.request.cards.length} catalogue cards`);

  // --- 3. Request, through the sheet --------------------------------------
  const section = testId(page, "search-request-section");
  // Not simply the first card: a re-run against the same node finds the title
  // the last run asked for already badged "Requested", and its sheet offers a
  // disabled button. Pick one nobody has asked for yet.
  const firstCard = section
    .locator("[role=button]")
    .filter({ hasNotText: "Requested" })
    .first();
  const cardLabel = await firstCard.getAttribute("aria-label");

  if (!viewport.hasTouch) {
    // Web: the button is the hover affordance, so drive the pointer by hand.
    // `locator.click()` re-runs its own actionability pass, which moves the
    // mouse off the card and unmounts the very button it is aiming at.
    const cardBox = await firstCard.boundingBox();
    await page.mouse.move(
      cardBox.x + cardBox.width / 2,
      cardBox.y + cardBox.height / 2,
    );
    const button = await visibleSoon(testId(page, "search-request-button"), 5000);
    if (!button) note("hover", "search-request-button did not appear on hover");
    else ok("hover -> search-request-button");
    await shot(page, `search-hover-${viewport.id}`);
    const target = button
      ? await testId(page, "search-request-button").first().boundingBox()
      : cardBox;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.waitForTimeout(200);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
  } else {
    await firstCard.click();
  }

  const sheet = await visibleSoon(testId(page, "requests-sheet"), 15000);
  if (!sheet) {
    note("sheet", `pressing "${cardLabel}" did not open requests-sheet`);
    await page.close();
    return { consoleErrors, consoleWarnings };
  }
  ok(`sheet open for "${cardLabel}"`);
  // The dialog fades in; a shot taken the instant it mounts catches it at 40%.
  await page.waitForTimeout(900);
  await shot(page, `search-sheet-${viewport.id}`);

  const submit = testId(page, "requests-submit");
  const disabled = await submit.first().isDisabled().catch(() => false);
  if (disabled) note("sheet", `Request is disabled for "${cardLabel}"`);
  await submit.first().click();
  await testId(page, "requests-sheet")
    .first()
    .waitFor({ state: "detached", timeout: 30000 })
    .catch(() => note("sheet", "the sheet stayed open after Request"));
  await page.waitForTimeout(2500);
  await shot(page, `search-requested-${viewport.id}`);

  // --- 4. the card says so, and so does My requests ------------------------
  const after = await readSections(page);
  const requested = after.request?.text?.includes("Requested");
  if (!requested) note("badge", 'no "Requested" pill on the catalogue grid after asking');
  else ok('"Requested" pill on the grid');

  await page.goto(`${base}/requests`, { waitUntil: "domcontentloaded", timeout: 60000 });
  const listed = await visibleSoon(testId(page, "requests-list"), 20000);
  const rows = listed
    ? await testId(page, "requests-card").allInnerTexts()
    : [];
  await shot(page, `requests-mine-${viewport.id}`);
  if (!listed || rows.length === 0) {
    note("my-requests", "the request did not appear under My requests");
  } else {
    ok(`My requests: ${rows.length} row(s) — ${rows[0].split("\n")[0]}`);
  }
  const tabs = await testId(page, "requests-tabs").first().innerText().catch(() => "");
  if (/discover/i.test(tabs)) note("tabs", `Requests still shows a Discover tab: ${tabs.replace(/\n/g, " ")}`);
  else ok(`Requests tabs: ${tabs.replace(/\n/g, " / ")}`);

  const overflow = await pageOverflow(page);
  if (overflow.scrollWidth > overflow.innerWidth + 1) {
    note("overflow-page", `${overflow.scrollWidth}px in a ${overflow.innerWidth}px window`);
  }

  await page.close();
  return { consoleErrors, consoleWarnings };
}

let creds;

async function main() {
  const browser = await chromium.launch();
  try {
    if (args["first-run"]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
      });
      const page = await context.newPage();
      creds = await createFirstRunAccount(page, { base });
      writeCreds(args.creds, creds);
      console.log(`created the first-run account -> ${args.creds}`);
      await context.close();
    } else {
      creds = readCreds(args.creds);
    }

    const console_ = { errors: [], warnings: [] };
    for (const viewport of VIEWPORTS) {
      console.log(`\n== ${viewport.id} ==`);
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        isMobile: viewport.isMobile ?? false,
        hasTouch: viewport.hasTouch ?? false,
        colorScheme: "dark",
      });
      const { consoleErrors, consoleWarnings } = await run(context, viewport);
      for (const e of consoleErrors) {
        note("console-error", `${viewport.id}: ${e.slice(0, 200)}`);
        console_.errors.push(e);
      }
      console_.warnings.push(...consoleWarnings);
      await context.close();
    }

    console.log(`\nconsole: ${console_.errors.length} error(s), ${console_.warnings.length} warning(s)`);
    for (const w of [...new Set(console_.warnings)].slice(0, 10)) {
      console.log(`  ~ warning: ${w.slice(0, 160)}`);
    }
    fs.writeFileSync(
      path.join(out, "findings.json"),
      JSON.stringify({ base, findings, warnings: [...new Set(console_.warnings)] }, null, 2),
    );
    console.log(`\n${findings.length} finding(s) -> ${path.join(out, "findings.json")}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
