from chrona.infrastructure.resources import resource

PROMPTS = resource("harness/rendering/prompts")


def prompt_defaults() -> dict:
    return {
        "systemPrompt": (PROMPTS / "render-system.txt").read_text(),
        "prompt": (PROMPTS / "render-default.txt").read_text(),
    }
