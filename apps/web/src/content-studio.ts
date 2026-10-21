import { setRawText } from '../../../packages/i18n/src/browser';
import { getLocale, displayAssetLabel, onLocaleChange, formatMessage } from '../../../packages/i18n/src/index';
import { setTranslatedAttribute, setText } from '../../../packages/i18n/src/browser';
import { t, escapeHtml } from '../../../packages/i18n/src/index';
import type { ContentPackage, EditPlan, SceneSelection } from '../../../packages/protocol/src/content';
import type { WorldView } from '../../../packages/viewer/src/world-view';
import { jsonBody, requestJson } from './api';
import type { RoamInput } from './input';
import { AgentSettingsPanel } from './agent-settings';
import type { AgentRun, AgentStatus } from '../../../packages/protocol/src/agent';
import { suggestRegionSite } from '../../../packages/world/src/regions';

type Reply = { plan?: EditPlan; message?: string; release?: { package: ContentPackage; source: string; report: unknown }; trace: unknown[]; mode: string; model?: string };
type Message = { role: 'user' | 'assistant'; text: string };

/** Non-modal editing: capture the target before asynchronous agent work starts. */
export class ContentStudio {
  private root = document.createElement('section');
  private worldId = '';
  private messages: Message[] = [];
  private material?: string;
  private busy = false;
  private epoch = 0;
  private visibilityEpoch = 0;
  private resumeOnClose = false;
  private agentSettings: AgentSettingsPanel;
  private activeRequest?: string;
  private at = <T extends HTMLElement>(id: string) => this.root.querySelector(`#${id}`) as T;
  constructor(private view: () => WorldView, private input: () => RoamInput, private save: () => Promise<void>, private toast: (text: string, error?: boolean) => void) {
    onLocaleChange(() => { this.refreshSelection(); this.attachments(); });
    this.root.className = 'scene-composer'; this.root.id = 'scene-composer'; this.root.hidden = true; setTranslatedAttribute(this.root, 'aria-label', t('ui.content-studio.scene-conversation-editor'));
    this.root.innerHTML = `<div id="composer-body"><div class="composer-heading"><span><span data-i18n="ui.content-studio.talk-to-the-world">${escapeHtml(t('ui.content-studio.talk-to-the-world'))}</span> <small id="composer-agent-mode">Agent</small></span><div><button id="composer-agent-settings" title="${escapeHtml(t('ui.content-studio.configure-the-code-agent-api-model-and-key'))}" data-i18n-title="ui.content-studio.configure-the-code-agent-api-model-and-key"><span data-i18n="ui.content-studio.model">${escapeHtml(t('ui.content-studio.model'))}</span></button><button id="composer-undo" title="${escapeHtml(t('ui.content-studio.undo-the-latest-edit'))}" data-i18n-title="ui.content-studio.undo-the-latest-edit"><span data-i18n="ui.content-studio.undo">${escapeHtml(t('ui.content-studio.undo'))}</span></button><button id="composer-resume"><span data-i18n="ui.content-studio.continue-exploring">${escapeHtml(t('ui.content-studio.continue-exploring'))}</span></button><button id="composer-close" aria-label="${escapeHtml(t('ui.content-studio.close-conversation'))}" title="${escapeHtml(t('ui.content-studio.esc-closes-the-conversation-and-returns-to-exploration'))}" data-i18n-aria-label="ui.content-studio.close-conversation" data-i18n-title="ui.content-studio.esc-closes-the-conversation-and-returns-to-exploration">×</button></div></div>
      <div id="composer-messages" class="composer-messages" role="log" aria-live="polite"></div>
      <div id="composer-status" class="composer-status" role="status" hidden></div>
      <button id="composer-region-visit" type="button" hidden><span data-i18n="ui.content-studio.visit-the-new-region">${escapeHtml(t('ui.content-studio.visit-the-new-region'))}</span></button>
      <div class="composer-selection"><span id="composer-target"><span data-i18n="ui.content-studio.right-click-an-object-or-a-ground-anchor">${escapeHtml(t('ui.content-studio.right-click-an-object-or-a-ground-anchor'))}</span></span><button id="composer-clear" title="${escapeHtml(t('ui.content-studio.clear-selection'))}" data-i18n-title="ui.content-studio.clear-selection">×</button></div>
      <form id="composer-form"><textarea id="composer-prompt" rows="2" aria-label="${escapeHtml(t('ui.content-studio.scene-editing-instruction'))}" placeholder="${escapeHtml(t('ui.content-studio.for-example-turn-this-into-a-cherry-tree-with'))}" data-i18n-aria-label="ui.content-studio.scene-editing-instruction" data-i18n-placeholder="ui.content-studio.for-example-turn-this-into-a-cherry-tree-with"></textarea>
      <div id="composer-attachments" class="composer-attachments"></div><div class="composer-actions"><div><button type="button" id="composer-material-toggle"><span data-i18n="ui.content-studio.assets">${escapeHtml(t('ui.content-studio.assets'))}</span></button><label class="composer-file"><span data-i18n="ui.content-studio.reference-image">${escapeHtml(t('ui.content-studio.reference-image'))}</span><input id="composer-files" type="file" accept="image/png,image/jpeg,image/webp" multiple/></label></div><button type="submit" id="composer-send" aria-label="${escapeHtml(t('ui.content-studio.send-editing-instruction'))}" data-i18n-aria-label="ui.content-studio.send-editing-instruction"><span data-i18n="ui.content-studio.send">${escapeHtml(t('ui.content-studio.send'))}</span></button></div></form>
      <div id="composer-materials" class="composer-materials" hidden>${[['cherry', t('ui.content-studio.cherry-tree')], ['bench', t('ui.content-studio.wooden-bench')], ['lantern', t('ui.content-studio.lantern')], ['meadow', t('ui.content-studio.lavender-hills')]].map(([id, text]) => `<button type="button" data-material="${id}">${text}</button>`).join('')}</div>
      <details class="composer-details"><summary><span data-i18n="ui.content-studio.tools-and-validation">${escapeHtml(t('ui.content-studio.tools-and-validation'))}</span></summary><pre id="composer-trace"><span data-i18n="ui.content-studio.no-task-yet-built-in-skills-no-external-model">${escapeHtml(t('ui.content-studio.no-task-yet-built-in-skills-no-external-model'))}</span></pre><textarea id="composer-source" rows="8" readonly aria-label="${escapeHtml(t('ui.content-studio.agent-generated-plugin-source'))}" hidden data-i18n-aria-label="ui.content-studio.agent-generated-plugin-source"></textarea></details></div>`;
    document.querySelector('.first-stage')!.append(this.root);
    this.agentSettings = new AgentSettingsPanel(status => this.updateAgent(status), () => {
      if (!this.root.hidden) this.at<HTMLTextAreaElement>('composer-prompt').focus({ preventScroll: true });
    });
    this.at('composer-agent-settings').onclick = () => void this.agentSettings.open();
    document.querySelector<HTMLButtonElement>('#composer-toggle')!.onclick = () => { if (this.root.hidden) void this.open(); else this.close(); };
    this.at('composer-close').onclick = () => this.close();
    this.at('composer-resume').onclick = () => this.close(true);
    this.at('composer-clear').onclick = () => this.select(null);
    this.at('composer-undo').onclick = () => void this.undo();
    this.at('composer-material-toggle').onclick = () => { this.at('composer-materials').hidden = !this.at('composer-materials').hidden; };
    this.at('composer-form').onsubmit = e => { e.preventDefault(); void this.submit(); };
    this.at('composer-prompt').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!e.repeat) void this.submit(); } };
    this.at<HTMLInputElement>('composer-files').onchange = () => this.attachments();
    this.root.querySelectorAll<HTMLButtonElement>('[data-material]').forEach(button => button.onclick = () => {
      this.material = this.material === button.dataset.material ? undefined : button.dataset.material;
      this.root.querySelectorAll('[data-material]').forEach(b => b.classList.toggle('active', (b as HTMLElement).dataset.material === this.material)); this.attachments();
    });
    document.addEventListener('contextmenu', e => { if (e.target === this.view().firstRenderer.domElement) e.preventDefault(); });
    document.addEventListener('pointerdown', e => {
      if (e.target !== this.view().firstRenderer.domElement) return;
      if (!this.root.hidden) { e.preventDefault(); this.at<HTMLTextAreaElement>('composer-prompt').focus({ preventScroll: true }); return; }
      if (e.button !== 2) return;
      e.preventDefault(); const locked = document.pointerLockElement === e.target;
      this.select(locked ? this.view().pick() : this.view().pick(e.clientX, e.clientY));
    });
    window.addEventListener('keydown', e => {
      if (e.isComposing || e.repeat) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape' && !this.root.hidden) { e.preventDefault(); e.stopPropagation(); this.close(); return; }
      if ((e.target as HTMLElement)?.closest('input,textarea,[contenteditable="true"],button,dialog')) return;
      if (e.key === 'Enter' && this.root.hidden) { e.preventDefault(); e.stopPropagation(); void this.open(); }
    }, { capture: true });
  }
  private ensureWorld(): void {
    const id = this.view().runtime.id; if (id === this.worldId) return;
    this.worldId = id; this.messages = []; this.epoch++;
    this.at('composer-region-visit').hidden = true;
    try { const value = JSON.parse(localStorage.getItem(`chrona:conversation:${id}`) ?? localStorage.getItem(`dynamic-world:conversation:${id}`) ?? '[]'); if (Array.isArray(value)) this.messages = value.filter(m => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string').slice(-30); } catch { /* Empty history is valid. */ }
    this.renderMessages(); this.refreshSelection();
  }
  async open(): Promise<void> {
    this.ensureWorld();
    if (this.root.hidden) this.resumeOnClose = document.pointerLockElement === this.view().firstRenderer.domElement;
    const epoch = ++this.visibilityEpoch;
    this.root.hidden = false; this.refreshSelection();
    void this.agentSettings.refresh().catch(() => undefined);
    document.querySelector('#composer-toggle')!.setAttribute('aria-expanded', 'true');
    await this.input().suspend();
    requestAnimationFrame(() => {
      if (!this.root.hidden && epoch === this.visibilityEpoch) this.at<HTMLTextAreaElement>('composer-prompt').focus({ preventScroll: true });
    });
  }
  close(resume = this.resumeOnClose): void {
    this.visibilityEpoch++; this.root.hidden = true;
    this.agentSettings.close();
    this.at<HTMLTextAreaElement>('composer-prompt').blur(); this.input().resume(); this.resumeOnClose = false;
    document.querySelector('#composer-toggle')!.setAttribute('aria-expanded', 'false');
    if (resume) void this.input().enter();
  }
  private updateAgent(status: AgentStatus): void {
    const text = status.mode === 'api' ? `${status.model}${status.unlocked ? '' : t('ui.content-studio.locked')}` : t('ui.content-studio.demo-agent');
    setText(this.at('composer-agent-mode'), text); setTranslatedAttribute(this.at('composer-agent-mode'), 'title', text);
  }
  private async progress(requestId: string): Promise<void> {
    try {
      const value = await requestJson<AgentRun>(`/api/content/agent/runs/${requestId}`);
      if (this.activeRequest !== requestId) return;
      setText(this.at('composer-status'), value.phase);
      setText(this.at('composer-trace'), JSON.stringify({ mode: value.mode, phase: value.phase, trace: value.trace }, null, 2));
    } catch { /* The run may not have started yet. The edit response remains authoritative. */ }
  }
  select(value: SceneSelection | null): void { this.ensureWorld(); this.epoch++; this.view().select(value); this.refreshSelection(); }
  private refreshSelection(): void {
    const selection = this.view().selection;
    const asset = selection?.objectId ? this.view().runtime.sceneAssets.get(selection.objectId) : undefined;
    let label = selection ? displayAssetLabel(selection.label, asset?.contentKey) : '';
    if (selection?.kind === 'ground') {
      const key = (['viewer.selection.ground-anchor', 'ui.content-studio.creation-anchor-ahead'] as const).find(key => [formatMessage(key, {}, 'en'), formatMessage(key, {}, 'zh-Hans')].includes(selection.label));
      if (key) label = t(key);
    }
    setText(this.at('composer-target'), selection ? `${label} · ${selection.kind === 'object' ? selection.objectId : `${selection.point.x.toFixed(1)}, ${selection.point.z.toFixed(1)}`}` : t('ui.content-studio.right-click-an-object-or-a-ground-anchor'));
    this.at<HTMLButtonElement>('composer-undo').disabled = this.busy || !this.view().runtime.content.state.history.length;
  }
  private attachments(): void {
    const names = [...(this.at<HTMLInputElement>('composer-files').files ?? [])].map(f => f.name);
    setText(this.at('composer-attachments'), [this.material ? t('ui.content-studio.asset', { p0: this.material }) : '', ...names].filter(Boolean).join(' · '));
  }
  private add(role: Message['role'], text: string): void {
    this.messages.push({ role, text }); this.messages = this.messages.slice(-30); this.renderMessages();
    try { localStorage.setItem(`chrona:conversation:${this.worldId}`, JSON.stringify(this.messages)); } catch { /* World persistence is independent. */ }
  }
  private renderMessages(): void {
    const container = this.at('composer-messages'); container.replaceChildren();
    for (const m of this.messages) { const p = document.createElement('p'); p.className = `message-${m.role}`; setRawText(p, m.text); container.append(p); }
    container.scrollTop = container.scrollHeight;
  }
  private async undo(): Promise<void> {
    if (this.busy) return;
    try { const result = await this.view().runtime.editor.undo(); await this.save();
      const a = result.id ? this.view().runtime.chunks.assets.get(result.id) : undefined;
      this.view().select(a ? { kind: 'object', objectId: a.id, point: { x: a.x, y: a.y, z: a.z }, version: this.view().runtime.editor.version(a.id), label: a.design?.label ?? a.kind } : null);
      this.add('assistant', result.label); this.refreshSelection(); }
    catch (error) { this.add('assistant', (error as Error).message); }
  }
  async submit(): Promise<void> {
    if (this.busy) return; this.ensureWorld();
    const text = this.at<HTMLTextAreaElement>('composer-prompt').value.trim(); if (!text) return;
    const view = this.view(), runtime = view.runtime, epoch = this.epoch, worldId = runtime.id, requestId = crypto.randomUUID();
    let selection = view.selection ? structuredClone(view.selection) : null;
    if (!selection) {
      const hit = view.pick(), x = runtime.camera.x - Math.sin(runtime.camera.yaw) * 6, z = runtime.camera.z - Math.cos(runtime.camera.yaw) * 6;
      selection = hit?.kind === 'ground' ? hit : { kind: 'ground', label: t('ui.content-studio.creation-anchor-ahead'), point: { x, y: runtime.groundHeight(x, z), z } };
      view.select(selection); this.refreshSelection();
    }
    const history = this.messages.slice(-8).map(m => ({ ...m, text: m.text.slice(0, 1500) }));
    const camera = { ...runtime.camera }, material = this.material, files = [...(this.at<HTMLInputElement>('composer-files').files ?? [])];
    const target = selection.kind === 'object' ? structuredClone({ asset: runtime.sceneAssets.get(selection.objectId!), dynamic: runtime.state.entities.get(selection.objectId!) }) : null;
    this.busy = true; this.at<HTMLButtonElement>('composer-send').disabled = true; this.refreshSelection();
    this.activeRequest = requestId; this.at('composer-status').hidden = false; setText(this.at('composer-status'), t('ui.content-studio.collecting-the-target-and-context'));
    const progress = setInterval(() => void this.progress(requestId), 1000);
    this.add('user', text); this.at<HTMLTextAreaElement>('composer-prompt').value = ''; setText(this.at('composer-trace'), t('ui.content-studio.collecting-the-target-surroundings-and-references'));
    let applied = false;
    try {
      if (files.length > 8) throw new Error(t('ui.content-studio.select-up-to-8-reference-images-at-a-time'));
      const referenceIds = [];
      for (const file of files) { const body = new FormData(); body.append('file', file); const ref = await requestJson<{ id: string }>('/api/render/references', { method: 'POST', body }); referenceIds.push(ref.id); }
      setText(this.at('composer-trace'), t('ui.content-studio.the-agent-is-planning-reading-skills-writing-and-validating'));
      let site: ReturnType<typeof suggestRegionSite> | undefined, siteError: string | undefined;
      try { site = suggestRegionSite(runtime.config, camera, runtime.chunks.records.values()); } catch (error) { siteError = (error as Error).message; }
      const context = { ...view.context(), authoring: { site, error: siteError, protectedChunks: [...runtime.chunks.records.keys()] } };
      const reply = await requestJson<Reply>('/api/content/edit', jsonBody({ requestId, worldId, replyLocale: getLocale(), prompt: text, selection, camera, material, referenceIds, history, config: runtime.config, context, target }));
      if (this.view().runtime.id !== worldId) throw new Error(t('ui.content-studio.the-world-changed-this-result-was-not-applied'));
      clearInterval(progress); this.activeRequest = undefined;
      setText(this.at('composer-trace'), JSON.stringify({ mode: reply.mode, trace: reply.trace, plan: reply.plan, validation: reply.release?.report }, null, 2));
      this.at<HTMLTextAreaElement>('composer-source').value = reply.release?.source ?? ''; this.at('composer-source').hidden = !reply.release?.source;
      setText(this.at('composer-agent-mode'), reply.mode === 'api' ? reply.model ?? 'API Agent' : t('ui.content-studio.demo-agent'));
      void this.agentSettings.refresh().catch(() => undefined);
      if (!reply.plan) { this.add('assistant', t('ui.content-studio.no-scene-changes-were-made', { p0: reply.message ?? t('ui.content-studio.the-agent-did-not-submit-an-edit-plan') })); return; }
      setText(this.at('composer-status'), t('ui.content-studio.recomputing-the-region-and-checking-the-actual-result')); await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const result = await runtime.editor.apply(reply.plan, reply.release?.package); applied = true; await this.save();
      await requestJson(`/api/content/edits/${requestId}/receipt`, jsonBody({ worldId, status: result.regionReport?.status === 'partial' ? 'partial' : 'applied', revision: result.revision, regionReport: result.regionReport })).catch(() => undefined);
      if (this.epoch === epoch && result.id) {
        const asset = runtime.chunks.assets.get(result.id);
        if (asset) view.select({ kind: 'object', objectId: asset.id, version: runtime.editor.version(asset.id), label: asset.design?.label ?? asset.kind, point: { x: asset.x, y: asset.y, z: asset.z } }); else view.select(null);
      }
      if (result.regionReport && reply.release?.package.region) {
        const report = result.regionReport, region = reply.release.package.region;
        this.at('composer-trace').textContent += t('ui.content-studio.actual-region-validation', { p0: JSON.stringify(report, null, 2) });
        this.add('assistant', t('ui.content-studio.region-rules-published-and-existing-regions-are-preserved-visit', { p0: report.status === 'partial' ? t('ui.content-studio.partially-validated') : t('ui.content-studio.passed-generation-checks'), p1: result.label, p2: report.summary, p3: report.unsupported.length ? t('ui.content-studio.not-yet-supported', { p0: report.unsupported.join('；') }) : '', p4: region.center.x.toFixed(0), p5: region.center.z.toFixed(0) }));
        const button = this.at<HTMLButtonElement>('composer-region-visit'); button.hidden = false;
        button.onclick = () => { if (this.view().runtime.id !== worldId) return; runtime.teleport(region.center.x, region.center.z); void this.save(); this.close(); };
      } else this.add('assistant', t('ui.content-studio.saved-and-undoable-subsequent-recordings-use-the-updated-context', { p0: reply.plan.action === 'future' ? t('ui.content-studio.installed-rules-for-future-chunks') : t('ui.content-studio.edit-applied'), p1: result.label }));
      this.at<HTMLInputElement>('composer-files').value = ''; this.attachments();
    } catch (error) {
      void requestJson(`/api/content/edits/${requestId}/receipt`, jsonBody({ worldId, status: 'rejected', error: (error as Error).message })).catch(() => undefined);
      if (this.view().runtime.id === worldId) this.add('assistant', `${applied ? t('ui.content-studio.the-scene-was-updated-but-saving-failed-try-saving') : t('ui.content-studio.not-applied')}：${(error as Error).message}`);
      this.toast((error as Error).message, true);
    }
    finally { clearInterval(progress); this.activeRequest = undefined; this.at('composer-status').hidden = true; this.busy = false; this.at<HTMLButtonElement>('composer-send').disabled = false; this.refreshSelection(); }
  }
}
