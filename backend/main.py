import asyncio
import io
import os
import json
import logging
import time
import re
import wave
import uuid
import threading
from datetime import datetime, timezone
from functools import lru_cache
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Tuple

import httpx
import supermemory
from exa_py import Exa

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
import piper

from dotenv import load_dotenv
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.messages import ModelRequest, ModelResponse, UserPromptPart, TextPart

from faster_whisper import WhisperModel


load_dotenv()

SM_API_KEY = os.getenv("SUPER_MEM_KEY")
sm_client = supermemory.Supermemory(api_key=SM_API_KEY) if SM_API_KEY else None
exa_client = Exa(api_key=os.getenv("EXA_API_KEY")) if os.getenv("EXA_API_KEY") else None
CONTAINER_TAGS = ["sm_project_speakbro"]

LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.groq.com/openai/v1")
LLM_MODEL_NAME = os.getenv("LLM_MODEL_NAME", "openai/gpt-oss-20b")
LLM_API_KEY = (
    os.getenv("LLM_API_KEY")
    or os.getenv("GROQ_API_KEY")
    or os.getenv("CEREBRAS_API_KEY")
)

LLM_PROVIDER = OpenAIProvider(base_url=LLM_BASE_URL, api_key=LLM_API_KEY)

LLM_MODEL = OpenAIChatModel(model_name=LLM_MODEL_NAME, provider=LLM_PROVIDER)

SYSTEM_PROMPT = (
    "You are SpeakBro, a helpful, friendly, and concise voice assistant. "
    "Keep your answers short and conversational (1 to 2 sentences max) as they will be spoken aloud. "
    "Your master is Tanav. "
    "Use supermemory to retrieve long term facts. Relevant memories about the user are "
    "automatically recalled and prepended to your prompt — use them naturally without "
    "announcing that you looked them up. Only save a memory when something is a durable, "
    "long-term fact worth remembering. Prefer stable preferences, identity details, recurring "
    "projects, allergies, or other lasting constraints. Do NOT save moods, one-off plans, "
    "temporary status updates, timestamps, or casual conversation. "
    "You have tools to search the web, manage memories, get the current time, "
    "and manage OpenCode sessions (create, list, summarize, send messages, view messages). "
    "Only create an OpenCode session when the task is complex and requires many steps of work, "
    "or when the user explicitly asks you to use OpenCode or write code. "
    "You can send a message to a session to hand it work, view the last few messages to recall "
    "what happened, or summarize a session when it gets long. "
    "The user can select an OpenCode session in the UI to have you manage it; that becomes the "
    "'selected session'. When you send a message or summarize, you may omit the session id to "
    "target the selected session automatically. If no session is selected and you omit the id, "
    "ask the user to select one or create a new session."
)

agent = Agent(
    LLM_MODEL,
    system_prompt=SYSTEM_PROMPT,
    retries=2,
    deps_type=WebSocket,
)


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

    durable_hits = [
        pattern for pattern in MEMORY_DURABLE_HINTS if re.search(pattern, lower)
    ]
    transient_hits = [
        pattern for pattern in MEMORY_TRANSIENT_PATTERNS if re.search(pattern, lower)
    ]

    should_save = bool(durable_hits) and not transient_hits and word_count >= 4
    if word_count < 4:
        should_save = False

    if transient_hits and not durable_hits:
        reason = "Looks temporary or situational, so it was skipped."
        category = "transient"
    elif durable_hits:
        reason = "Looks like a durable fact worth keeping."
        category = "durable"
    else:
        reason = "Not enough signal that this is a long-term fact."
        category = "uncertain"

    return {
        "should_save": should_save,
        "reason": reason,
        "category": category,
        "word_count": word_count,
        "transient_hits": len(transient_hits),
        "durable_hits": len(durable_hits),
        "cleaned": clean_memory_text(normalized),
    }


async def send_memory_event(ctx: RunContext[WebSocket], payload: dict) -> None:
    try:
        await ctx.deps.send_json({"type": "memory_event", **payload})
    except Exception:
        return


def _serialize_memory_item(memory: object) -> dict:
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


@agent.tool(strict=False)
def web_search(ctx: RunContext[WebSocket], query: str, max_results: int = 5) -> str:
    """Search the web for current information on any topic.

    Use when the user asks about news, current events, facts you're unsure about,
    or anything requiring up-to-date information beyond your training data.
    """
    log_stage(
        logging.INFO, "tool.web_search", "query=%r max_results=%d", query, max_results
    )
    start = time.perf_counter()
    if exa_client is None:
        elapsed = time.perf_counter() - start
        log_stage(
            logging.WARNING,
            "tool.web_search",
            "Exa not configured; returning unavailable after %.2fs",
            elapsed,
        )
        return json.dumps(
            {
                "success": False,
                "error": "Web search is not configured (no EXA_API_KEY).",
            }
        )
    try:
        response = exa_client.search_and_contents(
            query,
            num_results=max_results,
            text=True,
        )
        formatted = [
            {
                "title": r.title or "",
                "snippet": r.text or "",
                "url": r.url or "",
            }
            for r in response.results
        ]
        elapsed = time.perf_counter() - start
        log_stage(
            logging.INFO,
            "tool.web_search",
            "results=%d elapsed=%.2fs",
            len(formatted),
            elapsed,
        )
        return json.dumps({"success": True, "results": formatted})
    except Exception as e:
        elapsed = time.perf_counter() - start
        log_stage(
            logging.ERROR,
            "tool.web_search",
            "error after %.2fs: %s",
            elapsed,
            e,
            exc_info=True,
        )
        return json.dumps({"success": False, "error": str(e)})


