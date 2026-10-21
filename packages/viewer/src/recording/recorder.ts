import { LocalizedError } from '../../../i18n/src/index';
import { msg } from '../../../i18n/src/index';
import type { RecordedTake, RenderCapabilities } from '../../../protocol/src/render-contracts';
import type { WorldView } from '../world-view';

/** Captures only the proxy camera, with its own fixed-size rendering surface. */
export class ProxyRecorder {
  contextBudget = { near: 12, middle: 8, far: 4 };
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private lastObservation = -1;
  private observations: RecordedTake['observations'] = [];
  private contextSnapshots: NonNullable<RecordedTake['contextSnapshots']> = [];
  private lastRevision = -1;
  private seenWorldEvents = new Set<string>();
  private editEvents: NonNullable<RecordedTake['editEvents']> = [];
  private config?: RenderCapabilities['recording'];
  private track?: CanvasCaptureMediaStreamTrack;
  private resolve?: (take: RecordedTake) => void;
  private reject?: (error: Error) => void;
  private view?: WorldView;
  private pausedAt = 0;
  private pausedSeconds = 0;
  private stoppedDuration = 0;
  private visibilityChange = () => {
    if (!this.active) return;
    if (document.hidden && this.recorder!.state === 'recording') {
      this.pausedAt = performance.now(); this.recorder!.pause();
    } else if (!document.hidden && this.recorder!.state === 'paused') {
      this.pausedSeconds += (performance.now() - this.pausedAt) / 1000; this.pausedAt = 0; this.recorder!.resume();
    }
  };
  get active(): boolean { return Boolean(this.recorder && this.recorder.state !== 'inactive'); }
  get elapsed(): number { return this.active ? ((this.pausedAt || performance.now()) - this.startedAt) / 1000 - this.pausedSeconds : 0; }
  get frameCount(): number { return this.observations.length; }

  start(view: WorldView, config: RenderCapabilities['recording']): Promise<RecordedTake> {
    if (this.active) throw new LocalizedError('viewer.recorder.a-recording-is-already-in-progress');
    if (!globalThis.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new LocalizedError('viewer.recorder.this-browser-does-not-support-video-recording-use-a');
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new LocalizedError('viewer.recorder.no-supported-video-encoder-is-available-in-this-browser');
    this.view = view; this.config = config;
    const canvas = view.beginRecording(config.width, config.height);
    this.stream = canvas.captureStream(0);
    this.track = this.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    this.recorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: config.bitsPerSecond });
    this.chunks = []; this.observations = []; this.contextSnapshots = []; this.editEvents = []; this.lastRevision = view.runtime.content.state.revision; this.lastObservation = -1;
    this.seenWorldEvents = new Set(view.runtime.events.map(event => event.id));
    this.pausedAt = 0; this.pausedSeconds = 0; this.stoppedDuration = 0;
    const world = { id: view.runtime.id, generatorVersion: view.runtime.observation().generatorVersion, config: structuredClone(view.runtime.config) };
    const completed = new Promise<RecordedTake>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
    this.recorder.onerror = () => { this.reject?.(new LocalizedError('viewer.recorder.video-encoding-failed-record-again')); this.cleanup(); };
    this.recorder.onstop = () => {
      const take: RecordedTake = {
        blob: new Blob(this.chunks, { type: mimeType }), mimeType, duration: this.stoppedDuration,
        width: config.width, height: config.height, fps: config.fps, frameCount: this.frameCount, world, observations: this.observations, contextSnapshots: this.contextSnapshots, editEvents: this.editEvents,
      };
      this.cleanup(); this.resolve?.(take);
    };
    this.startedAt = performance.now(); this.recorder.start(250);
    document.addEventListener('visibilitychange', this.visibilityChange);
    return completed;
  }
  frame(): void {
    if (this.recorder?.state !== 'recording' || !this.view || !this.config) return;
    const elapsed = this.elapsed;
    const frameSlot = Math.floor(elapsed * this.config.fps);
    if (frameSlot > this.lastObservation) {
      this.view.renderRecording();
      this.observations.push({ time: elapsed, observation: this.view.recordingObservation() });
      const revision = this.view.runtime.content.state.revision, changed = revision !== this.lastRevision;
      const worldEvents = this.view.runtime.events;
      const physicalCreates = worldEvents.filter(event => !this.seenWorldEvents.has(event.id) && event.operation === 'physics.create');
      this.seenWorldEvents = new Set(worldEvents.map(event => event.id));
      if (changed || physicalCreates.length) {
        const events = this.view.runtime.content.state.events.filter(e => e.revision > this.lastRevision);
        this.editEvents.push({ time: elapsed, frame: this.frameCount - 1, revision, objectIds: [...events.map(e => e.objectId), ...physicalCreates.flatMap(e => e.objectIds)], actions: [...events.map(e => e.action), ...physicalCreates.map(() => 'create')] }); this.lastRevision = revision;
      }
      if (changed || physicalCreates.length || !this.contextSnapshots.length || elapsed - this.contextSnapshots.at(-1)!.time >= 0.5) this.contextSnapshots.push(this.view.context(elapsed, this.contextBudget));
      this.track?.requestFrame();
      this.lastObservation = frameSlot;
    }
  }
  stop(): void {
    if (!this.active) return;
    if (this.frameCount < 2) throw new LocalizedError('viewer.recorder.capture-at-least-two-frames-before-stopping');
    this.stoppedDuration = this.elapsed;
    this.recorder!.stop();
  }
  private cleanup(): void {
    this.stream?.getTracks().forEach(track => track.stop()); this.track = undefined;
    document.removeEventListener('visibilitychange', this.visibilityChange);
    this.view?.endRecording(); this.stream = undefined;
  }
}
