from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any


DEFAULT_MODEL_ID = "LiquidAI/d1-2B"
# Pin the custom model code and weights used by the experiments.
DEFAULT_REVISION = "cfe5760ff5d5998f91d9ac56bd4b2dbd96996d41"


class D1Model:
    def __init__(
        self,
        device: str = "auto",
        model_id: str = DEFAULT_MODEL_ID,
        revision: str = DEFAULT_REVISION,
        local_files_only: bool = False,
    ) -> None:
        import torch
        from transformers import AutoModel

        self.torch = torch
        self.device = self._resolve_device(device)
        self.dtype = torch.float32 if self.device == "cpu" else torch.bfloat16
        self.model_id = model_id
        self.revision = revision
        started = time.perf_counter()
        self.model = AutoModel.from_pretrained(
            model_id,
            revision=revision,
            trust_remote_code=True,
            dtype=self.dtype,
            local_files_only=local_files_only,
        ).to(self.device)
        self.model.eval()
        self._synchronize()
        self.load_seconds = time.perf_counter() - started

    def _resolve_device(self, requested: str) -> str:
        if requested != "auto":
            return requested
        if self.torch.cuda.is_available():
            return "cuda"
        if self.torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    def _synchronize(self) -> None:
        if self.device == "cuda":
            self.torch.cuda.synchronize()
        elif self.device == "mps":
            self.torch.mps.synchronize()

    def system_one(
        self, state: Any, questions: Mapping[str, Any], media: Any = None
    ) -> tuple[dict[str, Any], float]:
        self._synchronize()
        started = time.perf_counter()
        with self.torch.inference_mode():
            result = self.model.system_one(state, questions, media=media)
        self._synchronize()
        return result, (time.perf_counter() - started) * 1000
