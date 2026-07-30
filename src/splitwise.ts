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
  if (!res.ok) throw new Error(`Splitwise API ${path} failed: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function findGroup(apiKey: string, name: string): Promise<SplitwiseGroup> {
  const data = await api<{ groups: SplitwiseGroup[] }>(apiKey, '/get_groups');
  const matches = data.groups.filter(g => g.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 0) throw new Error(`No group found with name "${name}"`);
  if (matches.length > 1) throw new Error(`Multiple groups found with name "${name}"`);
  return matches[0];
}

export async function createExpense(
  apiKey: string,
  group: SplitwiseGroup,
  opts: { description: string; amount: number; date: string },
): Promise<{ id: number }> {
  const data = await api<{ expenses: { id: number }[] }>(apiKey, '/create_expense', {
    method: 'POST',
    body: JSON.stringify({
      cost: opts.amount.toFixed(2),
      description: opts.description,
      date: opts.date,
      group_id: group.id,
      split_equally: true,
    }),
  });
  return { id: data.expenses[0].id };
}
