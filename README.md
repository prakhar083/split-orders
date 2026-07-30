# split-orders

Fetch layer for the split-orders skill. Pulls recent orders from Zepto (official
MCP) and Amazon Now (local Playwright) into one `NormalizedOrder[]`. (Blinkit is out
of scope for this implementation.)

## Setup
- `npm install && npx playwright install chromium`
- Add Zepto MCP: `claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`

## Test
- `npm test`

## Usage
- Amazon Now: `npx tsx src/cli.ts --sources amazon --limit 5`
- Map Zepto MCP payload: `echo '<payload>' | npx tsx src/cli.ts --map-zepto`

## Re-capturing Amazon fixtures (when the site changes)
Amazon parsing is anchored on stable text labels, but if the page changes you can
refresh the test fixtures: open a headed browser, log in, navigate, and dump HTML:
- `npx tsx src/capture.ts amazon list` / `npx tsx src/capture.ts amazon detail`

Then adjust `src/amazon.ts` until `npm test` passes.

Amazon is fetched from your own account; the session persists in `.sessions/`
(gitignored). See `docs/superpowers/specs/2026-07-06-order-fetch-layer-design.md`.
