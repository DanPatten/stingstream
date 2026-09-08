import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.argv[2] || 'http://127.0.0.1:8790';
const PW = process.argv[3];
const out = 'E:/Dan/Documents/Repos/StingStream/.local/ui-loop/review/verify';
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch();
const results = [];
for (const [w,h,tag] of [[1440,900,'1440'],[2000,1100,'2000'],[390,844,'390']]) {
  const ctx = await b.newContext({ viewport:{width:w,height:h}, colorScheme:'dark', isMobile: w===390, hasTouch: w===390 });
  const p = await ctx.newPage();
  const errs = []; p.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
  await p.goto(BASE, { waitUntil:'networkidle' });
  if (PW && await p.locator('[data-testid=login-username]').count()) {
    await p.fill('[data-testid=login-username]', 'dan');
    await p.fill('[data-testid=login-password]', PW);
    await p.click('[data-testid=login-submit]');
    await p.waitForTimeout(5000);
  }
  await p.waitForTimeout(2500);
  const q = async (sel) => await p.locator(sel).count();
  results.push({
    tag,
    signedIn: (await q('[data-testid=login-username]')) === 0,
    topAvatar: await q('[data-testid=shell-topbar] [data-testid=shell-user-menu]'),
    sidebarAvatar: await q('[data-testid=shell-sidebar] [data-testid=shell-user-menu]'),
    collapseToggle: await q('[data-testid=sidebar-collapse]'),
    watchTogether: await q('[data-testid*=watch-together]'),
    overflowPx: await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    consoleErrors: errs.length,
  });
  await p.screenshot({ path: `${out}/home-${tag}.png` });
  await ctx.close();
}
console.log(JSON.stringify(results, null, 1));
await b.close();
