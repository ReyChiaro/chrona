import { LocalizedError } from '../../../i18n/src/index';
import { annotatePayload, errorPayload } from '../../../i18n/src/index';
import { msg } from '../../../i18n/src/index';
import { initializePhysics, WorldRuntime } from '../rapier/runtime';
import { configSchema } from '../../../protocol/src/config';
import type { MovementInput } from '../../../world/src/ports/read-model';
let runtime: WorldRuntime;
let timer: ReturnType<typeof setInterval> | undefined;
let previous = 0, broadcastAt = 0;
let input: MovementInput = { forward: 0, right: 0, sprint: false, jump: false };
let inputAt = 0;
let writerToken: string | undefined;
let chunksSignature = '';
function packet(force = false) {
  const snapshot = runtime.snapshot();
  const signature = `${snapshot.content?.revision}:${snapshot.config.loadRange}:${[...runtime.chunks.active.keys()].join('|')}`;
  const changed = force || signature !== chunksSignature; chunksSignature = signature;
  return { snapshot, observation: runtime.observation(), origin: { ...runtime.origin }, grounded: runtime.grounded,
    chunks: changed ? [...runtime.chunks.active.values()] : undefined, traffic: [...runtime.traffic.assets.values()],
    metrics: { blockedAutomaticSpawns: [...runtime.state.blockedSpawns].map(id => ({ id, reason: 'entity-budget' })), pendingSteps: runtime.pendingSteps, stepMilliseconds: runtime.stepMilliseconds, simulationChunks: runtime.simulationChunks.size,
      rigidBodies: runtime.physics.bodies.len(), impulseJoints: runtime.physics.impulseJoints.len(), multibodyJoints: runtime.physics.multibodyJoints.len(),
      activeBodies: [...runtime.state.bodies.values()].filter(b => !b.isSleeping()).length,
      sleepingBodies: [...runtime.state.bodies.values()].filter(b => b.isSleeping()).length,
      residency: [...runtime.residencyReasons].map(([key, owners]) => ({ key, owners: [...owners] })) } };
}
function publish(force = false) { postMessage({ type: 'frame', value: packet(force) }); }
function start() {
  if (timer) return;
  previous = performance.now();
  timer = setInterval(() => {
    const now = performance.now(), dt = (now - previous) / 1000; previous = now;
    try {
      runtime.updateObserver(dt, now - inputAt < runtime.config.execution.inputTimeoutMs ? input : { forward: 0, right: 0, sprint: false, jump: false });
      runtime.advanceWorld(dt);
      if (now - broadcastAt > 1000 / runtime.config.execution.publishHz) { publish(); broadcastAt = now; }
    } catch (error) { clearInterval(timer); timer = undefined; postMessage({ type: 'fatal', error: errorPayload(error) }); }
  }, 1000 / runtime.config.execution.hostHz);
}
self.onmessage = async ({ data }) => {
  const { id, method, args = [] } = data;
  try {
    if (method !== 'init' && data.worldId !== runtime.id) throw new LocalizedError('adapters.host.worker.the-world-identity-does-not-match');
    let result: unknown;
    switch (method) {
      case 'init': await initializePhysics(); runtime?.dispose(); runtime = new WorldRuntime(configSchema.parse(args[0]), args[1]); result = packet(true); break;
      case 'start': writerToken = args[0]; start(); break;
      case 'input': input = args[0]; inputAt = performance.now(); return;
      case 'look': runtime.look(args[0], args[1]); break;
      case 'camera': Object.assign(runtime.camera, args[0]); runtime.teleport(runtime.camera.x, runtime.camera.z, runtime.camera.y); break;
      case 'rename': if (typeof args[0] !== 'string' || !args[0].trim() || args[0].length > 100) throw new LocalizedError('adapters.host.worker.invalid-world-name'); runtime.name = args[0]; break;
      case 'pause': runtime.clock.paused = args[0]; break;
      case 'configure': runtime.applyRuntimeConfig(configSchema.parse(args[0])); break;
      case 'teleport': runtime.teleport(args[0], args[1], args[2]); break;
      case 'apply': result = runtime.editor.apply(args[0], args[1]); break;
      case 'undo': result = runtime.editor.undo(); break;
      case 'install': runtime.installContent(args[0], args[1]); break;
      case 'drop': result = runtime.dropPhysicsObject(); break;
      case 'checkpoint': result = runtime.snapshot(true); break;
      case 'stop': clearInterval(timer); timer = undefined; result = runtime.snapshot(true); break;
      case 'close':
        clearInterval(timer); timer = undefined;
        // Best effort final save; acknowledged periodic checkpoints remain the recovery guarantee.
        await fetch(`/api/worlds/${runtime.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(writerToken ? { 'X-Chrona-Session': writerToken } : {}) }, body: JSON.stringify(runtime.snapshot(true)) });
        result = runtime.snapshot(); break;
      default: throw new Error(`Unknown runtime operation: ${method}`);
    }
    postMessage({ type: 'reply', id, result: annotatePayload(result), frame: method !== 'init' ? packet() : undefined });
  } catch (error) { postMessage({ type: 'reply', id, error: errorPayload(error) }); }
};
