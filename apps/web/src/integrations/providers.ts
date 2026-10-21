import type { ContentProvider, VideoProvider, Observation } from '../../../../packages/protocol/src/contracts';

/** Optional adapters live outside the world simulation and cannot advance its clock. */
export class IntegrationRegistry {
  video: VideoProvider | null = null;
  content: ContentProvider | null = null;
  private observers = new Set<(observation: Observation) => void>();
  get hasObservers(): boolean { return this.observers.size > 0; }
  registerVideo(provider: VideoProvider): void { this.video = provider; }
  registerContent(provider: ContentProvider): void { this.content = provider; }
  subscribe(listener: (observation: Observation) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }
  publish(observation: Observation): void { for (const listener of this.observers) listener(structuredClone(observation)); }
}
