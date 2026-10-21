import type { Observation } from './contracts';
import type { WorldConfig } from './config';
import type { SceneContext } from './content';

export interface RenderParameter {
  key: string; label: string; labelKey?: string; type: 'number' | 'boolean'; default: number | boolean;
  min?: number; max?: number; step?: number;
}
export interface RenderCapabilities {
  label: string; labelKey?: string; enabled: boolean; providerState: string; providerError: string;
  recording: { fps: number; width: number; height: number; bitsPerSecond: number };
  fps: number; minFrames: number; maxFrames: number; frameMultiple: number; frameOffset: number;
  samplingNote?: string; samplingNoteKey?: string;
  adapters?: { maxActive: number; maxScale: number; items: { id: string; label: string; sha256: string; kind: string }[]; warnings?: string[] };
  segmentation?: { minSeconds: number; maxSeconds: number; defaultSeconds: number; defaultOverlapFrames: number };
  parameters: RenderParameter[]; prompt: string; systemPrompt: string;
  conditions: Record<string, boolean>;
  promptEnhancement?: { available: boolean; configured: boolean; defaultEnabled: boolean; label: string; referenceVideo: boolean; maxReferenceSeconds: number };
}
export interface ContextEvidence {
  kind: 'text' | 'image' | 'keyframe'; text?: string; asset_id?: string;
  world_tick?: number; confidence?: number; metadata?: Record<string, unknown>;
}
export interface RenderSubmission {
  recording_id: string; prompt: string; system_prompt?: string;
  parameters: Record<string, number | boolean>;
  adapters?: { id: string; scale: number }[];
  frame_stride: number; segment_seconds: number; overlap_frames: number; retries: number;
  budgets: Record<string, number>;
  prompt_enhancement?: boolean;
}
export interface RenderJob {
  kind?: 'route'; segments?: { index: number; status: string; attempts: number; error?: string; phase?: string }[];
  id: string; recordingId: string; status: 'queued' | 'running' | 'succeeded' | 'failed';
  phase: string; progress: number; createdAt: number; error: string | null; videoUrl: string | null;
  result?: { duration: number; width: number; height: number; fps: number };
  stage?: string; startedAt?: number; finishedAt?: number; stageStartedAt?: number;
  elapsedSeconds?: number; stageElapsedSeconds?: number;
  sampling?: { completed: number; total: number; samplingSeconds: number; samplingEtaSeconds: number | null };
}
export interface RecordedTake {
  blob: Blob; duration: number; mimeType: string; width: number; height: number; fps: number; frameCount: number;
  world: { id: string; generatorVersion: string; config: WorldConfig };
  observations: { time: number; observation: Observation }[];
  contextSnapshots?: SceneContext[];
  editEvents?: { time: number; frame: number; revision: number; objectIds: string[]; actions: string[] }[];
}