@agent.tool(strict=False)
def search_memories(
    ctx: RunContext[WebSocket],
    information_to_get: str,
    limit: int = 10,
    include_full_docs: bool = True,
) -> str:
    """Search (recall) memories/details/information about the user or other facts or entities.

    Run when explicitly asked or when context about user's past choices would be helpful.
    """
    log_stage(
        logging.INFO,
        "tool.search_memories",
        "query=%r limit=%d",
        information_to_get,
        limit,
    )
    start = time.perf_counter()
    if sm_client is None:
        return json.dumps({"success": False, "error": "SuperMemory is not configured."})
    try:
        response = sm_client.search.execute(
            q=information_to_get,
            container_tags=CONTAINER_TAGS,
            limit=limit,
            include_full_docs=include_full_docs,
        )
        results = [
            {
                "title": getattr(r, "title", ""),
                "content": getattr(r, "content", ""),
                "url": getattr(r, "url", ""),
            }
            for r in response.results
        ]
        elapsed = time.perf_counter() - start
        log_stage(
            logging.INFO,
            "tool.search_memories",
            "results=%d elapsed=%.2fs",
            len(results),
            elapsed,
        )
        return json.dumps({"success": True, "results": results, "count": len(results)})
    except Exception as e:
        elapsed = time.perf_counter() - start
        log_stage(
            logging.ERROR,
            "tool.search_memories",
            "error after %.2fs: %s",
            elapsed,
            e,
            exc_info=True,
        )
        return json.dumps({"success": False, "error": str(e)})


@agent.tool(strict=False)
async def add_memory(ctx: RunContext[WebSocket], memory: str) -> str:
    """Add a memory only when it is clearly durable and worth keeping long-term.

    This tool now filters out temporary, one-off, or conversational details before
    saving anything to SuperMemory.
    """
    start = time.perf_counter()
    candidate = classify_memory_candidate(memory)
    cleaned_memory = candidate["cleaned"]

    log_stage(
        logging.INFO,
        "tool.add_memory",
        "category=%s durable_hits=%d transient_hits=%d memory=%r",
        candidate["category"],
        candidate["durable_hits"],
        candidate["transient_hits"],
        cleaned_memory[:200],
    )

    if sm_client is None:
        await send_memory_event(
            ctx,
            {
                "action": "error",
                "category": candidate["category"],
                "reason": "SuperMemory is not configured.",
                "memory": cleaned_memory,
            },
        )
        return json.dumps({"success": False, "error": "SuperMemory is not configured."})

    if not candidate["should_save"]:
        await send_memory_event(
            ctx,
            {
                "action": "skipped",
                "category": candidate["category"],
                "reason": candidate["reason"],
                "memory": cleaned_memory,
                "wordCount": candidate["word_count"],
            },
        )
        return json.dumps(
            {
                "success": True,
                "saved": False,
                "skipped": True,
                "category": candidate["category"],
                "reason": candidate["reason"],
            }
        )

    try:
        response = sm_client.add(
            content=cleaned_memory,
            container_tags=CONTAINER_TAGS,
        )
        elapsed = time.perf_counter() - start
        memory_id = getattr(response, "id", "")
        await send_memory_event(
            ctx,
            {
                "action": "saved",
                "category": candidate["category"],
                "reason": candidate["reason"],
                "memory": cleaned_memory,
                "memoryId": memory_id,
                "wordCount": candidate["word_count"],
            },
        )
        log_stage(
            logging.INFO,
            "tool.add_memory",
            "saved memory_id=%s elapsed=%.2fs",
            memory_id,
            elapsed,
        )
        return json.dumps(
            {
                "success": True,
                "saved": True,
                "memory_id": memory_id,
                "category": candidate["category"],
            }
        )
    except Exception as e:
        elapsed = time.perf_counter() - start
        await send_memory_event(
            ctx,
            {
                "action": "error",
                "category": candidate["category"],
                "reason": str(e),
                "memory": cleaned_memory,
            },
        )
        log_stage(
            logging.ERROR,
            "tool.add_memory",
            "error after %.2fs: %s",
            elapsed,
            e,
            exc_info=True,
        )
        return json.dumps({"success": False, "error": str(e)})


@agent.tool(strict=False)
def get_current_time(ctx: RunContext[WebSocket]) -> str:
    """Get the current date and time. Use when the user asks about the current time, date, or day."""
    log_stage(logging.INFO, "tool.get_current_time", "called")
    now = datetime.now(timezone.utc)
    result = json.dumps(
        {
            "success": True,
            "datetime": now.isoformat(),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M:%S UTC"),
            "day": now.strftime("%A"),
        }
    )
    log_stage(
        logging.INFO,
        "tool.get_current_time",
        "returned %s",
        now.strftime("%H:%M:%S UTC"),
    )
    return result


