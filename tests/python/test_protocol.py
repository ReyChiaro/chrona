import json
import subprocess
import shutil
import sys
from pathlib import Path
import pytest
from pydantic import ValidationError
from chrona.protocol import generated
from chrona.api.authoring import create_app
from chrona.infrastructure.config import Settings
from fastapi.testclient import TestClient


def test_cross_language_schema_roundtrip_and_invalid_bounds():
    node = shutil.which('node')
    if not node: pytest.skip('Node required for cross-language protocol test')
    root = Path(__file__).resolve().parents[2]
    script = "import { configSchema } from './contracts/schemas/config.ts'; import { SceneSnapshot, SceneObject } from './contracts/schemas/recording.ts'; console.log(JSON.stringify({invalidBoundsAccepted:SceneObject.safeParse({id:'x',kind:'pine',label:'pine',distance:1,band:'near',position:{x:0,y:0,z:0},stateHash:'x',bounds:[0.9,0.9,0.1,0.1]}).success,config:configSchema.parse({}), scene:SceneSnapshot.parse({time:0,worldId:'test',tick:0,worldSeconds:0,camera:{x:1,y:2,z:3,yaw:0,pitch:0}})}));"
    values = json.loads(subprocess.check_output([node, '--import', 'tsx', '--input-type=module', '-e', script], cwd=root))
    assert generated.WorldConfig.model_validate(values['config']).model_dump(mode='json') == values['config']
    assert generated.SceneSnapshot.model_validate(values['scene']).model_dump(mode='json', exclude_none=True) == values['scene']
    assert values['invalidBoundsAccepted'] is False
    with pytest.raises(ValidationError): generated.SceneObject.model_validate({'id':'x','kind':'pine','label':'pine','distance':1,'band':'near','position':{'x':0,'y':0,'z':0},'stateHash':'x','bounds':[0.9,0.9,0.1,0.1]})
    invalid = {**values['scene'], 'camera': {'x': 0}}
    with pytest.raises(ValidationError): generated.SceneSnapshot.model_validate(invalid)
    with pytest.raises(ValidationError): generated.WorldConfig.model_validate({'loadRange': 0})


def test_authoring_starts_without_model_or_rendering_imports(tmp_path):
    with TestClient(create_app(Settings(data_dir=tmp_path))) as client:
        assert client.get('/api/authoring/health').json() == {'status': 'ok', 'mode': 'unconfigured'}
        assert client.get('/api/render/content/agent/status').json()['mode'] == 'unconfigured'
    # Validate in a fresh interpreter, independent of collection order.
    subprocess.run([sys.executable, '-c', "from chrona.api.authoring import create_app; import sys; assert not any(m.startswith(('torch','diffusers','chrona.rendering')) for m in sys.modules)"], check=True)
