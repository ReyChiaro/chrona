import {
  localizePayload,
  LocalizedError,
  formatMessage,
  isDescriptor,
} from "../../../i18n/src/index";
import { CameraPresentation } from "./presentation";
import type { RuntimeFrame as Frame } from "./frame";
import type { RuntimeHost } from "../../../world/src/ports/runtime-host";
import type { WorldConfig } from "../../../protocol/src/config";
import type {
  CameraState,
  Observation,
  WorldSnapshot,
} from "../../../protocol/src/contracts";
import type {
  ContentPackage,
  ObjectConstraint,
  EditPlan,
} from "../../../protocol/src/content";
import type { ChunkData } from "../../../world/src/generator";
import { ChunkManager, type ChunkChange } from "../../../world/src/chunks";
import { WorldContent } from "../../../world/src/content";
import { WorldClock } from "../../../world/src/clock";
import { surfaceHeight } from "../../../world/src/surface";
import { terrainHeight } from "../../../world/src/terrain";
import { hexKey, worldToHex } from "../../../world/src/hex";
import type {
  WorldReadModel,
  MovementInput,
  ApplyReceipt,
} from "../../../world/src/ports/read-model";

type SessionStore = {
  claim(id: string): Promise<{ token: string; snapshot: WorldSnapshot | null }>;
  save(snapshot: WorldSnapshot, token?: string): Promise<void>;
};
/** A viewer copy and a command channel. The Worker is the sole authoritative runtime. */
export class WorldRuntime implements RuntimeHost {
  private worker = new Worker(new URL("./host.worker.ts", import.meta.url), {
    type: "module",
  });
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void }
  >();
  private listeners = new Set<(change: ChunkChange) => void>();
  private saved!: WorldSnapshot;
  private latest!: Frame;
  private observed!: Observation;
  private configuration!: WorldConfig;
  private release?: () => void;
  private channel?: BroadcastChannel;
  private disposed = false;
  private presentation = new CameraPresentation();
  private configSignature = "";
  private lastInputAt = -Infinity;
  private lastInput = "";
  private lastLookSent = 0;
  private movement: MovementInput = { forward: 0, right: 0, sprint: false, jump: false };
  private viewerId = crypto.randomUUID();
  private viewers = new Map<string, number>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private writing = false;
  private hasWriterFrame = false;
  private writerToken?: string;
  private sessionStore?: SessionStore;
  readOnly = false;
  metrics: Record<string, unknown> = {};
  origin = { x: 0, z: 0 };
  grounded = false;
  content = new WorldContent();
  chunks!: ChunkManager;
  private worldClock!: WorldClock;
  readonly state = {
    entities: new Map<
      string,
      import("../../../protocol/src/contracts").DynamicEntityState
    >(),
    bodies: new Map<string, unknown>(),
    snapshot: () => structuredClone([...this.state.entities.values()]),
  };
  readonly traffic = {
    assets: new Map<string, import("../../../world/src/generator").Asset>(),
    bodies: new Map<string, unknown>(),
  };
  readonly editor = {
    object: (id: string) => structuredClone(this.sceneAssets.get(id)),
    version: (id: string) => this.content.state.objectVersions[id] ?? 0,
    apply: (plan: EditPlan, pack?: ContentPackage) =>
      this.command<ApplyReceipt>("apply", plan, pack),
    undo: () => this.command<ApplyReceipt>("undo"),
  };
  private constructor() {
    this.worker.onmessage = ({ data }) => {
      if (data.type === "fatal") {
        window.dispatchEvent(
          new CustomEvent("chrona-runtime-error", {
            detail: data.error?.code
              ? formatMessage(data.error.code, data.error.params)
              : (data.error?.message ?? data.error),
          }),
        );
        return;
      }
      if (data.type === "frame") {
        this.accept(data.value);
        this.broadcast(data.value);
        return;
      }
      const task = this.pending.get(data.id);
      if (!task) return;
      this.pending.delete(data.id);
      if (data.frame) {
        this.accept(data.frame);
        this.broadcast(data.frame);
      }
      if (data.error) {
        const value = data.error;
        task.reject(
          value.code && isDescriptor({ key: value.code })
            ? new LocalizedError(value.code, value.params)
            : new Error(value.message ?? value),
        );
      } else task.resolve(localizePayload(data.result));
    };
    this.worker.onerror = (event) => {
      for (const task of this.pending.values())
        task.reject(new Error(event.message));
      this.pending.clear();
    };
  }
  static async create(
    config: WorldConfig,
    saved?: WorldSnapshot,
    sessionStore?: SessionStore,
  ): Promise<WorldRuntime> {
    const client = new WorldRuntime();
    client.sessionStore = sessionStore;
    try {
      const frame = await client.rpc<Frame>("init", config, saved);
      client.accept(frame);
      client.channel = new BroadcastChannel(`chrona:world:${client.id}`);
      client.channel.onmessage = ({ data }) => {
        if (client.writing && (data.type === "query" || data.type === "viewer")) {
          const seen = client.viewers.get(data.viewerId);
          client.viewers.set(data.viewerId, performance.now());
          if (data.type === "query" || seen === undefined || performance.now() - seen > 6000) client.channel!.postMessage({
            type: "frame", target: data.viewerId, value: client.fullFrame(client.latest),
          });
        }
        if (data.type === "leave") client.viewers.delete(data.viewerId);
        if (data.type === "frame" && client.readOnly && (!data.target || data.target === client.viewerId)) {
          if (data.value.resetChunks) client.hasWriterFrame = true;
          if (client.hasWriterFrame) client.accept(data.value);
        }
      };
      if (!navigator.locks)
        throw new LocalizedError(
          "adapters.client.this-browser-does-not-support-world-session-locks-use",
        );
      await new Promise<void>((resolve, reject) => {
        void navigator.locks
          .request(
            `chrona:writer:${client.id}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) {
                client.readOnly = true;
                client.worker.terminate();
                const announce = () => client.channel!.postMessage({
                  type: client.hasWriterFrame ? "viewer" : "query", viewerId: client.viewerId,
                });
                announce();
                client.heartbeat = setInterval(announce, 2000);
                resolve();
                return;
              }
              if (client.sessionStore) {
                const grant = await client.sessionStore.claim(client.id);
                client.writerToken = grant.token;
                if (grant.snapshot)
                  client.accept(
                    await client.rpc<Frame>(
                      "init",
                      grant.snapshot.config,
                      grant.snapshot,
                    ),
                  );
              }
              client.writing = true;
              await client.rpc("start", client.writerToken);
              resolve();
              await new Promise<void>((done) => {
                client.release = done;
              });
            },
          )
          .catch(reject);
      });
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }
  get id() {
    return this.saved.id;
  }
  get name() {
    return this.saved.name;
  }
  rename(name: string) {
    return this.command("rename", name);
  }
  pause(value: boolean) {
    return this.command("pause", value);
  }
  setCameraPose(pose: Partial<CameraState>) {
    return this.command("camera", pose);
  }
  get config() {
    return this.configuration;
  }
  get camera(): CameraState {
    return this.saved.camera;
  }
  presentationCamera(now: number): CameraState {
    return this.presentation.sample(now);
  }
  get events() {
    return structuredClone(this.saved.events ?? []);
  }
  get trail() {
    return this.saved.trail;
  }
  get sceneAssets() {
    return new Map([...this.chunks.assets, ...this.traffic.assets]);
  }
  get clock() {
    const client = this;
    return {
      get paused() {
        return client.worldClock.paused;
      },
      set paused(value: boolean) {
        void client.command("pause", value).catch(client.report);
      },
      get tick() {
        return client.worldClock.tick;
      },
      get elapsedSeconds() {
        return client.worldClock.elapsedSeconds;
      },
      get hour() {
        return client.worldClock.hour;
      },
      get label() {
        return client.worldClock.label;
      },
    };
  }
  private report = (error: Error) =>
    window.dispatchEvent(
      new CustomEvent("chrona-runtime-error", { detail: error.message }),
    );
  private fullFrame(frame: Frame): Frame {
    // postMessage performs the clone; do not clone snapshots again here.
    return { ...frame, chunks: [...this.chunks.active.values()], removedChunks: undefined, resetChunks: true };
  }
  private broadcast(frame: Frame): void {
    const now = performance.now();
    for (const [id, seen] of this.viewers) if (now - seen > 6000) this.viewers.delete(id);
    if (this.viewers.size) this.channel?.postMessage({ type: "frame", value: frame });
  }
  private accept(frame: Frame) {
    const contentChanged = !this.saved || this.saved.content?.revision !== frame.snapshot.content?.revision;
    this.latest = frame;
    this.saved = frame.snapshot;
    this.observed = frame.observation;
    this.origin = frame.origin;
    this.grounded = frame.grounded;
    this.metrics = frame.metrics;
    const signature = JSON.stringify(frame.snapshot.config);
    if (signature !== this.configSignature) {
      this.configSignature = signature;
      this.configuration = structuredClone(frame.snapshot.config);
    }
    this.presentation.receive(this.camera, performance.now(), 1000 / this.config.execution.publishHz, frame.cameraEpoch, frame.lookSequence);
    this.worldClock ??= new WorldClock(this.configuration.clock);
    Object.assign(this.worldClock, {
      config: this.configuration.clock,
      paused: this.saved.simulation.paused,
      tick: this.saved.tick,
      elapsedSeconds: this.saved.elapsedSeconds,
    });
    if (contentChanged) this.content = new WorldContent(this.saved.content);
    if (!this.chunks) this.chunks = new ChunkManager(this.configuration);
    this.chunks.config = this.configuration;
    this.chunks.center = worldToHex(this.camera.x, this.camera.z, this.config.chunkRadius);
    if (frame.resetChunks || frame.chunks?.length || this.chunks.records.size !== this.saved.chunks.length) {
      if (frame.resetChunks) this.chunks.records.clear();
      for (const record of this.saved.chunks) this.chunks.records.set(hexKey(record), record);
    }
    const removed = new Set(frame.removedChunks ?? []);
    if (frame.resetChunks) {
      const wanted = new Set(frame.chunks?.map(chunk => chunk.key));
      for (const key of this.chunks.active.keys()) if (!wanted.has(key)) removed.add(key);
    }
    for (const key of removed) this.chunks.active.delete(key);
    const added: ChunkData[] = [];
    for (const chunk of frame.chunks ?? []) {
      const previous = this.chunks.active.get(chunk.key);
      if (!previous || previous.fingerprint !== chunk.fingerprint || contentChanged) {
        this.chunks.active.set(chunk.key, chunk);
        added.push(chunk);
      }
    }
    this.state.entities.clear();
    this.state.bodies.clear();
    for (const entity of this.saved.simulation.entities) {
      this.state.entities.set(entity.id, entity);
      this.state.bodies.set(entity.id, null);
    }
    this.traffic.assets.clear();
    this.traffic.bodies.clear();
    for (const asset of frame.traffic) {
      this.traffic.assets.set(asset.id, asset);
      this.traffic.bodies.set(asset.id, null);
    }
    if (added.length || removed.size || contentChanged)
      for (const listener of this.listeners) listener({ added, removed: [...removed], center: this.chunks.center });
  }
  private rpc<T = void>(method: string, ...args: unknown[]): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({
        id,
        method,
        args,
        worldId: method === "init" ? undefined : this.id,
      });
    });
  }
  private command<T = void>(method: string, ...args: unknown[]): Promise<T> {
    if (this.readOnly)
      return Promise.reject(
        new LocalizedError(
          "adapters.client.this-world-is-running-in-another-tab-this-view",
        ),
      );
    if (this.disposed)
      return Promise.reject(
        new LocalizedError("adapters.client.the-world-session-is-closed"),
      );
    this.flushInput(true);
    return this.rpc<T>(method, ...args);
  }
  subscribe(listener: (change: ChunkChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  snapshot() {
    return structuredClone(this.saved);
  }
  observation() {
    return structuredClone(this.observed);
  }
  async persist(snapshot: WorldSnapshot): Promise<void> {
    if (this.readOnly || !this.sessionStore)
      throw new LocalizedError(
        "adapters.client.this-view-does-not-have-permission-to-save-the",
      );
    await this.sessionStore.save(snapshot, this.writerToken);
  }
  checkpoint() {
    return this.readOnly
      ? Promise.reject(
          new LocalizedError(
            "adapters.client.a-read-only-view-cannot-save-the-world",
          ),
        )
      : this.command<WorldSnapshot>("checkpoint");
  }
  stop() {
    return this.command<WorldSnapshot>("stop");
  }
  closeSession() {
    if (!this.readOnly) void this.command("close").catch(this.report);
  }
  groundHeight(x: number, z: number) {
    const chunk = this.chunks.active.get(
      hexKey(worldToHex(x, z, this.config.chunkRadius)),
    );
    return chunk
      ? (surfaceHeight(chunk, x, z) ?? terrainHeight(x, z, this.config))
      : terrainHeight(x, z, this.config);
  }
  private flushInput(force = false): void {
    if (this.readOnly || this.disposed) return;
    const now = performance.now(), signature = JSON.stringify(this.movement);
    if (!force && signature === this.lastInput && now - this.lastInputAt < 1000 / this.config.execution.hostHz) return;
    const look = this.presentation.pendingLook;
    this.worker.postMessage({
      method: "input", args: [this.movement, look && look.sequence > this.lastLookSent ? look : undefined], worldId: this.id,
    });
    if (look) this.lastLookSent = look.sequence;
    this.lastInputAt = now;
    this.lastInput = signature;
  }
  update(_delta: number, input: MovementInput) {
    this.movement = input;
    this.flushInput();
  }
  look(dx: number, dy: number) {
    if (!this.readOnly && !this.disposed) this.presentation.turn(dx, dy, this.config.presentation.mouseSensitivity, performance.now());
  }
  teleport(x: number, z: number, y?: number) {
    return this.command("teleport", x, z, y);
  }
  applyRuntimeConfig(config: WorldConfig) {
    return this.command("configure", structuredClone(config));
  }
  dropPhysicsObject() {
    return this.command<string>("drop");
  }
  installContent(
    pack: ContentPackage,
    options?: {
      futureChunks?: boolean;
      targetId?: string;
      asset?: string;
      constraint?: ObjectConstraint;
    },
  ) {
    return this.command("install", pack, options);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.release?.();
    clearInterval(this.heartbeat);
    if (this.readOnly) this.channel?.postMessage({ type: "leave", viewerId: this.viewerId });
    this.channel?.close();
    this.worker.terminate();
    this.listeners.clear();
    for (const task of this.pending.values())
      task.reject(
        new LocalizedError("adapters.client.the-world-session-is-closed"),
      );
    this.pending.clear();
  }
}
