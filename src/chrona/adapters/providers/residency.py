"""Bound component residency while preserving the library's memory reserve policy."""
from chrona.infrastructure.i18n import msg
from contextlib import contextmanager


def gpu_memory(device):
    if str(device).split(":", 1)[0] != "cuda": return {}
    import torch
    if torch.device(device).type != "cuda":
        return {}
    free, total = torch.cuda.mem_get_info(device)
    return {"allocatedBytes": torch.cuda.memory_allocated(device),
            "reservedBytes": torch.cuda.memory_reserved(device),
            "peakAllocatedBytes": torch.cuda.max_memory_allocated(device),
            "freeBytes": free, "totalBytes": total}


class SequentialOffloadStrategy:
    """Retire other components even when weights fit; activations also need room."""
    def __init__(self, reserve_policy, report):
        self.reserve_policy, self.report = reserve_policy, report
        self.memory_reserve_margin = reserve_policy.memory_reserve_margin

    def __call__(self, hooks, model_id, model, execution_device):
        required = self.reserve_policy(hooks, model_id, model, execution_device)
        retiring = required + [hook for hook in hooks if hook not in required]
        self.report(msg('backend.adapters.providers.residency.switching-model-components-and-unloading-previous-stage-weights'), event="model.component.switch",
            component=model_id.rsplit("_", 1)[0],
            offloadComponents=[hook.model_id.rsplit("_", 1)[0] for hook in retiring],
            memoryReserveBytes=self.memory_reserve_margin, gpuMemory=gpu_memory(execution_device))
        return retiring


class ComponentResidency:
    def __init__(self, manager, device, reserve):
        self.manager, self.device, self.reserve = manager, device, reserve
        self.report = lambda *args, **kwargs: None

    def configure(self):
        from diffusers.modular_pipelines.components_manager import AutoOffloadStrategy
        policy = SequentialOffloadStrategy(AutoOffloadStrategy(self.reserve), self.emit)
        # Registering components resets the library policy. Apply ours only after loading.
        self.manager.enable_auto_cpu_offload(device=self.device, memory_reserve_margin=self.reserve,
                                            offload_strategy=policy)
        self.emit(msg('backend.adapters.providers.residency.stage-unloading-and-gpu-memory-reservation-applied'), event="model.offload.configured",
                  policy="sequential-components@1", memoryReserve=self.reserve,
                  memoryReserveBytes=policy.memory_reserve_margin)

    def emit(self, message, **details):
        self.report(message, **details)

    def release(self):
        import torch
        for hook in self.manager.model_hooks or []:
            hook.offload()
        if torch.device(self.device).type == "cuda":
            with torch.cuda.device(self.device):
                torch.cuda.empty_cache()
        self.emit(msg('backend.adapters.providers.residency.model-components-moved-back-to-cpu'), event="model.offload.released", gpuMemory=gpu_memory(self.device))

    @contextmanager
    def session(self, report):
        import torch
        self.report = report
        try:
            # LoRA loading may rebuild hooks; restore the policy for every request.
            self.configure()
            if torch.device(self.device).type == "cuda":
                torch.cuda.reset_peak_memory_stats(self.device)
            yield
        finally:
            try:
                self.release()
            finally:
                self.report = lambda *args, **kwargs: None

    def close(self):
        self.manager.disable_auto_cpu_offload()
