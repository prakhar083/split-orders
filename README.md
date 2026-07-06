# split-orders

Fetch layer for the split-orders skill. Pulls recent orders from Zepto (official
MCP), Amazon.in, and Blinkit (local Playwright) into one `NormalizedOrder[]`.

## Setup
- `npm install && npx playwright install chromium`
- Add Zepto MCP: `claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`

## Test
- `npm test`

## Usage
- Scrape: `npx tsx src/cli.ts --sources amazon,blinkit --limit 5`
- Map Zepto MCP payload: `echo '<payload>' | npx tsx src/cli.ts --map-zepto`

## Capturing real fixtures (first-time selector tuning)
Selectors ship tuned to synthetic fixtures. To adapt them to the live sites, open a
headed browser, log in, navigate to the page, and dump its HTML into the fixture:
- `npx tsx src/capture.ts amazon list` / `npx tsx src/capture.ts amazon detail`
- `npx tsx src/capture.ts blinkit list` / `npx tsx src/capture.ts blinkit detail`

Then adjust the selectors in `src/amazon.ts` / `src/blinkit.ts` until `npm test` passes.

Amazon/Blinkit are scraped from your own accounts; sessions persist in `.sessions/`
(gitignored). See `docs/superpowers/specs/2026-07-06-order-fetch-layer-design.md`.
