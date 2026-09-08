import { chromium } from "playwright";
import { createFirstRunAccount } from "./flows/web.mjs";
import { writeCreds } from "./lib/authFile.mjs";

const BASE = "http://127.0.0.1:8843";
const CREDS = "E:/Dan/Documents/Repos/StingStream/.local/ui-loop/fix-wp1/creds.json";
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
const creds = await createFirstRunAccount(page, { base: BASE });
writeCreds(CREDS, creds);
console.log("account created:", creds.username);
await browser.close();
