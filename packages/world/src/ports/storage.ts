import type { WorldSnapshot, WorldSummary } from '../../../protocol/src/contracts';
export interface WorldStorePort {
  list(): Promise<WorldSummary[]>;
  read(id: string): Promise<WorldSnapshot>;
  write(snapshot: WorldSnapshot, sessionToken?: string): Promise<WorldSnapshot>;
}

export interface WorldSessionStorePort extends WorldStorePort {
  claim(id: string): Promise<{ token: string; snapshot: WorldSnapshot | null }>;
}
