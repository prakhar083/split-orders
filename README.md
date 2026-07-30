# split-orders

Implementation of the split-orders skill. Pulls recent orders from Zepto (official
MCP) and Amazon Now (local Playwright) into one `NormalizedOrder[]`, marks each item
personal or shared, computes the shared amount per order, and posts it to a Splitwise
group as an equal split. (Blinkit is out of scope for this implementation.)

## Setup
- `npm install && npx playwright install chromium`
- Add Zepto MCP: `claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`

## Test
- `npm test`

## Usage
- Amazon Now: `npx tsx src/cli.ts --sources amazon --limit 5`
- Map Zepto MCP payload: `echo '<payload>' | npx tsx src/cli.ts --map-zepto`
- Review unmarked items: `npx tsx src/review-cli.ts --orders <orders.json> --rules rules.json`
- Apply answers: `npx tsx src/review-cli.ts --apply <answers.json> --rules rules.json`
- Compute splits: `npx tsx src/split-cli.ts --split <orders.json> --rules rules.json`
- Post to Splitwise: `npx tsx src/split-cli.ts --post <split-results.json> --config config.json`

Splitwise posting needs a `config.json` (copy `config.example.json`, API key from
https://dev.splitwise.com).

## Re-capturing Amazon fixtures (when the site changes)
Amazon parsing is anchored on stable text labels, but if the page changes you can
refresh the test fixtures: open a headed browser, log in, navigate, and dump HTML:
- `npx tsx src/capture.ts amazon list` / `npx tsx src/capture.ts amazon detail`

Then adjust `src/amazon.ts` until `npm test` passes.

Amazon is fetched from your own account; the session persists in `.sessions/`
(gitignored). See `docs/superpowers/specs/2026-07-06-order-fetch-layer-design.md`.
