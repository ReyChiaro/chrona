import subprocess
from pathlib import Path


def ffmpeg(*args):
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-threads",
                "2",
                *map(str, args),
            ],
            check=True,
            capture_output=True,
            timeout=1200,
        )
    except subprocess.CalledProcessError as error:
        raise RuntimeError(
            error.stderr.decode(errors="replace")[-4000:]
        ) from error


def sample_route(
    source: Path, output: Path, plan: dict, width: int, height: int
):
    stride, last, fps = (
        plan["frameStride"],
        plan["sourceFrames"] - 1,
        plan["outputFps"],
    )
    ffmpeg(
        "-i",
        source,
        "-an",
        "-vf",
        f"select='not(mod(n,{stride}))+eq(n,{last})',setpts=N/({fps}*TB),scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
        "-frames:v",
        plan["outputFrames"],
        "-r",
        fps,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        output,
    )


def segment_video(
    source: Path, output: Path, segment: dict, fps: int, *, tail_frames=1
):
    # One extra terminal frame satisfies providers that sample t=(frames-1)/fps strictly inside the clip.
    ffmpeg(
        "-i",
        source,
        "-an",
        "-vf",
        f"trim=start_frame={segment['start']}:end_frame={segment['end']},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop={segment['paddingFrames'] + 2}",
        "-frames:v",
        segment["frames"] + tail_frames,
        "-r",
        fps,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        output,
    )


def extract_frame(video: Path, output: Path, index: int):
    ffmpeg(
        "-i", video, "-vf", f"select=eq(n\\,{index})", "-frames:v", 1, output
    )


def join_segments(
    files: list[Path],
    segments: list[dict],
    output: Path,
    fps: int,
    *,
    audio=False,
):
    """Encode each core/seam once, then remux. Work scales linearly with route length."""
    parts = []
    for index, (video, segment) in enumerate(zip(files, segments)):
        overlap = segment["overlapFrames"]
        if index and overlap:
            previous = segments[index - 1]
            seam = output.parent / f"seam-{index:04d}.mp4"
            graph = (
                f"[0:v]trim=start_frame={previous['validFrames'] - overlap}:end_frame={previous['validFrames']},setpts=PTS-STARTPTS[a];"
                f"[1:v]trim=end_frame={overlap},setpts=PTS-STARTPTS[b];"
                f"[a][b]blend=all_expr='A*(1-min(1,(N-1)/{max(1, overlap - 1)}))+B*min(1,(N-1)/{max(1, overlap - 1)})'[v]"
            )
            ffmpeg(
                "-i",
                files[index - 1],
                "-i",
                video,
                "-filter_complex_threads",
                1,
                "-filter_complex",
                graph,
                "-map",
                "[v]",
                "-frames:v",
                overlap,
                "-r",
                fps,
                "-an",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                seam,
            )
            parts.append(seam)
        end = segment["validFrames"] - (
            segments[index + 1]["overlapFrames"]
            if index + 1 < len(segments)
            else 0
        )
        core = output.parent / f"core-{index:04d}.mp4"
        ffmpeg(
            "-i",
            video,
            "-vf",
            f"trim=start_frame={overlap}:end_frame={end},setpts=PTS-STARTPTS",
            "-frames:v",
            end - overlap,
            "-an",
            "-r",
            fps,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            core,
        )
        parts.append(core)
    manifest = output.parent / "concat.txt"
    manifest.write_text("".join(f"file '{part.name}'\n" for part in parts))
    ffmpeg(
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        manifest,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        output,
    )

    if audio:
        audio_parts = []
        for index, (video, segment) in enumerate(zip(files, segments)):
            overlap = segment["overlapFrames"]
            if index and overlap:
                previous = segments[index - 1]
                seam = output.parent / f"audio-seam-{index:04d}.wav"
                duration = overlap / fps
                graph = (
                    f"[0:a]atrim=start={(previous['validFrames'] - overlap) / fps}:end={previous['validFrames'] / fps},asetpts=PTS-STARTPTS[a];"
                    f"[1:a]atrim=end={duration},asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d={duration}:c1=tri:c2=tri[out]"
                )
                ffmpeg(
                    "-i",
                    files[index - 1],
                    "-i",
                    video,
                    "-filter_complex",
                    graph,
                    "-map",
                    "[out]",
                    "-ar",
                    48000,
                    "-ac",
                    2,
                    seam,
                )
                audio_parts.append(seam)
            end = segment["validFrames"] - (
                segments[index + 1]["overlapFrames"]
                if index + 1 < len(segments)
                else 0
            )
            core = output.parent / f"audio-core-{index:04d}.wav"
            ffmpeg(
                "-i",
                video,
                "-vn",
                "-af",
                f"atrim=start={overlap / fps}:end={end / fps},asetpts=PTS-STARTPTS",
                "-ar",
                48000,
                "-ac",
                2,
                core,
            )
            audio_parts.append(core)
        audio_manifest = output.parent / "audio-concat.txt"
        audio_manifest.write_text(
            "".join(f"file '{part.name}'\n" for part in audio_parts)
        )
        muxed = output.with_name("muxed-" + output.name)
        duration = (
            sum(s["validFrames"] - s["overlapFrames"] for s in segments) / fps
        )
        ffmpeg(
            "-i",
            output,
            "-f",
            "concat",
            "-safe",
            1,
            "-i",
            audio_manifest,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-t",
            duration,
            "-movflags",
            "+faststart",
            muxed,
        )
        muxed.replace(output)
