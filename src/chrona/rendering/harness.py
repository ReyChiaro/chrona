from chrona.infrastructure.i18n import msg
from pathlib import Path
from chrona.protocol.media import RenderRequest
from chrona.rendering.prompting import compile_visual_prompt

from chrona.infrastructure.resources import resource
PROMPTS = resource("harness/rendering/prompts")


def prompt_defaults() -> dict:
    return {"systemPrompt": (PROMPTS / "render-system.txt").read_text(), "prompt": (PROMPTS / "render-default.txt").read_text()}


def compile_request(request: RenderRequest) -> dict:
    """Model-neutral orchestration; adapters translate reference identifiers."""
    unsupported = [item for item in request.context_buffer + request.history_keyframes if item.kind != "text"]
    if unsupported:
        raise ValueError(msg('backend.rendering.harness.this-provider-does-not-support-image-or-historical-keyframe'))
    evidence = [item.text for item in request.context_buffer if item.text and item.confidence > 0]
    memories = [item.text for item in request.history_keyframes if item.text and item.confidence > 0.75]
    result = compile_visual_prompt(request.prompt, scene="A continuous first-person view of the scene shown in the reference video.",
        system=request.system_prompt.strip() or prompt_defaults()["systemPrompt"], subjects=evidence,
        motion="The camera follows the exact path, orientation and movement timing of the reference video.",
        continuity=" ".join(memories[:1]))
    return result


def compose_prompt(request: RenderRequest) -> str:
    return compile_request(request)["prompt"]
