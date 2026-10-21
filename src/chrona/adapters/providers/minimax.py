"""MiniMax-H3 Ref2VA adapter using the upstream Modular Diffusers interface."""

from chrona.infrastructure.i18n import msg
from pathlib import Path
import math
import os
import re
from time import perf_counter
from chrona.infrastructure.progress import observe_steps
from chrona.adapters.lora import LocalLoraCatalog, LoraSession
from chrona.adapters.providers.residency import ComponentResidency, gpu_memory

PROMPT_FORMAT_VERSION = "ref2va-layout@3"
REFERENCE_CANVAS_VERSION = "output-canvas@1"


def configure_reference_canvas(pipeline, width, height):
    """Use the requested canvas for proxy normalization, preserving aspect ratio."""
    pipeline.register_to_config(
        canvas_short_edge=min(width, height), canvas_max_pixels=width * height
    )


def reference_prompt(prompt):
    """The proxy conditions layout and motion; the requested appearance describes the output."""
    if re.search(
        r"^integrated_multimodal_description\s*:", prompt, re.MULTILINE
    ):
        # Context-IR already supplies H3 sections: keep them at the top level.
        definition = "<Video 1> is the low-poly layout and camera guide; infer photoreal real-world detail, preserving its geometry, objects and motion. "
        guard = "[reference generation] Keep the proxy camera path/timing and current world state; no cuts or UI. "
        if re.search(r"^subject_definitions\s*:", prompt, re.MULTILINE):
            prompt = re.sub(
                r"(^subject_definitions\s*:)",
                lambda m: m[0] + "\n" + definition,
                prompt,
                count=1,
                flags=re.MULTILINE,
            )
        else:
            prompt = "subject_definitions:\n" + definition + "\n\n" + prompt
        if re.search(r"^summary\s*:", prompt, re.MULTILINE):
            return re.sub(
                r"(^summary\s*:)",
                lambda m: m[0] + "\n" + guard,
                prompt,
                count=1,
                flags=re.MULTILINE,
            )
        return "summary:\n" + guard + "\n\n" + prompt
    return (
        "subject_definitions:\n"
        "<Video 1> is a coarse low-poly 3D guide to the scene layout, object positions and camera motion, "
        "rather than the target visual appearance.\n\n"
        "summary:\n"
        "[reference generation] Generate a new rendering of the world shown in <Video 1>, "
        "with the target appearance described below. Keep the reference composition, scale, "
        "occlusion and camera path and timing while rebuilding surface detail, materials and lighting.\n\n"
        "integrated_multimodal_description:\n" + prompt
    )


