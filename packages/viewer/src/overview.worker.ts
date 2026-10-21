import type { WorldConfig } from '../../protocol/src/config';
import type { Hex } from '../../world/src/hex';
import { buildOverviewMesh, overviewSummary, type OverviewLOD } from './overview-data';
import { WorldContent } from '../../world/src/content';
import type { ChunkRecord } from '../../protocol/src/contracts';
import { hexKey } from '../../world/src/hex';

let config: WorldConfig;
const summaries: Hex[] = [];
let jobs: { cell: Hex; lod: OverviewLOD }[] = [];
let scheduled = false;
let awaitingUpload = false;
let content = new WorldContent();
let revision = 0;
const records = new Map<string, ChunkRecord>();

function pump(): void {
  scheduled = false;
  if (!config) return;
  const started = performance.now(), result = [];
  try {
    if (jobs.length && !awaitingUpload) {
      const job = jobs.shift()!, record = records.get(hexKey(job.cell));
      const custom = Boolean(record?.contentPackages?.length || Object.keys(content.state.overrides).length || Object.keys(content.state.additions).length || Object.keys(content.state.patches).length || content.state.deletedIds.length);
      const mesh = buildOverviewMesh(job.cell, config, job.lod, custom ? content.generate(job.cell, config, record) : undefined);
      awaitingUpload = true;
      self.postMessage({ type: 'mesh', mesh, revision }, { transfer: [mesh.positions.buffer, mesh.colors.buffer, mesh.normals.buffer] });
    } else {
      while (summaries.length && result.length < 24 && performance.now() - started < 8) {
        const cell = summaries.pop()!, record = records.get(hexKey(cell)), summary = overviewSummary(cell, config);
        if (record?.contentPackages?.some(key => content.state.packages.find(p => `${p.id}@${p.version}` === key)?.region)) {
          const data = content.generate(cell, config, record);
          summary.height = data.positions[1]; summary.color = Array.from(data.colors.slice(0, 3));
          summary.corners = data.boundary.filter((_, i) => i % config.subdivisions === 0).map(p => p.y);
          summary.top = Math.max(...summary.corners, ...data.assets.map(a => a.y + (a.design ? Math.max(...a.design.parts.map(p => p.position[1] + p.size[1] / 2)) * a.scale : config.population.treeHeight)), ...Array.from(data.positions).filter((_, i) => i % 3 === 1));
        }
        result.push(summary);
      }
      if (result.length) self.postMessage({ type: 'summaries', summaries: result });
    }
  } catch (error) { awaitingUpload = false; self.postMessage({ type: 'error', message: (error as Error).message }); }
  if ((jobs.length && !awaitingUpload) || summaries.length) schedule();
}
function schedule(): void { if (!scheduled) { scheduled = true; setTimeout(pump, 0); } }

self.onmessage = event => {
  if (event.data.type === 'init') config = event.data.config;
  if (event.data.type === 'content') { content = new WorldContent(event.data.state); revision = event.data.state.revision; for (const r of event.data.records) records.set(hexKey(r), r); jobs = []; awaitingUpload = false; }
  if (event.data.type === 'records') for (const r of event.data.records) records.set(hexKey(r), r);
  if (event.data.type === 'summaries') summaries.push(...event.data.cells);
  if (event.data.type === 'plan') jobs = event.data.jobs;
  if (event.data.type === 'uploaded' && event.data.revision === revision) awaitingUpload = false;
  schedule();
};
