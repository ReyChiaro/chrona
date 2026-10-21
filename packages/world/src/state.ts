import type { DynamicEntityState } from "../../protocol/src/contracts";
/** Stable domain identities and migratable state, independent of any physical engine. */
export class EntityState {
  readonly entities = new Map<string, DynamicEntityState>();
  constructor(saved: DynamicEntityState[] = []) {
    for (const entity of saved)
      this.entities.set(entity.id, structuredClone(entity));
  }
  create(
    id: string,
    x: number,
    y: number,
    z: number,
    tick: number,
  ): DynamicEntityState {
    const entity: DynamicEntityState = {
      id,
      kind: "crate",
      position: { x, y, z },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linearVelocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      halfExtent: 0.55,
      updatedTick: tick,
      sleeping: false,
    };
    this.entities.set(id, entity);
    return entity;
  }

  replace(id: string, entity?: DynamicEntityState): void {
    this.entities.delete(id);
    if (entity) this.entities.set(id, structuredClone(entity));
  }
  snapshot(): DynamicEntityState[] {
    return structuredClone([...this.entities.values()]);
  }
}
