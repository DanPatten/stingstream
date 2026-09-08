// Settings -> Link a device: the renamed authorising side of "sign in with a code".
import { chromium } from "playwright";
const [, , base, out, user, pass] = process.argv;
const findings = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
const page = await ctx.newPage();
page.on("console", (m) => { if (m.type() === "error") findings.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => findings.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.locator('[data-testid="login-username"]').waitFor({ timeout: 20000 });
await page.locator('[data-testid="login-username"]').fill(user);
await page.locator('[data-testid="login-password"]').fill(pass);
await page.locator('[data-testid="login-submit"]').click();
await page.waitForFunction(() => Array.from(document.querySelectorAll("img")).some((i) => i.complete && i.naturalWidth > 0), { timeout: 60000 });

await page.goto(new URL("/settings", base).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
await page.getByText("Link a device", { exact: true }).first().waitFor({ timeout: 20000 });
console.log('"Link a device" group present');
console.log("old wording gone:", (await page.getByText(/quick connect/i).count()) === 0);
await page.getByText(/enter a code from|enter the code shown on the other device/i).first().scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/1440-30-settings-link-device.png` });

await page.getByText(/enter the code shown on the other device/i).first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/1440-31-link-device-sheet.png` });
console.log("sheet text:", (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(-260));

await browser.close();
console.log("\n=== findings ===\n" + (findings.length ? findings.join("\n") : "none"));
