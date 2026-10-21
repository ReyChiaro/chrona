import { LocalizedError } from '../../i18n/src/index';
import { msg } from '../../i18n/src/index';
import { contentStateSchema, editPlanSchema, type ContentPackage, type EditPlan, type ObjectEditState, type StoredObject } from '../../protocol/src/content';
import type { EditorHost } from './ports/editor';
import { WorldContent } from './content';
import { evaluateRegion } from './region-validation';
import type { RegionReport } from '../../protocol/src/regions';
import type { DynamicEntityState } from '../../protocol/src/contracts';

const dynamicObject = (entity: DynamicEntityState): StoredObject => ({ id: entity.id, kind: 'custom', ...entity.position, scale: 1, rotation: 0, variant: 0,
  design: { label: msg('viewer.selection.physics-cube'), parts: [], effect: 'none', collider: { halfExtents: [entity.halfExtent, entity.halfExtent, entity.halfExtent], center: [0, 0, 0] } } });

/** Atomic, undoable object edits. No rendering or model owns world state. */
export class WorldEditor {
  constructor(private runtime: EditorHost) {}
  version(id: string): number { return this.runtime.content.state.objectVersions[id] ?? 0; }
  object(id: string): StoredObject | undefined { return this.runtime.sceneAssets.get(id); }
  private before(id: string): ObjectEditState {
    const s = this.runtime.content.state;
    return structuredClone({ addition: s.additions[id], patch: s.patches[id], resolved: this.object(id), deleted: s.deletedIds.includes(id), override: s.overrides[id],
      constraint: s.constraints.find(c => c.objectId === id), dynamic: this.runtime.state.entities.get(id) });
  }
  private restore(id: string, value: ObjectEditState, restoreDynamic = true): void {
    const s = this.runtime.content.state;
    for (const [key, data] of [['additions', value.addition], ['patches', value.patch], ['overrides', value.override]] as const) {
      delete s[key][id]; if (data) (s[key] as Record<string, unknown>)[id] = structuredClone(data);
    }
    s.deletedIds = s.deletedIds.filter(v => v !== id); if (value.deleted) s.deletedIds.push(id);
    s.constraints = s.constraints.filter(c => c.objectId !== id); if (value.constraint) s.constraints.push(structuredClone(value.constraint));
    if (restoreDynamic) this.runtime.state.replace(id, value.dynamic);
  }
  apply(input: EditPlan, pack?: ContentPackage): { id?: string; label: string; revision: number; regionReport?: RegionReport } {
    const plan = editPlanSchema.parse(input), r = this.runtime, s = r.content.state;
    if (plan.worldId !== r.id || r.disposed) throw new LocalizedError('world.editor.the-world-changed-this-request-was-not-applied');
    if (s.appliedRequests.includes(plan.requestId)) return { id: plan.action === 'create' ? `user:${plan.requestId}` : plan.targetId, label: msg('world.editor.this-request-has-already-been-applied'), revision: s.revision };
    if (plan.action === 'undo') return this.undo(plan.requestId);
    const original = structuredClone(s), dynamic = r.state.snapshot();
    let id = plan.targetId, target = id ? this.object(id) : undefined, entity = id ? r.state.entities.get(id) : undefined;
    if (!['create', 'future'].includes(plan.action)) {
      if (!id || (!target && !entity) || s.deletedIds.includes(id)) throw new LocalizedError('world.editor.the-target-was-deleted-or-left-the-loaded-area');
      if (plan.expectedVersion !== undefined && plan.expectedVersion !== this.version(id)) throw new LocalizedError('world.editor.another-instruction-changed-the-target-submit-the-edit-again');
    }
    if (plan.action === 'future') {
      if (!pack?.terrain && !pack?.region) throw new LocalizedError('world.editor.a-validated-terrain-or-region-package-is-required');
      const activeBefore = [...s.activePackages];
      let regionReport: RegionReport | undefined;
      if (pack?.region) {
        const candidate = new WorldContent(s), protectedChunks = [...r.chunks.records.keys()];
        candidate.deployRegion(pack, protectedChunks, r.clock.tick);
        regionReport = evaluateRegion(candidate, pack, r.config, plan.intent);
        if (regionReport.status === 'failed') throw new LocalizedError('world.editor.region-validation-failed', { p0: regionReport.failures.join('；') });
        r.content.deployRegion(pack, protectedChunks, r.clock.tick);
      } else r.content.install(pack!, true);
      s.appliedRequests = [...s.appliedRequests, plan.requestId].slice(-500);
      s.history.push({ id: plan.requestId, label: plan.label, changes: [], activeBefore }); s.history = s.history.slice(-50);
      r.refreshEditedObjects(); r.recordEvent?.(plan.requestId, 'content.future', [], pack?.region ? [`${pack.id}@${pack.version}`] : []); return { label: plan.label, revision: s.revision, regionReport };
    }
    if (plan.action === 'create') id = `user:${plan.requestId}`;
    const before = this.before(id!);
    try {
      if (target?.role === 'vehicle' && ['move', 'replace'].includes(plan.action)) throw new LocalizedError('world.editor.moving-vehicles-support-deletion-undo-and-appearance-constraints-publish');
      let next = target ? structuredClone(target) : undefined;
      if (plan.action === 'create' || plan.action === 'replace') {
        if (!pack || !plan.asset || !pack.assets[plan.asset]) throw new LocalizedError('world.editor.a-validated-asset-is-required');
        const content = new WorldContent(s); content.install(pack, false);
        const point = plan.action === 'create' ? plan.point : target ?? entity?.position;
        if (!point) throw new LocalizedError('world.editor.right-click-the-ground-to-choose-a-creation-anchor');
        next = { id: id!, kind: target?.kind ?? 'custom', x: point.x, y: point.y, z: point.z,
          scale: target?.scale ?? 1, rotation: target?.rotation ?? 0, variant: target?.variant ?? 0,
          design: pack.assets[plan.asset], contentKey: `${pack.id}@${pack.version}` };
        r.validatePlacement(next, plan.action === 'replace' ? id : undefined);
        r.content.install(pack, false);
        delete s.overrides[id!];
        // Replacing a physics crate explicitly converts it into a persistent static scene object.
        if (entity) { r.state.replace(id!, undefined); delete s.patches[id!]; s.additions[id!] = next; }
        else if (plan.action === 'create' || s.additions[id!]) s.additions[id!] = next;
        else s.patches[id!] = next;
      } else if (plan.action === 'move') {
        if (!plan.delta && !plan.point) throw new LocalizedError('world.editor.specify-a-movement-distance-or-position');
        const base = target ?? entity!.position;
        const p = plan.point ?? { x: base.x + plan.delta!.x, y: base.y + plan.delta!.y, z: base.z + plan.delta!.z };
        const y = plan.delta?.y ? p.y : r.groundHeight(p.x, p.z) + (entity ? entity.halfExtent : 0);
        if (target) { next = { ...structuredClone(target), ...p, y }; r.validatePlacement(next, id);
          if (s.additions[id!]) s.additions[id!] = next; else s.patches[id!] = next; }
        else { const copy = structuredClone(entity!); copy.position = { ...p, y }; copy.linearVelocity = { x: 0, y: 0, z: 0 };
          r.validatePlacement(dynamicObject(copy), id);
          r.state.replace(id!, copy); }
      } else if (plan.action === 'delete') {
        if (!s.deletedIds.includes(id!)) s.deletedIds.push(id!);
        r.state.replace(id!, undefined);
      }
      if (plan.constraint || plan.referenceIds.length) {
        const constraint = { objectId: id!, text: plan.constraint || next?.design?.label || msg('world.editor.preserve-this-object-s-appearance-and-position'), referenceIds: plan.referenceIds };
        const index = s.constraints.findIndex(c => c.objectId === id);
        if (index >= 0) { if (!plan.referenceIds.length) constraint.referenceIds = s.constraints[index].referenceIds; s.constraints[index] = constraint; }
        else s.constraints.push(constraint);
      }
      s.revision++; s.objectVersions[id!] = this.version(id!) + 1;
      const after = this.before(id!);
      s.history.push({ id: plan.requestId, label: plan.label, changes: [{ id: id!, before, after }] }); s.history = s.history.slice(-50);
      const p = next ?? target ?? entity?.position ?? plan.point!;
      s.events.push({ id: plan.requestId, objectId: id!, revision: s.revision, tick: r.clock.tick, worldSeconds: r.clock.elapsedSeconds,
        action: plan.action === 'create' ? 'create' : plan.action === 'delete' ? 'delete' : plan.action === 'constraint' ? 'constraint' : 'update',
        label: plan.label, position: { x: p.x, y: p.y, z: p.z } }); s.events = s.events.slice(-200);
      s.appliedRequests = [...s.appliedRequests, plan.requestId].slice(-500);
      contentStateSchema.parse(s);
      r.refreshEditedObjects(); r.recordEvent?.(plan.requestId, plan.action, [id!]); return { id, label: plan.label, revision: s.revision };
    } catch (error) { r.content.state = original; for (const e of dynamic) r.state.replace(e.id, e); r.refreshEditedObjects(); throw error; }
  }
  undo(requestId: string = crypto.randomUUID()): { id?: string; label: string; revision: number } {
    const r = this.runtime, s = r.content.state, last = s.history.at(-1);
    if (s.appliedRequests.includes(requestId)) return { label: msg('world.editor.this-undo-request-has-already-been-applied'), revision: s.revision };
    if (!last) throw new LocalizedError('world.editor.there-are-no-edits-to-undo');
    const semantic = (entity: DynamicEntityState | undefined) => entity ? JSON.stringify({ position: entity.position, rotation: entity.rotation, linearVelocity: entity.linearVelocity, angularVelocity: entity.angularVelocity, sleeping: entity.sleeping }) : '';
    for (const change of last.changes) {
      const current = this.before(change.id);
      for (const field of ['addition', 'patch', 'deleted', 'override', 'constraint'] as const) {
        if (JSON.stringify(current[field]) !== JSON.stringify(change.after[field])) throw new LocalizedError('world.editor.the-target-changed-and-undo-would-conflict-select-the');
      }
      if (semantic(change.before.dynamic) !== semantic(change.after.dynamic) && semantic(current.dynamic) !== semantic(change.after.dynamic)) throw new LocalizedError('world.editor.the-object-has-continued-moving-undo-would-rewind-physics');
      const value = change.before.addition ?? change.before.patch ?? change.before.resolved ?? (change.before.dynamic ? dynamicObject(change.before.dynamic) : undefined);
      if (value && !change.before.deleted) r.validatePlacement(value.role === 'vehicle' ? r.traffic.resolve(value.id, r.clock.elapsedSeconds) ?? value : value, change.id);
    }
    if (last.activeBefore) s.activePackages = [...last.activeBefore];
    for (const change of last.changes) {
      this.restore(change.id, change.before, semantic(change.before.dynamic) !== semantic(change.after.dynamic)); s.objectVersions[change.id] = this.version(change.id) + 1;
      const p = change.before.addition ?? change.before.patch ?? change.before.resolved ?? change.after.addition ?? change.after.patch ?? change.before.dynamic?.position ?? { x: r.camera.x, y: r.camera.y, z: r.camera.z };
      s.events.push({ id: requestId, objectId: change.id, revision: s.revision + 1, tick: r.clock.tick, worldSeconds: r.clock.elapsedSeconds,
        action: change.before.deleted || (!change.before.addition && change.after.addition && !change.before.dynamic) ? 'delete' : 'undo',
        label: msg('world.editor.undo', { p0: last.label }), position: { x: p.x, y: p.y, z: p.z } });
    }
    s.history.pop(); s.revision++; s.events = s.events.slice(-200); s.appliedRequests = [...s.appliedRequests, requestId].slice(-500);
    r.refreshEditedObjects(); r.recordEvent?.(requestId, 'undo', last.changes.map(c => c.id)); return { id: last.changes[0]?.id, label: last.activeBefore ? msg('world.editor.undid-future-generation-rules-explored-regions-are-preserved', { p0: last.label }) : msg('world.editor.undone', { p0: last.label }), revision: s.revision };
  }
}
