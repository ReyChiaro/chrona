import json
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from chrona.api.app import create_app
from chrona.infrastructure.config import Settings
from chrona.rendering.generation import VideoRequest
from chrona.rendering.continuous.manager import validate_parameters
from chrona.rendering.continuous.media import join_segments
from chrona.rendering.continuous.planning import plan_route


def test_current_request_format_rejects_removed_fields():
    request = VideoRequest(recording_id=str(uuid.uuid4()), prompt='sunlit stone', frame_stride=7)
    assert request.frame_stride == 7
    for extra in [{'trajectory': {'frame_stride': 7}}, {'history_keyframes': []}, {'context_buffer': []}]:
        with pytest.raises(ValueError):
            VideoRequest(recording_id=request.recording_id, **extra)
    fixed = [{'key': 'steps', 'label': '采样步数', 'default': 4, 'min': 4, 'max': 4, 'step': 1}]
    with pytest.raises(ValueError, match='4–4'):
        validate_parameters({'steps': 8}, fixed)
    assert validate_parameters({'audio': True}, [{'key': 'audio', 'label': '声音', 'type': 'boolean', 'default': False}]) == {'audio': True}


def test_archived_jobs_and_route_aliases_are_not_public(tmp_path, monkeypatch):
    identifier = str(uuid.uuid4()); folder = tmp_path / identifier; folder.mkdir()
    record = {'id': identifier, 'createdAt': 1, 'status': 'succeeded'}
    (folder / 'job.json').write_text(json.dumps(record))
    app = create_app(Settings(data_dir=tmp_path, video_provider='test_continuous:RouteCopyProvider', preload=False))
    with TestClient(app) as client:
        assert client.get('/api/render/jobs').json()['jobs'] == []
        assert client.get(f'/api/render/jobs/{identifier}').status_code == 404
        assert client.get('/api/render/routes').status_code == 404
        assert client.get('/api/render/routes/capabilities').status_code == 404
        assert client.post('/api/render/routes', json={}).status_code == 404
        assert json.loads((folder / 'job.json').read_text()) == record
        other = str(uuid.uuid4())
        app.state.routes.jobs[other] = {'status': 'failed', 'provider': 'another.module:Renderer', 'profile': 'different'}
        assert client.post(f'/api/render/jobs/{other}/retry').status_code == 409


def test_local_reference_adapter_advertises_actual_model_frame_alignment(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, video_provider='chrona.adapters.providers.local_reference:LocalReferenceRenderer', provider='test_render_service:CopyProvider', preload=False))
    with TestClient(app) as client:
        caps = client.get('/api/render/capabilities').json()
        assert (caps['minFrames'], caps['maxFrames'], caps['frameMultiple'], caps['frameOffset']) == (124, 345, 17, 5)
        assert caps['conditions']['firstImage'] is False
        for frames in [2, 60, 1000]:
            plan = plan_route(frames, 1, caps['fps'], caps['segmentation']['defaultSeconds'], 9,
                minimum=caps['minFrames'], maximum=caps['maxFrames'], multiple=17, offset=5)
            assert all(124 <= s['frames'] <= 345 and (s['frames'] - 5) % 17 == 0 for s in plan['segments'])
            assert plan['outputFrames'] == frames


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='Audio media integration runs on render host')
def test_segment_join_preserves_audio_with_the_same_overlap_and_frame_count(tmp_path):
    files = []
    for i in range(2):
        path = tmp_path / f'part-{i}.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=24',
            '-f', 'lavfi', '-i', f'sine=frequency={440+i*220}:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', str(path)], check=True)
        files.append(path)
    segments = [{'validFrames': 24, 'overlapFrames': 0}, {'validFrames': 24, 'overlapFrames': 6}]
    output = tmp_path / 'result.mp4'
    join_segments(files, segments, output, 24, audio=True)
    result = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-of', 'json', str(output)], capture_output=True, text=True, check=True)
    streams = json.loads(result.stdout)['streams']
    assert next(s for s in streams if s['codec_type'] == 'video')['nb_read_frames'] == '42'
    assert any(s['codec_type'] == 'audio' for s in streams)
    assert abs(float(next(s for s in streams if s['codec_type'] == 'audio')['duration']) - 1.75) < 0.05


class LoggedLocalProvider:
    def __init__(self, settings): pass
    def load(self, *, report): report('读取模型配置', event='model.config', stage='loading')


def test_only_the_selected_local_model_is_preloaded_and_keeps_structured_events(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, video_provider='chrona.adapters.providers.local_reference:LocalReferenceRenderer',
        provider='test_generation:LoggedLocalProvider', preload=True))
    with TestClient(app):
        app.state.routes.executor.submit(lambda: None).result(timeout=5)
        events = app.state.manager.journal.read()['entries']
        assert any(e['event'] == 'model.config' for e in events)
        assert any(e['event'] == 'model.ready' for e in events)
        assert not any(e['event'] == 'model.failed' for e in events)


def test_local_model_identity_changes_with_weights_and_profile_instead_of_reusing_old_cache(tmp_path):
    from chrona.adapters.providers.local_reference import LocalReferenceRenderer
    weights = tmp_path / 'model'; weights.mkdir()
    (weights / 'config.json').write_text('{"model":"test"}')
    path = weights / 'weights.safetensors'; path.write_bytes(b'first')
    settings = Settings(model_path=weights, provider='chrona.adapters.providers.disabled:DisabledRenderer', model_revision='test-revision')
    provider = LocalReferenceRenderer(settings)
    first = provider.capabilities()
    path.write_bytes(b'different-weights')
    second = provider.capabilities()
    assert first['profile'] != second['profile']
    assert second['modelIdentity']['revision'] == 'test-revision'
    provider.profile = {**provider.profile, 'parameters': [{**field, 'default': field['default'] + 1} if field['key'] == 'steps' else field for field in provider.profile['parameters']]}
    assert provider.capabilities()['profile'] != second['profile']
