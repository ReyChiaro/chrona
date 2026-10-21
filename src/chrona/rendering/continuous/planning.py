from chrona.infrastructure.i18n import msg
import math


def plan_route(source_frames: int, stride: int, fps: int, segment_seconds: float, overlap_frames: int,
               *, minimum=5, maximum=721, multiple=4, offset=1, breaks=None):
    if source_frames < 2 or stride < 1 or fps < 1 or not math.isfinite(segment_seconds):
        raise ValueError(msg('backend.rendering.continuous.planning.invalid-camera-trajectory-parameters'))
    selected = list(range(0, source_frames, stride))
    if selected[-1] != source_frames - 1:
        selected.append(source_frames - 1)
    capacity = min(maximum, max(minimum, round(segment_seconds * fps)))
    capacity = ((capacity - offset) // multiple) * multiple + offset
    if not 1 <= overlap_frames or overlap_frames * 2 >= capacity:
        raise ValueError(msg('backend.rendering.continuous.planning.overlap-must-be-positive-and-less-than-half-the'))
    import bisect
    boundaries = sorted({bisect.bisect_left(selected, int(frame)) for frame in (breaks or []) if 0 < frame < source_frames})
    boundaries = [0] + [b for b in boundaries if 0 < b < len(selected)] + [len(selected)]
    segments = []
    for begin, stop in zip(boundaries, boundaries[1:]):
        start = begin
        while start < stop:
            end = min(start + capacity, stop)
            # Avoid a nearly fully overlapping tail that would leave a negative-sized core.
            if stop - end <= overlap_frames and stop - start <= maximum:
                candidate = math.ceil((stop - start - offset) / multiple) * multiple + offset
                if candidate <= maximum: end = stop
            count = end - start
            model_frames = math.ceil((max(minimum, count) - offset) / multiple) * multiple + offset
            segments.append({"index": len(segments), "start": start, "end": end, "frames": model_frames,
                             "validFrames": count, "paddingFrames": model_frames - count,
                             "sourceStart": selected[start], "sourceEnd": selected[end - 1],
                             "overlapFrames": 0 if start == begin else overlap_frames,
                             "stateBoundary": begin > 0 and start == begin})
            if end == stop: break
            start = end - overlap_frames
    return {"sourceFrames": source_frames, "frameStride": stride, "selectedFrames": selected,
            "outputFrames": len(selected), "outputFps": fps, "outputDuration": len(selected) / fps,
            "segments": segments, "overlapFrames": overlap_frames}
