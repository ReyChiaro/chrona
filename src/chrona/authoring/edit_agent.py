from chrona.authoring.commands import demo_intent, movement_distance
"""Conversational scene editing through LangGraph; explicit bounded offline planner."""
from chrona.infrastructure.i18n import msg
import json
import math
import re
import time
import hashlib
from typing import TypedDict
from chrona.authoring.content_agent import ROOT
from langgraph.graph import StateGraph, START, END


class EditTask(TypedDict, total=False):
    request: dict
    plan: dict
    source: str
    trace: list
    material: str


def inspect_scene(state):
    request = state['request']
    return {'trace': [{'tool': 'inspect_scene', 'backend': 'offline-demo', 'worldId': request['worldId'],
                       'selection': request.get('selection'), 'prompt': request['prompt'], 'conversation': request.get('history', [])[-6:]}]}


def plan_edit(state):
    request = state['request']; prompt = request['prompt'].strip(); lower = prompt.lower()
    selection = request.get('selection') or {}
    chosen = request.get('material')
    material, action = demo_intent(lower, chosen)
    if action == 'replace' and material not in {'cherry', 'bench', 'lantern'}:
        raise ValueError(msg('backend.authoring.edit-agent.the-demo-agent-supports-cherry-trees-benches-lanterns-movement'))
    if action == 'create' and material not in {'cherry', 'bench', 'lantern'}:
        raise ValueError(msg('backend.authoring.edit-agent.demo-mode-can-create-cherry-trees-wooden-benches-and'))
    plan = {'requestId': request['requestId'], 'worldId': request['worldId'], 'action': action,
            'label': prompt[:160], 'referenceIds': request.get('referenceIds', [])}
    if action in {'replace', 'move', 'delete', 'constraint'}:
        if selection.get('kind') != 'object': raise ValueError(msg('backend.authoring.edit-agent.right-click-the-object-you-want-to-edit-first'))
        plan.update(targetId=selection['objectId'], expectedVersion=selection.get('version', 0))
    if action == 'create':
        if selection.get('kind') != 'ground': raise ValueError(msg('backend.authoring.edit-agent.right-click-the-ground-to-choose-an-anchor-before'))
        plan['point'] = selection['point']
    if action == 'move':
        distance = movement_distance(lower)
        if not 0 < distance <= 50: raise ValueError(msg('backend.authoring.edit-agent.a-single-movement-distance-must-be-within-0-50'))
        yaw = request.get('camera', {}).get('yaw', 0)
        if '左' in prompt or 'left' in lower: dx, dz = -math.cos(yaw), math.sin(yaw)
        elif '右' in prompt or 'right' in lower: dx, dz = math.cos(yaw), -math.sin(yaw)
        elif '后' in prompt or 'back' in lower: dx, dz = math.sin(yaw), math.cos(yaw)
        else: dx, dz = -math.sin(yaw), -math.cos(yaw)
        plan['delta'] = {'x': dx * distance, 'y': 0, 'z': dz * distance}
    if action in {'create', 'replace', 'constraint'}:
        plan['constraint'] = prompt[:1500]
    if action in {'create', 'replace'}: plan['asset'] = {'cherry': 'cherry', 'bench': 'bench', 'lantern': 'lantern'}[material]
    return {'plan': plan, 'material': material, 'trace': state['trace'] + [{'tool': 'plan_edit', 'action': action, 'mode': 'offline-demo'}]}


def read_skill(state):
    text = (ROOT / 'skills/editing.md').read_text()
    system = (ROOT / 'prompts/edit-system.txt').read_text()
    return {'trace': state['trace'] + [{'tool': 'read_skill', 'skill': 'editing', 'sha256': hashlib.sha256(text.encode()).hexdigest(),
                                       'systemPrompt': 'edit-system@1', 'systemSha256': hashlib.sha256(system.encode()).hexdigest()}]}


def write_content(state):
    source = ''
    if state['plan']['action'] in {'create', 'replace', 'future'}:
        pack = json.loads((ROOT / 'demos' / f"{state['material']}.json").read_text())
        pack['version'] = f'1.1.{time.time_ns()}'
        source = 'export default defineContent(' + json.dumps(pack, ensure_ascii=False, indent=2) + ');\n'
    return {'source': source, 'trace': state['trace'] + [{'tool': 'write_plugin' if source else 'select_edit_tool', 'backend': 'prebuilt-demo', 'action': state['plan']['action']}]}


builder = StateGraph(EditTask)
for name, node in [('inspect', inspect_scene), ('plan', plan_edit), ('skill', read_skill), ('write', write_content)]: builder.add_node(name, node)
builder.add_edge(START, 'inspect'); builder.add_edge('inspect', 'plan'); builder.add_edge('plan', 'skill'); builder.add_edge('skill', 'write'); builder.add_edge('write', END)
edit_graph = builder.compile()


def propose_edit(data):
    if not isinstance(data.get('prompt'), str) or not 0 < len(data['prompt'].strip()) <= 12000: raise ValueError(msg('backend.authoring.agents.manager.enter-a-valid-instruction'))
    if data.get('material') not in {None, '', 'cherry', 'bench', 'lantern', 'meadow'}: raise ValueError(msg('backend.authoring.edit-agent.unknown-asset'))
    result = edit_graph.invoke({'request': data})
    return {k: result[k] for k in ['plan', 'source', 'trace']}
