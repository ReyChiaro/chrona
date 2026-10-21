import uuid

import pytest
from fastapi.testclient import TestClient
from chrona.api.authoring import create_app
from chrona.infrastructure.config import Settings


@pytest.mark.parametrize('enabled,mode', [(True, 'unconfigured'), (False, 'disabled')])
def test_unconfigured_agent_has_no_offline_execution(tmp_path, enabled, mode):
    app = create_app(Settings(data_dir=tmp_path, agent_enabled=enabled, agent_base_url='', agent_model=''))
    with TestClient(app) as client:
        assert client.get('/api/render/content/agent/status').json()['mode'] == mode
        response = client.post('/api/render/content/edit', json={'requestId': str(uuid.uuid4()), 'prompt': 'Create a tree'})
        assert response.status_code == 400
        assert 'Configure and enable the code model' in response.text
        assert client.post('/api/render/content/propose', json={'prompt': 'Create a tree'}).status_code == 404
    assert not app.state.agents.runs


def test_project_and_render_data_directories_are_independent(tmp_path, monkeypatch):
    project = tmp_path / "project-data"
    render = tmp_path / "render-data"
    explicit = tmp_path / "explicit-render"
    monkeypatch.setenv("CHRONA_DATA_DIR", str(project))
    monkeypatch.setenv("CHRONA_RENDER_DATA_DIR", str(render))
    assert Settings(_env_file=None).data_dir == render
    assert Settings(_env_file=None, data_dir=explicit).data_dir == explicit
