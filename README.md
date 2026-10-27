# split-orders

A [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that settles
the monthly "who owes what for groceries" problem in a shared flat.

It pulls recent orders from **Zepto** (official MCP server), **Amazon Now** and
**Blinkit** (Playwright, using your own logged-in session), normalizes them into one
schema, works out which items were shared and which were personal, prorates fees and
discounts, and posts the shared portion of each order to a **Splitwise** group as an
equal split.

You run it by asking Claude: *"split my grocery orders since the 1st"*. Claude drives
the CLI, asks you about any item it hasn't seen before, shows a preview, and posts
only after you confirm.

```
fetch (Zepto MCP · Amazon Now · Blinkit)
  → normalize  → NormalizedOrder[]
  → review     → unseen items: personal or shared? (answers are remembered)
  → split      → shared subtotal + prorated fees/discounts per order
  → confirm    → one confirmation for the whole batch
  → post       → Splitwise expenses, equal split, tagged with the order id
```

## Why it's interesting

- **Three very different data sources behind one schema.** Zepto comes from its
  official MCP server (amounts in paise). Amazon Now is scraped from rendered pages,
  anchored on stable text labels rather than CSS classes. Blinkit never renders an
  order id into the DOM, so the fetcher reads the `order_history` JSON the page
  already requests for itself, then parses each bill from the DOM.
- **Charges reconcile.** Each order's items, delivery/handling/packaging fees,
  surcharges and discounts are summed and checked against the paid total. Mismatches
  are flagged instead of silently posted.
- **Fair splitting.** Only shared items count toward the split. Order-level fees
  (delivery, packaging, taxes, tip) are split in full, the discount is prorated by
  the order's shared fraction, and orders with nothing shared are dropped.
- **It learns.** Personal/shared decisions are stored per item in `rules.json`, with
  auto-guessed categories (grocery, household, personal hygiene, …), so later runs
  only ask about new items.
- **Partial failure is a first-class case.** One unreadable order doesn't abort a
  scrape. Posting stops at the first failure and reports exactly what was and wasn't
  posted, and every expense carries an `order:<source>:<id>` tag so duplicates are
  easy to spot.
- **Tested against real page captures.** 100+ vitest tests run against redacted HTML
  and JSON fixtures from each source, so a site redesign shows up as a failing test,
  not a wrong bill.

## Install

```bash
git clone https://github.com/prakhar083/split-orders ~/split-orders
cd ~/split-orders && npm install && npx playwright install chromium
ln -s ~/split-orders ~/.claude/skills/split-orders          # register the skill

# Zepto's official MCP server (OAuth with your Indian mobile number)
claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp
```

The first Amazon and Blinkit runs open a browser for you to log in (OTP included).
Sessions are saved under `.sessions/` (gitignored) and reused after that.

Posting is optional. To post, copy `config.example.json` to `config.json` and fill in
a Splitwise API key from <https://dev.splitwise.com> and your group name. Splitwise
only allows API writes for accounts with **Splitwise Pro**. Without it every call
returns 403, and the tool says so instead of failing obscurely.

## Usage

In Claude Code:

> split my orders from Zepto and Blinkit since October 1st, and post them

The full agent procedure is in [`SKILL.md`](SKILL.md). The CLIs it drives can also be
run by hand:

| Step | Command |
|---|---|
| Fetch Amazon Now / Blinkit | `npx tsx src/cli.ts --sources amazon,blinkit --since 2026-10-01 --limit 20` |
| Map Zepto MCP payloads | `echo '[<order-detail>, …]' \| npx tsx src/cli.ts --map-zepto` |
| List unreviewed items | `npx tsx src/review-cli.ts --orders run.json --rules rules.json` |
| Save answers | `npx tsx src/review-cli.ts --apply answers.json --rules rules.json` |
| Compute splits | `npx tsx src/split-cli.ts --split run.json --rules rules.json > results.json` |
| Post to Splitwise | `npx tsx src/split-cli.ts --post results.json --config config.json` |

## Layout

```
src/
  zepto.ts amazon.ts blinkit.ts   source adapters → NormalizedOrder
  schema.ts                       the shared order schema + charge reconciliation
  categorize.ts                   item categories and the rules.json store
  split.ts                        shared-amount math (fees, prorated discount)
  splitwise.ts                    minimal Splitwise v3 client
  session.ts capture.ts           persistent Playwright sessions, fixture capture
  *-cli.ts                        the commands Claude runs
test/                             vitest suites + captured (redacted) fixtures
docs/superpowers/                 design specs and implementation plans
```

When a site changes its markup, refresh the fixtures with
`npx tsx src/capture.ts <amazon|blinkit> <list|detail>` and fix the parser until
`npm test` passes again.

## Development

```bash
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

## License

MIT
