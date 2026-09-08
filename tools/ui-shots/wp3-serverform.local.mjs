// "Use a different server" on a node-served build: it lives behind Advanced, it works, and
// Cancel comes back to the node's own sign-in card.
import { chromium } from "playwright";
const [, , base, out] = process.argv;
const findings = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") findings.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => findings.push(`pageerror: ${e.message}`));
page.on("response", (r) => { if (r.status() >= 400) findings.push(`http: ${r.status()} ${r.url()}`); });

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.locator('[data-testid="login-submit"]').waitFor({ timeout: 20000 });

// Hidden until Advanced is opened: the server you want is the page you are looking at.
console.log("link visible before Advanced:", await page.locator('[data-testid="login-use-different-server"]').isVisible());
await page.getByText("Advanced", { exact: true }).click();
await page.locator('[data-testid="login-use-different-server"]').waitFor({ timeout: 5000 });
console.log("link visible after Advanced:", await page.locator('[data-testid="login-use-different-server"]').isVisible());
await page.screenshot({ path: `${out}/1440-20-advanced.png` });

await page.locator('[data-testid="login-use-different-server"]').click();
await page.locator('[data-testid="login-server-url"]').waitFor({ timeout: 10000 });
await page.screenshot({ path: `${out}/1440-21-serverform.png` });
console.log("server form:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 240));
console.log("discovery hidden on web:", (await page.getByText(/search for local servers/i).count()) === 0);

// Nothing listening: a sentence, not a spinner that never stops.
await page.locator('[data-testid="login-server-url"]').fill("http://127.0.0.1:1");
await page.locator('[data-testid="login-connect"]').click();
await page.waitForSelector('[role="alert"]', { timeout: 40000 });
console.log("unreachable message:", JSON.stringify(await page.locator('[role="alert"]').allInnerTexts()));
await page.screenshot({ path: `${out}/1440-22-serverform-error.png` });

// The bare host:port -- what the node's own banner prints, and what anybody would type. It used
// to hang the Connect button for ever with no error and no way back (docs/UI-LOOP.md); the
// sub-path retry in checkJellyfinServer means it simply connects.
await page.locator('[data-testid="login-server-url"]').fill(base);
await page.locator('[data-testid="login-connect"]').click();
await page.locator('[data-testid="login-submit"]').waitFor({ timeout: 40000 });
console.log("bare host:port connected:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 80));

await browser.close();
console.log("\n=== findings ===\n" + (findings.length ? findings.join("\n") : "none"));
