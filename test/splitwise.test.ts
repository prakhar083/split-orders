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

describe('Splitwise Pro gating', () => {
  // Splitwise put third-party API access behind a paid plan, and the raw body is
  // not actionable. Posting is opt-in, so this error has to say what to do.
  const proBody = {
    errors: {
      base: [
        "This app can't access Splitwise right now because its developer doesn't have an active Splitwise Pro subscription. Please contact the app's developer for help.",
      ],
    },
  };

  it('explains the Pro requirement instead of dumping the HTTP body', async () => {
    mockFetchOnce(proBody, false, 403);
    await expect(findGroup('key', 'Flatmates')).rejects.toThrow(/Splitwise Pro subscription/i);
  });

  it('names the account that needs the subscription', async () => {
    mockFetchOnce(proBody, false, 403);
    await expect(findGroup('key', 'Flatmates')).rejects.toThrow(/dev\.splitwise\.com/i);
  });

  it('tells the user their computed split is not lost', async () => {
    mockFetchOnce(proBody, false, 403);
    await expect(findGroup('key', 'Flatmates')).rejects.toThrow(/nothing was posted/i);
  });

  it('leaves other API failures reported verbatim', async () => {
    mockFetchOnce({ errors: { base: ['Invalid API request: you are not logged in'] } }, false, 401);
    const err = await findGroup('key', 'Flatmates').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/HTTP 401/);
    expect((err as Error).message).not.toMatch(/Splitwise Pro/i);
  });
});
