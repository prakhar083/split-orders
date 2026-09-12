const BASE = 'https://secure.splitwise.com/api/v3.0';

export interface SplitwiseMember {
  id: number;
}

export interface SplitwiseGroup {
  id: number;
  name: string;
  members: SplitwiseMember[];
}

async function api<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Splitwise gates third-party API access behind a paid plan. The raw body
    // blames "the app's developer", which is the user's own dev.splitwise.com
    // account here — so say that, and say the computed split survives.
    if (res.status === 403 && /Pro subscription/i.test(body)) {
      throw new Error(
        'Splitwise rejected the API key: posting through the API needs an active ' +
          'Splitwise Pro subscription on the account that registered the key at ' +
          'https://dev.splitwise.com. Nothing was posted — the computed split is ' +
          'saved and can be posted with --post once Pro is active.',
      );
    }
    throw new Error(`Splitwise API ${path} failed: HTTP ${res.status}${body ? ` — ${body}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export async function findGroup(apiKey: string, name: string): Promise<SplitwiseGroup> {
  const data = await api<{ groups: SplitwiseGroup[] }>(apiKey, '/get_groups');
  const matches = data.groups.filter(g => g.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) {
    const available = data.groups.map(g => g.name).join(', ') || '(none)';
    throw new Error(`No group found with name "${name}". Available groups: ${available}`);
  }
  if (matches.length > 1) throw new Error(`Multiple groups found with name "${name}"`);
  return matches[0];
}

export async function createExpense(
  apiKey: string,
  group: SplitwiseGroup,
  opts: { description: string; amount: number; date: string; details?: string },
): Promise<{ id: number }> {
  const data = await api<{ expenses: { id: number }[]; errors?: unknown }>(apiKey, '/create_expense', {
    method: 'POST',
    body: JSON.stringify({
      cost: opts.amount.toFixed(2),
      currency_code: 'INR',
      description: opts.description,
      details: opts.details,
      date: opts.date,
      group_id: group.id,
      split_equally: true,
    }),
  });
  if (!data.expenses || data.expenses.length === 0) {
    throw new Error(`Splitwise rejected the expense: ${JSON.stringify(data.errors)}`);
  }
  return { id: data.expenses[0].id };
}
