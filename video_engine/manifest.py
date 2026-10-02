"""Scene manifest: the contract between the AI script stage and the renderer (TRD §8, VID-001..006)."""
from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field, model_validator

SceneType = Literal["avatar", "narration_slides", "animation", "screen_demo", "mixed"]
Lang = Literal["en", "hi"]


class Interaction(BaseModel):
    kind: Literal["pause_quiz", "hotspot", "reflection", "choose_path", "tutor_prompt", "glossary"]
    at_sec: float = Field(ge=0)
    prompt: str
    # branch targets: option label -> scene id; every path must reach an outcome
    branches: dict[str, str] = {}


class Scene(BaseModel):
    id: str
    type: SceneType
    narration: dict[Lang, str]            # reviewed text per language
    on_screen_text: str = ""
    visual_prompt: str                    # prompt sent to the video model
    reference_image: Optional[str] = None # image-to-video if set
    duration_sec: float = Field(default=6, gt=0, le=15)
    interactions: list[Interaction] = []
    sources: list[str] = []               # provenance (VID-006)


class Manifest(BaseModel):
    topic_id: str
    title: str
    languages: list[Lang] = ["en"]
    glossary: dict[str, str] = {}         # locked technical terms
    outcomes: list[str] = []
    scenes: list[Scene]

    @model_validator(mode="after")
    def _check(self):
        ids = {s.id for s in self.scenes}
        if len(ids) != len(self.scenes):
            raise ValueError("duplicate scene ids")
        for s in self.scenes:
            for lang in self.languages:
                if not s.narration.get(lang, "").strip():
                    raise ValueError(f"scene {s.id}: missing {lang} narration")
            for i in s.interactions:
                for tgt in i.branches.values():
                    if tgt not in ids:
                        raise ValueError(f"scene {s.id}: branch to unknown scene {tgt}")
        return self

    def unreachable_scenes(self) -> list[str]:
        """Branch reachability QA: scenes never reachable from the first scene."""
        order = [s.id for s in self.scenes]
        seen, stack = set(), [order[0]]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            idx = order.index(cur)
            if idx + 1 < len(order):
                stack.append(order[idx + 1])
            for i in next(s for s in self.scenes if s.id == cur).interactions:
                stack.extend(i.branches.values())
        return [i for i in order if i not in seen]
