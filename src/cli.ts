import { fetchAmazonOrders } from './amazon.js';
import { fetchBlinkitOrders } from './blinkit.js';
import { mapZeptoOrders } from './zepto.js';
import type { NormalizedOrder } from './schema.js';

export function parseArgs(argv: string[]): { sources: string[]; since?: string; limit?: number; mapZepto: boolean } {
  const out: { sources: string[]; since?: string; limit?: number; mapZepto: boolean } = { sources: [], mapZepto: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--map-zepto') out.mapZepto = true;
    else if (a === '--sources') out.sources = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

export function validateWindow(a: { since?: string; limit?: number; mapZepto: boolean }): string[] {
  if (a.mapZepto) return [];
  if (!a.since && a.limit == null) return ['provide at least one of --since or --limit'];
  return [];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const errs = validateWindow(args);
  if (errs.length) {
    console.error(errs.join('\n'));
    process.exit(2);
  }

  if (args.mapZepto) {
    const payload = JSON.parse(await readStdin());
    process.stdout.write(JSON.stringify(mapZeptoOrders(payload), null, 2));
    return;
  }

  const orders: NormalizedOrder[] = [];
  const errors: string[] = [];
  if (args.sources.includes('amazon')) {
    try { orders.push(...(await fetchAmazonOrders(args))); }
    catch (e) { errors.push(`amazon: ${(e as Error).message}`); }
  }
  if (args.sources.includes('blinkit')) {
    try { orders.push(...(await fetchBlinkitOrders(args))); }
    catch (e) { errors.push(`blinkit: ${(e as Error).message}`); }
  }
  if (errors.length) console.error(errors.join('\n'));
  process.stdout.write(JSON.stringify(orders, null, 2));
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
