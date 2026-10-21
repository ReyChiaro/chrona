import type { WorldReadModel } from './read-model';
import type { WorldSnapshot } from '../../../protocol/src/contracts';
/** Execution and persistence checkpoints do not depend on a drawing loop or thread API. */
export interface RuntimeHost extends WorldReadModel {
  readonly readOnly: boolean;
  pause(paused: boolean): Promise<void>;
  checkpoint(): Promise<WorldSnapshot>;
  stop(): Promise<WorldSnapshot>;
}
