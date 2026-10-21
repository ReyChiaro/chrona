import type { WorldSnapshot, WorldSummary } from '../../../packages/protocol/src/contracts';
import { snapshotSchema } from '../../../packages/protocol/src/contracts';
import { requestJson as request } from './api';

export const persistence = {
  async claim(id: string): Promise<{ token: string; snapshot: WorldSnapshot | null }> {
    const result = await request<{ token: string; snapshot: unknown }>(`/api/worlds/${encodeURIComponent(id)}/session`, { method: 'POST' });
    return { token: result.token, snapshot: result.snapshot ? snapshotSchema.parse(result.snapshot) : null };
  },
  async list(): Promise<WorldSummary[]> { return (await request<{ worlds: WorldSummary[] }>('/api/worlds')).worlds; },
  async load(id: string): Promise<WorldSnapshot> { return snapshotSchema.parse(await request(`/api/worlds/${encodeURIComponent(id)}`)); },
  async save(snapshot: WorldSnapshot, token?: string): Promise<void> {
    await request(`/api/worlds/${encodeURIComponent(snapshot.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Chrona-Session': token } : {}) }, body: JSON.stringify(snapshot) });
    localStorage.setItem('chrona:last-world', snapshot.id);
  },
};
