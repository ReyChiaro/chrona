import { msg } from "../../../i18n/src/index";
import type { WorldStorePort } from "../../../world/src/ports/storage";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  snapshotSchema,
  type WorldSnapshot,
  type WorldSummary,
} from "../../../protocol/src/contracts";
export class CheckpointConflict extends Error {}
export class WorldStore implements WorldStorePort {
  private writes = new Map<string, Promise<unknown>>();
  private sessions = new Map<string, string>();
  constructor(readonly directory: string) {}
  private filename(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
      throw new Error("Invalid world identifier");
    return join(this.directory, `${id}.json`);
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    this.writes.set(id, task);
    try {
      return await task;
    } finally {
      if (this.writes.get(id) === task) this.writes.delete(id);
    }
  }
  private async readCurrent(id: string): Promise<WorldSnapshot> {
    return snapshotSchema.parse(
      JSON.parse(await readFile(this.filename(id), "utf8")),
    );
  }
  async list(): Promise<WorldSummary[]> {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory);
    const worlds = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            const world = await this.readCurrent(name.slice(0, -5));
            return {
              id: world.id,
              name: world.name,
              savedAt: world.savedAt,
              chunks: world.chunks.length,
              seed: world.config.seed,
            };
          } catch {
            return null;
          }
        }),
    );
    return worlds
      .filter((world): world is WorldSummary => world !== null)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  async read(id: string): Promise<WorldSnapshot> {
    await this.writes.get(id)?.catch(() => undefined);
    return this.readCurrent(id);
  }
  /** Claim is serialized with writes; a previous page cannot save after this grant. */
  async claim(
    id: string,
  ): Promise<{ token: string; snapshot: WorldSnapshot | null }> {
    this.filename(id);
    return this.serial(id, async () => {
      let snapshot: WorldSnapshot | null = null;
      try {
        snapshot = await this.readCurrent(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const token = crypto.randomUUID();
      this.sessions.set(id, token);
      return { token, snapshot };
    });
  }
  async write(input: WorldSnapshot, token?: string): Promise<WorldSnapshot> {
    const world = snapshotSchema.parse(input);
    return this.serial(world.id, async () => {
      if (
        (token !== undefined || this.sessions.has(world.id)) &&
        this.sessions.get(world.id) !== token
      )
        throw new CheckpointConflict(
          msg(
            "adapters.world-store.this-writing-session-has-expired-an-old-page-cannot",
          ),
        );
      let current: WorldSnapshot | undefined;
      try {
        current = await this.readCurrent(world.id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (
        current &&
        (world.tick < current.tick ||
          (world.content?.revision ?? 0) < (current.content?.revision ?? 0))
      )
        throw new CheckpointConflict(
          msg(
            "adapters.world-store.an-older-checkpoint-cannot-overwrite-confirmed-world-state",
          ),
        );
      await mkdir(this.directory, { recursive: true });
      const destination = this.filename(world.id),
        temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(world), { flag: "wx" });
        await rename(temporary, destination);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return world;
    });
  }
}
