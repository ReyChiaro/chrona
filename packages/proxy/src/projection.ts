import { hexKey, worldToHex } from '../../world/src/hex';
import type { WorldReadModel } from '../../world/src/ports/read-model';
/** Stable, copied proxy data. A projection cannot become a world writer. */
export function projectWorld(world: WorldReadModel) {
  return structuredClone({ worldId: world.id, tick: world.clock.tick, revision: world.content.state.revision,
    assets: [...world.sceneAssets.values()].filter(asset => world.chunks.active.has(hexKey(worldToHex(asset.x, asset.z, world.config.chunkRadius)))), entities: world.state.snapshot().filter(entity => world.chunks.active.has(hexKey(worldToHex(entity.position.x, entity.position.z, world.config.chunkRadius)))),
    chunks: [...world.chunks.active.values()].map(chunk => ({ key: chunk.key, fingerprint: chunk.fingerprint, contentPackages: chunk.contentPackages ?? [] })) });
}
