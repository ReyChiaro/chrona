"""Allowlisted authoring tools. Only the browser world editor applies mutations."""
from chrona.infrastructure.i18n import msg
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Literal

import httpx
from pydantic import BaseModel, ConfigDict, Field

from chrona.authoring.content_agent import ROOT
from chrona.protocol.media import ObjectAppearance


class Arguments(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)


class SkillArguments(Arguments):
    name: Literal['editing', 'assets', 'terrain', 'appearance', 'regions', 'water']


class SourceArguments(Arguments):
    source: str = Field(min_length=1, max_length=100000)


class Point(Arguments):
    x: float
    y: float
    z: float


class SubmitArguments(Arguments):
    action: Literal['create', 'replace', 'move', 'delete', 'constraint', 'undo', 'future']
    label: str = Field(min_length=1, max_length=200)
    asset: str | None = Field(None, pattern=r'^[a-z][a-z0-9-]{0,63}$')
    constraint: str | None = Field(None, max_length=1500)
    direction: Literal['left', 'right', 'forward', 'back', 'up', 'down'] | None = None
    distance: float | None = Field(None, gt=0, le=50)
    delta: Point | None = None
    point: Point | None = None


ARGUMENTS = {'inspect_scene': Arguments, 'read_skill': SkillArguments, 'read_protocol': Arguments,
             'write_plugin': SourceArguments, 'write_validate_plugin': SourceArguments, 'compile_validate_stage': Arguments, 'submit_edit': SubmitArguments}


def function_tools():
    catalog = json.loads((ROOT / 'tools.json').read_text())['tools']
    return [{'type': 'function', 'function': {'name': item['name'], 'description': item['description'],
             'parameters': ARGUMENTS[item['name']].model_json_schema()}}
            for item in catalog if item.get('agentCallable') and item['name'] in ARGUMENTS]


def bounded_scene(request):
    context = request.get('context', {})
    scene = {key: context[key] for key in ['worldId', 'revision', 'tick', 'worldSeconds', 'camera', 'weather', 'budgets', 'environment'] if key in context}
    scene['objects'] = []
    for obj in context.get('objects', [])[:24]:
        value = {key: obj[key] for key in ['id', 'kind', 'label', 'position', 'distance', 'band', 'bounds', 'stateHash'] if key in obj}
        if obj.get('constraint'):
            c = obj['constraint']; value['constraint'] = {'text': str(c.get('text', ''))[:700], 'referenceIds': c.get('referenceIds', [])[:8]}
        if obj.get('appearance'):
            value['appearance'] = ObjectAppearance.model_validate(obj['appearance']).model_dump(exclude_none=True)
        scene['objects'].append(value)
    scene['distantChunks'] = context.get('distantChunks', [])[:12]
    scene['regions'] = context.get('regions', [])[:12]
    scene['regionalSite'] = context.get('authoring', {}).get('site')
    scene['regionalSiteError'] = context.get('authoring', {}).get('error')
    scene['selection'] = request.get('selection')
    scene['target'] = request.get('target')
    config = request.get('config', {})
    scene['geometryConfig'] = {key: config[key] for key in ['chunkRadius', 'loadRange', 'terrain', 'population', 'physics'] if key in config}
    level = config.get('terrain', {}).get('waterLevel')
    scene['waterSystem'] = {'level': level, 'levelSource': 'geometryConfig.terrain.waterLevel', 'coordinate': 'absolute world Y',
        'capability': 'native terrain-clipped water in first-person, overview and map',
        'surfaceAssetsAllowed': False, 'regionDeclaration': {'water': {'kind': 'ocean', 'shoreColor': '#dfcb96', 'shoreHeight': 1.2}},
        'guidance': 'Read water skill. Lower the actual seabed below this level. Do not add water boxes, tiles or local Y offsets. Vegetation can use habitat:underwater; swaying and swimming are unsupported.'}
    scene['conversation'] = [{'role': x['role'], 'text': x['text'][:1500]} for x in request.get('history', [])[-8:]]
    scene['omittedNearbyObjects'] = max(0, len(context.get('objects', [])) - len(scene['objects']))
    # Preserve the complete selected recipe; trim lower-priority neighbors first
    # when their richer surface descriptions consume the finite context budget.
    while scene['objects'] and len(json.dumps(scene, ensure_ascii=False)) > 60000:
        scene['objects'].pop()
        scene['omittedNearbyObjects'] += 1
    if len(json.dumps(scene, ensure_ascii=False)) > 60000:
        raise ValueError(msg('backend.authoring.agents.tools.the-scene-context-exceeds-the-code-agent-input-budget'))
    return scene


