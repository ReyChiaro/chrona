from pathlib import Path

import httpx
import pytest

from chrona.infrastructure.config import Settings
from chrona.adapters.providers.http_video import HttpVideoRenderer


def renderer(tmp_path, *, status='succeeded', selected=''):
    profile = {'id': 'model-a', 'label': 'sample_backend / reference model', 'strategy': 'chunk_causal',
        'config': 'sample_backend/configs/model.yaml', 'steps': 4, 'guidance': 1, 'seed': 1, 'fps': 24, 'max_frames': 721}
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path == '/api/catalog':
            return httpx.Response(200, json={'profiles': [profile], 'default_profile': 'model-a', 'model_root': 'models/sample_backend'})
        if request.url.path == '/api/readiness': return httpx.Response(200, json={'ready': True})
        if request.url.path == '/api/jobs/remote-job':
            return httpx.Response(200, json={'status': status, 'error': 'sample_backend sampling failed', 'artifacts': ['outputs/render.mp4']})
        if request.url.path.endswith('/logs'):
            return httpx.Response(200, json={'text': 'sample_backend: loading /models/sample_backend/weights; sampling 4/4'})
        if '/artifacts/' in request.url.path: return httpx.Response(200, content=b'generated-video')
        raise AssertionError(request.url.path)
    adapter = HttpVideoRenderer(Settings(video_service_url='http://video-service.test', video_service_token='test-secret', video_profile=selected))
    adapter.client = lambda: httpx.Client(base_url=adapter.base, headers=adapter.headers, transport=httpx.MockTransport(handler))
    return adapter, requests


def test_http_adapter_uses_generic_configuration_and_normalizes_remote_diagnostics(tmp_path):
    adapter, requests = renderer(tmp_path)
    caps = adapter.capabilities()
    assert caps['profile'] == 'model-a'
    assert 'sample_backend' not in caps['label']
    assert next(field for field in caps['parameters'] if field['key'] == 'steps')['max'] == 4
    events = []
    output = tmp_path / 'result.mp4'
    adapter.render_segment(video=Path('unused'), image=None, prompt='a meadow', parameters={'profile': 'model-a'}, output=output,
        resume_id='remote-job', progress=lambda message, **data: events.append((message, data)))
    assert output.read_bytes() == b'generated-video'
    assert all(request.headers['Authorization'] == 'Bearer test-secret' for request in requests)
    assert 'sampling 4/4' in events[0][1]['modelLog']
    assert 'sample_backend' not in str(events)
    assert 'test-secret' not in str(adapter.settings.model_dump(mode='json'))


def test_unknown_model_is_rejected_and_failure_messages_remain_service_neutral(tmp_path):
    adapter, _ = renderer(tmp_path, selected='missing-model')
    with pytest.raises(ValueError, match='CHRONA_VIDEO_PROFILE'): adapter.capabilities()
    adapter, _ = renderer(tmp_path, status='failed')
    adapter.capabilities()
    with pytest.raises(RuntimeError) as failure:
        adapter.render_segment(video=Path('unused'), image=None, prompt='a meadow', parameters={'profile': 'model-a'}, output=tmp_path / 'result.mp4',
            resume_id='remote-job', progress=lambda *args, **kwargs: None)
    assert 'sampling failed' in str(failure.value)
    assert 'sample_backend' not in str(failure.value)