class ReferenceRenderer:
    def __init__(self, settings):
        self.settings = settings
        self.pipeline = None
        self.residency = None
        self.adapter_catalog = LocalLoraCatalog(settings.lora_dir)
        self.loras = LoraSession(self.adapter_catalog)

    def available(self):
        return bool(
            self.settings.model_path
            and (
                self.settings.model_path / "modular_model_index.json"
            ).is_file()
        )

    def load(self, *, report=None):
        report = report or (lambda *args, **kwargs: None)
        if self.pipeline is not None:
            report(
                msg(
                    "backend.adapters.providers.minimax.reusing-the-loaded-model"
                ),
                event="model.reused",
                stage="loading",
                modelPath=str(self.settings.model_path.resolve()),
            )
            return
        if (
            not self.settings.model_path
            or not self.settings.model_path.is_dir()
        ):
            raise RuntimeError(
                msg(
                    "backend.adapters.providers.minimax.the-model-directory-does-not-exist-check-dw-model"
                )
            )
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        import torch
        from diffusers import ComponentsManager, ModularPipeline

        report(
            msg(
                "backend.adapters.providers.minimax.reading-model-configuration"
            ),
            event="model.config",
            stage="loading",
            modelPath=str(self.settings.model_path.resolve()),
            device=self.settings.device,
            dtype="bfloat16",
            attentionBackend=self.settings.attention_backend,
            memoryReserve=self.settings.memory_reserve,
            localFilesOnly=True,
        )
        started = perf_counter()
        manager = ComponentsManager()
        pipeline = ModularPipeline.from_pretrained(
            str(self.settings.model_path),
            workflow="ref2va",
            components_manager=manager,
            local_files_only=True,
        )
        report(
            msg(
                "backend.adapters.providers.minimax.loading-the-text-encoder-reference-video-transformer-and-audio"
            ),
            event="model.components.loading",
            stage="loading",
            components=["text_encoder", "transformer_ref", "vae", "audio_vae"],
            modelPath=str(self.settings.model_path.resolve()),
        )
        pipeline.load_components(dtype=torch.bfloat16, local_files_only=True)
        pipeline.transformer_ref.set_attention_backend(
            self.settings.attention_backend
        )
        self.residency = ComponentResidency(
            manager, self.settings.device, self.settings.memory_reserve
        )
        self.residency.report = report
        try:
            self.residency.configure()
        finally:
            self.residency.report = lambda *args, **kwargs: None
        self.pipeline = pipeline
        report(
            msg("backend.adapters.providers.minimax.model-components-loaded"),
            event="model.components.ready",
            stage="loading",
            durationSeconds=perf_counter() - started,
        )

    def render(
        self,
        *,
        video: Path,
        prompt: str,
        parameters: dict,
        output: Path,
        progress,
        adapters=None,
    ) -> dict:
        self.load(report=progress)
        self.loras.apply(self.pipeline, adapters or [], progress)
        with self.residency.session(progress):
            return self._render(
                video=video,
                prompt=prompt,
                parameters=parameters,
                output=output,
                progress=progress,
                adapters=adapters,
            )

    def _render(self, *, video, prompt, parameters, output, progress, adapters):
        import torch
        from diffusers.modular_pipelines.minimax_h3 import (
            MiniMaxH3VideoReference,
        )
        from diffusers.utils.export_utils import encode_video

        pipeline = self.pipeline
        progress(
            msg(
                "backend.adapters.providers.minimax.reading-the-reference-video"
            ),
            0.1,
            event="reference.loading",
            stage="conditioning",
            inputPath=str(video.resolve()),
        )
        reference = MiniMaxH3VideoReference.from_file(str(video))
        duration = len(reference.frames) / reference.fps
        requested_frames = round(duration * pipeline.fps)
        frames_per_chunk = pipeline.vae_frames_per_chunk
        offset = pipeline.vae_latents_per_chunk
        frames = (
            math.ceil((requested_frames - offset) / frames_per_chunk)
            * frames_per_chunk
            + offset
        )
        if (
            not pipeline.min_duration
            <= frames / pipeline.fps
            <= pipeline.max_duration
        ):
            raise ValueError(
                msg(
                    "backend.adapters.providers.minimax.the-reference-segment-exceeds-this-model-s-supported-duration"
                )
            )
        width, height = int(parameters["width"]), int(parameters["height"])
        if (
            width % pipeline.canvas_multiple
            or height % pipeline.canvas_multiple
        ):
            raise ValueError(
                msg(
                    "backend.adapters.providers.minimax.output-dimensions-must-be-multiples-of",
                    p0=pipeline.canvas_multiple,
                )
            )
        configure_reference_canvas(pipeline, width, height)
        # Apply the same library normalizer once, so logs describe the actual condition.
        from diffusers.modular_pipelines.minimax_h3.before_encoder import (
            MiniMaxH3Ref2VASetupStep,
        )

        normalized_frames = MiniMaxH3Ref2VASetupStep._normalize_video_condition(
            reference.frames,
            float(reference.fps),
            frames,
            pipeline.canvas_multiple,
            pipeline.config.canvas_short_edge,
            pipeline.config.canvas_max_pixels,
            pipeline.fps,
        )
        reference = MiniMaxH3VideoReference(
            frames=normalized_frames,
            fps=float(pipeline.fps),
            audio=reference.audio,
            sample_rate=reference.sample_rate,
        )
        reference_height, reference_width = reference.frames.shape[1:3]
        if reference_height * reference_width > width * height:
            raise ValueError(
                msg(
                    "backend.adapters.providers.minimax.the-reference-video-canvas-exceeds-the-output-pixel-budget"
                )
            )
        progress(
            msg(
                "backend.adapters.providers.minimax.reference-video-loaded-preparing-conditioning"
            ),
            0.12,
            event="reference.ready",
            stage="conditioning",
            inputPath=str(video.resolve()),
            inputFrames=len(reference.frames),
            inputFps=reference.fps,
            outputFrames=frames,
            outputFps=pipeline.fps,
            width=width,
            height=height,
            parameters=parameters,
            referenceWidth=reference_width,
            referenceHeight=reference_height,
            referenceCanvasPolicy=REFERENCE_CANVAS_VERSION,
            gpuMemory=gpu_memory(self.settings.device),
        )
        # This syntax is specific to this provider; it never reaches generic UI/contracts.
        model_prompt = reference_prompt(prompt)
        prompt_path = output.parent / "model-prompt.txt"
        prompt_path.write_text(model_prompt)
        progress(
            msg(
                "backend.adapters.providers.minimax.model-prompt-compiled-the-low-poly-video-provides-layout"
            ),
            0.15,
            event="conditioning.prompt",
            stage="conditioning",
            prompt=model_prompt,
            promptPath=str(prompt_path.resolve()),
            formatVersion=PROMPT_FORMAT_VERSION,
        )

        def sampled(event, completed, total, elapsed):
            if event == "end":
                progress(
                    msg(
                        "backend.adapters.providers.minimax.sampling-complete-decoding-video-and-audio"
                    ),
                    0.9,
                    event="sampling.finished",
                    stage="decoding",
                    completed=completed,
                    total=total,
                    samplingSeconds=elapsed,
                    gpuMemory=gpu_memory(self.settings.device),
                )
            else:
                eta = (
                    elapsed / completed * (total - completed)
                    if completed and total
                    else None
                )
                progress(
                    msg(
                        "backend.adapters.providers.minimax.sampling",
                        p0=completed,
                        p1=total,
                    ),
                    0.25 + 0.6 * completed / total if total else 0.25,
                    event="sampling.started"
                    if event == "start"
                    else "sampling.step",
                    stage="sampling",
                    completed=completed,
                    total=total,
                    samplingSeconds=elapsed,
                    samplingEtaSeconds=eta,
                    gpuMemory=gpu_memory(self.settings.device),
                )

        progress(
            msg(
                "backend.adapters.providers.minimax.encoding-the-prompt-and-reference-conditioning"
            ),
            0.2,
            event="conditioning.started",
            stage="conditioning",
        )
        started = perf_counter()
        # In this pinned library version, .blocks returns a deep copy. __call__ executes _blocks.
        with torch.inference_mode(), observe_steps(pipeline._blocks, sampled):
            results = pipeline(
                prompt=model_prompt,
                references=[reference],
                width=width,
                height=height,
                num_frames=frames,
                num_inference_steps=int(parameters["steps"]),
                generator=torch.Generator(device="cpu").manual_seed(
                    int(parameters["seed"])
                ),
                output=["videos", "audio", "sampling_rate"],
            )
        progress(
            msg(
                "backend.adapters.providers.minimax.generation-and-decoding-complete-saving-video"
            ),
            0.95,
            event="video.saving",
            stage="saving",
            outputPath=str(output.resolve()),
            generationSeconds=perf_counter() - started,
            gpuMemory=gpu_memory(self.settings.device),
        )
        audio = results["audio"][0] if parameters.get("audio", True) else None
        encode_video(
            results["videos"][0],
            fps=pipeline.fps,
            output_path=str(output),
            audio=audio,
            audio_sample_rate=results["sampling_rate"]
            if audio is not None
            else None,
        )
        return {
            "fps": pipeline.fps,
            "frames": frames,
            "duration": frames / pipeline.fps,
            "width": width,
            "height": height,
            "steps": int(parameters["steps"]),
            "adapters": adapters or [],
            "promptFormat": PROMPT_FORMAT_VERSION,
            "referenceCanvasPolicy": REFERENCE_CANVAS_VERSION,
            "referenceWidth": reference_width,
            "referenceHeight": reference_height,
        }

    def unload(self):
        if self.residency is not None:
            self.residency.close()
            self.residency = None
        self.pipeline = None
        self.loras.active = []
        import gc
        import torch

        gc.collect()
        torch.cuda.empty_cache()
