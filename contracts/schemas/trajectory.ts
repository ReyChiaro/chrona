export interface ReferenceLimits {
  fps: number;
  minDuration: number;
  maxDuration: number;
  frameMultiple: number;
  frameOffset: number;
}

/** Sampling is independent from a model's per-segment length limits. */
export function sampledFrameCount(
  sourceFrames: number,
  frameStride: number,
): number {
  const count = Math.max(0, Math.floor(sourceFrames)),
    stride = Math.max(1, Math.floor(frameStride));
  return count
    ? Math.floor((count - 1) / stride) + 1 + Number((count - 1) % stride !== 0)
    : 0;
}

/** Preserve the first and last view while retaining one of every N recorded frames. */
export function trajectoryPlan(
  sourceFrames: number,
  frameStride: number,
  limits: ReferenceLimits,
) {
  const count = Math.max(0, Math.floor(sourceFrames));
  const stride = Math.max(1, Math.floor(frameStride));
  const sampledFrames = sampledFrameCount(count, stride);
  const align = (frames: number) =>
    Math.ceil((frames - limits.frameOffset) / limits.frameMultiple) *
      limits.frameMultiple +
    limits.frameOffset;
  const outputFrames = align(
    Math.max(sampledFrames, Math.ceil(limits.minDuration * limits.fps)),
  );
  const maxFrames =
    Math.floor(
      (limits.maxDuration * limits.fps - limits.frameOffset) /
        limits.frameMultiple,
    ) *
      limits.frameMultiple +
    limits.frameOffset;
  return {
    sourceFrames: count,
    frameStride: stride,
    sampledFrames,
    outputFrames,
    outputDuration: outputFrames / limits.fps,
    paddingFrames: outputFrames - sampledFrames,
    valid: count > 0 && outputFrames <= maxFrames,
    suggestedStride: Math.max(
      1,
      Math.ceil((count - 1) / Math.max(1, maxFrames - 1)),
    ),
  };
}
