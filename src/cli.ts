import { fetchAmazonOrders } from './amazon.js';
import { fetchBlinkitOrders } from './blinkit.js';
import { mapZeptoOrders } from './zepto.js';
import type { NormalizedOrder } from './schema.js';

export interface FetchWindow { since?: string; limit?: number }
export type Fetcher = (opts: FetchWindow) => Promise<NormalizedOrder[]>;

/** Sources this CLI can scrape itself. Zepto is deliberately absent: it comes
 *  from the official MCP, and its payloads enter via --map-zepto instead. */
export const FETCHERS: Record<string, Fetcher> = {
  amazon: fetchAmazonOrders,
  blinkit: fetchBlinkitOrders,
};

/** Fetch each requested source, isolating failures so one broken source
 *  cannot take the others' orders down with it. */
export async function fetchFromSources(
  sources: string[],
  opts: FetchWindow,
  fetchers: Record<string, Fetcher> = FETCHERS,
): Promise<{ orders: NormalizedOrder[]; errors: string[] }> {
  const orders: NormalizedOrder[] = [];
  const errors: string[] = [];
  for (const source of sources) {
    const fetcher = fetchers[source];
    if (!fetcher) {
      errors.push(
        source === 'zepto'
          ? 'zepto: not scraped by this CLI — fetch it via the Zepto MCP and pipe the details through --map-zepto'
          : `${source}: unknown source (known: ${Object.keys(fetchers).join(', ') || 'none'})`,
      );
      continue;
    }
    try {
      orders.push(...(await fetcher(opts)));
    } catch (e) {
      errors.push(`${source}: ${(e as Error).message}`);
    }
  }
  return { orders, errors };
}

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

  const { orders, errors } = await fetchFromSources(args.sources, args);
  if (errors.length) console.error(errors.join('\n'));
  process.stdout.write(JSON.stringify(orders, null, 2));
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
