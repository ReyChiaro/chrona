import json
import stat
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from chrona.authoring.agents.settings import AgentConfig, AgentConfigStore, AgentUpdate
from chrona.authoring.agents.client import ChatClient, AgentAPIError, test_connection as check_connection
from chrona.authoring.agents.scene import run_scene_agent
from chrona.authoring.agents.tools import function_tools, WorldTools
from chrona.api.app import create_app
from chrona.infrastructure.config import Settings


SECRET = 'test-only-provider-key-never-real'


def update(**rest):
    return AgentUpdate(**({'enabled': True, 'baseUrl': 'https://provider.example/v1', 'model': 'a-code-model'} | rest))


def test_settings_are_private_persistent_and_do_not_reuse_keys_at_new_destinations(tmp_path):
    path = tmp_path / 'agent.json'
    store = AgentConfigStore(path, AgentConfig())
    assert store.snapshot().mode == 'unconfigured'
    public = store.save(update(apiKey=SECRET))
    assert public['mode'] == 'api' and public['hasApiKey']
    assert SECRET not in json.dumps(public) and 'apiKey' not in public
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    store.save(update(model='different-model'))
    store.save(update())
    restored = AgentConfigStore(path, AgentConfig())
    assert restored.snapshot().api_key.get_secret_value() == SECRET
    with pytest.raises(ValueError, match='changing the API'):
        store.save(AgentUpdate(enabled=True, baseUrl='https://other.example/v1', model='different-model'))
    store.save(update(clearApiKey=True))
    assert not store.snapshot().api_key.get_secret_value()
    store.save(AgentUpdate(enabled=False, baseUrl='', model=''))
    assert store.snapshot().mode == 'disabled'
    for url in ['file:///tmp/a', 'https://user:password@example.com', 'https://example.com?key=private']:
        with pytest.raises(ValueError): AgentConfig(baseUrl=url)


def test_transport_sends_real_function_protocol_and_redacts_http_errors():
    def endpoint(request):
        assert str(request.url) == 'https://provider.example/v1/chat/completions'
        assert request.headers['authorization'] == f'Bearer {SECRET}'
        body = json.loads(request.content)
        assert body['model'] == 'a-code-model' and body['tools'][0]['function']['name'] == 'connection_check'
        assert body['tool_choice'] == 'auto'
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': None, 'tool_calls': [
            {'id': 'connection', 'type': 'function', 'function': {'name': 'connection_check', 'arguments': '{}'}}]}}]})
    config = AgentConfig(baseUrl='https://provider.example/v1', model='a-code-model', apiKey=SECRET)
    assert check_connection(config, transport=httpx.MockTransport(endpoint))['ok']
    client = ChatClient(config, transport=httpx.MockTransport(lambda _: httpx.Response(401, text=SECRET)))
    try:
        with pytest.raises(AgentAPIError) as error: client.complete([], [])
        assert '401' in str(error.value) and SECRET not in str(error.value)
    finally: client.close()


def test_reasoning_compatible_probe_still_requires_a_real_tool_call_and_reports_safe_diagnostics():
    config = AgentConfig(baseUrl='https://provider.example/v1', model='reasoning-model', apiKey=SECRET)
    def endpoint(request):
        body = json.loads(request.content)
        if body['tool_choice'] != 'auto':
            return httpx.Response(400, json={'error': {'message': 'Thinking mode does not support this tool_choice'}})
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': None, 'tool_calls': [
            {'id': 'check', 'type': 'function', 'function': {'name': 'connection_check', 'arguments': '{}'}}]}}]})
    assert check_connection(config, transport=httpx.MockTransport(endpoint))['ok']
    with pytest.raises(AgentAPIError, match='without tool calls'):
        check_connection(config, transport=httpx.MockTransport(lambda _: httpx.Response(200, json={
            'choices': [{'message': {'role': 'assistant', 'content': 'OK'}}]})))
    message = f'Thinking mode does not support this tool_choice; credential={SECRET}; Bearer {SECRET}; request_id=example'
    client = ChatClient(config, transport=httpx.MockTransport(lambda _: httpx.Response(400, json={'error': {'message': message}})))
    try:
        with pytest.raises(AgentAPIError) as caught: client.complete([], [])
        assert caught.value.status_code == 400 and 'Thinking mode' in str(caught.value)
        assert 'request_id=example' in str(caught.value) and SECRET not in str(caught.value)
    finally: client.close()


