import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { parseReviewArgs, applyAnswers } from '../src/review-cli.js';
import { loadRules, saveRules } from '../src/categorize.js';

const ORDERS = new URL('./fixtures/split-orders.json', import.meta.url).pathname;
const RULES = new URL('./fixtures/tmp-review-rules.json', import.meta.url).pathname;
const ANSWERS = new URL('./fixtures/tmp-review-answers.json', import.meta.url).pathname;

afterEach(() => {
  for (const p of [RULES, ANSWERS]) if (existsSync(p)) unlinkSync(p);
});

describe('parseReviewArgs', () => {
  it('parses --orders and --rules', () => {
    expect(parseReviewArgs(['--orders', ORDERS, '--rules', RULES]))
      .toEqual({ ordersPath: ORDERS, rulesPath: RULES, applyPath: undefined });
  });
  it('parses --apply and --rules', () => {
    expect(parseReviewArgs(['--apply', ANSWERS, '--rules', RULES]))
      .toEqual({ ordersPath: undefined, rulesPath: RULES, applyPath: ANSWERS });
  });
});

describe('apply mode merges answers into rules', () => {
  it('saves a rule per answered item, guessing category', () => {
    saveRules(RULES, {});
    writeFileSync(ANSWERS, JSON.stringify([
      { name: 'Amul Dahi', shared: true },
      { name: 'Classic Double Burst Cigarette', shared: false },
    ]));
    applyAnswers(ANSWERS, RULES);
    const rules = loadRules(RULES);
    expect(rules['Amul Dahi']).toEqual({ category: 'grocery', shared: true });
    expect(rules['Classic Double Burst Cigarette']).toEqual({ category: 'tobacco-alcohol', shared: false });
  });
});