@agent.tool(strict=False)
async def create_opencode_session(
    ctx: RunContext[WebSocket],
    title: str = "SpeakBro session",
    message: str | None = None,
) -> str:
    """Create a new OpenCode session for complex coding tasks that require many steps of work.

    Use this when the user asks to write code, work on a project, debug something complex,
    or when a task clearly needs multiple steps of LLM work that would benefit from an
    OpenCode session. Do NOT create a session for simple questions or quick answers.
    If `message` is provided, it is queued to the new session immediately (fire and forget),
    which is handy for kicking off the work right after creation.
    """
    log_stage(logging.INFO, "tool.create_opencode_session", "title=%r", title)
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{OPENCODE_API_URL}/session",
                json={"title": title},
                timeout=5.0,
            )
            response.raise_for_status()
            data = response.json()
            session_id = data.get("id")
            elapsed = time.perf_counter() - start
            if session_id:
                log_stage(
                    logging.INFO,
                    "opencode.session",
                    "Created OpenCode session: %s",
                    session_id,
                )
                log_stage(
                    logging.INFO,
                    "tool.create_opencode_session",
                    "session_id=%s elapsed=%.2fs",
                    session_id,
                    elapsed,
                )
                await ctx.deps.send_json(
                    {"type": "opencode_session", "sessionId": session_id}
                )
                ctx.deps.selected_session_id = session_id

                queued = False
                if message:
                    try:
                        msg_start = time.perf_counter()
                        msg_response = await client.post(
                            f"{OPENCODE_API_URL}/session/{session_id}/prompt_async",
                            json={
                                # "model": {
                                #     "providerID": provider_id,
                                #     "modelID": model_id,
                                # },
                                "parts": [{"type": "text", "text": message}],
                            },
                            timeout=10.0,
                        )
                        msg_elapsed = time.perf_counter() - msg_start
                        queued = msg_response.status_code == 204
                        log_stage(
                            logging.INFO,
                            "opencode.session",
                            "Queued message to new OpenCode session: %s",
                            session_id,
                        )
                        log_stage(
                            logging.INFO,
                            "tool.create_opencode_session",
                            "message queued session_id=%s elapsed=%.2fs",
                            session_id,
                            msg_elapsed,
                        )
                    except Exception as e:
                        log_stage(
                            logging.WARNING,
                            "opencode.session",
                            "Failed to queue message to new OpenCode session %s: %s",
                            session_id,
                            e,
                            exc_info=True,
                        )

                return json.dumps(
                    {
                        "success": True,
                        "session_id": session_id,
                        "title": data.get("title", title),
                        "queued": queued,
                    }
                )
    except Exception as e:
        elapsed = time.perf_counter() - start
        log_stage(
            logging.WARNING,
            "opencode.session",
            "Failed to create OpenCode session: %s",
            e,
            exc_info=True,
        )
        log_stage(
            logging.ERROR,
            "tool.create_opencode_session",
            "error after %.2fs: %s",
            elapsed,
            e,
        )
    return json.dumps({"success": False, "error": "Failed to create OpenCode session"})


@agent.tool(strict=False)
async def list_opencode_sessions(ctx: RunContext[WebSocket]) -> str:
    """List all existing OpenCode sessions.

    Use this to check what sessions are available before summarizing, forking, or
    managing sessions. Returns session IDs, titles, and basic info.
    """
    log_stage(logging.INFO, "tool.list_opencode_sessions", "called")
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{OPENCODE_API_URL}/session",
                timeout=5.0,
            )
            response.raise_for_status()
            sessions = response.json()
            summaries = [
                {"id": s.get("id"), "title": s.get("title", "Untitled")}
                for s in sessions
            ]
            elapsed = time.perf_counter() - start
            log_stage(
                logging.INFO,
                "tool.list_opencode_sessions",
                "count=%d elapsed=%.2fs",
                len(summaries),
                elapsed,
            )
            return json.dumps(
                {"success": True, "sessions": summaries, "count": len(summaries)}
            )
    except Exception as e:
        elapsed = time.perf_counter() - start
        log_stage(
            logging.WARNING,
            "opencode.session",
            "Failed to list OpenCode sessions: %s",
            e,
            exc_info=True,
        )
        log_stage(
            logging.ERROR,
            "tool.list_opencode_sessions",
            "error after %.2fs: %s",
            elapsed,
            e,
        )
        return json.dumps({"success": False, "error": str(e)})


@agent.tool(strict=False)
async def summarize_opencode_session(
    ctx: RunContext[WebSocket],
    session_id: str | None = None,
) -> str:
    """Return the last 3 text messages from an OpenCode session.

    Use this when the user wants to inspect recent session history. Only text parts are
    included in the output, matching the message shapes documented by OpenCode.

    If `session_id` is omitted, the currently selected OpenCode session (chosen by the
    user in the UI) is used automatically.
    """
    selected = session_id or getattr(ctx.deps, "selected_session_id", None)
    if not selected:
        log_stage(
            logging.WARNING,
            "tool.summarize_opencode_session",
            "No session_id provided and no selected session",
        )
        return json.dumps(
            {
                "success": False,
                "error": "No session_id provided and no OpenCode session is currently selected. Ask the user to select a session or pass a session_id.",
            }
        )

    def _text_only_content(parts: object) -> str:
        if not isinstance(parts, list):
            return ""

        texts: list[str] = []
        for part in parts:
            if not isinstance(part, dict):
                continue
            if part.get("type") != "text":
                continue
            text = part.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
        return "\n".join(texts).strip()

    def _created_at(item: object) -> int:
        if not isinstance(item, dict):
            return 0
        info = item.get("info")
        if not isinstance(info, dict):
            return 0
        time_info = info.get("time")
        if not isinstance(time_info, dict):
            return 0
        created = time_info.get("created")
        return created if isinstance(created, int) else 0

    log_stage(
        logging.INFO,
        "tool.summarize_opencode_session",
        "session_id=%s",
        selected,
    )
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{OPENCODE_API_URL}/session/{selected}/message",
                params={"limit": 3},
                timeout=10.0,
            )
            response.raise_for_status()
            messages = response.json()
            if not isinstance(messages, list):
                raise ValueError("Unexpected OpenCode messages response")

            recent_messages = sorted(
                (item for item in messages if isinstance(item, dict)),
                key=_created_at,
            )[-3:]
            result = [
                {
                    "id": item.get("info", {}).get("id"),
                    "role": item.get("info", {}).get("role"),
                    "created": item.get("info", {}).get("time", {}).get("created"),
                    "content": _text_only_content(item.get("parts")),
                }
                for item in recent_messages
            ]
            elapsed = time.perf_counter() - start
            log_stage(
                logging.INFO,
                "opencode.session",
                "Loaded recent OpenCode messages: %s",
                selected,
            )
            log_stage(
                logging.INFO,
                "tool.summarize_opencode_session",
                "session_id=%s elapsed=%.2fs",
                selected,
                elapsed,
            )
            return json.dumps(
                {
                    "success": True,
                    "session_id": selected,
                    "message_count": len(result),
                    "messages": result,
                }
            )
    except Exception as e:
        elapsed = time.perf_counter() - start
        log_stage(
            logging.WARNING,
            "opencode.session",
            "Failed to load OpenCode messages for session %s: %s",
            selected,
            e,
            exc_info=True,
        )
        log_stage(
            logging.ERROR,
            "tool.summarize_opencode_session",
            "error after %.2fs: %s session_id=%s",
            elapsed,
            e,
            selected,
        )
        return json.dumps({"success": False, "error": str(e)})


