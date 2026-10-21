import asyncio
import copy
import json
from pathlib import Path

import httpx
import pytest

from chrona.api.authoring import create_app
from chrona.infrastructure.config import Settings
from chrona.infrastructure.i18n import annotate_payload, catalog, error_message, format_message, msg, negotiate_locale, normalize_locale
from chrona.adapters.providers.local_reference import LocalReferenceRenderer


def test_catalog_parity_and_persisted_message_roundtrip():
    assert catalog().keys() == catalog('zh-Hans').keys()
    message = msg('backend.authoring.agents.manager.preparing-the-scene-edit')
    assert copy.deepcopy(message) == message
    saved = json.loads(json.dumps(annotate_payload({'phase': message, 'label': '保留用户名称'})))
    assert annotate_payload(saved, 'zh-Hans')['phase'] == '准备场景编辑'
    assert saved['phase'] == 'Preparing the scene edit'
    assert annotate_payload(saved, 'zh-Hans')['label'] == '保留用户名称'
    assert error_message(ValueError(message)) is message


def test_negotiation_and_stale_metadata():
    assert normalize_locale('zh_CN') == 'zh-Hans'
    assert normalize_locale('zh-Hant') == normalize_locale('ja') == 'en'
    assert negotiate_locale('ja,zh-CN;q=0.8,en;q=0.5') == 'zh-Hans'
    assert negotiate_locale('zh;q=0,en') == 'en'
    saved = annotate_payload({'phase': msg('backend.authoring.agents.manager.preparing-the-scene-edit')})
    saved['phase'] = msg('backend.authoring.agents.manager.edit-not-applied')
    assert annotate_payload(saved, 'zh-Hans')['phase'] == '编辑未应用'
    saved['phase'] = 'External phase'
    assert annotate_payload(saved, 'zh-Hans')['phase'] == 'External phase'
    saved = annotate_payload({'error': msg('backend.authoring.agents.manager.edit-not-applied')})
    saved['error'] = None
    assert annotate_payload(saved, 'zh-Hans')['error'] is None


def test_exception_parameters_remain_json_safe_and_nested_messages_translate():
    nested = msg('backend.authoring.agents.manager.preparing-the-scene-edit')
    value = msg('backend.api.app.cannot-read-the-recorded-video', p0=ValueError(nested))
    saved = json.loads(json.dumps(annotate_payload({'error': value})))
    assert '准备场景编辑' in annotate_payload(saved, 'zh-Hans')['error']


def test_profile_labels_do_not_change_model_identity(tmp_path):
    import hashlib
    settings = Settings(data_dir=tmp_path, provider='chrona.adapters.providers.disabled:DisabledRenderer', model_path=None, model_revision='')
    provider = LocalReferenceRenderer(settings)
    original = json.loads(Path('configs/render-profile.json').read_text())
    assert provider.profile == original
    expected = hashlib.sha256(json.dumps({'provider': settings.provider, 'revision': settings.model_revision,
        'files': [], 'manifests': [], 'profile': provider.model_profile()}, sort_keys=True).encode()).hexdigest()
    assert provider.model_identity()['fingerprint'] == expected
    display = provider.display_profile()
    assert display['label'] == 'MiniMax-H3 · Reference video'
    assert annotate_payload(display, 'zh-Hans')['label'] == original['label']
    assert provider.model_identity()['fingerprint'] == expected
    assert provider.profile == original



@pytest.mark.asyncio
async def test_python_http_locales_are_independent(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, agent_enabled=False))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
        async def request(language):
            return await client.get('/api/render/content/agent/runs/00000000-0000-0000-0000-000000000000', headers={'Accept-Language': language})
        english, chinese = await asyncio.gather(request('en'), request('zh-CN'))
        assert english.status_code == chinese.status_code == 404
        assert english.headers['content-language'] == 'en'
        assert chinese.headers['content-language'] == 'zh-Hans'
        assert english.json()['detail'].startswith('The Agent request')
        assert chinese.json()['detail'] == 'Agent 请求尚未开始或记录已过期'
        assert english.json()['code'] == chinese.json()['code']
