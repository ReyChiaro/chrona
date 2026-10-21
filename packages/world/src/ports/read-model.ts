import type { WorldConfig } from '../../../protocol/src/config';
import type { CameraState, DynamicEntityState, Observation, TrailPoint, WorldSnapshot } from '../../../protocol/src/contracts';
import type { ContentPackage, ObjectConstraint, EditPlan } from '../../../protocol/src/content';
import type { RegionReport } from '../../../protocol/src/regions';
import type { ChunkChange } from '../chunks';
import type { Asset, ChunkData } from '../generator';
import type { WorldContent } from '../content';
import type { WorldClock } from '../clock';
import type { ChunkRecord } from '../../../protocol/src/contracts';
export interface MovementInput { forward: number; right: number; sprint: boolean; jump: boolean }
export interface ApplyReceipt { id?: string; label: string; revision: number; regionReport?: RegionReport }
export interface WorldReadModel {
  readonly id: string; readonly name: string; readonly config: WorldConfig;
  readonly camera: CameraState; readonly origin: { x: number; z: number };
  readonly events: import('../../../protocol/src/contracts').WorldEvent[];
  readonly trail: TrailPoint[]; readonly grounded: boolean; readonly content: WorldContent;
  readonly chunks: { active: Map<string, ChunkData>; records: Map<string, ChunkRecord>; assets: Map<string, Asset> };
  readonly clock: Pick<WorldClock, 'paused' | 'tick' | 'elapsedSeconds' | 'hour' | 'label'>;
  readonly state: { entities: Map<string, DynamicEntityState>; bodies: Map<string, unknown>; snapshot(): DynamicEntityState[] };
  readonly traffic: { assets: Map<string, Asset> }; readonly sceneAssets: Map<string, Asset>;
  readonly editor: { version(id: string): number; apply(plan: EditPlan, pack?: ContentPackage): ApplyReceipt | Promise<ApplyReceipt>; undo(): ApplyReceipt | Promise<ApplyReceipt> };
  subscribe(listener: (change: ChunkChange) => void): () => void;
  observation(): Observation; snapshot(): WorldSnapshot; groundHeight(x: number, z: number): number;
  teleport(x: number, z: number, y?: number): void | Promise<void>;
  look(dx: number, dy: number): void;
  update(delta: number, input: MovementInput): void;
  applyRuntimeConfig(config: WorldConfig): void | Promise<void>;
  dropPhysicsObject(): string | Promise<string>;
  installContent(pack: ContentPackage, options?: { futureChunks?: boolean; targetId?: string; asset?: string; constraint?: ObjectConstraint }): void | Promise<void>;
  dispose(): void;
}
