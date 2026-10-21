import json
import subprocess
from pathlib import Path


def probe(path: Path, *, count_frames=False) -> dict:
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,r_frame_rate,nb_read_frames:format=duration", *( ["-count_frames"] if count_frames else [] ), "-of", "json", str(path)],
        check=True, capture_output=True, timeout=600 if count_frames else 30)
    data = json.loads(result.stdout)
    stream = data["streams"][0]
    numerator, denominator = stream["r_frame_rate"].split("/")
    fps = float(numerator) / float(denominator)
    duration = data.get("format", {}).get("duration")
    if duration is None:
        packets = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
            "packet=pts_time,duration_time", "-of", "json", str(path)], check=True, capture_output=True, timeout=30)
        entries = json.loads(packets.stdout)["packets"]
        duration = max(float(p.get("pts_time", 0)) + float(p.get("duration_time", 1 / fps)) for p in entries)
    info = {"width": stream["width"], "height": stream["height"], "fps": fps, "duration": float(duration)}
    if count_frames:
        info["frameCount"] = int(stream["nb_read_frames"])
    return info


def normalize(source: Path, destination: Path, *, plan: dict, width: int, height: int):
    stride, fps = plan["frameStride"], plan["outputFps"]
    # Select the complete take, including its endpoint, then create the independent output timeline.
    selection = f"select='not(mod(n,{stride}))+eq(n,{plan['sourceFrames'] - 1})',setpts=N/({fps}*TB)"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source),
        "-an", "-vf", f"{selection},scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,fps={fps},tpad=stop_mode=clone:stop={plan['paddingFrames'] + 1}",
        "-frames:v", str(plan["outputFrames"]), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(destination)],
        check=True, capture_output=True, timeout=600)


def frame_timestamps(path: Path) -> list[float]:
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "frame=best_effort_timestamp_time", "-of", "json", str(path)], check=True, capture_output=True, timeout=600)
    return [float(frame["best_effort_timestamp_time"]) for frame in json.loads(result.stdout)["frames"]]