@agent.tool(strict=False)
async def add_message_to_opencode_session(
    ctx: RunContext[WebSocket],
    message: str,
    session_id: str | None = None,
) -> str:
    """Send a message to an existing OpenCode session asynchronously (fire and forget).

    Use this to hand a task, instruction, or follow-up prompt to an OpenCode session
    that is already created. The message is queued and processed by OpenCode without
    waiting for a reply, which is ideal for kicking off work or chaining steps.

    If `session_id` is omitted, the currently selected OpenCode session (chosen by the
    user in the UI) is targeted automatically.
    """
    selected = session_id or getattr(ctx.deps, "selected_session_id", None)
    if not selected:
        log_stage(
            logging.WARNING,
            "tool.add_message_to_opencode_session",
            "No session_id provided and no selected session",
        )
        return json.dumps(
            {
                "success": False,
                "error": "No session_id provided and no OpenCode session is currently selected. Ask the user to select a session or pass a session_id.",
            }
        )
    log_stage(
        logging.INFO,
        "tool.add_message_to_opencode_session",
        "session_id=%s message=%r",
        selected,
        message[:200],
    )
    start = time.perf_counter()
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{OPENCODE_API_URL}/session/{selected}/prompt_async",
                json={
                    # "model": {"providerID": provider_id, "modelID": model_id},
                    "parts": [{"type": "text", "text": message}],
                },
                timeout=10.0,
            )
            elapsed = time.perf_counter() - start
            if response.status_code == 204:
                log_stage(
                    logging.INFO,
                    "opencode.session",
                    "Queued message to OpenCode session: %s",
                    selected,
                )
                log_stage(
                    logging.INFO,
                    "tool.add_message_to_opencode_session",
                    "session_id=%s elapsed=%.2fs",
                    selected,
                    elapsed,
                )
                return json.dumps(
                    {
                        "success": True,
                        "session_id": selected,
                        "queued": True,
                    }
                )
            response.raise_for_status()
            return json.dumps(
                {
                    "success": True,
                    "session_id": selected,
                    "status": response.status_code,
                }
            )
    except Exception as e:
        elapsed = time.perf_counter() - start
        log_stage(
            logging.WARNING,
            "opencode.session",
            "Failed to send message to OpenCode session %s: %s",
            selected,
            e,
            exc_info=True,
        )
        log_stage(
            logging.ERROR,
            "tool.add_message_to_opencode_session",
            "error after %.2fs: %s",
            elapsed,
            e,
        )
        return json.dumps({"success": False, "error": str(e)})


DEFAULT_SAMPLE_RATE = 16000
MAX_HISTORY_MESSAGES = 12
OPENCODE_API_URL = os.getenv("OPENCODE_API_URL", "http://127.0.0.1:4096")
logger = logging.getLogger("speakbro")
logger.setLevel(logging.DEBUG)
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
    )
    logger.addHandler(_handler)


def safe_positive_int(value: object, default: int) -> int:
    """Parse a positive integer configuration value with a fallback default."""

    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def safe_sample_rate(value: object, default: int = DEFAULT_SAMPLE_RATE) -> int:
    return safe_positive_int(value, default)


def log_stage(
    level: int,
    stage: str,
    message: str,
    *args,
    session_id: str | None = None,
    exc_info=False,
):
    prefix = f"[{session_id}] {stage}" if session_id else stage
    logger.log(level, "%s: " + message, prefix, *args, exc_info=exc_info)


ROOT = Path(__file__).resolve().parent.parent
DOTENV_PATH = Path(__file__).resolve().parent / ".env"
BACKEND_DIR = Path(__file__).resolve().parent

PIPER_VOICE = piper.PiperVoice.load(
    BACKEND_DIR / "voices" / "en_US-ryan-medium.onnx",
    config_path=BACKEND_DIR / "voices" / "en_US-ryan-medium.onnx.json",
)


@lru_cache(maxsize=1)
def get_whisper_model() -> WhisperModel:
    return WhisperModel(
        "tiny.en",
        device="cpu",
        compute_type="int8",
    )


app = FastAPI(title="SpeakBro")
MEMORY_LIST_PAGE_SIZE = 100


def trim_history(messages: list[dict]) -> None:
    """Keep the conversation context bounded."""

    excess = len(messages) - (MAX_HISTORY_MESSAGES + 1)
    if excess > 0:
        del messages[1 : 1 + excess]


def append_history(messages: list[dict], role: str, content: str) -> None:
    messages.append({"role": role, "content": content})
    trim_history(messages)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/memories/seed")
def seed_demo_memories() -> dict:
    """Pre-seed a few durable facts so the memory demo works instantly on stage.

    Idempotent-ish: it simply adds the facts to the SuperMemory container. Safe to
    call repeatedly. Useful for hackathon demos where you want to prove recall across
    a restart without first having a conversation.
    """
    if sm_client is None:
        return {"success": False, "error": "SuperMemory is not configured."}

    seed_facts = [
        "My name is Tanav and I prefer concise, direct answers.",
        "I am building SpeakBro, a local-first AI voice assistant with long-term memory.",
        "My favorite programming language is Python and I use it for most backend work.",
        "I am allergic to peanuts and need to avoid them in any food recommendations.",
        "I live in and work from a Windows machine but deploy to Linux servers.",
    ]

    results = []
    start = time.perf_counter()
    for fact in seed_facts:
        try:
            response = sm_client.add(
                content=fact,
                container_tags=CONTAINER_TAGS,
            )
            results.append(
                {
                    "success": True,
                    "content": fact,
                    "id": getattr(response, "id", ""),
                }
            )
        except Exception as e:
            results.append({"success": False, "content": fact, "error": str(e)})

    elapsed = time.perf_counter() - start
    log_stage(
        logging.INFO,
        "memory.seed",
        "seeded=%d/%d elapsed=%.2fs",
        sum(1 for r in results if r.get("success")),
        len(results),
        elapsed,
    )
    return {"success": True, "seeded": len(results), "results": results}


