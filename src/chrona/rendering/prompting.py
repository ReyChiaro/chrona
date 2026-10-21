from chrona.infrastructure.resources import resource
"""Compile visual prose for video encoders; identifiers stay in the audit manifest."""
import hashlib
import re
from pathlib import Path

COMPILER_VERSION = "visual-shot@1"
DEFAULT_RULES = resource("harness/rendering/prompts/video-system.txt")
MAX_UNITS = 400
MAX_CHARACTERS = 2800


def units(text: str) -> float:
    """Conservative multilingual packing estimate, not a model tokenizer count."""
    return sum(max(1.5, len(token) / 5) if token.isascii() and token[0].isalnum() else 2 if not token.isascii() else 0.25
               for token in re.findall(r"[a-zA-Z0-9]+|[^\s]", text))


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", str(text)).strip()


def shorten(text: str, budget: float) -> str:
    text = clean(text)
    if units(text) <= budget:
        return text
    end = 0
    for match in re.finditer(r"[a-zA-Z0-9]+|[^\s]", text):
        if units(text[:match.end()]) > budget - 2:
            break
        end = match.end()
    candidate = text[:end].rstrip(" ,;，；")
    sentences = list(re.finditer(r"[.!?。！？](?:\s|$)", candidate))
    if sentences and units(candidate[:sentences[-1].end()]) >= 10:
        return candidate[:sentences[-1].end()].strip()
    return candidate.rstrip(".!?。！？") + "." if candidate else ""


def compile_visual_prompt(direction: str, *, scene="", subjects=(), changes=(), motion="", lighting="", system="", continuity="") -> dict:
    # Reserve space for local appearance and current-state changes before generic prose.
    tail = [("motion", motion, 42), ("lighting", lighting, 30), ("continuity", continuity, 25),
            ("render-rules", system.strip() or DEFAULT_RULES.read_text(), 100)]
    tail = [(role, text, shorten(text, maximum)) for role, text, maximum in tail if text]
    reserved = sum(units(text) for _, _, text in tail)
    candidates = [("scene", scene, 42), ("direction", direction, 125)]
    candidates += [("current-state", text, 45) for text in changes[:2]]
    candidates += [("subject", text, 65) for text in subjects[:4]]
    subject_reserve = units(shorten(subjects[0], 65)) if subjects else 0
    paragraphs, audit, warnings = [], [], []
    for role, original, maximum in candidates:
        if not original:
            continue
        remaining = MAX_UNITS - reserved - sum(units(p) for p in paragraphs)
        if role == "subject":
            subject_reserve = 0
        else:
            remaining -= subject_reserve
        text = shorten(original, min(maximum, remaining)) if remaining >= 12 else ""
        if len("\n\n".join([*paragraphs, text])) > MAX_CHARACTERS:
            text = ""
        if text:
            paragraphs.append(text)
        truncated = clean(original) != text
        audit.append({"role": role, "source": original, "text": text, "truncated": truncated})
        if truncated:
            warnings.append(f"{role}: shortened or omitted to fit the video text budget")
    for role, original, text in tail:
        paragraphs.append(text)
        truncated = clean(original) != text
        audit.append({"role": role, "source": original, "text": text, "truncated": truncated})
        if truncated:
            warnings.append(f"{role}: shortened to fit the video text budget")
    prompt = "\n\n".join(paragraphs)
    return {"prompt": prompt, "version": COMPILER_VERSION, "paragraphs": audit, "warnings": warnings,
            "estimatedUnits": round(units(prompt), 2), "characters": len(prompt),
            "sha256": hashlib.sha256(prompt.encode()).hexdigest()}