class WorldTools:
    def __init__(self, request, world_url, *, transport=None, audit_dir=None):
        self.request = request
        self.http = httpx.Client(base_url=world_url.rstrip('/'), timeout=20, follow_redirects=False, trust_env=False, transport=transport)
        self.source = ''
        self.draft = None
        self.result = None
        self.inspected = False
        self.audit_dir = Path(audit_dir) if audit_dir else None

    def close(self):
        self.http.close()

    def call(self, name, raw):
        if name not in ARGUMENTS: raise ValueError(msg('backend.authoring.agents.tools.the-model-requested-an-unauthorized-tool'))
        args = ARGUMENTS[name].model_validate(raw)
        if name == 'write_validate_plugin':
            written = self.call('write_plugin', {'source': args.source})
            return {**written, **self.call('compile_validate_stage', {})}
        if name == 'inspect_scene':
            self.inspected = True
            return bounded_scene(self.request)
        if name == 'read_skill':
            text = (ROOT / 'skills' / f'{args.name}.md').read_text()
            return {'name': args.name, 'text': text, 'sha256': hashlib.sha256(text.encode()).hexdigest()}
        if name == 'read_protocol':
            return self._response(self.http.get('/api/content/protocol'))
        if name == 'write_plugin':
            self.source, self.draft, self.result = args.source, None, None
            if self.audit_dir:
                self.audit_dir.mkdir(parents=True, exist_ok=True)
                (self.audit_dir / 'candidate.ts').write_text(self.source)
            return {'written': True, 'bytes': len(self.source.encode()), 'sha256': hashlib.sha256(self.source.encode()).hexdigest(), 'next': 'compile_validate_stage'}
        if name == 'compile_validate_stage':
            if not self.source: raise ValueError(msg('backend.authoring.agents.tools.write-a-data-recipe-with-write-plugin-first'))
            self.draft = None
            draft = self._response(self.http.post('/api/content/validate', json={'source': self.source, 'config': self.request.get('config', {}),
                'context': {'prompt': self.request.get('prompt', ''), 'protectedChunks': self.request.get('context', {}).get('authoring', {}).get('protectedChunks', [])}}))
            self.draft = draft
            return {'passed': True, 'draftId': draft['id'], 'report': draft['report'],
                    'assets': list(draft['package']['assets']), 'package': {k: draft['package'][k] for k in ['id', 'version', 'title']}}
        if name == 'submit_edit':
            return self.submit(args)
        raise ValueError(msg('backend.authoring.agents.tools.tool-not-implemented'))

    @staticmethod
    def _response(response):
        if len(response.content) > 2 * 1024 * 1024: raise ValueError(msg('backend.authoring.agents.tools.the-tool-result-is-too-large'))
        if response.status_code >= 300:
            value = response.json()
            raise ValueError(str(value.get('error', msg('backend.authoring.agents.tools.the-content-validation-service-is-temporarily-unavailable')))[:1600])
        return response.json()

    def submit(self, args: SubmitArguments):
        if not self.inspected: raise ValueError(msg('backend.authoring.agents.tools.call-inspect-scene-to-check-the-target-and-scene'))
        request, selection = self.request, self.request.get('selection') or {}
        plan = {'requestId': request['requestId'], 'worldId': request['worldId'], 'label': args.label,
                'action': args.action, 'referenceIds': request.get('referenceIds', [])}
        source = ''
        if args.action in {'create', 'replace', 'future'}:
            if not self.draft: raise ValueError(msg('backend.authoring.agents.tools.write-the-recipe-and-pass-compile-validate-stage-before'))
            if args.action == 'future':
                if not self.draft['package'].get('terrain') and not self.draft['package'].get('region'): raise ValueError(msg('backend.authoring.agents.tools.future-region-edits-require-a-validated-terrain-or-region'))
            elif not args.asset or args.asset not in self.draft['package']['assets']:
                raise ValueError(msg('backend.authoring.agents.tools.asset-must-reference-an-asset-in-the-validated-recipe'))
            water_prompt = re.sub(r'海洋(?:蓝色?|风格|主题)|\b(?:ocean|sea)[ -](?:blue|themed)\b', '', request['prompt'], flags=re.I)
            regional_intent = re.search(r'雪原|山地|火山地形|城市|volcanic terrain|snowfield|city|urban', request['prompt'], re.I) or re.search(
                r'(?:生成|创建|新增|扩展|改成|变成|变为).{0,16}(?:海洋|海岸|海湾|湖泊)|(?:create|generate|extend|build).{0,30}\b(?:ocean|coast|lake)\b', water_prompt, re.I)
            if regional_intent and not self.draft['package'].get('region') and not re.search(r'摆件|雕塑|模型|miniature|sculpture', request['prompt'], re.I):
                raise ValueError(msg('backend.authoring.agents.tools.this-request-requires-a-regional-scene-not-one-composite'))
            if self.draft['package'].get('region') and args.action != 'future':
                raise ValueError(msg('backend.authoring.agents.tools.regional-scenes-must-be-deployed-through-future-not-created'))
            source = self.source
            if args.asset: plan['asset'] = args.asset
        if args.action in {'replace', 'move', 'delete', 'constraint'}:
            if selection.get('kind') != 'object': raise ValueError(msg('backend.authoring.agents.tools.right-click-the-object-to-edit-before-opening-the'))
            plan.update(targetId=selection['objectId'], expectedVersion=selection.get('version', 0))
        if args.action == 'create':
            if selection.get('kind') != 'ground': raise ValueError(msg('backend.authoring.agents.tools.creating-an-object-requires-a-ground-anchor-clear-the'))
            plan['point'] = selection['point']
        if args.action == 'move':
            if args.direction and args.distance:
                yaw = request.get('camera', {}).get('yaw', 0)
                vectors = {'left': (-math.cos(yaw), 0, math.sin(yaw)), 'right': (math.cos(yaw), 0, -math.sin(yaw)),
                           'forward': (-math.sin(yaw), 0, -math.cos(yaw)), 'back': (math.sin(yaw), 0, math.cos(yaw)),
                           'up': (0, 1, 0), 'down': (0, -1, 0)}
                plan['delta'] = dict(zip(['x', 'y', 'z'], [v * args.distance for v in vectors[args.direction]]))
            elif args.point: plan['point'] = args.point.model_dump()
            elif args.delta: plan['delta'] = args.delta.model_dump()
            else: raise ValueError(msg('backend.authoring.agents.tools.movement-requires-direction-distance-delta-or-an-absolute-point'))
            if 'delta' in plan and (abs(plan['delta']['x']) > 50 or abs(plan['delta']['z']) > 50 or abs(plan['delta']['y']) > 20):
                raise ValueError(msg('backend.authoring.agents.tools.a-single-move-is-limited-to-50-metres-horizontally'))
        if args.action in {'create', 'replace', 'constraint'}:
            plan['constraint'] = args.constraint or request['prompt'][:1500]
        self.result = {'plan': plan, 'source': source, 'draftId': self.draft['id'] if source else None}
        return {'ready': True, 'action': args.action, 'label': args.label, 'next': 'host world/version/collision checks and undoable application'}
