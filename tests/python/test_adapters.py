import json
from pathlib import Path
import struct

import pytest

from chrona.adapters.lora import AdapterSelection, LocalLoraCatalog, LoraSession, resolve_adapters
from chrona.infrastructure.config import Settings
from chrona.rendering.continuous.manager import RouteManager
from chrona.adapters.providers.local_reference import LocalReferenceRenderer


def checkpoint(path, value=0, prefix='transformer_ref'):
    header = json.dumps({f'{prefix}.blocks.0.attn.to_q.lora_A.weight':
        {'dtype': 'F32', 'shape': [1, 1], 'data_offsets': [0, 4]}}).encode()
    path.write_bytes(struct.pack('<Q', len(header)) + header + struct.pack('<f', value))


def test_catalog_is_local_validates_format_and_detects_weight_replacement(tmp_path):
    valid = tmp_path / 'style.safetensors'; checkpoint(valid)
    (tmp_path / 'broken.safetensors').write_bytes(b'not a tensor')
    checkpoint(tmp_path / 'other-model.safetensors', prefix='unet')
    outside = tmp_path.parent / 'outside.safetensors'; checkpoint(outside)
    (tmp_path / 'external.safetensors').symlink_to(outside)
    catalog = LocalLoraCatalog(tmp_path)
    caps = catalog.capabilities()
    assert len(caps['items']) == 1 and len(caps['warnings']) == 2
    item = caps['items'][0]
    assert item['label'] == 'style.safetensors' and str(tmp_path) not in json.dumps(item)
    adapters = resolve_adapters([{'id': item['id'], 'scale': 0.7}], {'adapters': caps})
    assert catalog.files(adapters)[0][1] == valid
    checkpoint(valid, 1)
    with pytest.raises(ValueError, match='weights have changed'): catalog.files(adapters)


def test_adapter_requests_reject_unsupported_duplicates_and_invalid_scales(tmp_path):
    checkpoint(tmp_path / 'style.safetensors')
    caps = {'adapters': LocalLoraCatalog(tmp_path).capabilities()}
    selection = {'id': caps['adapters']['items'][0]['id'], 'scale': 1}
    assert resolve_adapters([], {}) == []
    with pytest.raises(ValueError): resolve_adapters([selection], {})
    with pytest.raises(ValueError, match='selected twice'): resolve_adapters([selection, selection], caps)
    with pytest.raises(ValueError, match='strength'): resolve_adapters([dict(selection, scale=3)], caps)
    with pytest.raises(ValueError): AdapterSelection(id='../escape', scale=1)
    with pytest.raises(ValueError): AdapterSelection(id=selection['id'], scale=float('nan'))


class Pipeline:
    def __init__(self): self.loaded = []; self.unloaded = 0; self.scales = []
    def load_lora_weights(self, path, **kwargs):
        assert kwargs['local_files_only'] and kwargs['load_into_transformer_ref'] and kwargs['use_safetensors']
        self.loaded.append(kwargs['adapter_name'])
    def get_list_adapters(self): return {'transformer_ref': self.loaded}
    def set_adapters(self, names, adapter_weights): self.scales = adapter_weights
    def unload_lora_weights(self): self.loaded = []; self.unloaded += 1


def test_lora_session_reuses_only_exact_weights_and_clears_between_jobs_and_failures(tmp_path):
    checkpoint(tmp_path / 'style.safetensors')
    catalog = LocalLoraCatalog(tmp_path); session = LoraSession(catalog); pipeline = Pipeline()
    item = catalog.capabilities()['items'][0]; a = [{**item, 'scale': 0.5}]
    report = lambda *args, **kwargs: None
    session.apply(pipeline, a, report); assert pipeline.scales == [0.5]
    session.apply(pipeline, a, report); assert len(pipeline.loaded) == 1
    session.apply(pipeline, [{**item, 'scale': 0.8}], report)
    assert pipeline.scales == [0.8] and pipeline.unloaded == 1
    session.apply(pipeline, [], report); assert not pipeline.loaded and pipeline.unloaded == 2
    pipeline.get_list_adapters = lambda: {}
    with pytest.raises(ValueError, match='did not match'): session.apply(pipeline, a, report)
    assert not session.active and not pipeline.loaded