def test_connection_api_records_safe_failures_and_success_without_changing_saved_configuration(tmp_path, monkeypatch):
    app = create_app(Settings(data_dir=tmp_path, provider='chrona.adapters.providers.disabled:DisabledRenderer', preload=False,
        agent_settings_path=tmp_path / 'agent.json'))
    with TestClient(app) as client:
        app.state.agents.store.save(update(apiKey=SECRET))
        original = app.state.agents.store.path.read_bytes()
        payload = update().model_dump(mode='json')
        def fail(config): raise AgentAPIError('模型 API 拒绝了请求参数（HTTP 400）：unsupported tool_choice', status_code=400)
        monkeypatch.setattr('chrona.api.authoring.test_connection', fail)
        response = client.post('/api/render/content/agent/test', json=payload)
        assert response.status_code == 400 and 'unsupported tool_choice' in response.text
        event = app.state.manager.journal.read()['entries'][-1]
        assert event['event'] == 'agent.connection.failed' and event['data']['httpStatus'] == 400
        monkeypatch.setattr('chrona.api.authoring.test_connection', lambda config: {'ok': True, 'model': config.model, 'latencyMs': 10})
        assert client.post('/api/render/content/agent/test', json=payload).status_code == 200
        assert app.state.manager.journal.read()['entries'][-1]['event'] == 'agent.connection.succeeded'
        assert app.state.agents.store.path.read_bytes() == original
        assert SECRET not in app.state.manager.journal.service_path.read_text()


def test_api_agent_authors_novel_recipe_repairs_validation_and_keeps_target_bindings():
    identifier = str(uuid.uuid4())
    recipe = {'protocol': 1, 'id': 'novel-stone-well', 'version': '1.0.0', 'title': '山间石井', 'description': 'new test geometry', 'assets': {'well': {
        'label': '苔石水井', 'parts': [{'shape': 'cylinder', 'size': [2, 1.2, 2], 'position': [0, 0.6, 0], 'color': '#7d8876', 'roughness': 0.95},
        {'shape': 'cylinder', 'size': [1.5, 0.1, 1.5], 'position': [0, 1.25, 0], 'color': '#719fa8', 'roughness': 0.3}],
        'collider': {'halfExtents': [0.8, 0.6, 0.8], 'center': [0, 0.6, 0]}, 'effect': 'none'}}}
    source = 'export default defineContent(' + json.dumps(recipe) + ');'
    calls, staged = [], []
    def tool(name, args): return {'id': str(uuid.uuid4()), 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}
    rounds = [
        [tool('inspect_scene', {}), tool('read_skill', {'name': 'assets'}), tool('read_protocol', {})],
        [tool('write_plugin', {'source': 'export default defineContent(fetch("bad"));'}), tool('compile_validate_stage', {})],
        [tool('write_plugin', {'source': source}), tool('compile_validate_stage', {}), tool('submit_edit', {'action': 'create', 'label': '新增苔石水井', 'asset': 'well', 'constraint': 'mossy stone and blue water'})],
    ]
    def model(request):
        body = json.loads(request.content); calls.append(body)
        assert SECRET not in json.dumps(body)
        if len(calls) == 3:
            assert any('error' in m.get('content', '') for m in body['messages'] if m['role'] == 'tool')
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': None, 'tool_calls': rounds[len(calls) - 1]}}]})
    def world(request):
        if request.method == 'GET': return httpx.Response(200, json={'schema': {'type': 'object'}, 'sdk': 'data only'})
        value = json.loads(request.content)
        if 'fetch(' in value['source']: return httpx.Response(400, json={'error': '只允许数据字面量'})
        staged.append(value['source'])
        return httpx.Response(200, json={'id': 'checked-draft', 'package': recipe, 'report': {'passed': True, 'checks': ['data-only', 'seams']}})
    request = {'requestId': identifier, 'worldId': 'world-1', 'prompt': '新增一座苔石水井', 'selection': {'kind': 'ground', 'point': {'x': 8, 'y': 2, 'z': -5}},
               'referenceIds': ['a' * 64], 'context': {}, 'config': {}, 'history': [], 'camera': {'yaw': 0}}
    result = run_scene_agent(request, AgentConfig(baseUrl='https://provider.example/v1', model='a-code-model', apiKey=SECRET),
                             'http://world.local', api_transport=httpx.MockTransport(model), world_transport=httpx.MockTransport(world))
    assert result['mode'] == 'api' and result['source'] == source and len(calls) == 3
    assert result['plan']['point'] == request['selection']['point'] and result['plan']['worldId'] == 'world-1'
    assert result['plan']['referenceIds'] == ['a' * 64]
    assert result['draftId'] == 'checked-draft' and staged == [source]
    assert any(t['tool'] == 'compile_validate_stage' and t['status'] == 'error' for t in result['trace'])
    assert SECRET not in json.dumps(result)
    names = {t['function']['name'] for t in function_tools()}
    assert names == {'inspect_scene', 'read_skill', 'read_protocol', 'write_plugin', 'write_validate_plugin', 'compile_validate_stage', 'submit_edit'}


