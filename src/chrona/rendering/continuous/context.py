from chrona.infrastructure.i18n import msg
from chrona.infrastructure.resources import resource
import hashlib
import json
import math
import sqlite3
from pathlib import Path
from typing import TypedDict
from PIL import Image, ImageOps
from langgraph.graph import StateGraph, START, END

from chrona.rendering.prompting import compile_visual_prompt
from chrona.rendering.continuous.description import describe_shot, deleted_ids

PROMPT = resource("harness/rendering/prompts/video-system.txt")


class VideoContext(TypedDict, total=False):
    snapshots: list
    direction: str
    system: str
    budgets: dict
    objects: list
    prompt: str
    trace: list
    memories: list
    continuity: dict
    referenceBindings: list
    shot: dict
    promptManifest: dict


def gather(state):
    objects = {}
    for snapshot in state["snapshots"]:
        for item in snapshot.get("objects", []):
            # The latest physical state wins. References stay attached to object IDs.
            objects[item["id"]] = item
    absent = deleted_ids(state["snapshots"])
    ordered = sorted((o for o in objects.values() if o["id"] not in absent), key=lambda x: (not bool(x.get("constraint")), {"near": 0, "middle": 1, "far": 2}[x["band"]], x["distance"]))
    counts = {"near": 0, "middle": 0, "far": 0}
    selected = []
    for obj in ordered:
        band = obj["band"]
        if counts[band] < state["budgets"][band]:
            selected.append(obj); counts[band] += 1
    return {"objects": selected, "trace": [{"tool": "collect_visible_context", "budgets": state["budgets"],
        "candidates": len(objects), "selected": len(selected), "omitted": len(objects) - len(selected)}]}


def assemble(state):
    system = state.get("system") or PROMPT.read_text()
    shot = describe_shot(state["snapshots"], state["objects"], continuity=state.get("continuity"), reference_bindings=state.get("referenceBindings", []))
    manifest = compile_visual_prompt(state["direction"], system=system,
        **{key: shot[key] for key in ("scene", "subjects", "changes", "motion", "lighting", "continuity")})
    return {"prompt": manifest["prompt"], "shot": shot, "promptManifest": manifest,
            "trace": state["trace"] + [{"tool": "compile_visual_shot", "version": manifest["version"],
                "templateSha256": hashlib.sha256(system.encode()).hexdigest(), "characters": manifest["characters"],
                "estimatedUnits": manifest["estimatedUnits"], "warnings": manifest["warnings"],
                "objectBindings": [b["objectId"] for b in shot["bindings"]]}]}


builder = StateGraph(VideoContext)
builder.add_node("gather", gather); builder.add_node("assemble", assemble)
builder.add_edge(START, "gather"); builder.add_edge("gather", "assemble"); builder.add_edge("assemble", END)
video_graph = builder.compile()


class SpatialMemory:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)
        self.database = root / 'index.sqlite'
        with sqlite3.connect(self.database) as db:
            db.execute('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, world TEXT, style TEXT, x REAL, z REAL, document TEXT)')
            db.execute('CREATE INDEX IF NOT EXISTS memories_location ON memories(world, style, x, z)')

    def retrieve(self, context: dict, style: str):
        if not context: return []
        objects = {o["id"]: o["stateHash"] for o in context.get("objects", [])}
        latest = {}
        for e in context.get('edits', []): latest[e['objectId']] = e
        deleted = {key for key, e in latest.items() if e['action'] == 'delete'}
        result = []
        camera = context['camera']
        with sqlite3.connect(self.database) as db:
            candidates = db.execute('SELECT document FROM memories WHERE world=? AND style=? AND x BETWEEN ? AND ? AND z BETWEEN ? AND ?',
                (context['worldId'], style, camera['x'] - 40, camera['x'] + 40, camera['z'] - 40, camera['z'] + 40)).fetchall()
        for (document,) in candidates:
            memory = json.loads(document)
            if deleted.intersection(memory['states']): continue
            old, new = memory["camera"], context["camera"]
            distance = math.dist([old[k] for k in ("x", "y", "z")], [new[k] for k in ("x", "y", "z")])
            yaw = abs((old["yaw"] - new["yaw"] + math.pi) % (2 * math.pi) - math.pi)
            pitch = abs(old["pitch"] - new["pitch"])
            overlap = sum(objects.get(k) == v for k, v in memory["states"].items()) / max(1, len(memory["states"]))
            confidence = overlap * math.exp(-distance / 18 - yaw * 2 - pitch * 2 - abs(memory["worldSeconds"] - context["worldSeconds"]) / 2400)
            if any(k in objects and objects[k] != memory['states'][k] for k in memory.get('nearIds', [])):
                confidence *= 0.25
            if confidence > 0.15 and (self.root / f"{memory['id']}.png").exists():
                result.append({**memory, "confidence": confidence})
        return sorted(result, key=lambda m: m["confidence"], reverse=True)[:3]

    def save(self, identifier: str, image: Path, context: dict, style: str):
        if not context: return
        import shutil
        shutil.copyfile(image, self.root / f"{identifier}.png")
        value = {"id": identifier, "worldId": context["worldId"], "style": style, "camera": context["camera"],
                 "worldSeconds": context["worldSeconds"], "tick": context["tick"], "objectIds": [o["id"] for o in context.get("objects", [])],
                 "states": {o["id"]: o["stateHash"] for o in context.get("objects", [])}}
        value['nearIds'] = [o['id'] for o in context.get('objects', []) if o['band'] == 'near']
        temporary = self.root / f"{identifier}.tmp"
        temporary.write_text(json.dumps(value)); temporary.replace(self.root / f"{identifier}.json")
        with sqlite3.connect(self.database) as db:
            db.execute('INSERT OR REPLACE INTO memories VALUES (?,?,?,?,?,?)', (identifier, context['worldId'], style, context['camera']['x'], context['camera']['z'], json.dumps(value)))


def bind_references(image: Path, context: dict, references: Path):
    """Spatially bounded first-image appearance hints, explicitly a soft composite."""
    canvas = Image.open(image).convert("RGB")
    bindings = []
    absent = deleted_ids([context])
    for obj in context.get("objects", []):
        if obj["id"] in absent: continue
        constraint = obj.get("constraint") or {}
        refs = constraint.get("referenceIds", [])
        bounds = obj.get("bounds")
        if not refs or not bounds: continue
        import re
        if not re.fullmatch(r'[a-f0-9]{64}', refs[0]): raise ValueError(msg('backend.rendering.continuous.context.invalid-reference-image-id'))
        path = references / f"{refs[0]}.png"
        if not path.is_file(): raise ValueError(msg('backend.rendering.continuous.context.object-is-missing-reference-image', p0=obj['id'], p1=refs[0]))
        x0, y0, x1, y1 = [round(v * (canvas.width if i % 2 == 0 else canvas.height)) for i, v in enumerate(bounds)]
        if x1 <= x0 or y1 <= y0: continue
        patch = ImageOps.fit(Image.open(path).convert("RGB"), (x1 - x0, y1 - y0))
        original = canvas.crop((x0, y0, x1, y1))
        canvas.paste(Image.blend(original, patch, 0.55), (x0, y0))
        bindings.append({"objectId": obj["id"], "referenceId": refs[0], "bounds": bounds, "mode": "soft-first-image-composite", "strength": 0.55})
    canvas.save(image)
    return bindings
