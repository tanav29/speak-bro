"""Pure memory filtering and serialization helpers."""

import re

MEMORY_TRANSIENT_PATTERNS = (
    r"\b(today|tonight|tomorrow|yesterday|this morning|this afternoon|this evening)\b",
    r"\b(right now|currently|for now|temporary|temporarily|one-time|one off|just for now)\b",
    r"\b(going to|gonna|will be|planning to|plan to|need to|have to|about to)\b",
    r"\b(meeting|appointment|lunch|dinner|flight|ride|errand|deadline)\b",
    r"\b(mood|tired|hungry|bored|stressed|anxious|busy)\b",
)
MEMORY_DURABLE_HINTS = (
    r"\b(i like|i love|i prefer|my favorite|my favourite|i usually|i always|i never)\b",
    r"\b(my name is|call me|i am|i'm|i work as|i work on|i live in|i live at|i use)\b",
    r"\b(pronouns|allergic|allergy|diagnosed|birthday|partner|spouse|kid|children|pet)\b",
    r"\b(project|startup|company|team|repo|workspace|stack|deadline)\b",
    r"\b(language|timezone|diet|exercise|habit|goal|goal is|goal of)\b",
)
MEMORY_PREFIX_STRIPPER = re.compile(
    r"^(please\s+)?(remember|note|keep in mind)(\s+that|\s+this)?[:,\s-]*",
    re.IGNORECASE,
)


def normalize_memory_text(text: str) -> str:
    return " ".join((text or "").split()).strip()


def clean_memory_text(text: str) -> str:
    cleaned = normalize_memory_text(text)
    cleaned = MEMORY_PREFIX_STRIPPER.sub("", cleaned).strip(" .")
    return cleaned or normalize_memory_text(text)


def classify_memory_candidate(text: str) -> dict:
    normalized = normalize_memory_text(text)
    lower = normalized.lower()
    word_count = len(normalized.split())
    durable_hits = [pattern for pattern in MEMORY_DURABLE_HINTS if re.search(pattern, lower)]
    transient_hits = [pattern for pattern in MEMORY_TRANSIENT_PATTERNS if re.search(pattern, lower)]
    should_save = bool(durable_hits) and not transient_hits and word_count >= 4
    if transient_hits and not durable_hits:
        reason, category = "Looks temporary or situational, so it was skipped.", "transient"
    elif durable_hits:
        reason, category = "Looks like a durable fact worth keeping.", "durable"
    else:
        reason, category = "Not enough signal that this is a long-term fact.", "uncertain"
    return {
        "should_save": should_save,
        "reason": reason,
        "category": category,
        "word_count": word_count,
        "transient_hits": len(transient_hits),
        "durable_hits": len(durable_hits),
        "cleaned": clean_memory_text(normalized),
    }


def serialize_memory_item(memory: object) -> dict:
    return {
        "id": getattr(memory, "id", ""),
        "title": getattr(memory, "title", None),
        "content": getattr(memory, "content", None),
        "summary": getattr(memory, "summary", None),
        "createdAt": getattr(memory, "created_at", None),
        "updatedAt": getattr(memory, "updated_at", None),
        "status": getattr(memory, "status", None),
        "type": getattr(memory, "type", None),
        "url": getattr(memory, "url", None),
        "filepath": getattr(memory, "filepath", None),
        "customId": getattr(memory, "custom_id", None),
        "connectionId": getattr(memory, "connection_id", None),
        "containerTags": getattr(memory, "container_tags", None),
        "metadata": getattr(memory, "metadata", None),
    }
