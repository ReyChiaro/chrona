import { LocalizedError } from "../../../i18n/src/index";
import { annotatePayload, errorPayload } from "../../../i18n/src/index";
import type { ChunkData } from "../../../world/src/generator";
import type { RuntimeFrame } from "./frame";
import type { LookInput } from "./presentation";
import { initializePhysics, WorldRuntime } from "../rapier/runtime";
import { configSchema, generationSignature } from "../../../protocol/src/config";
import type { MovementInput } from "../../../world/src/ports/read-model";
let runtime: WorldRuntime;
let timer: ReturnType<typeof setInterval> | undefined;
let publisher: ReturnType<typeof setTimeout> | undefined;
let prefetch: Worker | undefined;
let preparationBusy = false;
let preparationGeneration = 0;
let preparationSignature = "";
let prefetchFailed = false;
let prefetchedChunks = 0;
let prefetchError = "";
let previous = 0;
let lookSequence = 0;
let cameraEpoch = 0;
let input: MovementInput = { forward: 0, right: 0, sprint: false, jump: false };
let inputAt = 0;
let writerToken: string | undefined;
let sentChunks = new Map<string, ChunkData>();
let sentRevision = -1;
function packet(force = false): RuntimeFrame {
  const snapshot = runtime.snapshot();
  const contentChanged = snapshot.content?.revision !== sentRevision;
  const chunks = [...runtime.chunks.active.values()].filter(chunk => force || contentChanged || sentChunks.get(chunk.key) !== chunk);
  const removedChunks = [...sentChunks.keys()].filter(key => !runtime.chunks.active.has(key));
  sentChunks = new Map(runtime.chunks.active);
  sentRevision = snapshot.content?.revision ?? 0;
  return {
    snapshot,
    observation: runtime.observation(),
    origin: { ...runtime.origin },
    grounded: runtime.grounded,
    chunks: chunks.length || force ? chunks : undefined,
    removedChunks: removedChunks.length ? removedChunks : undefined,
    resetChunks: force || undefined,
    lookSequence,
    cameraEpoch,
    traffic: [...runtime.traffic.assets.values()],
    metrics: {
      blockedAutomaticSpawns: [...runtime.state.blockedSpawns].map((id) => ({
        id,
        reason: "entity-budget",
      })),
      prefetchedChunks,
      preparedChunks: runtime.chunks.preparedCount,
      prefetchError,
      pendingSteps: runtime.pendingSteps,
      stepMilliseconds: runtime.stepMilliseconds,
      simulationChunks: runtime.simulationChunks.size,
      rigidBodies: runtime.physics.bodies.len(),
      impulseJoints: runtime.physics.impulseJoints.len(),
      multibodyJoints: runtime.physics.multibodyJoints.len(),
      activeBodies: [...runtime.state.bodies.values()].filter(
        (b) => !b.isSleeping(),
      ).length,
      sleepingBodies: [...runtime.state.bodies.values()].filter((b) =>
        b.isSleeping(),
      ).length,
      residency: [...runtime.residencyReasons].map(([key, owners]) => ({
        key,
        owners: [...owners],
      })),
    },
  };
}
function publish(force = false) {
  postMessage({ type: "frame", value: packet(force) });
}
function stopTimers(): void {
  clearInterval(timer);
  clearTimeout(publisher);
  prefetch?.terminate();
  prefetch = undefined;
  preparationBusy = false;
  preparationSignature = "";
  timer = publisher = undefined;
}
function fail(error: unknown): void {
  stopTimers();
  postMessage({ type: "fatal", error: errorPayload(error) });
}
function prepare(): void {
  if (prefetchFailed) return;
  const signature = () => `${runtime.content.state.revision}:${generationSignature(runtime.config)}`;
  const disable = (message: string) => {
    prefetchError = message;
    prefetchFailed = true;
    prefetch?.terminate();
    prefetch = undefined;
    preparationBusy = false;
  };
  try {
    if (!prefetch) {
      prefetch = new Worker(new URL("./prefetch.worker.ts", import.meta.url), { type: "module" });
      prefetch.onmessage = ({ data }) => {
        if (data.generation !== preparationGeneration) return;
        preparationBusy = false;
        if (data.type === "error") { disable(data.message); return; }
        if (data.type === "prepared" && signature() === preparationSignature) {
          runtime.chunks.storePrepared(data.chunk);
          prefetchedChunks++;
        }
      };
      prefetch.onerror = (event) => disable(event.message);
    }
    const nextSignature = signature();
    if (nextSignature !== preparationSignature) {
      preparationSignature = nextSignature;
      preparationGeneration++;
      preparationBusy = false;
      runtime.chunks.invalidatePrepared();
      prefetch.postMessage({ type: "init", config: runtime.config, content: runtime.content.state, generation: preparationGeneration });
    }
    if (preparationBusy) return;
    const cell = runtime.chunks.nextPreparation(runtime.camera.x, runtime.camera.z);
    if (!cell) return;
    preparationBusy = true;
    prefetch.postMessage({ type: "prepare", cell, record: runtime.chunks.records.get(`${cell.q},${cell.r}`), generation: preparationGeneration });
  } catch (error) { disable((error as Error).message); }
}
function start() {
  if (timer) return;
  previous = performance.now();
  // Publication has its own deadline; 25 Hz is not rounded down to every third 60 Hz tick.
  let nextPublication = previous + 1000 / runtime.config.execution.publishHz;
  const broadcast = () => {
    try {
      publish();
      const period = 1000 / runtime.config.execution.publishHz;
      nextPublication = Math.max(nextPublication + period, performance.now() + 1);
      publisher = setTimeout(broadcast, Math.max(0, nextPublication - performance.now()));
    } catch (error) { fail(error); }
  };
  publisher = setTimeout(broadcast, Math.max(0, nextPublication - performance.now()));
  timer = setInterval(() => {
    const now = performance.now(), dt = (now - previous) / 1000;
    previous = now;
    try {
      runtime.updateObserver(dt, now - inputAt < runtime.config.execution.inputTimeoutMs
        ? input : { forward: 0, right: 0, sprint: false, jump: false });
      runtime.advanceWorld(dt);
      // One job at a time in a separate Worker; terrain generation cannot block physics/publication.
      prepare();
    } catch (error) { fail(error); }
  }, 1000 / runtime.config.execution.hostHz);
}
self.onmessage = async ({ data }) => {
  const { id, method, args = [] } = data;
  try {
    if (method !== "init" && data.worldId !== runtime.id)
      throw new LocalizedError(
        "adapters.host.worker.the-world-identity-does-not-match",
      );
    let result: unknown;
    switch (method) {
      case "init":
        await initializePhysics();
        stopTimers();
        runtime?.dispose();
        sentChunks.clear();
        sentRevision = -1;
        lookSequence = 0;
        prefetchFailed = false;
        prefetchError = "";
        prefetchedChunks = 0;
        cameraEpoch++;
        input = { forward: 0, right: 0, sprint: false, jump: false };
        runtime = new WorldRuntime(configSchema.parse(args[0]), args[1]);
        result = packet(true);
        break;
      case "start":
        writerToken = args[0];
        start();
        break;
      case "input":
        input = args[0];
        inputAt = performance.now();
        const look: LookInput | undefined = args[1];
        if (look && Number.isSafeInteger(look.sequence) && look.sequence > lookSequence && Number.isFinite(look.yaw) && Number.isFinite(look.pitch)) {
          runtime.camera.yaw = look.yaw;
          runtime.camera.pitch = Math.max(-Math.PI * 0.47, Math.min(Math.PI * 0.47, look.pitch));
          lookSequence = look.sequence;
        }
        return;
      case "camera":
        cameraEpoch++;
        Object.assign(runtime.camera, args[0]);
        runtime.teleport(runtime.camera.x, runtime.camera.z, runtime.camera.y);
        break;
      case "rename":
        if (
          typeof args[0] !== "string" ||
          !args[0].trim() ||
          args[0].length > 100
        )
          throw new LocalizedError("adapters.host.worker.invalid-world-name");
        runtime.name = args[0];
        break;
      case "pause":
        runtime.clock.paused = args[0];
        break;
      case "configure":
        runtime.applyRuntimeConfig(configSchema.parse(args[0]));
        if (timer) { stopTimers(); start(); }
        break;
      case "teleport":
        cameraEpoch++;
        runtime.teleport(args[0], args[1], args[2]);
        break;
      case "apply":
        result = runtime.editor.apply(args[0], args[1]);
        break;
      case "undo":
        result = runtime.editor.undo();
        break;
      case "install":
        runtime.installContent(args[0], args[1]);
        break;
      case "drop":
        result = runtime.dropPhysicsObject();
        break;
      case "checkpoint":
        result = runtime.snapshot(true);
        break;
      case "stop":
        stopTimers();
        result = runtime.snapshot(true);
        break;
      case "close":
        stopTimers();
        // Best effort final save; acknowledged periodic checkpoints remain the recovery guarantee.
        await fetch(`/api/worlds/${runtime.id}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(writerToken ? { "X-Chrona-Session": writerToken } : {}),
          },
          body: JSON.stringify(runtime.snapshot(true)),
        });
        result = runtime.snapshot();
        break;
      default:
        throw new Error(`Unknown runtime operation: ${method}`);
    }
    postMessage({
      type: "reply",
      id,
      result: annotatePayload(result),
      frame: method !== "init" ? packet() : undefined,
    });
  } catch (error) {
    postMessage({ type: "reply", id, error: errorPayload(error) });
  }
};