def test_api_asks_questions_without_claiming_mutation_and_does_not_fall_back():
    config = AgentConfig(baseUrl='https://provider.example/v1', model='a-code-model')
    request = {'requestId': str(uuid.uuid4()), 'worldId': 'world-1', 'prompt': '换个风格', 'context': {}, 'history': [], 'referenceIds': []}
    result = run_scene_agent(request, config, 'http://world.local', api_transport=httpx.MockTransport(lambda _: httpx.Response(200,
        json={'choices': [{'message': {'role': 'assistant', 'content': '希望使用什么颜色？'}}]})))
    assert 'plan' not in result and result['mode'] == 'api' and '颜色' in result['message']
    with pytest.raises(AgentAPIError):
        run_scene_agent(request, config, 'http://world.local', api_transport=httpx.MockTransport(lambda _: httpx.Response(500)))


def test_agent_settings_and_calls_need_no_server_token_and_keys_never_echo(tmp_path, monkeypatch):
    app = create_app(Settings(data_dir=tmp_path, provider='chrona.adapters.providers.disabled:DisabledRenderer', preload=False,
                              agent_settings_path=tmp_path / 'settings.json'))
    monkeypatch.setattr('chrona.api.authoring.test_connection', lambda config: {'ok': True, 'model': config.model, 'latencyMs': 1})
    monkeypatch.setattr('chrona.authoring.agents.manager.run_scene_agent', lambda *a, **kw: {
        'mode': 'api', 'model': 'a-code-model', 'trace': [], 'message': 'Ready'})
    with TestClient(app) as client:
        status = client.get('/api/render/content/agent/status').json()
        assert status['mode'] == 'unconfigured' and 'unlocked' not in status
        assert client.get('/api/render/content/agent').status_code == 200
        assert not list(tmp_path.rglob('access.token'))
        for path in ['unlock', 'lock']:
            assert client.post('/api/render/content/agent/' + path, json={}).status_code == 404
        response = client.put('/api/render/content/agent', json=update(apiKey=SECRET).model_dump(mode='json') | {'apiKey': SECRET})
        assert response.status_code == 200 and SECRET not in response.text
        assert 'set-cookie' not in response.headers
        assert client.get('/api/render/content/agent').json()['hasApiKey']
        assert stat.S_IMODE(app.state.agents.store.path.stat().st_mode) == 0o600
        assert client.post('/api/render/content/agent/test', json=update().model_dump(mode='json')).status_code == 200
        request = {'requestId': str(uuid.uuid4()), 'worldId': 'world', 'prompt': 'new tree', 'referenceIds': []}
        result = client.post('/api/render/content/edit', json=request)
        assert result.status_code == 200 and result.json()['mode'] == 'api'
        assert client.post('/api/render/content/edit', json=request).json() == result.json()
        assert client.get(f"/api/render/content/agent/runs/{request['requestId']}").json()['status'] == 'succeeded'
        foreign = {'Origin': 'https://untrusted.example'}
        assert client.get('/api/render/content/agent', headers=foreign).status_code == 403
        assert client.put('/api/render/content/agent', headers=foreign, json={}).status_code == 403
        assert client.post('/api/render/content/agent/test', headers=foreign, json={}).status_code == 403
        assert client.post('/api/render/content/edit', headers=foreign, json=request).status_code == 403
        assert client.get('/api/render/content/agent', headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
        assert client.get('/api/render/content/agent', headers={'Origin': 'http://localhost:4173'}).status_code == 200
        assert SECRET not in app.state.manager.journal.service_path.read_text()


def test_standalone_authoring_settings_open_without_server_token(tmp_path):
    from chrona.api.authoring import create_app as create_authoring_app

    app = create_authoring_app(Settings(data_dir=tmp_path))
    with TestClient(app) as client:
        assert client.get('/api/render/content/agent').status_code == 200
        response = client.put('/api/render/content/agent', json={
            'enabled': True, 'baseUrl': 'https://provider.example/v1',
            'model': 'a-code-model', 'apiKey': SECRET,
        })
        assert response.status_code == 200 and SECRET not in response.text
        assert client.get('/api/render/content/agent/status').json()['configured']
        assert not list(tmp_path.rglob('access.token'))
        assert client.get('/api/render/content/agent', headers={'Origin': 'https://foreign.example'}).status_code == 403


def test_combined_authoring_tool_keeps_validation_identity_and_failure_audit(tmp_path):
    from pathlib import Path
    recipe = json.loads((Path(__file__).parents[1] / 'fixtures/stone-well.json').read_text())
    source = 'export default defineContent(' + json.dumps(recipe) + ');'
    request = {'requestId': str(uuid.uuid4()), 'worldId': 'world-fixed', 'prompt': '新增水井', 'referenceIds': [],
               'selection': {'kind': 'ground', 'point': {'x': 12, 'y': 3, 'z': -8}},
               'context': {'authoring': {'protectedChunks': ['0,0']}}, 'config': {}}
    received = []
    def validate(req):
        body = json.loads(req.content); received.append(body)
        if 'fetch(' in body['source']:
            return httpx.Response(400, json={'error': '只允许数据字面量'})
        return httpx.Response(200, json={'id': 'validated', 'package': recipe, 'report': {'passed': True, 'checks': ['real-validator']}})
    tools = WorldTools(request, 'http://world.local', transport=httpx.MockTransport(validate), audit_dir=tmp_path)
    try:
        tools.call('inspect_scene', {})
        result = tools.call('write_validate_plugin', {'source': source})
        assert result['passed'] and result['draftId'] == 'validated'
        assert received[0]['context'] == {'prompt': '新增水井', 'protectedChunks': ['0,0']}
        assert (tmp_path / 'candidate.ts').read_text() == source
        tools.call('submit_edit', {'action': 'create', 'label': '新增水井', 'asset': 'well'})
        assert tools.result['plan']['worldId'] == 'world-fixed'
        assert tools.result['plan']['point'] == request['selection']['point']
        with pytest.raises(ValueError, match='数据字面量'):
            tools.call('write_validate_plugin', {'source': 'export default defineContent(fetch("bad"));'})
        assert tools.draft is None
        assert 'fetch(' in (tmp_path / 'candidate.ts').read_text()
        with pytest.raises(ValueError, match='pass compile_validate_stage'):
            tools.call('submit_edit', {'action': 'create', 'label': '不可绕过检查', 'asset': 'well'})
    finally:
        tools.close()


def test_appearance_skill_is_injected_and_scene_includes_bound_material_surfaces():
    from chrona.authoring.agents.tools import bounded_scene
    material = {'id': 'wood-post', 'label': '木支架', 'partIndices': [1, 2], 'color': '#83532e', 'roughness': 0.8,
                'metalness': 0, 'texture': {'pattern': 'wood', 'seed': 17, 'repeat': [2, 3], 'contrast': 0.35, 'bump': 0.025}}
    request = {'requestId': str(uuid.uuid4()), 'worldId': 'world', 'prompt': '保留形状，把木支架换成带木纹的深棕木头',
               'referenceIds': [], 'context': {'objects': [{'id': 'post', 'label': '木支架', 'appearance': {
                   'colors': ['#83532e'], 'roughness': 0.8, 'effect': 'none', 'materials': [material]}}]}}
    assert bounded_scene(request)['objects'][0]['appearance']['materials'][0]['texture']['seed'] == 17
    def endpoint(req):
        messages = json.loads(req.content)['messages']
        system = messages[0]['content']
        assert 'Material and appearance protocol v2' in system
        assert 'Material-only changes must not be submitted as action constraint' in system
        assert 'part.material' in system and 'Preserve unspecified surfaces' in system
        return httpx.Response(200, json={'choices': [{'message': {'role': 'assistant', 'content': '需要检查当前部件配方后再修改。'}}]})
    result = run_scene_agent(request, AgentConfig(baseUrl='https://provider.example/v1', model='a-code-model'),
                             'http://world.local', api_transport=httpx.MockTransport(endpoint))
    assert any(item.get('skill') == 'appearance' for item in result['trace'])


def test_rich_neighbor_materials_do_not_displace_the_selected_recipe_from_context():
    from chrona.authoring.agents.tools import bounded_scene
    material = {'id': 'wood', 'label': '木' * 80, 'partIndices': list(range(32)), 'color': '#83532e', 'roughness': 0.8,
                'texture': {'pattern': 'wood', 'seed': 17, 'repeat': [2, 3], 'contrast': 0.35, 'bump': 0.025}}
    objects = [{'id': f'neighbor-{i}', 'appearance': {'colors': ['#83532e'], 'roughness': 0.8, 'materials': [material] * 8},
                'constraint': {'text': '木' * 700, 'referenceIds': ['a' * 64] * 8}} for i in range(24)]
    target = {'asset': {'id': 'selected', 'design': {'keep': 'complete recipe'}}}
    scene = bounded_scene({'context': {'objects': objects}, 'target': target})
    assert scene['target'] == target and scene['omittedNearbyObjects'] > 0
    assert len(json.dumps(scene, ensure_ascii=False)) <= 60000


def test_water_authoring_exposes_the_actual_engine_level_and_allowlisted_skill():
    from chrona.authoring.agents.tools import bounded_scene, SkillArguments
    scene = bounded_scene({'config': {'terrain': {'waterLevel': 0.6}}, 'context': {}})
    assert scene['geometryConfig']['terrain']['waterLevel'] == 0.6
    assert scene['waterSystem']['level'] == 0.6 and not scene['waterSystem']['surfaceAssetsAllowed']
    assert SkillArguments(name='water').name == 'water'
    tools = WorldTools({}, 'http://world.local')
    try:
        assert 'Never approximate a water body with transparent box assets' in tools.call('read_skill', {'name': 'water'})['text']
    finally: tools.close()
