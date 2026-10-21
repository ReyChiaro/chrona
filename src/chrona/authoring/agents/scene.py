from chrona.infrastructure.i18n import normalize_locale
from chrona.infrastructure.i18n import error_message
from chrona.infrastructure.i18n import msg
import hashlib
import json
import time
from typing import TypedDict

import httpx
from langgraph.graph import StateGraph, START, END
from pydantic import ValidationError

from chrona.infrastructure.resources import resource

ROOT = resource("harness/authoring")
from chrona.authoring.agents.client import ChatClient
from chrona.authoring.agents.tools import WorldTools, function_tools


class AuthoringState(TypedDict, total=False):
    messages: list
    trace: list
    rounds: int
    calls: list
    done: bool
    message: str


def run_scene_agent(
    request,
    config,
    world_url,
    *,
    progress=lambda **_: None,
    api_transport=None,
    world_transport=None,
    audit_dir=None,
):
    tools = WorldTools(
        request, world_url, transport=world_transport, audit_dir=audit_dir
    )
    client = ChatClient(config, transport=api_transport)
    functions = function_tools()
    system = (ROOT / "prompts/agent-authoring.txt").read_text()
    reply_locale = normalize_locale(request.get("replyLocale"))
    system += (
        "\n\nHost reply language: "
        + ("Simplified Chinese" if reply_locale == "zh-Hans" else "English")
        + ". Use this for replies, new labels and unsupported reasons unless the user explicitly requests another language. Preserve user text verbatim when quoting it. Video prompt language is controlled separately."
    )
    skills, trace = [], []
    for name in ["editing", "assets", "appearance"]:
        text = (ROOT / "skills" / f"{name}.md").read_text()
        skills.append(text)
        trace.append(
            {
                "tool": "read_skill",
                "skill": name,
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
            }
        )
    trace.append(
        {
            "tool": "system_prompt",
            "sha256": hashlib.sha256(system.encode()).hexdigest(),
            "backend": "api",
            "model": config.model,
        }
    )
    intent = {
        key: request.get(key)
        for key in ["prompt", "selection", "camera", "referenceIds"]
    }
    intent["newRelease"] = {
        "id": "authored-" + request["requestId"][:12],
        "version": "1.0.0",
    }
    messages = [
        {"role": "system", "content": system + "\n\n" + "\n\n".join(skills)},
        {"role": "user", "content": json.dumps(intent, ensure_ascii=False)},
    ]

    def think(state):
        round_number = state["rounds"] + 1
        if round_number > config.max_rounds:
            raise ValueError(
                msg(
                    "backend.authoring.agents.scene.the-code-agent-reached-its-maximum-tool-rounds-reduce"
                )
            )
        progress(
            phase=msg(
                "backend.authoring.agents.scene.model-planning-round",
                p0=round_number,
                p1=config.max_rounds,
            ),
            trace=state["trace"],
        )
        message, usage = client.complete(state["messages"], functions)
        calls = message.get("tool_calls") or []
        if not isinstance(calls, list) or len(calls) > 8:
            raise ValueError(
                msg(
                    "backend.authoring.agents.scene.invalid-number-of-model-tool-calls"
                )
            )
        item = {
            "round": round_number,
            "tool": "model",
            "model": config.model,
            "calls": len(calls),
        }
        return {
            "messages": state["messages"] + [message],
            "calls": calls,
            "rounds": round_number,
            "trace": state["trace"] + [item],
            "done": not calls,
            "message": str(
                message.get("content")
                or msg(
                    "backend.authoring.agents.scene.the-model-did-not-submit-an-edit-plan-no"
                )
            )[:4000]
            if not calls
            else "",
        }

    def execute(state):
        results, trace = [], list(state["trace"])
        labels = {
            "inspect_scene": msg(
                "backend.authoring.agents.scene.reading-the-target-and-scene"
            ),
            "read_skill": msg("backend.authoring.agents.scene.reading-skills"),
            "read_protocol": msg(
                "backend.authoring.agents.scene.reading-the-recipe-protocol"
            ),
            "write_plugin": msg(
                "backend.authoring.agents.scene.writing-a-new-recipe"
            ),
            "write_validate_plugin": msg(
                "backend.authoring.agents.scene.writing-and-validating-the-scene"
            ),
            "compile_validate_stage": msg(
                "backend.authoring.agents.scene.checking-geometry-and-boundaries"
            ),
            "submit_edit": msg(
                "backend.authoring.agents.scene.submitting-the-edit-plan"
            ),
        }
        for call in state["calls"]:
            if time.monotonic() >= client.deadline:
                raise ValueError(
                    msg(
                        "backend.authoring.agents.client.the-code-agent-reached-the-total-time-limit-for"
                    )
                )
            if call.get("type") != "function" or not call.get("id"):
                raise ValueError(
                    msg(
                        "backend.authoring.agents.scene.invalid-model-tool-call-protocol"
                    )
                )
            name = call.get("function", {}).get("name", "")
            progress(
                phase=labels.get(
                    name,
                    msg(
                        "backend.authoring.agents.scene.checking-tool-permissions"
                    ),
                ),
                trace=trace,
            )
            try:
                raw = call["function"]["arguments"]
                if not isinstance(raw, str) or len(raw) > 120000:
                    raise ValueError(
                        msg(
                            "backend.authoring.agents.scene.invalid-tool-argument-format-or-length"
                        )
                    )
                value = tools.call(name, json.loads(raw))
                entry = {"round": state["rounds"], "tool": name, "status": "ok"}
                if name in {"compile_validate_stage", "write_validate_plugin"}:
                    entry.update(
                        draftId=value["draftId"],
                        checks=value["report"]["checks"],
                    )
                if name == "write_plugin":
                    entry.update(bytes=value["bytes"], sha256=value["sha256"])
            except (ValueError, KeyError, TypeError, httpx.HTTPError) as error:
                if isinstance(error, ValidationError):
                    message = "; ".join(
                        e["msg"] for e in error.errors(include_input=False)
                    )[:1200]
                elif isinstance(error, httpx.HTTPError):
                    message = msg(
                        "backend.authoring.agents.scene.cannot-connect-to-the-world-content-validation-service-check"
                    )
                else:
                    message = error_message(error)[:1600]
                value = {"error": message, "recoverable": True}
                entry = {
                    "round": state["rounds"],
                    "tool": name,
                    "status": "error",
                    "message": message,
                }
            trace.append(entry)
            results.append(
                {
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": json.dumps(value, ensure_ascii=False),
                }
            )
            if tools.result:
                break
        progress(
            phase=msg("backend.authoring.agents.scene.edit-plan-validated")
            if tools.result
            else msg(
                "backend.authoring.agents.scene.tool-results-returned-to-the-model"
            ),
            trace=trace,
        )
        return {
            "messages": state["messages"] + results,
            "trace": trace,
            "done": tools.result is not None,
        }

    graph = StateGraph(AuthoringState)
    graph.add_node("model", think)
    graph.add_node("tools", execute)
    graph.add_edge(START, "model")
    graph.add_conditional_edges(
        "model",
        lambda s: "end" if s["done"] else "tools",
        {"end": END, "tools": "tools"},
    )
    graph.add_conditional_edges(
        "tools",
        lambda s: "end" if s["done"] else "model",
        {"end": END, "model": "model"},
    )
    started = time.monotonic()
    try:
        result = graph.compile().invoke(
            {"messages": messages, "trace": trace, "rounds": 0},
            {"recursion_limit": config.max_rounds * 2 + 4},
        )
        return {
            **(tools.result or {"message": result["message"], "source": ""}),
            "trace": result["trace"],
            "mode": "api",
            "model": config.model,
            "durationSeconds": round(time.monotonic() - started, 2),
        }
    finally:
        tools.close()
        client.close()
