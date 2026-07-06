# Order Fetch Layer — Design Spec

**Date:** 2026-07-06
**Project:** `split-orders` (Claude Code skill)
**Phase:** v1 — Data fetching only (filtering + Splitwise deferred)

## Overview

`split-orders` is a Claude Code skill whose end goal is to pull orders from
Zepto, Amazon, and Blinkit, filter items (include/exclude), and post an itemized
expense to Splitwise split with flatmates.

This spec covers **only the first phase: the data-fetching layer.** It fetches a
window of recent orders from all three sources and normalizes them into a single
structure. Filtering rules and the Splitwise write path are explicitly out of
scope here and will be designed as later phases.

## MCP / API feasibility (researched 2026-07-06)

| Service | Official integration? | What we use | Nature |
| --- | --- | --- | --- |
| **Zepto** | ✅ Official MCP | `github.com/zeptonow/mcp`, endpoint `https://mcp.zepto.co.in/mcp`, OAuth (Indian mobile). Exposes order history. | First-party |
| **Amazon** | ❌ No consumer/orders MCP | Local Playwright scraper against `amazon.in` (own account). Official Amazon MCPs are Ads-only / B2B Business — wrong products. | Self-built scraper |
| **Blinkit** | ❌ No official MCP | Local Playwright scraper against `blinkit.com` (own account). Only unofficial/community MCPs + product scrapers exist. | Self-built scraper |
| **Splitwise** | ❌ No MCP, ✅ official REST API | `dev.splitwise.com` (`create_expense`) — used in a later phase, not this one. | First-party API |

**Risk note (accepted by user):** Amazon and Blinkit are scraped from the user's
own accounts for personal bill-splitting. This is a legitimate personal use, but
carries ToS, brittleness, bot-detection, and session-handling risks. These were
flagged and accepted. The scraper runs locally with a persisted login session.

## Goal

One command that pulls the user's **last N / date-ranged** orders from Zepto,
Amazon.in, and Blinkit and returns them as a single normalized list, ready for
filtering and Splitwise in later phases.

## The core contract: `NormalizedOrder`

Every fetcher produces this shape. All charge lines are captured now (even though
allocation is decided in a later phase) so nothing must be re-fetched.

```ts
type NormalizedOrder = {
  source: 'zepto' | 'amazon' | 'blinkit';
  orderId: string;
  placedAt: string;              // ISO 8601
  items: {
    name: string;
    quantity: number;
    unitPrice?: number;          // optional — some receipts only give line total
    lineTotal: number;
  }[];
  charges: {
    subtotal: number;
    taxes?: number;
    deliveryFee?: number;
    packagingFee?: number;
    discount?: number;           // positive number = amount reduced (see convention below)
    tip?: number;
  };
  grandTotal: number;
  currency: 'INR';
  raw?: unknown;                 // original payload/HTML-derived object, for debugging
};
```

Conventions:
- All monetary values are numbers in INR (rupees, not paise).
- `discount` is stored as a **positive** number representing the amount reduced;
  `grandTotal = subtotal + taxes + deliveryFee + packagingFee + tip - discount`.
- A fetcher must validate this identity (within a rounding tolerance) and warn if
  it does not reconcile, rather than silently returning inconsistent data.

## Components

```
split-orders/
├── SKILL.md                    # orchestration: asks window/sources, calls fetchers, shows results
├── src/
│   ├── schema.ts               # NormalizedOrder type + runtime validator + reconcile check
│   ├── zepto.ts                # maps official Zepto MCP output → NormalizedOrder
│   ├── amazon.ts               # Playwright fetcher (amazon.in)
│   ├── blinkit.ts              # Playwright fetcher (blinkit.com)
│   ├── session.ts              # persisted-profile login manager
│   └── cli.ts                  # `fetch-orders --sources … --since … --limit …`
├── test/
│   ├── fixtures/               # saved order-detail HTML + sample MCP payloads
│   └── *.test.ts
├── .sessions/                  # gitignored persisted browser profiles
├── package.json
└── docs/superpowers/specs/…    # this spec
```

