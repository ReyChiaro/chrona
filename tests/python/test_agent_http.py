"""Real HTTP against a simulated upstream and the actual Node compiler; no paid model."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
from fastapi.testclient import TestClient
import pytest

from chrona.api.app import create_app
from chrona.infrastructure.config import Settings


def test_model_http_tool_loop_uses_actual_node_validation_and_immutable_release(tmp_path):
    root = Path(__file__).resolve().parents[2]
    bundled = root / '.tools/node/bin/node'
    node = str(bundled) if bundled.exists() else shutil.which('node')
    if not node: pytest.skip('Node runtime required for HTTP authoring integration')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    recipe = json.loads((root / 'tests/fixtures/stone-well.json').read_text())
    source = 'export default defineContent(' + json.dumps(recipe) + ');'
    requests = []

    def call(name, arguments):
        return {'id': str(uuid.uuid4()), 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}

    class Upstream(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            assert self.path == '/v1/chat/completions'
            assert self.headers['Authorization'] == 'Bearer integration-test-only-key'
            data = json.loads(self.rfile.read(int(self.headers['Content-Length']))); requests.append(data)
            round_number = len(requests)
            if round_number == 1: calls = [call('inspect_scene', {}), call('read_protocol', {})]
            elif round_number == 2: calls = [call('write_plugin', {'source': 'export default defineContent(fetch("not-allowed"));'}), call('compile_validate_stage', {})]
            else:
                assert any('data literals' in m.get('content', '') for m in data['messages'] if m['role'] == 'tool')
                calls = [call('write_plugin', {'source': source}), call('compile_validate_stage', {}), call('submit_edit', {'action': 'create', 'label': '新增苔石水井', 'asset': 'well'})]
            body = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': None, 'tool_calls': calls}}]}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    thread = threading.Thread(target=upstream.serve_forever, daemon=True); thread.start()
    environment = {**os.environ, 'HOST': '127.0.0.1', 'PORT': str(port), 'CONTENT_DATA_DIR': str(tmp_path / 'content'), 'WORLD_DATA_DIR': str(tmp_path / 'worlds')}
    process = subprocess.Popen([node, '--import', 'tsx', 'apps/api/src/index.ts', '--production'], cwd=root, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        with httpx.Client(trust_env=False, timeout=10) as world:
            for _ in range(100):
                try:
                    if world.get(origin + '/api/health').status_code == 200: break
                except httpx.HTTPError: pass
                if process.poll() is not None: raise RuntimeError('Node test server did not start')
                time.sleep(0.05)
            else: raise RuntimeError('Node test server readiness timeout')
            settings = Settings(data_dir=tmp_path / 'render', provider='chrona.adapters.providers.disabled:DisabledRenderer', preload=False,
                                agent_base_url='', agent_model='', agent_settings_path=tmp_path / 'agent.json', agent_world_url=origin)
            app = create_app(settings)
            with TestClient(app) as client:
                assert client.post('/api/render/content/agent/unlock', json={'accessToken': app.state.agents.access.owner_token}).status_code == 200
                config = {'enabled': True, 'baseUrl': f'http://127.0.0.1:{upstream.server_port}/v1', 'model': 'simulated-test-model', 'apiKey': 'integration-test-only-key', 'maxRounds': 6, 'timeoutSeconds': 30}
                assert client.put('/api/render/content/agent', json=config).status_code == 200
                data = {'requestId': str(uuid.uuid4()), 'worldId': 'isolated-world', 'prompt': '新增一座苔石水井', 'referenceIds': ['a' * 64],
                        'selection': {'kind': 'ground', 'point': {'x': 10, 'y': 2, 'z': -5}}, 'camera': {'yaw': 0}, 'config': {}, 'context': {}, 'history': []}
                response = client.post('/api/render/content/edit', json=data)
                assert response.status_code == 200, response.text
                result = response.json()
                assert result['mode'] == 'api' and result['source'] == source and len(requests) == 3
                assert result['plan']['referenceIds'] == data['referenceIds'] and result['plan']['point'] == data['selection']['point']
                assert any(t['tool'] == 'compile_validate_stage' and t['status'] == 'error' for t in result['trace'])
                release = world.post(origin + '/api/content/publish', json={'id': result['draftId']})
                assert release.status_code == 201 and release.json()['package']['assets']['well']['label'] == '苔石水井'
                assert 'integration-test-only-key' not in app.state.manager.journal.service_path.read_text()
                assert client.get(f"/api/render/content/agent/runs/{data['requestId']}").json()['status'] == 'succeeded'
    finally:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        upstream.shutdown(); upstream.server_close(); thread.join(timeout=2)
