import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from chrona.infrastructure.events import EventJournal
from chrona.infrastructure.progress import observe_steps
from chrona.api.app import create_app
from chrona.infrastructure.config import Settings


def test_journal_preserves_files_cursors_unicode_and_redacts_secrets(tmp_path):
    journal = EventJournal(tmp_path)
    job = "one-job"
    journal.emit("config", "初始配置", job_id=job, token="private", proxy="http://name:password@host:3128", path="data/input.mp4")
    first = journal.read(job_id=job, limit=1)
    assert first["entries"][0]["data"]["token"] == "[redacted]"
    assert "password" not in json.dumps(first)
    assert first["entries"][0]["data"]["path"] == "data/input.mp4"
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda i: journal.emit("step", f"步数 {i}", job_id=job), range(20)))
    rest = journal.read(job_id=job, after=first["cursor"])
    assert len(rest["entries"]) == 20
    assert len(journal.read()["entries"]) == 21
    restored = EventJournal(tmp_path)
    assert restored.read(job_id=job)["entries"][0]["message"] == "初始配置"
    assert journal.read(job_id=job, after=rest["cursor"])["entries"] == []


class Bar:
    def __init__(self, total): self.total = total
    def __enter__(self): return self
    def update(self, n=1): pass
    def __exit__(self, *args): return False


class Block:
    def __init__(self, children=None): self.sub_blocks = children or {}
    def progress_bar(self, total): return Bar(total)


def test_instance_progress_is_real_and_restored_after_failure():
    events = []
    child = Block()
    block, other = Block({"denoise": child}), Block()
    with pytest.raises(RuntimeError):
        with observe_steps(block, lambda *args: events.append(args)):
            with child.progress_bar(total=3) as bar:
                bar.update(); bar.update()
                raise RuntimeError("failed step")
    assert [(event[0], event[1], event[2]) for event in events] == [("start", 0, 3), ("step", 1, 3), ("step", 2, 3)]
    assert "progress_bar" not in block.__dict__
    assert "progress_bar" not in child.__dict__
    assert "progress_bar" not in other.__dict__


def test_configuration_and_bootstrap_failure_are_saved_even_if_provider_cannot_import(tmp_path):
    with pytest.raises(ModuleNotFoundError):
        create_app(Settings(data_dir=tmp_path, video_provider="missing_provider_module:Renderer"))
    events = EventJournal(tmp_path).read()["entries"]
    assert events[0]["event"] == "service.config"
    assert events[-1]["event"] == "service.initialization.failed"
    assert events[-1]["level"] == "error"
    bad_profile = tmp_path / 'bad-profile'
    with pytest.raises(FileNotFoundError):
        create_app(Settings(data_dir=bad_profile, profile_path=tmp_path / 'missing-profile.json'))
    assert EventJournal(bad_profile).read()['entries'][-1]['event'] == 'service.initialization.failed'


def test_observer_runs_the_actual_installed_denoise_loop_without_model_weights():
    pytest.importorskip("diffusers")
    from diffusers import ModularPipeline
    from diffusers.modular_pipelines.minimax_h3.denoise import MiniMaxH3Ref2VADenoiseStep
    block = MiniMaxH3Ref2VADenoiseStep()
    block.get_block_state = lambda state: SimpleNamespace(timesteps=[1, 2, 3])
    block.loop_step = lambda components, state, **kwargs: (components, state)
    block.set_block_state = lambda state, block_state: None
    pipeline = ModularPipeline(blocks=block)
    assert pipeline.blocks is not pipeline._blocks
    events = []
    with observe_steps(pipeline._blocks, lambda *args: events.append(args)):
        pipeline()
    assert [(e[0], e[1], e[2]) for e in events] == [("start", 0, 3), ("step", 1, 3), ("step", 2, 3), ("step", 3, 3), ("end", 3, 3)]
