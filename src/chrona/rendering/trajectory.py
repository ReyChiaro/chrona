from chrona.infrastructure.i18n import msg
import math
from bisect import bisect_left


def plan_trajectory(source_frames: int, stride: int, limits: dict) -> dict:
    if source_frames < 2:
        raise ValueError(
            msg(
                "backend.rendering.trajectory.a-recording-must-contain-at-least-two-frames"
            )
        )
    sampled = (
        (source_frames - 1) // stride
        + 1
        + int((source_frames - 1) % stride != 0)
    )
    fps, multiple, offset = (
        limits["fps"],
        limits["frameMultiple"],
        limits["frameOffset"],
    )
    frames = (
        math.ceil(
            (max(sampled, math.ceil(limits["minDuration"] * fps)) - offset)
            / multiple
        )
        * multiple
        + offset
    )
    maximum = (
        math.floor((limits["maxDuration"] * fps - offset) / multiple) * multiple
        + offset
    )
    suggested = max(1, math.ceil((source_frames - 1) / max(1, maximum - 1)))
    if frames > maximum:
        raise ValueError(
            msg(
                "backend.rendering.trajectory.the-full-trajectory-requires-more-downsampling-sample-at-least",
                p0=suggested,
            )
        )
    return {
        "sourceFrames": source_frames,
        "frameStride": stride,
        "sampledFrames": sampled,
        "outputFrames": frames,
        "outputFps": fps,
        "outputDuration": frames / fps,
        "paddingFrames": frames - sampled,
    }


def sample_observations(
    observations: list, source_times: list[float], stride: int, plan: dict
) -> list:
    if not observations:
        return []
    times = [item["time"] for item in observations]
    indices = list(range(0, len(source_times), stride))
    if indices[-1] != len(source_times) - 1:
        indices.append(len(source_times) - 1)
    result = []
    for output_frame, source_frame in enumerate(indices):
        time = source_times[source_frame]
        candidate = min(len(times) - 1, bisect_left(times, time))
        if candidate and abs(times[candidate - 1] - time) < abs(
            times[candidate] - time
        ):
            candidate -= 1
        result.append(
            {
                "sourceFrame": source_frame,
                "sourceTime": time,
                "outputTime": output_frame / plan["outputFps"],
                "observationTime": times[candidate],
                "observation": observations[candidate]["observation"],
            }
        )
    return result
