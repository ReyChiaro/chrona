import { formatDate, getLocale, localizePayload, onLocaleChange } from '../../../packages/i18n/src/index';
import { setText, setTranslatedAttribute } from '../../../packages/i18n/src/browser';
import { t, escapeHtml } from '../../../packages/i18n/src/index';
import type { RenderCapabilities, RecordedTake, RenderJob, RenderSubmission } from '../../../packages/protocol/src/render-contracts';
import type { WorldView } from '../../../packages/viewer/src/world-view';
import { ProxyRecorder } from '../../../packages/viewer/src/recording/recorder';
import { RenderLogs, renderJobProgress } from './render-logs';
import { sampledFrameCount } from '../../../packages/protocol/src/trajectory';
import { requestJson as request } from './api';
import { PromptEnhancementPanel } from './prompt-enhancement';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class VideoWorkspace {
  readonly recorder = new ProxyRecorder();
  private logs = new RenderLogs();
  private enhancement = new PromptEnhancementPanel();
  private capabilities?: RenderCapabilities;
  private take?: RecordedTake;
  private recordingId?: string;
  private sourceUrl?: string;
  private busy = false;
  private lastSummaryUpdate = 0;
  private watchedId?: string;
  private poll?: ReturnType<typeof setTimeout>;
  constructor(private getView: () => WorldView, private onEnter: () => void, private toast: (message: string, error?: boolean) => void) {
    const controls = document.createElement('div'); controls.className = 'continuous-controls';
    controls.innerHTML = `<details><summary><span data-i18n="ui.video-workspace.segments-and-retries">${escapeHtml(t('ui.video-workspace.segments-and-retries'))}</span></summary><div class="render-parameters"><label class="render-parameter"><span data-i18n="ui.video-workspace.seconds-per-segment">${escapeHtml(t('ui.video-workspace.seconds-per-segment'))}</span><input id="segment-seconds" type="number" min="0.5" max="30" step="0.5" value="3.5"/></label><label class="render-parameter"><span data-i18n="ui.video-workspace.overlap-frames">${escapeHtml(t('ui.video-workspace.overlap-frames'))}</span><input id="overlap-frames" type="number" min="1" max="120" step="1" value="9"/></label><label class="render-parameter"><span data-i18n="ui.video-workspace.automatic-retries">${escapeHtml(t('ui.video-workspace.automatic-retries'))}</span><input id="route-retries" type="number" min="0" max="3" step="1" value="1"/></label></div></details><details><summary><span data-i18n="ui.video-workspace.visible-context-budget-set-before-recording">${escapeHtml(t('ui.video-workspace.visible-context-budget-set-before-recording'))}</span></summary><div class="render-parameters">${['near', 'middle', 'far'].map((band, i) => `<label class="render-parameter">${[t('ui.video-workspace.near'), t('ui.video-workspace.middle'), t('ui.video-workspace.far')][i]}<span data-i18n="ui.video-workspace.objects">${escapeHtml(t('ui.video-workspace.objects'))}</span><input id="budget-${band}" type="number" min="0" max="32" value="${[12, 8, 4][i]}"/></label>`).join('')}</div></details>`;
    byId('render-parameters').before(controls);
    const note = document.createElement('p'); note.id = 'sampling-note'; note.className = 'render-note'; byId('render-parameters').after(note);
    const adapters = document.createElement('details'); adapters.id = 'lora-options'; adapters.hidden = true;
    adapters.innerHTML = `<summary><span data-i18n="ui.video-workspace.additional-lora">${escapeHtml(t('ui.video-workspace.additional-lora'))}</span></summary><div id="lora-list"></div><p id="lora-note" class="render-note"></p><button id="lora-refresh" class="button" type="button"><span data-i18n="ui.video-workspace.refresh-list">${escapeHtml(t('ui.video-workspace.refresh-list'))}</span></button>`;
    note.after(adapters);
    byId('lora-refresh').addEventListener('click', () => {
      void request<RenderCapabilities>('/api/render/capabilities').then(caps => {
        if (this.capabilities) this.capabilities.adapters = caps.adapters;
        this.showAdapters();
      }).catch(error => this.toast(error.message, true));
    });
    const routeStatus = document.createElement('div'); routeStatus.id = 'route-status'; byId('render-jobs').before(routeStatus);
    byId('record-toggle').addEventListener('click', () => this.toggleRecording());
    byId('video-settings-toggle').addEventListener('click', () => byId<HTMLDialogElement>('render-dialog').showModal());
    byId('render-dialog-close').addEventListener('click', () => byId<HTMLDialogElement>('render-dialog').close());
    byId('submit-render').addEventListener('click', () => void this.submit().catch(error => this.toast(error.message, true)));
    byId('video-source-toggle').addEventListener('click', () => {
      const video = byId<HTMLVideoElement>('source-video'); video.hidden = !video.hidden;
      if (!video.hidden) byId<HTMLDialogElement>('render-dialog').close();
    });
    byId('job-refresh').addEventListener('click', () => void this.refreshJobs().catch(error => this.toast(error.message, true)));
    window.addEventListener('keydown', event => { if (event.code === 'KeyR' && this.recorder.active && !(event.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"]')) this.toggleRecording(); });
    byId<HTMLInputElement>('frame-stride').addEventListener('input', () => this.updateTakeSummary());
    byId('stride-auto').addEventListener('click', () => {
      byId<HTMLInputElement>('frame-stride').value = '1'; this.updateTakeSummary();
    });
    void this.connect();
  }

  get active(): boolean { return this.recorder.active; }
  frame(): void {
    this.recorder.frame();
    if (this.recorder.active && performance.now() - this.lastSummaryUpdate > 200) {
      this.lastSummaryUpdate = performance.now();
      setText(byId('record-label'), t('ui.video-workspace.frames-s', { p0: this.recorder.frameCount, p1: this.recorder.elapsed.toFixed(1) }));
      this.updateTakeSummary();
    }
  }

  private updateTakeSummary(): void {
    if (!this.capabilities) return;
    const frames = this.take?.frameCount ?? this.recorder.frameCount;
    const elapsed = this.take?.duration ?? this.recorder.elapsed;
    const stride = Number(byId<HTMLInputElement>('frame-stride').value);
    if (!Number.isSafeInteger(stride) || stride < 1 || stride > 1000000) {
      setText(byId('sampling-summary'), t('ui.video-workspace.enter-a-valid-positive-integer-sampling-interval'));
      byId<HTMLButtonElement>('submit-render').disabled = true; return;
    }
    const sampled = sampledFrameCount(frames, stride);
    const duration = sampled / this.capabilities.fps;
    const summary = frames ? t('ui.video-workspace.frames-s-trajectory-conditioning-frames-estimated-video-s', { p0: frames, p1: elapsed.toFixed(1), p2: sampled, p3: duration.toFixed(2) }) : t('ui.layout.no-recording-yet');
    setText(byId('recording-summary'), summary);
    setText(byId('sampling-summary'), t('ui.video-workspace.short-recordings-use-one-segment-long-routes-are-joined'));
    byId<HTMLButtonElement>('submit-render').disabled = !this.take || this.busy || !this.capabilities.enabled;
    if (this.recorder.active) {
      setText(byId('render-phase'), summary);
      setTranslatedAttribute(byId('render-phase'), 'title', summary);
    }
  }

  private async connect(): Promise<void> {
    try {
      const capabilities = await request<RenderCapabilities>('/api/render/capabilities');
      this.capabilities = capabilities;
      setText(byId('provider-label'), capabilities.label);
      setText(byId('provider-state'), capabilities.enabled ? t('ui.video-workspace.video-generation-connected') : t('ui.video-workspace.video-model-not-ready'));
      byId<HTMLTextAreaElement>('render-prompt').value = capabilities.prompt;
      byId<HTMLTextAreaElement>('render-system-prompt').value = capabilities.systemPrompt;
      this.showParameters();
      this.showAdapters();
      setText(byId('sampling-note'), `${capabilities.label} · ${capabilities.samplingNote ?? t('ui.video-workspace.the-current-model-determines-the-sampling-step-range')}`);
      const segments = capabilities.segmentation;
      if (segments) {
        Object.assign(byId<HTMLInputElement>('segment-seconds'), { min: String(segments.minSeconds), max: String(segments.maxSeconds), value: String(segments.defaultSeconds) });
        byId<HTMLInputElement>('overlap-frames').value = String(segments.defaultOverlapFrames);
      }
      byId<HTMLButtonElement>('record-toggle').disabled = false;
      await this.refreshJobs();
      const query = new URLSearchParams(location.search), job = query.get('job') ?? query.get('route');
      if (job && /^[a-f0-9-]{36}$/.test(job)) this.watch(job);
    } catch {
      setText(byId('provider-state'), t('ui.video-workspace.video-service-unavailable'));
      setText(byId('render-phase'), t('ui.video-workspace.start-the-rendering-service-and-refresh-to-record-and'));
    }
  }

  private showParameters(): void {
      const capabilities = this.capabilities;
      if (!capabilities) return;
      const fields = byId('render-parameters'); fields.replaceChildren();
      for (const field of capabilities.parameters) {
        const label = document.createElement('label'); label.className = 'render-parameter';
        const text = document.createElement('span'); setText(text, field.label);
        const control = document.createElement('input'); control.name = field.key; control.dataset.type = field.type;
        control.type = field.type === 'boolean' ? 'checkbox' : 'number';
        if (field.type === 'boolean') control.checked = Boolean(field.default);
        else Object.assign(control, { value: String(field.default), min: String(field.min), max: String(field.max), step: String(field.step) });
        if (field.type === 'number' && field.min === field.max) { control.readOnly = true; setTranslatedAttribute(control, 'title', t('ui.video-workspace.the-current-model-uses-a-fixed-sampling-setting')); }
        label.append(text, control); fields.append(label);
      }
  }

  private showAdapters(): void {
    const catalog = this.capabilities?.adapters;
    byId('lora-options').hidden = !catalog;
    if (!catalog) return;
    const list = byId('lora-list');
    const previous = new Map(this.selectedAdapters().map(item => [item.id, item.scale]));
    list.replaceChildren();
    for (const item of catalog.items) {
      const row = document.createElement('div'); row.className = 'adapter-option';
      const label = document.createElement('label');
      const selected = document.createElement('input'); selected.type = 'checkbox'; selected.dataset.adapterId = item.id;
      selected.checked = previous.has(item.id);
      const name = document.createElement('span'); setText(name, item.label); setTranslatedAttribute(name, 'title', `SHA256 ${item.sha256}`);
      const scale = document.createElement('input'); scale.type = 'number'; scale.dataset.adapterScale = item.id;
      Object.assign(scale, { min: '0', max: String(catalog.maxScale), step: '0.05', value: String(previous.get(item.id) ?? 1), disabled: !selected.checked });
      setTranslatedAttribute(scale, 'aria-label', t('ui.video-workspace.strength', { p0: item.label }));
      selected.onchange = () => { scale.disabled = !selected.checked; };
      label.append(selected, name); row.append(label, scale); list.append(row);
    }
    setText(byId('lora-note'), catalog.items.length
      ? t('ui.video-workspace.select-up-to-adapters-with-strength-0-leave-unchecked', { p0: catalog.maxActive, p1: catalog.maxScale })
      : t('ui.video-workspace.no-lora-adapters-available-add-compatible-safetensors-files-to'));
    if (catalog.warnings?.length) byId('lora-note').textContent += ` ${catalog.warnings.join('；')}`;
  }

  private selectedAdapters(): { id: string; scale: number }[] {
    return [...byId('lora-list').querySelectorAll<HTMLInputElement>('input[data-adapter-id]:checked')].map(input => ({
      id: input.dataset.adapterId!, scale: Number(byId('lora-list').querySelector<HTMLInputElement>(`input[data-adapter-scale="${input.dataset.adapterId}"]`)!.value),
    }));
  }

  private toggleRecording(): void {
    try {
      if (this.recorder.active) { this.recorder.stop(); return; }
      if (this.busy) throw new Error(t('ui.video-workspace.the-current-recording-is-being-submitted-wait-before-starting'));
      if (!this.capabilities) throw new Error(t('ui.video-workspace.the-video-service-is-not-connected-yet'));
      this.take = undefined; this.recordingId = undefined;
      this.recorder.contextBudget = Object.fromEntries(['near', 'middle', 'far'].map(b => [b, Math.max(0, Math.min(32, Number(byId<HTMLInputElement>(`budget-${b}`).value)))])) as typeof this.recorder.contextBudget;
      byId<HTMLButtonElement>('submit-render').disabled = true;
      const take = this.recorder.start(this.getView(), this.capabilities.recording);
      byId('record-toggle').classList.add('recording');
      setTranslatedAttribute(byId('record-toggle'), 'aria-label', t('ui.video-workspace.stop-recording'));
      setTranslatedAttribute(byId('record-toggle'), 'title', t('ui.video-workspace.stop-recording-r-recording-does-not-stop-automatically'));
      setText(byId('render-phase'), t('ui.video-workspace.recording-the-first-person-camera-press-r-to-stop'));
      this.onEnter();
      void take.then(result => {
        this.take = result;
        if (this.sourceUrl) URL.revokeObjectURL(this.sourceUrl);
        this.sourceUrl = URL.createObjectURL(result.blob);
        byId<HTMLVideoElement>('source-video').src = this.sourceUrl;
        setText(byId('render-phase'), t('ui.video-workspace.recording-complete-generate-a-video-directly-or-add-a'));
        this.updateTakeSummary();
        byId<HTMLAnchorElement>('download-source').href = this.sourceUrl;
        byId('take-actions').hidden = false;
      }).catch(error => this.toast(error.message, true)).finally(() => {
        byId('record-toggle').classList.remove('recording'); setText(byId('record-label'), t('ui.layout.record'));
        setTranslatedAttribute(byId('record-toggle'), 'aria-label', t('ui.layout.start-recording'));
        setTranslatedAttribute(byId('record-toggle'), 'title', t('ui.layout.start-recording-press-r-to-stop'));
      });
    } catch (error) { this.toast((error as Error).message, true); }
  }

  async submit(): Promise<void> {
    if (!this.take || this.busy) return;
    const prompt = byId<HTMLTextAreaElement>('render-prompt').value.trim();
    this.busy = true; byId<HTMLButtonElement>('submit-render').disabled = true;
    try {
      if (!this.recordingId) {
        setText(byId('render-phase'), t('ui.video-workspace.uploading-the-reference-video-and-camera-trajectory'));
        const data = new FormData(); data.append('video', this.take.blob, 'proxy-take.webm');
        data.append('metadata', new Blob([JSON.stringify({ duration: this.take.duration, fps: this.take.fps, width: this.take.width,
          height: this.take.height, mimeType: this.take.mimeType, frameCount: this.take.frameCount, world: this.take.world, observations: this.take.observations, contextSnapshots: this.take.contextSnapshots, editEvents: this.take.editEvents })], { type: 'application/json' }), 'trajectory.json');
        const uploaded = await request<{ id: string; frameCount: number }>('/api/render/recordings', { method: 'POST', body: data });
        this.recordingId = uploaded.id;
        if (uploaded.frameCount) this.take.frameCount = uploaded.frameCount;
      }
      const frameStride = Number(byId<HTMLInputElement>('frame-stride').value);
      if (!Number.isSafeInteger(frameStride) || frameStride < 1) throw new Error(t('ui.video-workspace.the-downsampling-interval-must-be-a-positive-integer'));
      if (!this.capabilities?.enabled) throw new Error(t('ui.video-workspace.the-video-model-is-not-ready-try-again-shortly'));
      const parameters: Record<string, number | boolean> = {};
      byId('render-parameters').querySelectorAll('input').forEach(control => parameters[control.name] = control.dataset.type === 'boolean' ? control.checked : Number(control.value));
      const body: RenderSubmission = { recording_id: this.recordingId, prompt, system_prompt: byId<HTMLTextAreaElement>('render-system-prompt').value, parameters, adapters: this.selectedAdapters(), frame_stride: frameStride,
        prompt_enhancement: this.enhancement.enabled,
        segment_seconds: Number(byId<HTMLInputElement>('segment-seconds').value), overlap_frames: Number(byId<HTMLInputElement>('overlap-frames').value), retries: Number(byId<HTMLInputElement>('route-retries').value),
        budgets: Object.fromEntries(['near', 'middle', 'far'].map(b => [b, Number(byId<HTMLInputElement>(`budget-${b}`).value)])) };
      const job = await request<RenderJob>('/api/render/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      byId<HTMLDialogElement>('render-dialog').close();
      this.watch(job.id);
      await this.refreshJobs();
    } finally { this.busy = false; this.updateTakeSummary(); }
  }

  private watch(id: string): void {
    this.watchedId = id;
    clearTimeout(this.poll);
    const check = async () => {
      try {
        const job = await request<RenderJob>(`/api/render/jobs/${id}`);
        if (this.watchedId !== id) return;
        this.showRoute(job);
        this.logs.setJob(job);
        renderJobProgress(job);
        setText(byId('render-phase'), job.status === 'failed' ? t('ui.video-workspace.generation-failed', { p0: job.error }) : job.phase);
        setTranslatedAttribute(byId('render-phase'), 'title', byId('render-phase').textContent!);
        byId('render-progress').hidden = !['queued', 'running'].includes(job.status);
        if (job.status === 'succeeded' && job.videoUrl) {
          byId<HTMLVideoElement>('source-video').hidden = true;
          const video = byId<HTMLVideoElement>('video-output'); video.src = job.videoUrl; video.hidden = false;
          byId('render-empty').hidden = true;
          const link = byId<HTMLAnchorElement>('download-result'); link.href = job.videoUrl; link.hidden = false;
          await this.refreshJobs();
        } else if (job.status !== 'failed') this.poll = setTimeout(() => void check(), 2000);
        else await this.refreshJobs();
      } catch (error) {
        setText(byId('render-phase'), t('ui.video-workspace.connection-interrupted-retrying', { p0: (error as Error).message }));
        this.poll = setTimeout(() => void check(), 5000);
      }
    };
    void check();
  }

  private async refreshJobs(): Promise<void> {
    const { jobs } = await request<{ jobs: RenderJob[] }>('/api/render/jobs');
    const container = byId('render-jobs'); container.replaceChildren();
    for (const job of jobs.slice(0, 12)) {
      const button = document.createElement('button'); button.className = 'render-job';
      setText(button, `${formatDate(job.createdAt * 1000, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${job.phase}`);
      button.addEventListener('click', () => { this.watch(job.id); byId<HTMLDialogElement>('render-dialog').close(); });
      container.append(button);
    }
    const active = jobs.find(job => ['queued', 'running'].includes(job.status));
    if (active && !this.watchedId) this.watch(active.id);
  }

  private showRoute(job: RenderJob): void {
    const target = byId('route-status'); target.replaceChildren();
    if (!job.segments) return;
    const label = document.createElement('p'); label.className = 'render-note'; setText(label, job.segments.map(s => t('ui.video-workspace.attempts', { p0: s.index + 1, p1: s.status, p2: s.attempts })).join(' · ')); target.append(label);
    if (job.status === 'failed' || job.status === 'succeeded') for (const [action, text] of [['retry', t('ui.video-workspace.resume-unfinished-segments')], ['rebuild', t('ui.video-workspace.rebuild-video-cache')]] as const) {
      if (action === 'retry' && job.status === 'succeeded') continue;
      const button = document.createElement('button'); button.className = 'button'; setText(button, text);
      button.onclick = () => { button.disabled = true; void request<RenderJob>(`/api/render/jobs/${job.id}/${action}`, { method: 'POST' }).then(() => this.watch(job.id)).catch(e => { this.toast(e.message, true); button.disabled = false; }); }; target.append(button);
    }
  }
}
