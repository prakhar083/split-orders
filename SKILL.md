---
name: split-orders
description: Fetch recent orders from Zepto (official MCP) and Amazon Now (local Playwright), mark items personal or shared, then post the shared portion of each order to a Splitwise group as an equal split.
---

# split-orders

Fetch a windowed set of recent orders from Zepto and Amazon Now, normalize them into
one list, decide per item whether it is personal or shared, compute the shared amount
per order, and post those as equal-split Splitwise expenses. The full flow is
fetch → review → split → confirm → post. (Blinkit is out of scope for this
implementation.)

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

## Filtering and splitting

4. Save the fetched+merged `NormalizedOrder[]` to a temp JSON file, e.g.
   `/tmp/split-orders-run.json`.
5. Check for unmarked items:
   `npx tsx src/review-cli.ts --orders /tmp/split-orders-run.json --rules rules.json`
   Output is a JSON object keyed by category. An empty object (`{}`) means nothing
   is unmarked — that is the "no items to review" signal, not empty output.
   If it prints any items, show them to the user grouped by category and ask
   personal-or-shared for each. Write the answers as
   `[{ "name": "...", "shared": true|false }, ...]` to a temp file and run:
   `npx tsx src/review-cli.ts --apply <answers-path> --rules rules.json`
   Each answer may also carry an optional `"category"` (`grocery`,
   `personal-hygiene`, `tobacco-alcohol`, `household`, `other`) to override the
   auto-guessed category — use it when the user says a guessed category is wrong,
   including for items that already have a saved rule.
6. Compute the split:
   `npx tsx src/split-cli.ts --split /tmp/split-orders-run.json --rules rules.json > /tmp/split-results.json`
   This prints a `SplitResult[]` (orders with nothing shared, a zero, or a
   negative shared amount are dropped automatically).
7. Ensure `config.json` exists (copy `config.example.json` and ask the user to
   fill in `splitwiseApiKey` — from https://dev.splitwise.com — and
   `splitwiseGroupName` if it doesn't). `src/split-cli.ts --post` validates the
   config and resolves the group itself, and errors clearly if either field is
   missing.
8. Show a full preview from `/tmp/split-results.json`: for every `SplitResult`,
   print `orderId`, `placedAt`, the shared items, `splitAmount` (the total posted
   to Splitwise), and the per-person amount (`splitAmount` divided by the number
   of group members). Note that `sharedRatio` is a fraction (shared subtotal ÷
   order subtotal) used only for prorating the discount — never present it as a
   rupee amount. Flag any order whose original `reconcileCharges` check failed.
   Ask for **one confirmation** before posting anything.
9. On confirmation:
   `npx tsx src/split-cli.ts --post /tmp/split-results.json --config config.json`
   Each expense posts in INR as an equal split, described
   `"<source> order <placedAt> — <orderId>"` with `details` set to
   `order:<source>:<orderId>`. Progress is streamed on stderr; the final JSON
   array on stdout has one `{orderId, status, expenseId?, error?}` per attempt.
   Posting stops at the first failure. If that happens, report to the user which
   orderIds posted (with their expense ids) and which did not — and before any
   re-run, remove the already-posted orders from the results file. Re-running the
   same file as-is would double-post them; there is no automatic dedupe (the
   `details` tag exists so a duplicate can be spotted in Splitwise by hand).