@app.get("/memories")
def list_memories() -> dict:
    memories: list[dict] = []
    if sm_client is None:
        return {
            "memories": [],
            "count": 0,
            "containerTags": CONTAINER_TAGS,
            "error": "SuperMemory is not configured.",
        }

    page = 1

    while True:
        response = sm_client.documents.list(
            container_tags=CONTAINER_TAGS,
            include_content=True,
            limit=MEMORY_LIST_PAGE_SIZE,
            page=page,
            sort="updatedAt",
            order="desc",
        )
        items = getattr(response, "memories", []) or []
        memories.extend(_serialize_memory_item(item) for item in items)

        pagination = getattr(response, "pagination", None)
        current_page = int(getattr(pagination, "current_page", page) or page)
        total_pages = int(
            getattr(pagination, "total_pages", current_page) or current_page
        )
        if current_page >= total_pages or not items:
            break
        page += 1

    return {
        "memories": memories,
        "count": len(memories),
        "containerTags": CONTAINER_TAGS,
    }


@dataclass
class TurnBuffer:
    """Manages the buffer for the current user voice turn, accumulating incoming PCM chunks."""

    recording: bool = False
    sample_rate: int = DEFAULT_SAMPLE_RATE
    pcm_chunks: list[bytes] = field(default_factory=list)
    interrupted: bool = False

    def reset(self, sample_rate: Optional[int] = None) -> None:
        """Resets the state of the buffer to begin recording a new turn."""
        self.recording = True
        self.interrupted = False
        self.sample_rate = sample_rate or DEFAULT_SAMPLE_RATE
        self.pcm_chunks.clear()

    def append(self, chunk: bytes) -> bool:
        """Appends raw PCM audio chunk to the buffer if currently recording."""
        if self.recording and chunk:
            self.pcm_chunks.append(chunk)
            return True
        return False

    def finish(self) -> bytes:
        """Finalizes the turn, stops recording, and returns the accumulated raw audio bytes."""
        self.recording = False
        combined = b"".join(self.pcm_chunks)
        return combined

    def request_interrupt(self) -> None:
        """Signals that the user wants to interrupt the current processing."""
        self.interrupted = True

    def check_interrupted(self) -> bool:
        """Returns True if an interrupt was requested, then clears the flag."""
        if self.interrupted:
            self.interrupted = False
            return True
        return False


def pcm16_to_wav_bytes(
    pcm_bytes: bytes, sample_rate: int = 16000, channels: int = 1
) -> bytes:
    """Wraps raw 16-bit PCM bytes inside a standard WAV container."""

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)  # 2 bytes = 16-bit
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_bytes)
    return buffer.getvalue()


def build_silence_wav(
    duration_seconds: float = 1.0, sample_rate: int = DEFAULT_SAMPLE_RATE
) -> bytes:
    frame_count = max(1, int(duration_seconds * sample_rate))
    pcm = b"\x00\x00" * frame_count
    return pcm16_to_wav_bytes(pcm, sample_rate=sample_rate)


