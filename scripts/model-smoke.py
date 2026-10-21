"""Explicit opt-in GPU regression. All paths and sampling values come from arguments/config."""

import argparse
import json
from pathlib import Path
from chrona.infrastructure.config import Settings
from chrona.adapters.providers.minimax import ReferenceRenderer
from chrona.adapters.lora import resolve_adapters
from chrona.rendering.media import probe
from chrona.adapters.providers.local_reference import LocalReferenceRenderer
from chrona.rendering.continuous.planning import plan_route
from chrona.rendering.continuous.media import sample_route, segment_video

parser = argparse.ArgumentParser()
parser.add_argument("--video", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
parser.add_argument("--lora", required=True, type=Path)
parser.add_argument("--steps", required=True, type=int)
parser.add_argument("--width", required=True, type=int)
parser.add_argument("--height", required=True, type=int)
parser.add_argument("--seed", required=True, type=int)
parser.add_argument("--scale", required=True, type=float)
parser.add_argument("--prompt", default="")
args = parser.parse_args()
settings = Settings()
args.output.parent.mkdir(parents=True, exist_ok=True)
adapter = LocalReferenceRenderer(settings)
renderer = adapter.renderer
caps = adapter.capabilities()
catalog = renderer.adapter_catalog.capabilities()
relative = (
    args.lora.resolve().relative_to(settings.lora_dir.resolve()).as_posix()
)
item = next(item for item in catalog["items"] if item["label"] == relative)
adapters = resolve_adapters(
    [{"id": item["id"], "scale": args.scale}], {"adapters": catalog}
)
events = []


def report(message, value=None, **data):
    event = {"message": message, "progress": value, **data}
    events.append(event)
    print(json.dumps(event, ensure_ascii=False, default=str), flush=True)


try:
    source = probe(args.video, count_frames=True)
    plan = plan_route(
        source["frameCount"],
        1,
        caps["fps"],
        caps["maxFrames"] / caps["fps"],
        1,
        minimum=caps["minFrames"],
        maximum=caps["maxFrames"],
        multiple=caps["frameMultiple"],
        offset=caps["frameOffset"],
    )
    if len(plan["segments"]) != 1:
        raise ValueError(
            "Single-segment smoke input required; use the route API for long recordings"
        )
    sampled = args.output.with_suffix(".sampled.mp4")
    reference = args.output.with_suffix(".reference.mp4")
    sample_route(args.video, sampled, plan, args.width, args.height)
    segment_video(
        sampled,
        reference,
        plan["segments"][0],
        caps["fps"],
        tail_frames=caps["referenceTailFrames"],
    )
    result = renderer.render(
        video=reference,
        prompt=args.prompt,
        parameters={
            "steps": args.steps,
            "seed": args.seed,
            "width": args.width,
            "height": args.height,
            "audio": False,
        },
        output=args.output,
        progress=report,
        adapters=adapters,
    )
    media = probe(args.output, count_frames=True)
    manifest = {
        "plan": plan,
        "result": result,
        "media": media,
        "input": str(args.video),
        "model": str(settings.model_path),
        "modelIdentity": caps.get("modelIdentity"),
        "device": settings.device,
        "adapters": adapters,
    }
    args.output.with_suffix(".json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2)
    )
finally:
    renderer.unload()
    args.output.with_suffix(".events.json").write_text(
        json.dumps(events, ensure_ascii=False, indent=2, default=str)
    )
