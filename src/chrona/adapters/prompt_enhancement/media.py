"""A small private inline reference, without exposing a world recording URL."""

from chrona.infrastructure.i18n import msg
import base64
from pathlib import Path

from chrona.rendering.continuous.media import ffmpeg
from chrona.rendering.media import probe


def video_content(source: Path, destination: Path):
    info = probe(source)
    if info["duration"] > 15.05:
        raise ValueError(
            msg(
                "backend.adapters.prompt_enhancement.media.prompt-enhancement-reference-video-cannot-exceed-15-seconds-shorten"
            )
        )
    if not 0.4 <= info["width"] / info["height"] <= 2.5:
        raise ValueError(
            msg(
                "backend.adapters.prompt_enhancement.media.prompt-enhancement-requires-a-video-aspect-ratio-of-0"
            )
        )
    # Normalizing a separate copy never changes the reference passed to the renderer.
    scale = min(1, 960 / max(info["width"], info["height"]))
    scale = max(scale, 256 / min(info["width"], info["height"]))
    width, height = [
        max(256, 2 * round(value * scale / 2))
        for value in (info["width"], info["height"])
    ]
    ffmpeg(
        "-i",
        source,
        "-an",
        "-vf",
        f"scale={width}:{height},fps=24,tpad=stop_mode=clone:stop_duration=2",
        "-t",
        max(2, info["duration"]),
        "-c:v",
        "libx264",
        "-crf",
        28,
        "-pix_fmt",
        "yuv420p",
        destination,
    )
    if destination.stat().st_size > 24 * 1024 * 1024:
        raise ValueError(
            msg(
                "backend.adapters.prompt_enhancement.media.the-compressed-enhancement-reference-video-still-exceeds-24-mb"
            )
        )
    encoded = base64.b64encode(destination.read_bytes()).decode("ascii")
    return {
        "type": "video_url",
        "video_url": {"url": "data:video/mp4;base64," + encoded},
        "role": "reference_video",
    }


def image_content(source: Path):
    from PIL import Image
    import io

    with Image.open(source) as image:
        image = image.convert("RGB")
        image.thumbnail((960, 960))
        # Official images require both dimensions >= 256.
        if min(image.size) < 256:
            factor = 256 / min(image.size)
            image = image.resize(tuple(round(v * factor) for v in image.size))
        if not 0.4 <= image.width / image.height <= 2.5:
            raise ValueError(
                msg(
                    "backend.adapters.prompt_enhancement.media.the-enhancement-reference-image-aspect-ratio-exceeds-the-api"
                )
            )
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=85)
    return {
        "type": "image_url",
        "image_url": {
            "url": "data:image/jpeg;base64,"
            + base64.b64encode(buffer.getvalue()).decode("ascii")
        },
        "role": "reference_image",
    }
