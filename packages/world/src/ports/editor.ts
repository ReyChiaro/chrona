import type { WorldConfig } from '../../../protocol/src/config';
import type { DynamicEntityState, CameraState } from '../../../protocol/src/contracts';
import type { Asset } from '../generator';
import type { ChunkManager } from '../chunks';
import type { WorldClock } from '../clock';
import type { WorldContent } from '../content';

/** The world defines this port; physics and execution hosts implement it. */
export interface EditorHost {
  readonly id: string; disposed: boolean; config: WorldConfig; camera: CameraState;
  content: WorldContent; chunks: ChunkManager; clock: WorldClock;
  sceneAssets: Map<string, Asset>;
  state: { entities: Map<string, DynamicEntityState>; snapshot(): DynamicEntityState[]; replace(id: string, entity?: DynamicEntityState): void };
  traffic: { resolve(id: string, seconds: number): Asset | undefined };
  recordEvent?(id: string, operation: string, objectIds?: string[], regions?: string[]): void;
  groundHeight(x: number, z: number): number;
  validatePlacement(asset: Asset, excludeId?: string): void;
  refreshEditedObjects(): void;
}
