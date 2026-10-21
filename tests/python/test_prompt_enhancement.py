import json
import shutil
import stat
import subprocess
import time
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient

from chrona.api.app import create_app
from chrona.infrastructure.config import Settings
from chrona.adapters.prompt_enhancement.client import MiniMaxContextIR, EnhancementError
from chrona.adapters.prompt_enhancement.service import PromptEnhancement, instruction_for
from chrona.adapters.prompt_enhancement.settings import EnhancementConfig, EnhancementStore, EnhancementUpdate
from chrona.adapters.providers.minimax import reference_prompt
from chrona.infrastructure.events import EventJournal
from test_continuous import RouteCopyProvider, context

ENHANCED = ('subject_definitions: <Video 1> is the proxy guide.\n\nsummary: One photoreal first-person shot.\n\n'
            'integrated_multimodal_description: Real bark and grass preserve the scene and camera.\n\n'
            'overall_soundscape: Gentle wind.\n\nnon_diegetic_music: None.')


def config():
    return EnhancementConfig(apiKey='private-minimax-test-key', pollSeconds=1)


def test_official_async_api_and_safe_errors():
    calls, states = [], iter(['queued', 'running', 'succeeded'])
    def handler(request):
        calls.append((request.method, request.url.path))
        assert request.headers['Authorization'] == 'Bearer private-minimax-test-key'
        if request.method == 'POST':
            assert json.loads(request.content)['model'] == 'MiniMax-H3'
            return httpx.Response(200, json={'task_id': 'ir-123'})
        status = next(states)
        return httpx.Response(200, json={'task': {'id': 'ir-123', 'status': status, 'content': {'prompt': ENHANCED}, 'usage': {'total_tokens': 12}}})
    tasks, events = [], []
    result = MiniMaxContextIR(transport=httpx.MockTransport(handler), sleep=lambda _: None).enhance(config(),
        {'model': 'MiniMax-H3'}, checkpoint=tasks.append, report=lambda *a, **kw: events.append(kw))
    assert result['prompt'] == ENHANCED and tasks == ['ir-123']
    assert calls == [('POST', '/v2/h3_context_ir')] + [('GET', '/v2/query/video_generation/ir-123')] * 3
    assert [e['status'] for e in events if 'status' in e] == ['queued', 'running']
    bad = MiniMaxContextIR(transport=httpx.MockTransport(lambda _: httpx.Response(401, text='private-minimax-test-key')))
    with pytest.raises(EnhancementError, match='401') as error:
        bad.enhance(config(), {}, checkpoint=lambda _: None, report=lambda *a, **kw: None)
    assert 'private-minimax-test-key' not in str(error.value)


def test_resume_queries_existing_task_and_ignores_empty_results():
    def handler(request):
        assert request.method == 'GET'
        return httpx.Response(200, json={'task': {'status': 'succeeded', 'content': {'prompt': ''}}})
    with pytest.raises(EnhancementError, match='content.prompt'):
        MiniMaxContextIR(transport=httpx.MockTransport(handler)).enhance(config(), {}, task_id='old-task',
            checkpoint=lambda _: pytest.fail('must not create task'), report=lambda *a, **kw: None)


def test_settings_keep_secret_private_and_prevent_accidental_host_changes(tmp_path):
    store = EnhancementStore(Settings(data_dir=tmp_path))
    update = EnhancementUpdate(enabled=True, baseUrl='https://api.minimax.cn/', model='MiniMax-H3', apiKey='test-secret')
    public = store.save(update)
    assert public['hasApiKey'] and public['enabled'] and 'test-secret' not in json.dumps(public)
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
    saved = EnhancementStore(Settings(data_dir=tmp_path)).snapshot()
    assert saved.api_key.get_secret_value() == 'test-secret'
    retained = store.prepare(update.model_copy(update={'apiKey': None}))
    assert retained.api_key.get_secret_value() == 'test-secret'
    with pytest.raises(ValueError, match='changing the API URL'):
        store.prepare(update.model_copy(update={'baseUrl': 'https://api.minimax.io', 'apiKey': None}))
    with pytest.raises(ValueError, match='API URL'):
        EnhancementConfig(baseUrl='https://user:password@example.com')
    assert not store.prepare(update.model_copy(update={'enabled': False, 'apiKey': None, 'clearApiKey': True})).configured


