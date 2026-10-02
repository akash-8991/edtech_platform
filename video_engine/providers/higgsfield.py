from __future__ import annotations
import os
from pathlib import Path
import httpx


class HiggsfieldProvider:
    """Wraps higgsfield-client. Endpoint ids come from env so models can be swapped without a release."""
    name = "higgsfield"

    def __init__(self, t2v: str | None = None, i2v: str | None = None):
        import higgsfield_client  # lazy: not needed in mock mode
        self._hf = higgsfield_client
        self.t2v = t2v or os.environ.get("HF_T2V_MODEL", "")
        self.i2v = i2v or os.environ.get("HF_I2V_MODEL", "")
        if not os.environ.get("HF_KEY"):
            raise RuntimeError("HF_KEY not set (format key_id:key_secret)")

    def generate(self, prompt, out: Path, duration, image=None):
        model = self.i2v if image else self.t2v
        if not model:
            raise RuntimeError("Set HF_T2V_MODEL / HF_I2V_MODEL (see docs.higgsfield.ai/docs/models)")
        args = {"prompt": prompt, "duration": duration}
        if image:
            args["image_url"] = image
        # NOTE: argument names vary per model; verify against the model's reference page.
        result = self._hf.subscribe(model, arguments=args)
        url = (result.get("video") or (result.get("videos") or [{}])[0]).get("url")
        if not url:
            raise RuntimeError(f"no video url in result keys={list(result)}")
        with httpx.stream("GET", url, follow_redirects=True, timeout=300) as r:
            r.raise_for_status()
            out.write_bytes(b"".join(r.iter_bytes()))
        return {"provider": self.name, "model": model, "args": args, "source_url": url}
