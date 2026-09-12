---
name: split-orders
description: Fetch recent orders from Zepto (official MCP), Amazon Now and Blinkit (local Playwright), mark items personal or shared, then post the shared portion of each order to a Splitwise group as an equal split.
---

# split-orders

Fetch a windowed set of recent orders from Zepto, Amazon Now and Blinkit, normalize
them into one list, decide per item whether it is personal or shared, compute the
shared amount per order, and post those as equal-split Splitwise expenses. The full
flow is fetch → review → split → confirm → post.

**Project directory (always cd here first — this skill may be invoked from any cwd):**
`~/Desktop/Personal/split-orders`

## One-time setup

1. Add the official Zepto MCP:
   `claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`
   Then complete the OAuth login (Indian mobile) when prompted.
2. `cd ~/Desktop/Personal/split-orders && npm install && npx playwright install chromium`.
3. First Amazon and Blinkit runs each open a browser for you to log in (incl. OTP);
   the sessions are saved under `.sessions/<source>/` and reused afterward.
4. *Only if you intend to post:* copy `config.example.json` to `config.json` and fill
   in `splitwiseApiKey` (https://dev.splitwise.com) and `splitwiseGroupName`. That
   key only works while its developer account has Splitwise Pro. Everything up to
   and including the computed split works fine without any of this.

## Running

`cd ~/Desktop/Personal/split-orders` first, always. Ask the user three things
before fetching:
- the window (a `--since` date and/or a `--limit` count),
- which sources to include,
- **whether to post to Splitwise at the end.** Posting through the Splitwise API
  requires an active **Splitwise Pro** subscription on the account that registered
  the key at https://dev.splitwise.com; without it every call returns HTTP 403.
  Posting is therefore optional — if the user declines (or has no Pro), the run
  still produces the full split and saves it, it just stops before posting.
  Do not ask about posting again later; this is the one time it is decided.

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
   let the user log in. The itemized bill sits behind a "View order details" button
   that does not exist at `domcontentloaded`, so the fetcher waits for it before
   clicking. Some order-tracking URLs resolve to a download instead of a page and
   those orders are skipped with a message on stderr rather than aborting the run.
3. **Blinkit** (if included):
   `npx tsx src/cli.ts --sources blinkit --since <ISO> --limit <N>`
   Blinkit never renders an order id into the DOM, so the fetcher reads the
   `/v1/layout/order_history` JSON the account page already requests for itself
   (real `order_id`, `order_status`, total and date), then visits
   `blinkit.com/account/orders/<cartId>/<orderId>` for each and parses the bill.
   Cancelled orders are skipped. Items are read from the DOM, not flattened text —
   a product whose name begins with digits (e.g. `4700BC Hawaiian…`) otherwise
   corrupts the previous item's price. Situational surcharges ("Late night
   convenience charge") land in `charges.otherFees` so reconciliation stays honest.
4. Merge the JSON outputs and present a table: source, orderId, date, each
   item (name × qty = lineTotal), and the charge breakdown. Note any order whose
   `reconcileCharges` flagged a mismatch. Both scraped sources isolate per-order
   failures: a handful of unreadable orders are reported on stderr and the rest
   still come back, so check that count against what you expected.

## Filtering and splitting

5. Save the fetched+merged `NormalizedOrder[]` to a temp JSON file, e.g.
   `/tmp/split-orders-run.json`.
6. Check for unmarked items:
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
7. Compute the split, saving it somewhere durable (not `/tmp`, which gets cleared —
   the file is the whole run's output when posting is skipped or fails):
   `npx tsx src/split-cli.ts --split /tmp/split-orders-run.json --rules rules.json > <YYYY-MM>-split-results.json`
   This prints a `SplitResult[]` (orders with nothing shared, a zero, or a
   negative shared amount are dropped automatically).
8. Show a preview from that file — **always, whether or not posting is happening**.
   For every `SplitResult` print `orderId`, `placedAt`, the shared items and
   `splitAmount` (the total that would be posted). Add the per-person amount
   (`splitAmount` ÷ number of group members) only when posting — resolving the group
   requires the API, so when posting is off, report `splitAmount` and the overall
   total and say per-person needs the group size. Note that `sharedRatio` is a
   fraction (shared subtotal ÷ order subtotal) used only for prorating the discount
   — never present it as a rupee amount. Flag any order whose original
   `reconcileCharges` check failed. Do not list orders that were dropped in step 7
   (nothing shared).
9. **If the user declined posting**, stop here. Tell them the results file path and
   that posting later is a single command (step 11) once Pro is active. Do not ask
   for a posting confirmation — they already answered.
10. **If posting**, ensure `config.json` exists and is filled in (`--post` validates
   it and resolves the group itself, erroring clearly if either field is missing).
   Then ask for **one confirmation** before posting anything.
11. On confirmation:
   `npx tsx src/split-cli.ts --post <YYYY-MM>-split-results.json --config config.json`
   Each expense posts in INR as an equal split, described
   `"<source> order <placedAt> — <orderId>"` with `details` set to
   `order:<source>:<orderId>`. Progress is streamed on stderr; the final JSON
   array on stdout has one `{orderId, status, expenseId?, error?}` per attempt.
   Posting stops at the first failure. If that happens, report to the user which
   orderIds posted (with their expense ids) and which did not — and before any
   re-run, remove the already-posted orders from the results file. Re-running the
   same file as-is would double-post them; there is no automatic dedupe (the
   `details` tag exists so a duplicate can be spotted in Splitwise by hand).
   A HTTP 403 naming Splitwise Pro means the subscription lapsed: nothing was
   posted, the results file is intact, and the same command works once Pro is back.
