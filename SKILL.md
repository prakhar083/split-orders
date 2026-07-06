---
name: split-orders
description: Fetch recent orders from Zepto (official MCP), Amazon.in, and Blinkit (local Playwright), normalized into one list. v1 = data fetching only; filtering and Splitwise come later.
---

# split-orders (v1: fetch layer)

Fetch a windowed set of recent orders from Zepto, Amazon, and Blinkit and present
them as one normalized list. **This version only fetches and shows orders.** It does
not filter or post to Splitwise yet.

## One-time setup

1. Add the official Zepto MCP:
   `claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`
   Then complete the OAuth login (Indian mobile) when prompted.
2. In this project: `npm install && npx playwright install chromium`.
3. First Amazon/Blinkit run opens a browser for you to log in (incl. OTP); the
   session is saved under `.sessions/` and reused afterward.

## Running

Ask the user for the window (a `--since` date and/or a `--limit` count) and which
sources to include.

1. **Zepto** (if included): call the Zepto MCP order-history tool, then map it:
   `echo '<mcp-payload-json>' | npx tsx src/cli.ts --map-zepto`
2. **Amazon / Blinkit** (if included):
   `npx tsx src/cli.ts --sources amazon,blinkit --since <ISO> --limit <N>`
   (A visible browser opens if the saved session has expired — let the user log in.)
3. Merge the two JSON outputs and present a table: source, orderId, date, each
   item (name × qty = lineTotal), and the charge breakdown. Note any order whose
   `reconcileCharges` flagged a mismatch.

Stop here. Filtering and Splitwise are future phases.
