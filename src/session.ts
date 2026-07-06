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

export async function openSession(
  source: string,
  startUrl: string,
  cfg: LoginConfig,
  opts: { headless: boolean },
): Promise<{ context: BrowserContext; page: Page }> {
  let { context, page } = await launch(source, opts.headless);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  const markerPresent = (await page.locator(cfg.authMarker).count()) > 0;

  if (isLoggedOut(page.url(), markerPresent, cfg)) {
    // Need a human login. Relaunch headed and wait for the auth marker to appear.
    await context.close();
    ({ context, page } = await launch(source, false));
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    console.error(`[${source}] Please log in (and enter OTP) in the opened browser window…`);
    await page.waitForSelector(cfg.authMarker, { timeout: 300_000 });
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  }
  return { context, page };
}
