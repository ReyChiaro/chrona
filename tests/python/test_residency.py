from types import SimpleNamespace

import pytest

from chrona.adapters.providers.residency import ComponentResidency, SequentialOffloadStrategy
from chrona.adapters.providers.minimax import configure_reference_canvas


@pytest.fixture
def cpu_manager(monkeypatch):
    torch = pytest.importorskip("torch")
    from diffusers import ComponentsManager
    import diffusers.modular_pipelines.components_manager as library

    class CpuMemory:
        def __init__(self, device): pass
        def mem_get_info(self): return (2**40, 2**40)

    monkeypatch.setattr(library, "TorchDeviceBackend", CpuMemory)
    monkeypatch.setattr(library, "clear_device_cache", lambda: None)
    manager = ComponentsManager()
    manager.add("encoder", torch.nn.Linear(1, 1))
    manager.add("denoiser", torch.nn.Linear(1, 1))
    return manager


def test_reserve_is_restored_after_component_registration_and_hook_rebuild(cpu_manager):
    torch = pytest.importorskip("torch")
    residency = ComponentResidency(cpu_manager, "cpu", "18GB")
    residency.configure()
    assert cpu_manager._offload_strategy.memory_reserve_margin == 18_000_000_000
    cpu_manager.add("decoder", torch.nn.Linear(1, 1))
    residency.configure()
    assert cpu_manager._offload_strategy.memory_reserve_margin == 18_000_000_000
    assert all(h.hook.offload_strategy is cpu_manager._offload_strategy for h in cpu_manager.model_hooks)
    residency.close()


def test_stage_switch_evicts_encoders_even_when_weight_budget_has_room():
    events = []
    class AmpleMemory:
        memory_reserve_margin = 18_000_000_000
        def __call__(self, *args): return []
    hooks = [SimpleNamespace(model_id="encoder_1"), SimpleNamespace(model_id="vae_2")]
    strategy = SequentialOffloadStrategy(AmpleMemory(), lambda message, **data: events.append(data))
    retiring = strategy(hooks, "denoiser_3", None, "cpu")
    assert retiring == hooks
    assert events[0]["offloadComponents"] == ["encoder", "vae"]
    assert events[0]["memoryReserveBytes"] == 18_000_000_000


def test_failed_inference_releases_components_and_drops_request_callback(cpu_manager, monkeypatch):
    residency = ComponentResidency(cpu_manager, "cpu", "18GB")
    released, events = [], []
    with pytest.raises(RuntimeError, match="failed inference"):
        with residency.session(lambda message, **data: events.append(data)):
            for hook in cpu_manager.model_hooks:
                monkeypatch.setattr(hook, "offload", lambda name=hook.model_id: released.append(name))
            raise RuntimeError("failed inference")
    assert len(released) == 2
    assert events[-1]["event"] == "model.offload.released"
    count = len(events)
    residency.emit("next request")
    assert len(events) == count


@pytest.mark.parametrize("width,height", [(960, 544), (1344, 768), (384, 384)])
def test_native_proxy_normalizer_uses_request_canvas_without_upscaling(width, height):
    pytest.importorskip("torch")
    import numpy as np
    from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3Blocks
    from diffusers.modular_pipelines.minimax_h3.modular_pipeline import MiniMaxH3ModularPipeline
    from diffusers.modular_pipelines.minimax_h3.before_encoder import MiniMaxH3Ref2VASetupStep
    pipeline = MiniMaxH3ModularPipeline(blocks=MiniMaxH3Blocks(), workflow="ref2va")
    configure_reference_canvas(pipeline, width, height)
    frames = np.full((5, height, width, 3), 127, dtype=np.uint8)
    normalized = MiniMaxH3Ref2VASetupStep._normalize_video_condition(
        frames, 24, 5, pipeline.canvas_multiple, pipeline.config.canvas_short_edge,
        pipeline.config.canvas_max_pixels, pipeline.fps)
    assert normalized.shape == frames.shape
    assert np.array_equal(normalized, frames)