def test_retry_refuses_changed_lora_version_and_base_model_defaults_are_editable(tmp_path):
    checkpoint(tmp_path / 'style.safetensors')
    renderer = LocalReferenceRenderer(Settings(lora_dir=tmp_path))
    caps = renderer.capabilities()
    steps = next(f for f in caps['parameters'] if f['key'] == 'steps')
    assert steps['default'] == 30 and steps['min'] < 30 < steps['max']
    item = caps['adapters']['items'][0]
    saved = {'adapters': [{**item, 'scale': 1}]}
    manager = object.__new__(RouteManager)
    manager.verify_adapters(saved, caps)
    checkpoint(tmp_path / 'style.safetensors', 1)
    with pytest.raises(ValueError, match='version changed'): manager.verify_adapters(saved, renderer.capabilities())


def test_real_h3_loader_targets_reference_transformer_and_unloads_without_changing_base_weights(tmp_path):
    torch = pytest.importorskip('torch')
    pytest.importorskip('peft')
    from diffusers import MiniMaxH3Transformer3DModel
    from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3Blocks
    from diffusers.modular_pipelines.minimax_h3.modular_pipeline import MiniMaxH3ModularPipeline
    from safetensors.torch import save_file
    model = MiniMaxH3Transformer3DModel(num_attention_heads=1, attention_head_dim=8, hidden_size=8,
        num_layers=1, num_refiner_layers=1, ffn_dim=16, text_dim=8, freq_dim=8,
        time_embed_hidden_dim=8, time_embed_dim=8, rope_freq_dim=4)
    pipeline = MiniMaxH3ModularPipeline(blocks=MiniMaxH3Blocks(), workflow='ref2va')
    pipeline.update_components(transformer_ref=model)
    name, module = next((name, module) for name, module in model.named_modules() if name.endswith('to_q') and isinstance(module, torch.nn.Linear))
    original = module.weight.detach().clone()
    path = tmp_path / 'validation.safetensors'
    save_file({f'transformer_ref.{name}.lora_A.weight': torch.ones((1, module.in_features)),
               f'transformer_ref.{name}.lora_B.weight': torch.ones((module.out_features, 1))}, str(path))
    catalog = LocalLoraCatalog(tmp_path); item = catalog.capabilities()['items'][0]
    session = LoraSession(catalog); report = lambda *args, **kwargs: None
    session.apply(pipeline, [{**item, 'scale': 0.6}], report)
    assert pipeline.get_list_adapters()['transformer_ref']
    adapted = dict(model.named_modules())[name]
    assert next(iter(adapted.scaling.values())) == pytest.approx(0.6)
    session.apply(pipeline, [], report)
    restored = dict(model.named_modules())[name]
    assert torch.equal(restored.weight, original)


def test_catalog_accepts_original_peft_layout_supported_by_the_pinned_loader(tmp_path):
    import json
    import struct
    from chrona.adapters.lora import LocalLoraCatalog
    header = json.dumps({'token_refiner.refiner_blocks.0.attn.to_k.lora_A.default.weight': {'dtype': 'BF16', 'shape': [1, 1], 'data_offsets': [0, 2]},
                         'token_refiner.refiner_blocks.0.attn.to_k.lora_B.default.weight': {'dtype': 'BF16', 'shape': [1, 1], 'data_offsets': [2, 4]}}).encode()
    (tmp_path / 'peft.safetensors').write_bytes(struct.pack('<Q', len(header)) + header + b'\0' * 4)
    catalog = LocalLoraCatalog(tmp_path).capabilities()
    assert len(catalog['items']) == 1 and not catalog['warnings']