def test_instruction_preserves_scene_state_and_structured_output_is_not_nested():
    shot = {'scene': 'An underwater bay.', 'motion': 'The camera turns right.', 'lighting': 'Night. World animation is frozen.',
            'subjects': ['A kelp plant at left.'] * 4, 'changes': ['Keep the deleted boat absent.']}
    text, warnings = instruction_for(shot=shot, direction='写实材质。' * 2000, system='Render natural surfaces.', duration=3.25,
        has_image=False, base_prompt='unused')
    assert len(text) <= 7000 and warnings
    for value in ['underwater bay', 'camera turns right', 'World animation is frozen', 'boat absent', 'kelp plant', '3.250']:
        assert value in text
    assert 'no images are supplied' in text
    model_input = reference_prompt(ENHANCED)
    for heading in ['subject_definitions:', 'summary:', 'integrated_multimodal_description:', 'overall_soundscape:', 'non_diegetic_music:']:
        assert model_input.count(heading) == 1
    assert 'no cuts or UI' in model_input and 'Real bark and grass' in model_input


def test_settings_api_needs_no_server_token_and_does_not_return_secret(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, video_provider='test_continuous:RouteCopyProvider', preload=False))
    with TestClient(app) as client:
        assert client.get('/api/render/prompt-enhancement').status_code == 200
        status = client.get('/api/render/prompt-enhancement/status').json()
        assert not status['configured'] and not status['defaultEnabled'] and 'unlocked' not in status
        update = {'baseUrl': 'https://api.minimax.cn', 'model': 'MiniMax-H3', 'apiKey': 'never-in-browser'}
        response = client.put('/api/render/prompt-enhancement', json=update)
        assert response.status_code == 200, response.text
        assert response.json()['hasApiKey'] and 'never-in-browser' not in response.text
        assert 'never-in-browser' not in client.get('/api/render/prompt-enhancement').text
        assert 'never-in-browser' not in app.state.manager.journal.service_path.read_text()
        assert client.put('/api/render/prompt-enhancement', json=update, headers={'Origin': 'https://foreign.example'}).status_code == 403
        assert client.post('/api/render/jobs', json={'recording_id': str(uuid.uuid4()), 'prompt_enhancement': True}).status_code == 404
        assert client.post('/api/render/jobs', json={'recording_id': str(uuid.uuid4()), 'prompt_enhancement': True}, headers={'Origin': 'https://foreign.example'}).status_code == 403


def test_successful_enhancement_is_cached_and_bad_output_cannot_reach_renderer(tmp_path, monkeypatch):
    import chrona.adapters.prompt_enhancement.service as module
    service = PromptEnhancement(Settings(data_dir=tmp_path, prompt_enhancement_api_key='test-key'), EventJournal(tmp_path))
    folder = tmp_path / 'segment'; folder.mkdir(); video = folder / 'reference.mp4'; video.write_bytes(b'reference')
    monkeypatch.setattr(module, 'video_content', lambda *a: {'type': 'video_url', 'video_url': {'url': 'data:video/mp4;base64,cmVm'}, 'role': 'reference_video'})
    count = []
    def handler(request):
        count.append(request.method)
        return httpx.Response(200, json={'task_id': 'task-one'} if request.method == 'POST' else {'task': {'status': 'succeeded', 'content': {'prompt': ENHANCED}}})
    service.client = MiniMaxContextIR(transport=httpx.MockTransport(handler))
    kwargs = dict(captured=service.capture(True), folder=folder, video=video, image=None,
        harness={'prompt': 'Original', 'shot': {'scene': 'A forest.'}}, direction='', system='', duration=5,
        report=lambda *a, **kw: None, cancelled=lambda: False)
    assert service.enhance_segment(**kwargs) == ENHANCED
    assert service.enhance_segment(**kwargs) == ENHANCED and count == ['POST', 'GET']
    kwargs['direction'] = 'Evening'
    service.enhance_segment(**kwargs)
    assert count == ['POST', 'GET', 'POST', 'GET']
    assert not any('test-key' in p.read_text() for p in folder.glob('*.json'))


