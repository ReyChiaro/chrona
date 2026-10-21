"""LangGraph authoring workflow. The offline writer is explicitly a prebuilt demo."""
from chrona.infrastructure.i18n import msg
import hashlib
import json
import time
from pathlib import Path
from typing import TypedDict
from langgraph.graph import StateGraph, START, END

from chrona.infrastructure.resources import resource
ROOT = resource("harness/authoring")


class ContentTask(TypedDict, total=False):
    prompt: str
    demo: str
    context: dict
    skill: str
    source: str
    trace: list


def inspect_scene(state):
    context = state.get("context", {})
    return {"trace": [{"tool": "inspect_scene", "mode": "offline-demo", "target": context.get("targetId"),
                       "revision": context.get("revision"), "prompt": state["prompt"]}]}


def select_skill(state):
    demo = state.get("demo", "cherry")
    if demo not in {"cherry", "meadow", "lantern"}:
        raise ValueError(msg('backend.authoring.content-agent.the-demo-agent-supports-cherry-meadow-lantern-edit-plugin'))
    skill = "terrain" if demo == "meadow" else "assets"
    content = (ROOT / "skills" / f"{skill}.md").read_text()
    system = (ROOT / "prompts/content-system.txt").read_text()
    return {"skill": skill, "trace": state["trace"] + [{"tool": "read_skill", "skill": skill,
        "sha256": hashlib.sha256(content.encode()).hexdigest(), "systemSha256": hashlib.sha256(system.encode()).hexdigest()}]}


def write_plugin(state):
    recipe = json.loads((ROOT / "demos" / f"{state.get('demo', 'cherry')}.json").read_text())
    recipe["version"] = f"1.1.{time.time_ns()}"
    source = "export default defineContent(" + json.dumps(recipe, ensure_ascii=False, indent=2) + ");\n"
    return {"source": source, "trace": state["trace"] + [{"tool": "write_plugin", "backend": "prebuilt-demo",
        "skill": state["skill"], "bytes": len(source.encode()), "next": "compile → validate → stage → explicit publish"}]}


builder = StateGraph(ContentTask)
for name, node in (("inspect_scene", inspect_scene), ("read_skill", select_skill), ("write_plugin", write_plugin)):
    builder.add_node(name, node)
builder.add_edge(START, "inspect_scene")
builder.add_edge("inspect_scene", "read_skill")
builder.add_edge("read_skill", "write_plugin")
builder.add_edge("write_plugin", END)
content_graph = builder.compile()


def propose(data: dict):
    prompt = str(data.get("prompt", "")).strip()
    if not prompt or len(prompt) > 12000:
        raise ValueError(msg('backend.authoring.content-agent.enter-a-content-description-containing-1-12000-characters'))
    return content_graph.invoke({"prompt": prompt, "demo": data.get("demo", "cherry"), "context": data.get("context", {})})