# STT
def transcribe_audio(wav_bytes: bytes) -> str:
    start_time = time.perf_counter()
    log_stage(
        logging.INFO, "stt.input", "Transcribing audio (%d bytes)", len(wav_bytes)
    )
    if not wav_bytes:
        log_stage(
            logging.WARNING,
            "stt.input",
            "Empty audio payload received for transcription",
        )
        return "No audio data received."

    try:
        model = get_whisper_model()
        audio = io.BytesIO(wav_bytes)
        audio.seek(0)
        segments, info = model.transcribe(
            audio,
            beam_size=1,
            language="en",
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = " ".join(
            segment.text.strip() for segment in segments if segment.text.strip()
        ).strip()
        elapsed = time.perf_counter() - start_time
        log_stage(
            logging.INFO,
            "stt.complete",
            "elapsed=%.2fs language=%s",
            elapsed,
            getattr(info, "language", "en"),
        )
        return text or "I could not detect speech."
    except Exception as exc:
        log_stage(
            logging.ERROR, "stt.error", "Transcription failed: %s", exc, exc_info=True
        )
        return "STT failed."


# Proactive memory recall: surface relevant long-term facts before the LLM answers,
# so SpeakBro "remembers you" without the model having to explicitly call a tool.
async def recall_memory_context(query: str, limit: int = 5) -> list[dict]:
    """Search SuperMemory for context relevant to the current utterance.

    Returns a list of {title, content} dicts, or an empty list on any failure.
    """
    if not query or not query.strip():
        return []
    if sm_client is None:
        return []
    start = time.perf_counter()
    try:
        response = sm_client.search.execute(
            q=query,
            container_tags=CONTAINER_TAGS,
            limit=limit,
            include_full_docs=True,
        )
        results = [
            {
                "title": getattr(r, "title", "") or "",
                "content": getattr(r, "content", "") or "",
            }
            for r in getattr(response, "results", []) or []
            if getattr(r, "content", "") or getattr(r, "title", "")
        ]
        elapsed = time.perf_counter() - start
        log_stage(
            logging.INFO,
            "memory.recall",
            "recalled=%d elapsed=%.2fs",
            len(results),
            elapsed,
        )
        return results
    except Exception as e:
        elapsed = time.perf_counter() - start
        log_stage(
            logging.WARNING,
            "memory.recall",
            "failed after %.2fs: %s",
            elapsed,
            e,
        )
        return []


# LLM - pydantic-ai agent handles tool calling loop automatically


def _convert_history(messages: list[dict]) -> list[ModelRequest | ModelResponse]:
    """Convert dict-based session history to pydantic-ai ModelMessage objects."""
    result: list[ModelRequest | ModelResponse] = []
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content", "")
        if role == "user":
            result.append(ModelRequest(parts=[UserPromptPart(content=content)]))
        elif role == "assistant":
            result.append(ModelResponse(parts=[TextPart(content=content)]))
    return result


async def generate_llm_response(
    messages: list[dict], websocket: WebSocket, selected_session_id: str | None = None
) -> str:
    """Generate a response using the pydantic-ai agent.

    The agent automatically handles tool calls (web_search, memories, time, opencode).
    `selected_session_id` is the OpenCode session the user has chosen for the agent to
    manage; it is surfaced to the model so it knows which session is active.
    """
    try:
        system_msg = next(
            (m["content"] for m in messages if m.get("role") == "system"), None
        )
        non_system = [m for m in messages if m.get("role") != "system"]

        user_prompt = non_system[-1]["content"] if non_system else ""
        history = _convert_history(non_system[:-1]) if len(non_system) > 1 else []

        # Attach the selected OpenCode session directly to this voice turn so the
        # spoken request is explicitly tied to the session the user is managing.
        if selected_session_id:
            user_prompt = (
                f"[Active OpenCode session: {selected_session_id}]\n{user_prompt}"
            )

        instructions = system_msg
        if selected_session_id:
            instructions = (
                f"{system_msg}\n\n"
                f"The user has selected OpenCode session '{selected_session_id}' for you to "
                f"manage. Prefer targeting this session when sending messages or summarizing "
                f"unless the user names a different one."
            )
        else:
            instructions = (
                f"{system_msg}\n\n"
                f"No OpenCode session is currently selected. If the user asks you to manage or "
                f"message a session, create one or ask them to select one in the UI."
            )

        log_stage(
            logging.INFO,
            "llm.call",
            "Calling LLM | prompt=%r | history_msgs=%d | selected_session=%s",
            user_prompt[:200],
            len(history),
            selected_session_id,
        )

        # Proactively recall relevant long-term memory and feed it to the model.
        recalled = await recall_memory_context(user_prompt)
        recall_block = ""
        if recalled:
            recall_lines = []
            for item in recalled:
                title = item.get("title") or ""
                content = item.get("content") or ""
                recall_lines.append(f"- {title}: {content}".strip())
            recall_block = (
                "\n\nRelevant memories about the user (use if helpful):\n"
                + "\n".join(recall_lines[:5])
            )
            try:
                await websocket.send_json(
                    {
                        "type": "memory_recall",
                        "count": len(recalled),
                        "memories": [
                            {
                                "title": m.get("title", ""),
                                "content": m.get("content", ""),
                            }
                            for m in recalled[:5]
                        ],
                    }
                )
            except Exception:
                pass

        llm_start = time.perf_counter()

        result = await agent.run(
            user_prompt=user_prompt + recall_block,
            message_history=history,
            instructions=instructions,
            deps=websocket,
        )

        llm_elapsed = time.perf_counter() - llm_start
        response_text = result.output.strip() if result.output else ""
        if not response_text:
            log_stage(
                logging.WARNING,
                "llm.call",
                "LLM returned empty response (%.2fs)",
                llm_elapsed,
            )
            return "I do not have a response for that yet."

        log_stage(
            logging.INFO,
            "llm.call",
            "LLM responded | chars=%d | elapsed=%.2fs | text=%r",
            len(response_text),
            llm_elapsed,
            response_text[:200],
        )
        return response_text

    except Exception as e:
        llm_elapsed = time.perf_counter() - llm_start
        log_stage(
            logging.ERROR,
            "llm.call",
            "LLM error after %.2fs: %s",
            llm_elapsed,
            e,
            exc_info=True,
        )
        return "I'm sorry, I'm having trouble processing that query on my local brain right now."


# TTS
def synthesize_audio(
    text: str, stop_event: threading.Event | None = None
) -> Tuple[bytes, str]:
    # stop if no text
    cleaned = text.strip() or "No speech detected."
    log_stage(logging.INFO, "tts.input", "text=%r", cleaned[:50])
    start_time = time.perf_counter()

    try:
        pcm_chunks = []
        for chunk in PIPER_VOICE.synthesize(cleaned):
            if stop_event and stop_event.is_set():
                log_stage(
                    logging.INFO,
                    "tts.interrupt",
                    "TTS interrupted before completion; discarding generated audio",
                )
                return build_silence_wav(), "audio/wav"
            pcm_chunks.append(chunk.audio_int16_bytes)

        if stop_event and stop_event.is_set():
            log_stage(
                logging.INFO,
                "tts.interrupt",
                "TTS interrupted after synthesis; discarding generated audio",
            )
            return build_silence_wav(), "audio/wav"

        pcm_bytes = b"".join(pcm_chunks)
        # Wrap PCM in WAV (Piper default is 22050 Hz)
        audio_bytes = pcm16_to_wav_bytes(pcm_bytes, sample_rate=22050, channels=1)
        elapsed = time.perf_counter() - start_time
        log_stage(logging.INFO, "tts.complete", "elapsed=%.2fs", elapsed)
        return audio_bytes, "audio/wav"
    except Exception as e:
        log_stage(logging.ERROR, "tts.error", "TTS failed: %s", e, exc_info=True)
        return build_silence_wav(), "audio/wav"


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Manages full-duplex communication over WebSockets for voice recording, transcription, and feedback."""
    client_host = websocket.client.host if websocket.client else "unknown"
    client_port = websocket.client.port if websocket.client else "unknown"
    session_id = uuid.uuid4().hex[:8]

    await websocket.accept()

    turn = TurnBuffer()
    session_history = [{"role": "system", "content": SYSTEM_PROMPT}]
    websocket.selected_session_id = None
    current_turn_task: asyncio.Task | None = None
    current_turn_interrupt: threading.Event | None = None

    async def process_voice_turn(pcm_bytes: bytes, sample_rate: int) -> None:
        nonlocal current_turn_interrupt
        current_turn_interrupt = threading.Event()

        try:
            try:
                log_stage(
                    logging.INFO,
                    "ws.audio.prepare",
                    "Packaging %d PCM bytes into WAV",
                    len(pcm_bytes),
                    session_id=session_id,
                )
                wav_bytes = pcm16_to_wav_bytes(pcm_bytes, sample_rate=sample_rate)
            except Exception as err:
                log_stage(
                    logging.ERROR,
                    "ws.audio.prepare",
                    "Failed to package PCM data into WAV: %s",
                    err,
                    session_id=session_id,
                    exc_info=True,
                )
                await websocket.send_json(
                    {
                        "type": "error",
                        "phase": "idle",
                        "message": "Audio preparation failed.",
                    }
                )
                return

            if current_turn_interrupt.is_set():
                await websocket.send_json(
                    {
                        "type": "status",
                        "phase": "idle",
                        "message": "Interrupted. Ready for the next turn.",
                    }
                )
                return

            await websocket.send_json(
                {
                    "type": "status",
                    "phase": "transcribing",
                    "message": "Transcribing your audio...",
                }
            )
            log_stage(
                logging.INFO,
                "ws.stage",
                "Running STT transcription asynchronously",
                session_id=session_id,
            )
            transcript = await asyncio.to_thread(transcribe_audio, wav_bytes)

            if current_turn_interrupt.is_set():
                log_stage(
                    logging.INFO,
                    "ws.interrupt",
                    "Interrupt detected after STT, skipping remaining steps",
                    session_id=session_id,
                )
                await websocket.send_json(
                    {
                        "type": "status",
                        "phase": "idle",
                        "message": "Interrupted. Ready for the next turn.",
                    }
                )
                return

            log_stage(
                logging.INFO,
                "ws.stage",
                "STT transcription complete with transcript=%r",
                transcript,
                session_id=session_id,
            )

            if transcript in {
                "No audio data received.",
                "I could not detect speech.",
                "STT failed.",
            } or transcript.startswith("STT failed:"):
                await websocket.send_json(
                    {
                        "type": "error",
                        "phase": "idle",
                        "message": transcript,
                    }
                )
                return

            await websocket.send_json({"type": "transcript", "text": transcript})
            log_stage(
                logging.DEBUG,
                "ws.transcript",
                "Sent transcript to client: %r",
                transcript,
                session_id=session_id,
            )

            append_history(session_history, "user", transcript)
            log_stage(
                logging.DEBUG,
                "ws.history",
                "Appended user transcript to session history (messages=%d)",
                len(session_history),
                session_id=session_id,
            )

            await websocket.send_json(
                {
                    "type": "status",
                    "phase": "thinking",
                    "message": "Thinking...",
                }
            )
            log_stage(
                logging.INFO,
                "ws.stage",
                "Running Ollama response generation asynchronously",
                session_id=session_id,
            )
            llm_response = await generate_llm_response(
                session_history, websocket, websocket.selected_session_id
            )

            if current_turn_interrupt.is_set():
                log_stage(
                    logging.INFO,
                    "ws.interrupt",
                    "Interrupt detected after LLM, skipping TTS",
                    session_id=session_id,
                )
                await websocket.send_json(
                    {
                        "type": "status",
                        "phase": "idle",
                        "message": "Interrupted. Ready for the next turn.",
                    }
                )
                return

            log_stage(
                logging.INFO,
                "ws.stage",
                "Ollama response generation complete with response=%r",
                llm_response,
                session_id=session_id,
            )

            append_history(session_history, "assistant", llm_response)
            log_stage(
                logging.DEBUG,
                "ws.history",
                "Appended assistant response to session history (messages=%d)",
                len(session_history),
                session_id=session_id,
            )

            await websocket.send_json(
                {
                    "type": "status",
                    "phase": "speaking",
                    "message": "Speaking the reply...",
                }
            )
            log_stage(
                logging.INFO,
                "ws.stage",
                "Running TTS synthesis asynchronously",
                session_id=session_id,
            )
            audio_bytes, audio_mime = await asyncio.to_thread(
                synthesize_audio, llm_response, current_turn_interrupt
            )

            if current_turn_interrupt.is_set():
                log_stage(
                    logging.INFO,
                    "ws.interrupt",
                    "Interrupt detected after TTS, skipping audio send",
                    session_id=session_id,
                )
                await websocket.send_json(
                    {
                        "type": "status",
                        "phase": "idle",
                        "message": "Interrupted. Ready for the next turn.",
                    }
                )
                return

            log_stage(
                logging.INFO,
                "ws.stage",
                "TTS synthesis completed with %d bytes mime=%s",
                len(audio_bytes),
                audio_mime,
                session_id=session_id,
            )

            await websocket.send_json(
                {"type": "audio", "mime": audio_mime, "text": llm_response}
            )
            await websocket.send_bytes(audio_bytes)
            log_stage(
                logging.INFO,
                "ws.complete",
                "Voice-to-voice turn complete and response audio sent successfully",
                session_id=session_id,
            )
            await websocket.send_json(
                {
                    "type": "status",
                    "phase": "idle",
                    "message": "Ready for the next turn.",
                }
            )
        except asyncio.CancelledError:
            log_stage(
                logging.INFO,
                "ws.interrupt",
                "Voice turn task cancelled",
                session_id=session_id,
            )
            raise
        except Exception as exc:
            log_stage(
                logging.ERROR,
                "ws.turn",
                "Unhandled error while processing a voice turn: %s",
                exc,
                session_id=session_id,
                exc_info=True,
            )
            try:
                await websocket.send_json(
                    {
                        "type": "error",
                        "phase": "idle",
                        "message": "Voice turn failed.",
                    }
                )
            except Exception:
                pass
        finally:
            current_turn_interrupt = None

    try:
        await websocket.send_json(
            {
                "type": "ready",
                "phase": "idle",
                "message": "Connected. Hold the button and speak.",
            }
        )
    except Exception:
        log_stage(
            logging.ERROR,
            "ws.ready",
            "Failed to send ready message to %s:%s",
            client_host,
            client_port,
            session_id=session_id,
            exc_info=True,
        )
        return

    try:
        while True:
            message = await websocket.receive()

            # Process incoming binary audio frames
            if message.get("bytes") is not None:
                audio_chunk = message["bytes"]
                turn.append(audio_chunk)
                continue

            # Process incoming control messages
            text_data = message.get("text")
            if not text_data:
                continue

            try:
                payload = json.loads(text_data)
            except json.JSONDecodeError as err:
                log_stage(
                    logging.ERROR,
                    "ws.receive",
                    "Unable to parse JSON payload=%r error=%s",
                    text_data,
                    err,
                    session_id=session_id,
                )
                continue

            event_type = payload.get("type")
            log_stage(
                logging.INFO,
                "ws.event",
                "Received event type=%r payload=%r from %s:%s",
                event_type,
                payload,
                client_host,
                client_port,
                session_id=session_id,
            )

            if event_type == "start":
                sample_rate = safe_sample_rate(
                    payload.get("sampleRate"), DEFAULT_SAMPLE_RATE
                )
                turn.reset(sample_rate=sample_rate)
                log_stage(
                    logging.INFO,
                    "ws.audio.start",
                    "Recording initialized by client %s:%s with sample_rate=%d Hz",
                    client_host,
                    client_port,
                    turn.sample_rate,
                    session_id=session_id,
                )
                await websocket.send_json(
                    {
                        "type": "status",
                        "phase": "recording",
                        "sampleRate": turn.sample_rate,
                        "message": f"Recording at {turn.sample_rate} Hz.",
                    }
                )
                log_stage(
                    logging.DEBUG,
                    "ws.audio.start",
                    "Sent recording status message for sample_rate=%d Hz",
                    turn.sample_rate,
                    session_id=session_id,
                )

            elif event_type == "end":
                log_stage(
                    logging.INFO,
                    "ws.audio.end",
                    "Recording finished by client %s:%s; starting processing cascade",
                    client_host,
                    client_port,
                    session_id=session_id,
                )
                pcm_bytes = turn.finish()

                if not pcm_bytes:
                    log_stage(
                        logging.WARNING,
                        "ws.audio.end",
                        "Client ended recording but TurnBuffer contained 0 audio bytes",
                        session_id=session_id,
                    )
                    await websocket.send_json(
                        {
                            "type": "error",
                            "phase": "idle",
                            "message": "No audio received.",
                        }
                    )
                    continue

                if turn.check_interrupted():
                    log_stage(
                        logging.INFO,
                        "ws.interrupt",
                        "Interrupt detected before processing started; skipping turn",
                        session_id=session_id,
                    )
                    await websocket.send_json(
                        {
                            "type": "status",
                            "phase": "idle",
                            "message": "Interrupted. Ready for the next turn.",
                        }
                    )
                    continue

                if current_turn_task is not None and not current_turn_task.done():
                    log_stage(
                        logging.INFO,
                        "ws.audio.end",
                        "Previous turn task still active; cancelling before starting a new one",
                        session_id=session_id,
                    )
                    if current_turn_interrupt is not None:
                        current_turn_interrupt.set()
                    current_turn_task.cancel()

                current_turn_task = asyncio.create_task(
                    process_voice_turn(pcm_bytes, turn.sample_rate)
                )

            elif event_type == "interrupt":
                log_stage(
                    logging.INFO,
                    "ws.interrupt",
                    "Received interrupt from client %s:%s; cancelling current operation",
                    client_host,
                    client_port,
                    session_id=session_id,
                )
                turn.request_interrupt()
                if current_turn_interrupt is not None:
                    current_turn_interrupt.set()
                if current_turn_task is not None and not current_turn_task.done():
                    current_turn_task.cancel()
                await websocket.send_json(
                    {
                        "type": "status",
                        "phase": "idle",
                        "message": "Interrupted. Ready for the next turn.",
                    }
                )

            elif event_type == "select_session":
                new_selection = payload.get("sessionId")
                websocket.selected_session_id = new_selection
                log_stage(
                    logging.INFO,
                    "ws.select_session",
                    "Client %s:%s selected OpenCode session=%s",
                    client_host,
                    client_port,
                    new_selection,
                    session_id=session_id,
                )
                label = (
                    f"Managing OpenCode session {new_selection[:8]}."
                    if new_selection
                    else "No OpenCode session selected."
                )
                await websocket.send_json(
                    {
                        "type": "status",
                        "phase": "idle",
                        "message": label,
                    }
                )

            elif event_type == "ping":
                log_stage(
                    logging.DEBUG,
                    "ws.ping",
                    "Received ping from client %s:%s; sending pong",
                    client_host,
                    client_port,
                    session_id=session_id,
                )
                await websocket.send_json({"type": "pong"})

            else:
                log_stage(
                    logging.WARNING,
                    "ws.event",
                    "Received unexpected control message type=%r payload=%r",
                    event_type,
                    payload,
                    session_id=session_id,
                )

    except WebSocketDisconnect:
        log_stage(
            logging.INFO,
            "ws.disconnect",
            "WebSocket connection closed gracefully by client %s:%s",
            client_host,
            client_port,
            session_id=session_id,
        )
    except Exception as e:
        log_stage(
            logging.ERROR,
            "ws.error",
            "Unexpected error inside WebSocket session handler for %s:%s: %s",
            client_host,
            client_port,
            e,
            session_id=session_id,
            exc_info=True,
        )
    finally:
        if current_turn_interrupt is not None:
            current_turn_interrupt.set()
        if current_turn_task is not None and not current_turn_task.done():
            current_turn_task.cancel()
