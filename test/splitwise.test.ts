import { describe, it, expect, vi, afterEach } from 'vitest';
import { findGroup, createExpense, type SplitwiseGroup } from '../src/splitwise.js';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok, status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

function lastCall() {
  const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
  return { url: url as string, init: init as RequestInit };
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

  it('hits /get_groups with a bearer Authorization header', async () => {
    mockFetchOnce({ groups: [{ id: 1, name: 'Flatmates', members: [] }] });
    await findGroup('secret-key', 'Flatmates');
    const { url, init } = lastCall();
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/get_groups');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });

  it('throws when no group matches, listing the available group names', async () => {
    mockFetchOnce({ groups: [{ id: 1, name: 'Family', members: [] }, { id: 2, name: 'Trip', members: [] }] });
    await expect(findGroup('key', 'Flatmates')).rejects.toThrow(/no group found with name "Flatmates"/i);
    mockFetchOnce({ groups: [{ id: 1, name: 'Family', members: [] }, { id: 2, name: 'Trip', members: [] }] });
    await expect(findGroup('key', 'Flatmates')).rejects.toThrow(/Family, Trip/);
  });

  it('throws when more than one group matches exactly (case-insensitive dup)', async () => {
    mockFetchOnce({ groups: [
      { id: 1, name: 'Flatmates', members: [] },
      { id: 2, name: 'FLATMATES', members: [] },
    ]});
    await expect(findGroup('key', 'flatmates')).rejects.toThrow(/multiple/i);
  });

  it('throws on a non-OK HTTP response, including the response body', async () => {
    mockFetchOnce({ error: 'unauthorized' }, false, 401);
    await expect(findGroup('bad-key', 'Flatmates')).rejects.toThrow(/401.*unauthorized/s);
  });
});

describe('createExpense', () => {
  const group: SplitwiseGroup = { id: 2, name: 'Flatmates', members: [{ id: 20 }, { id: 21 }] };

  it('posts an equal-split INR expense to /create_expense and returns its id', async () => {
    mockFetchOnce({ expenses: [{ id: 999 }] });
    const result = await createExpense('secret-key', group, {
      description: 'zepto order', amount: 92, date: '2026-07-16T00:00:00.000Z', details: 'order:zepto:ORD-1',
    });
    expect(result).toEqual({ id: 999 });
    const { url, init } = lastCall();
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/create_expense');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(init.body as string);
    expect(body.cost).toBe('92.00');
    expect(body.currency_code).toBe('INR');
    expect(body.group_id).toBe(2);
    expect(body.split_equally).toBe(true);
    expect(body.details).toBe('order:zepto:ORD-1');
  });

  it('throws with the Splitwise error content when the expense is rejected with HTTP 200', async () => {
    mockFetchOnce({ expenses: [], errors: { base: ['some error'] } });
    await expect(createExpense('key', group, { description: 'x', amount: 1, date: '2026-07-16T00:00:00.000Z' }))
      .rejects.toThrow(/rejected the expense.*some error/s);
  });

  it('throws on a non-OK HTTP response', async () => {
    mockFetchOnce({ error: 'bad request' }, false, 400);
    await expect(createExpense('key', group, { description: 'x', amount: 1, date: '2026-07-16T00:00:00.000Z' }))
      .rejects.toThrow(/400/);
  });
});
