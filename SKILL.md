---
name: split-orders
description: Fetch recent orders from Zepto (official MCP) and Amazon Now (local Playwright), normalized into one list. v1 = data fetching only; filtering and Splitwise come later.
---

# split-orders (v1: fetch layer)

Fetch a windowed set of recent orders from Zepto and Amazon Now and present them as
one normalized list. **This version only fetches and shows orders.** It does not
filter or post to Splitwise yet. (Blinkit is out of scope for this implementation.)

**Project directory (always cd here first — this skill may be invoked from any cwd):**
`~/Desktop/Personal/split-orders`

## One-time setup

1. Add the official Zepto MCP:
   `claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`
   Then complete the OAuth login (Indian mobile) when prompted.
2. `cd ~/Desktop/Personal/split-orders && npm install && npx playwright install chromium`.
3. First Amazon run opens a browser for you to log in (incl. OTP); the session is
   saved under `.sessions/amazon/` and reused afterward.

## Running

`cd ~/Desktop/Personal/split-orders` first, always. Ask the user for the window
(a `--since` date and/or a `--limit` count) and which sources to include.

1. **Zepto** (if included): call `mcp__zepto__list_order_history` to get order ids
   within the window, then `mcp__zepto__get_order_detail` for each id. Collect the
   detail objects into a JSON array and map them:
   `echo '[<order-detail>, …]' | npx tsx src/cli.ts --map-zepto`
   (Amounts are in paise; the mapper converts to rupees. Order id shown is the
   human `code`, e.g. `KSJVKBLAJ06551`. Skip orders with `formattedStatus: "CANCELLED"`.)
2. **Amazon Now** (if included):
   `npx tsx src/cli.ts --sources amazon --since <ISO> --limit <N>`
   Pulls from the grocery-only Amazon Now orders (`tez/browse/yourOrders`); cancelled
   ₹0 orders are skipped. A visible browser opens if the saved session has expired —
   let the user log in. (Live click-navigation is implemented but not yet
   smoke-tested end-to-end — if it fails, fall back to the Zepto-only path and flag
   the failure to the user.)
3. Merge the two JSON outputs and present a table: source, orderId, date, each
   item (name × qty = lineTotal), and the charge breakdown. Note any order whose
   `reconcileCharges` flagged a mismatch.

Stop here. Filtering and Splitwise are future phases — not yet implemented.
