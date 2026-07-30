import { describe, it, expect } from 'vitest';
import { parseArgs, validateWindow } from '../src/cli.js';

describe('parseArgs', () => {
  it('parses sources, since, and limit', () => {
    const a = parseArgs(['--sources', 'amazon', '--since', '2026-07-01', '--limit', '5']);
    expect(a).toEqual({ sources: ['amazon'], since: '2026-07-01', limit: 5, mapZepto: false });
  });
  it('recognizes --map-zepto mode', () => {
    expect(parseArgs(['--map-zepto']).mapZepto).toBe(true);
  });
});

describe('validateWindow', () => {
  it('requires at least one of since/limit in scrape mode', () => {
    expect(validateWindow({ mapZepto: false })).toContain('provide at least one of --since or --limit');
  });
  it('accepts scrape mode with a limit', () => {
    expect(validateWindow({ limit: 3, mapZepto: false })).toEqual([]);
  });
  it('skips the window requirement in --map-zepto mode', () => {
    expect(validateWindow({ mapZepto: true })).toEqual([]);
  });
});
