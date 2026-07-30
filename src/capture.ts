import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { sessionDir } from './session.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const START: Record<string, string> = {
  // Amazon Now (quick-commerce grocery) orders list. Grocery-only, so no "now"
  // badge filtering is needed.
  amazon: 'https://www.amazon.in/tez/browse/yourOrders?qcbrand=qqfsWw9RkO',
};

function prompt(q: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, () => { rl.close(); res(); }));
}

async function main(): Promise<void> {
  const [source, kind] = process.argv.slice(2);
  if (!source || !kind || !START[source] || !['list', 'detail'].includes(kind)) {
    console.error('Usage: npx tsx src/capture.ts amazon <list|detail>');
    process.exit(2);
    return;
  }

  const context = await chromium.launchPersistentContext(sessionDir(source), { headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(START[source], { waitUntil: 'domcontentloaded' });

  console.log(`\nA browser window is open for ${source}.`);
  console.log('  1. Log in if prompted (enter OTP etc.). The session is saved for later runs.');
  console.log(`  2. Navigate to the ${kind === 'list' ? 'order-history list' : 'order-detail'} page you want to capture.`);
  await prompt('  3. Press Enter here to save the current page HTML… ');

  const html = await page.content();
  const out = path.join(ROOT, 'test', 'fixtures', `${source}-${kind}.html`);
  writeFileSync(out, html, 'utf8');
  console.log(`\nSaved ${html.length} bytes → ${path.relative(ROOT, out)}`);
  console.log(`Now open src/${source}.ts and adjust the selectors until \`npm test\` passes against the real HTML.`);

  await context.close();
}

main().catch(err => { console.error(err); process.exit(1); });