### `schema.ts`
Defines `NormalizedOrder`, a runtime validator (asserts required fields and types),
and a `reconcileCharges(order)` helper that checks the grand-total identity within
a ±1 INR tolerance and returns any discrepancy for the caller to surface.

### `zepto.ts`
Pure mapper. Input: the response object from the official Zepto MCP order-history
tool. Output: `NormalizedOrder[]`. No network/browser code — the skill calls the
MCP tool and hands the payload to this mapper. Testable against a saved fixture.

### `amazon.ts` / `blinkit.ts`
Playwright fetchers. Each:
1. Launches a persistent context using a per-source profile dir under `.sessions/`.
2. If logged out, delegates to `session.ts` to relaunch headed and wait for login.
3. Navigates the order-history page, applies the date-range / last-N window.
4. Opens each order-detail page and extracts items + charges.
5. Returns `NormalizedOrder[]`.

The **parsing** (DOM → NormalizedOrder) is factored into a pure function that takes
HTML/a parsed DOM and returns the order, so it can be unit-tested against fixtures
independently of the live browser.

### `session.ts`
Shared login manager. Per source it owns a persisted `userDataDir`
(`.sessions/<source>/`). Detects the logged-out state (redirect to login /
absence of an authenticated marker), relaunches the browser **headed**, waits for
the user to complete login + OTP, then resumes. Sessions persist across runs and
are only re-prompted when expired.

### `cli.ts`
Entry point the skill shells out to:
```
fetch-orders --sources amazon,blinkit --since 2026-07-01 --limit 5
```
Prints a merged `NormalizedOrder[]` as JSON to stdout. Flags:
- `--sources` — comma list of `amazon,blinkit` (Zepto handled by the skill via MCP).
- `--since` — ISO date lower bound (optional).
- `--limit` — max orders per source (optional).
At least one of `--since` / `--limit` must be provided.

## Data flow

1. Skill invoked → asks the user for the window (last N and/or date range) and
   which sources to include.
2. **Zepto**: skill calls the official Zepto MCP order-history tool, passes the
   result through `zepto.ts`.
3. **Amazon / Blinkit**: skill shells out to `cli.ts`, which runs the Playwright
   fetchers (headed login if the session is dead).
4. Each source yields `NormalizedOrder[]`; the skill merges them.
5. Skill prints a table of orders and their items.
6. **v1 ends here.** (Later phases: filter with rules+confirm, then Splitwise.)

## Error handling

- **Session expired** → relaunch headed, prompt login, retry once; if still failing,
  report and skip that source.
- **Selector miss / parse failure** → fail loudly for that order; save a screenshot
  and page HTML to the scratchpad for debugging. Never silently drop items.
- **Charge reconciliation mismatch** → include the order but flag the discrepancy in
  output so the user knows the totals didn't add up.
- **One source fails entirely** → still return the other sources' orders; report which
  source failed and why.
- **Bot detection / CAPTCHA** → surface to the user in the headed browser rather than
  retrying aggressively.

## Testing (TDD)

The deterministic core is **parsing**, and that is where tests focus:
- `schema.test.ts` — validator accepts good orders, rejects malformed ones;
  `reconcileCharges` catches total mismatches.
- `zepto.test.ts` — sample MCP payload fixture → expected `NormalizedOrder`.
- `amazon.test.ts` / `blinkit.test.ts` — saved order-detail HTML fixtures → expected
  `NormalizedOrder`, including edge cases (multi-quantity, discounts, missing unit price).
- Live login/navigation flows are validated by a **manual smoke test** (requires real
  accounts) — not part of the automated suite.

## Open items to verify during implementation

1. **Zepto MCP tool name and output schema** for order history — inspect live once the
   MCP is added (`claude mcp add --transport http --scope user zepto https://mcp.zepto.co.in/mcp`).
2. **amazon.in order-detail DOM** — confirm full per-item pricing is present; snapshot a
   real order page as the first test fixture.
3. **blinkit.com order-detail DOM** — same: confirm items + charge breakdown are
   available on the web order page; snapshot a real one.

## Out of scope (later phases)

- Include/exclude filtering rules (decided: "rules + confirm").
- Splitwise `create_expense` write path and split logic (decided: deferred).
- Any UI beyond the skill's terminal output.
