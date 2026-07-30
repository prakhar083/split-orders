import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findGroup, createExpense, type SplitwiseGroup } from '../src/splitwise.js';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok, status, json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('findGroup', () => {
  it('returns the group on an exact case-insensitive name match', async () => {
    mockFetchOnce({ groups: [
      { id: 1, name: 'Family', members: [{ id: 10 }] },
      { id: 2, name: 'Flatmates', members: [{ id: 20 }, { id: 21 }] },
    ]});
    const g = await findGroup('key', 'flatmates');
    expect(g).toEqual({ id: 2, name: 'Flatmates', members: [{ id: 20 }, { id: 21 }] });
  });

  it('throws when no group matches', async () => {
    mockFetchOnce({ groups: [{ id: 1, name: 'Family', members: [] }] });
    await expect(findGroup('key', 'Flatmates')).rejects.toThrow(/no group/i);
  });

  it('throws when more than one group matches exactly (case-insensitive dup)', async () => {
    mockFetchOnce({ groups: [
      { id: 1, name: 'Flatmates', members: [] },
      { id: 2, name: 'FLATMATES', members: [] },
    ]});
    await expect(findGroup('key', 'flatmates')).rejects.toThrow(/multiple/i);
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({ error: 'unauthorized' }, false, 401);
    await expect(findGroup('bad-key', 'Flatmates')).rejects.toThrow(/401/);
  });
});

describe('createExpense', () => {
  const group: SplitwiseGroup = { id: 2, name: 'Flatmates', members: [{ id: 20 }, { id: 21 }] };

  it('posts an equal-split expense and returns its id', async () => {
    mockFetchOnce({ expenses: [{ id: 999 }] });
    const result = await createExpense('key', group, { description: 'zepto order', amount: 92, date: '2026-07-16T00:00:00.000Z' });
    expect(result).toEqual({ id: 999 });
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.cost).toBe('92.00');
    expect(body.group_id).toBe(2);
    expect(body.split_equally).toBe(true);
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({ error: 'bad request' }, false, 400);
    await expect(createExpense('key', group, { description: 'x', amount: 1, date: '2026-07-16T00:00:00.000Z' }))
      .rejects.toThrow(/400/);
  });
});
