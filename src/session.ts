import { chromium, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface LoginConfig {
  loginUrlPattern: RegExp;
  authMarker: string; // selector present only when logged in
}

export function sessionDir(source: string): string {
  return path.join(ROOT, '.sessions', source);
}

export function isLoggedOut(url: string, authMarkerPresent: boolean, cfg: LoginConfig): boolean {
  return cfg.loginUrlPattern.test(url) || !authMarkerPresent;
}

async function launch(source: string, headless: boolean): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(sessionDir(source), { headless });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// Client-rendered apps can briefly show/redirect content around the auth check
// (e.g. an SSR shell rendered before a client-side redirect to login fires), so
// a single snapshot right after domcontentloaded can misread the login state.
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
}

async function checkLoggedOut(page: Page, cfg: LoginConfig): Promise<boolean> {
  const markerPresent = (await page.locator(cfg.authMarker).count()) > 0;
  return isLoggedOut(page.url(), markerPresent, cfg);
}

export async function openSession(
  source: string,
  startUrl: string,
  cfg: LoginConfig,
  opts: { headless: boolean },
): Promise<{ context: BrowserContext; page: Page }> {
  let { context, page } = await launch(source, opts.headless);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await settle(page);

  if (await checkLoggedOut(page, cfg)) {
    // Need a human login. Relaunch headed and wait for a stable logged-in state.
    await context.close();
    ({ context, page } = await launch(source, false));
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await settle(page);
    console.error(`[${source}] Please log in (and enter OTP) in the opened browser window…`);

    const deadline = Date.now() + 300_000;
    let consecutiveLoggedIn = 0;
    while (Date.now() < deadline && consecutiveLoggedIn < 2) {
      await page.waitForTimeout(1_000);
      consecutiveLoggedIn = (await checkLoggedOut(page, cfg)) ? 0 : consecutiveLoggedIn + 1;
    }
    if (await checkLoggedOut(page, cfg)) {
      throw new Error(`[${source}] Timed out waiting for login`);
    }
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await settle(page);
  }
  return { context, page };
}
