import copy

from chrona.rendering.continuous.context import video_graph
from chrona.rendering.prompting import MAX_UNITS, MAX_CHARACTERS, compile_visual_prompt, units
from chrona.rendering.harness import prompt_defaults
from chrona.adapters.providers.minimax import reference_prompt


def snapshot():
    return {"time": 0, "worldSeconds": 10, "tick": 600,
        "camera": {"x": 0, "y": 2, "z": 0, "yaw": 0, "pitch": 0},
        "environment": {"hour": 18, "paused": False},
        "objects": [{"id": "pine:private-id", "kind": "pine", "label": "cherry tree", "band": "near", "distance": 8,
            "stateHash": "private-state-hash", "position": {"x": -2, "y": 0, "z": -8}, "bounds": [0.1, 0.2, 0.3, 0.8],
            "appearance": {"colors": ["#ffb5d2", "#71452e"], "roughness": 0.9, "effect": "petals"},
            "constraint": {"text": "Pale pink blossoms and brown bark; petals gather below this tree.", "referenceIds": ["a" * 64]}}],
        "distantChunks": [{"key": "private-region-id", "biome": "river", "elevation": 12, "visible": True}], "weather": []}


def describe(*snapshots, **kwargs):
    return video_graph.invoke({"snapshots": list(snapshots), "direction": "Cinematic realism with finely textured grass.",
        "budgets": {"near": 12, "middle": 8, "far": 4}, "memories": [], **kwargs})


def test_prompt_describes_visible_shot_and_keeps_machine_identifiers_only_in_manifest():
    result = describe(snapshot())
    prompt = result['prompt']
    for text in ['river valley', 'cherry tree', 'foreground on the left', 'pink blossoms', 'evening sunlight']:
        assert text in prompt
    for text in ['private-id', 'private-state-hash', 'private-region-id', 'a' * 64, '600', 'CURRENT WORLD FACTS', 'confidence=']:
        assert text not in prompt
    assert result['shot']['bindings'][0]['objectId'] == 'pine:private-id'
    assert result['promptManifest']['version'] == 'visual-shot@1'


def test_only_real_image_conditions_are_described_as_first_image_appearance_hints():
    a = snapshot()
    assert 'appearance hint' not in describe(a)['prompt']
    result = describe(a, referenceBindings=[{'objectId': 'pine:private-id'}])
    assert 'appearance hint' in result['shot']['subjects'][0]
    assert 'same material colors' not in result['prompt']
    assert 'same material colors' in describe(a, continuity={'mode': 'previous-generated-frame'})['prompt']


def test_camera_motion_uses_trajectory_and_does_not_invent_walking_for_stationary_camera():
    a = snapshot(); b = copy.deepcopy(a)
    assert 'remains at the same location' in describe(a, b)['prompt']
    b['camera'].update(z=-4, yaw=-0.4)
    assert 'turning right' in describe(a, b)['prompt']
    assert 'moves through the scene' in describe(a, b)['prompt']
    b = copy.deepcopy(a); b['camera']['pitch'] = 0.3
    assert 'tilting upward' in describe(a, b)['prompt']
    assert 'steady viewing direction' not in describe(a, b)['prompt']


def test_deleted_subject_is_not_described_as_visible_and_undo_restores_it():
    a = snapshot()
    a['edits'] = [{'objectId': 'pine:private-id', 'revision': 2, 'action': 'delete', 'subject': {'kind': 'custom', 'label': 'cherry tree'}}]
    result = describe(a)
    assert 'pink blossoms' not in result['prompt']
    assert 'former location of cherry tree is now clear' in result['prompt']
    assert not result['shot']['bindings']
    b = copy.deepcopy(a); b['edits'].append({'objectId': 'pine:private-id', 'revision': 3, 'action': 'undo'})
    restored = describe(a, b)
    assert 'pink blossoms' in restored['prompt']
    assert 'space empty' not in restored['prompt']


def test_old_recordings_and_no_metadata_remain_usable_without_invented_lighting_or_memory():
    assert 'reference video' in describe()['prompt']
    a = snapshot(); a['environment'] = None
    result = describe(a)
    assert 'evening sunlight' not in result['prompt']
    assert 'confidence' not in result['prompt']


def test_paused_world_and_weather_describe_visible_effects():
    a = snapshot(); a['environment']['paused'] = True; a['weather'] = [{'kind': 'snow'}]
    result = describe(a)
    assert 'Snowflakes' in result['prompt']
    assert 'World animation is frozen' in result['prompt']


def test_long_multilingual_inputs_keep_motion_and_rules_and_record_omissions():
    result = compile_visual_prompt('细腻的草地与柔和的阳光。' * 500, scene='A wooded valley.',
        subjects=['pink petals on a cherry tree'] * 4, motion='A stationary camera slowly turns right.')
    assert len(result['prompt']) <= MAX_CHARACTERS and units(result['prompt']) <= MAX_UNITS
    assert 'stationary camera' in result['prompt'] and 'no cuts' in result['prompt']
    assert 'pink petals' in result['prompt']
    assert result['warnings']
    hostile = compile_visual_prompt('X' * 20000, motion='The camera remains still.')
    assert len(hostile['prompt']) <= MAX_CHARACTERS
    busy = compile_visual_prompt('视觉风格。' * 1000, scene='A landscape with many trees. ' * 50,
        subjects=['The focal cherry tree has pale pink blossoms and textured bark.'],
        changes=['The cleared ground shows the exposed background. ' * 30] * 2,
        motion='The stationary camera turns right. ' * 20, lighting='Frozen particles remain still. ' * 20,
        continuity='The same textures continue from the first image. ' * 20)
    assert 'focal cherry tree' in busy['prompt']
    assert units(busy['prompt']) <= MAX_UNITS