class EnhancedCopyProvider(RouteCopyProvider):
    def capabilities(self):
        return super().capabilities() | {'conditions': {'referenceVideo': True, 'firstImage': False}}
    def render_segment(self, **kwargs):
        assert kwargs['prompt'] == ENHANCED
        return super().render_segment(**kwargs)


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='Media integration runs on render host')
def test_route_uses_actual_proxy_and_enhanced_prompt_then_reuses_cache_on_retry_and_rebuild(tmp_path):
    settings = Settings(data_dir=tmp_path / 'render', video_provider='test_prompt_enhancement:EnhancedCopyProvider',
                        prompt_enhancement_api_key='private-route-key', preload=False)
    app = create_app(settings); posts = []; transient_failure = [True]
    def handler(request):
        if request.method == 'POST':
            payload = json.loads(request.content)
            assert payload['content'][0]['type'] == 'text' and 'pink petals' in payload['content'][0]['text']
            assert payload['content'][1]['role'] == 'reference_video'
            assert payload['content'][1]['video_url']['url'].startswith('data:video/mp4;base64,')
            assert 4 <= payload['duration'] <= 15
            posts.append(payload); return httpx.Response(200, json={'task_id': f'ir-{len(posts)}'})
        if transient_failure:
            transient_failure.pop(); return httpx.Response(503, json={'error': 'temporary failure'})
        return httpx.Response(200, json={'task': {'status': 'succeeded', 'content': {'prompt': ENHANCED}}})
    app.state.routes.prompt_enhancement.client = MiniMaxContextIR(transport=httpx.MockTransport(handler))
    source = tmp_path / 'source.webm'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=384x384:rate=24', '-t', '5', '-c:v', 'libvpx-vp9', str(source)], check=True)
    with TestClient(app) as client:
        upload = client.post('/api/render/recordings', files={'video': ('source.webm', source.read_bytes())},
            data={'metadata': json.dumps({'duration': 5, 'contextSnapshots': [context()]})})
        body = {'recording_id': upload.json()['id'], 'prompt_enhancement': True, 'retries': 0, 'segment_seconds': 3.5, 'overlap_frames': 9}
        response = client.post('/api/render/jobs', json=body)
        assert response.status_code == 202, response.text
        identifier = response.json()['id']
        def wait():
            for _ in range(400):
                job = client.get(f'/api/render/jobs/{identifier}').json()
                if job['status'] in {'failed', 'succeeded'}: return job
                time.sleep(0.05)
            pytest.fail('route timed out')
        assert wait()['status'] == 'failed'
        assert len(posts) == 1 and app.state.routes.provider.calls == []  # No silent fallback.
        assert client.post(f'/api/render/jobs/{identifier}/retry').status_code == 202
        assert wait()['status'] == 'failed' and len(posts) == 2  # Resumed the original IR task; model fails once.
        assert client.post(f'/api/render/jobs/{identifier}/retry').status_code == 202
        assert wait()['status'] == 'succeeded' and len(posts) == 2
        assert client.post(f'/api/render/jobs/{identifier}/rebuild').status_code == 202
        job = wait(); assert job['status'] == 'succeeded' and len(posts) == 2
        folder = app.state.routes.directory / identifier
        assert (folder / 'segment-0000/prompt.txt').read_text() == ENHANCED
        assert (folder / 'segment-0000/prompt-source.txt').read_text() != ENHANCED
        assert job['result']['frameCount'] == 120
        assert 'private-route-key' not in json.dumps(job)
        assert 'private-route-key' not in app.state.manager.journal.service_path.read_text()