def test_photoreal_conversion_rules_survive_budgeting_in_actual_h3_reference_prompt():
    result = describe(snapshot(), direction='Detailed natural materials. ' * 1000)
    rules = next(p for p in result['promptManifest']['paragraphs'] if p['role'] == 'render-rules')
    assert not rules['truncated']
    assert rules['text'] == prompt_defaults()['systemPrompt'].strip()
    model_input = reference_prompt(result['prompt'])
    for text in ['low-poly reference video', 'photoreal live-action footage', 'Infer plausible real materials',
                 'Replace polygon facets, flat colors and game shading', 'camera motion/timing', 'no cuts or UI']:
        assert text in model_input
    assert '[reference generation]' in model_input
    assert 'rather than the target visual appearance' in model_input
    assert '[video editing]' not in model_input
    assert len(result['prompt']) <= MAX_CHARACTERS and units(result['prompt']) <= MAX_UNITS
    custom = 'Watercolor textures with soft ink outlines.'
    assert reference_prompt(custom).endswith(custom)


def test_regional_biomes_and_world_time_vehicles_describe_actual_new_scene():
    a = snapshot()
    a['distantChunks'] = [{'biome': 'urban', 'visible': True}]
    a['objects'] = [{'id': 'car:test', 'kind': 'moving-vehicle', 'label': 'red road car', 'band': 'near', 'distance': 10,
                     'stateHash': 'pose:1', 'position': {'x': 0, 'y': 0, 'z': -10},
                     'appearance': {'colors': ['#bb3322'], 'roughness': 0.4, 'effect': 'none'}}]
    prompt = describe(a)['prompt']
    assert 'urban district' in prompt and 'drives along the road' in prompt
    a['environment']['paused'] = True
    assert 'stationary while the world is paused' in describe(a)['prompt']
    a['distantChunks'] = [{'biome': 'volcanic', 'visible': True}]
    assert 'depressed crater' in describe(a)['prompt']
    a['distantChunks'] = [{'biome': 'snowfield', 'visible': True}]
    assert 'snow-covered mountain' in describe(a)['prompt']


def test_bound_materials_survive_context_validation_and_describe_the_actual_proxy():
    from chrona.protocol.media import ObjectAppearance
    from chrona.rendering.continuous.description import appearance
    import pytest
    from pydantic import ValidationError
    data = {'colors': ['#83532e', '#ca8649'], 'roughness': 0.6, 'effect': 'none', 'emissiveColors': ['#ffb146'],
            'materials': [
                {'id': 'wood', 'label': '深色木支架', 'partIndices': [1, 2], 'color': '#83532e', 'roughness': 0.8,
                 'texture': {'pattern': 'wood', 'seed': 17, 'repeat': [2, 3], 'contrast': 0.25, 'bump': 0.025}},
                {'id': 'copper', 'label': '铜接头', 'partIndices': [3], 'color': '#ca8649', 'roughness': 0.3, 'metalness': 0.8},
                {'id': 'glass', 'label': '蓝色玻璃', 'partIndices': [4], 'color': '#93c7dc', 'roughness': 0.16, 'opacity': 0.45}]}
    resolved = ObjectAppearance.model_validate(data).model_dump(exclude_none=True)
    assert resolved['materials'][0]['partIndices'] == [1, 2] and resolved['emissiveColors'] == ['#ffb146']
    text = appearance({'kind': 'custom', 'appearance': resolved})
    assert 'directional wood grain' in text and 'metallic surfaces' in text and 'partially transparent' in text
    assert 'refraction' not in text and 'cast a gentle glow' not in text
    for invalid in [dict(data, materials=[{**data['materials'][0], 'roughness': 2}]),
                    dict(data, materials=[{**data['materials'][0], 'partIndices': [32]}])]:
        with pytest.raises(ValidationError): ObjectAppearance.model_validate(invalid)


def test_ocean_shot_distinguishes_above_water_from_a_submerged_camera():
    from chrona.rendering.continuous.description import describe_shot
    snapshot = {'environment': {'hour': 12, 'paused': True, 'waterLevel': 0.6},
                'camera': {'x': 0, 'y': -8, 'z': 0, 'yaw': 0, 'pitch': 0}, 'distantChunks': [{'biome': 'ocean', 'visible': True}]}
    assert 'underwater landscape' in describe_shot([snapshot], [])['scene']
    snapshot['camera']['y'] = 4
    scene = describe_shot([snapshot], [])['scene']
    assert 'sandy shores' in scene and 'underwater landscape' not in scene
