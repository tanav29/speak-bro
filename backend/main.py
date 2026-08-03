import asyncio
import atexit
import io
import os
import json
import logging
import shutil
import signal
import subprocess
import time
import re
import wave
import uuid
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import lru_cache
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Tuple
import httpx

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
import piper

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.messages import ModelRequest, ModelResponse, UserPromptPart, TextPart

from faster_whisper import WhisperModel


from config import (
    CONTAINER_TAGS,
    LLM_MODEL,
    OPENCODE_API_URL,
    OPENCODE_AUTO_START,
    OPENCODE_CORS,
    OPENCODE_HOST,
    OPENCODE_PORT,
    exa_client,
    sm_client,
)
from logging_utils import log_stage, logger
from memory_policy import classify_memory_candidate, clean_memory_text, normalize_memory_text, serialize_memory_item

SYSTEM_PROMPT = """You are SpeakBro — Tanav's voice co-pilot and vibecoding controller.

## Voice style
- Spoken answers only: 1–2 short sentences. No markdown, no bullet dumps, no raw IDs.
- Never speak full session IDs, paths dumps, JSON, or gibberish. Say "the coding session" or "this project".
- Sound confident and fast. Confirm actions briefly, then move on.

## Identity
You control OpenCode coding sessions for Tanav. You are the voice layer; OpenCode is the coding worker.
You receive runtime context each turn: selected project directory and active OpenCode session (if any).

## When to code vs answer
Use OpenCode (tools below) when the user wants to:
- write, edit, refactor, debug, or ship code
- work in a project / repo / codebase
- "vibe code", "build X", "fix this", "add a feature", "open a session"
- continue, check, stop, or steer an existing coding session

Answer yourself (no OpenCode) for:
- chitchat, time, memory, web facts, simple questions
- explaining concepts without changing code

## OpenCode playbook (high performance)
1. Prefer ONE composite call: `run_coding_task` for "build/fix/implement X".
   It ensures the server is up, reuses the selected session (or creates one),
   targets the selected project directory, queues work, and can wait for progress.
2. Prefer the selected session + selected project directory from context. Do not ask for them if present.
3. If no session and the user wants coding work → `run_coding_task` or `create_opencode_session` with a kickoff message.
4. If work is already running → `check_opencode_progress` (status + todos + recent text + diff summary).
5. Follow-ups / steers → `send_opencode_work` (omit session_id to hit the selected session).
6. Stop runaway work → `abort_opencode_session`.
7. Session hygiene → `list_opencode_sessions`, `view_opencode_messages`.
8. Always pass the exact selected project directory when creating sessions.
9. Write kickoff prompts for OpenCode like a senior engineer briefing a coder:
   concrete goal, constraints, files/areas if known, definition of done. Not vague.

## Memory
Relevant memories are auto-recalled — use them silently.
Only save durable long-term facts (preferences, identity, projects, allergies, lasting constraints).
Never save moods, one-off plans, temporary status, or casual chat.

## Tools at a glance
- web_search, search_memories, add_memory, get_current_time
- run_coding_task (preferred for coding asks)
- create_opencode_session, list_opencode_sessions, send_opencode_work
- check_opencode_progress, view_opencode_messages, abort_opencode_session
- select_opencode_session, ensure_opencode_server
"""

agent = Agent(
    LLM_MODEL,
    system_prompt=SYSTEM_PROMPT,
    retries=2,
    deps_type=WebSocket,
)


async def send_memory_event(ctx: RunContext[WebSocket], payload: dict) -> None:
    try:
        await ctx.deps.send_json({"type": "memory_event", **payload})
    except Exception:
        return


_serialize_memory_item = serialize_memory_item


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


# ---------------------------------------------------------------------------
# OpenCode server manager + API helpers
# ---------------------------------------------------------------------------

logger = logging.getLogger("speakbro")
logger.setLevel(logging.DEBUG)
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
    )
    logger.addHandler(_handler)


DEFAULT_SAMPLE_RATE = 16000
MAX_HISTORY_MESSAGES = 12


class OpenCodeServerManager:
    """Keep a local `opencode serve` process healthy for SpeakBro."""

    def __init__(self) -> None:
        self._proc: subprocess.Popen | None = None
        self._lock = asyncio.Lock()
        self._started_by_us = False

    @property
    def base_url(self) -> str:
        return OPENCODE_API_URL

    def _directory_headers(self, directory: str | None) -> dict[str, str]:
        if directory:
            return {"x-opencode-directory": directory}
        return {}

    async def health(self) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/global/health")
                if response.status_code == 200:
                    data = response.json() if response.content else {}
                    return {
                        "ok": True,
                        "version": data.get("version"),
                        "healthy": data.get("healthy", True),
                    }
                return {"ok": False, "status": response.status_code}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def _build_serve_command(self) -> list[str] | None:
        binary = shutil.which("opencode")
        if not binary:
            return None
        cmd = [
            binary,
            "serve",
            "--hostname",
            OPENCODE_HOST,
            "--port",
            str(OPENCODE_PORT),
        ]
        for origin in OPENCODE_CORS:
            cmd.extend(["--cors", origin])
        return cmd

    def _spawn(self) -> tuple[bool, str]:
        if self._proc is not None and self._proc.poll() is None:
            return True, "already running (managed)"

        cmd = self._build_serve_command()
        if not cmd:
            return False, "opencode binary not found on PATH"

        log_stage(logging.INFO, "opencode.server", "Starting: %s", " ".join(cmd))
        creationflags = 0
        if os.name == "nt":
            creationflags = subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]

        try:
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                creationflags=creationflags,
            )
            self._started_by_us = True
            return True, f"spawned pid={self._proc.pid}"
        except Exception as exc:
            self._proc = None
            self._started_by_us = False
            return False, f"spawn failed: {exc}"

    async def ensure(self, force_start: bool = False) -> dict[str, Any]:
        """Return healthy OpenCode server, auto-starting if configured."""
        async with self._lock:
            health = await self.health()
            if health.get("ok"):
                return {
                    "success": True,
                    "running": True,
                    "started": False,
                    "url": self.base_url,
                    "version": health.get("version"),
                }

            if not OPENCODE_AUTO_START and not force_start:
                return {
                    "success": False,
                    "running": False,
                    "error": (
                        f"OpenCode server not reachable at {self.base_url}. "
                        "Set OPENCODE_AUTO_START=true or run `opencode serve`."
                    ),
                }

            ok, detail = await asyncio.to_thread(self._spawn)
            if not ok:
                return {"success": False, "running": False, "error": detail}

            # Wait for health
            deadline = time.perf_counter() + 12.0
            last_err = detail
            while time.perf_counter() < deadline:
                await asyncio.sleep(0.35)
                health = await self.health()
                if health.get("ok"):
                    log_stage(
                        logging.INFO,
                        "opencode.server",
                        "Healthy at %s version=%s",
                        self.base_url,
                        health.get("version"),
                    )
                    return {
                        "success": True,
                        "running": True,
                        "started": True,
                        "url": self.base_url,
                        "version": health.get("version"),
                        "detail": detail,
                    }
                last_err = health.get("error") or health.get("status") or last_err

            return {
                "success": False,
                "running": False,
                "error": f"OpenCode started but not healthy: {last_err}",
                "detail": detail,
            }

    def stop(self) -> None:
        if not self._started_by_us or self._proc is None:
            return
        proc = self._proc
        self._proc = None
        self._started_by_us = False
        try:
            if proc.poll() is None:
                if os.name == "nt":
                    proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                else:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
            log_stage(logging.INFO, "opencode.server", "Stopped managed OpenCode process")
        except Exception as exc:
            log_stage(
                logging.WARNING,
                "opencode.server",
                "Failed stopping OpenCode: %s",
                exc,
            )


opencode_manager = OpenCodeServerManager()
atexit.register(opencode_manager.stop)


def _resolve_session_id(ctx: RunContext[WebSocket], session_id: str | None) -> str | None:
    return session_id or getattr(ctx.deps, "selected_session_id", None)


def _resolve_directory(ctx: RunContext[WebSocket], directory: str | None = None) -> str | None:
    return directory or getattr(ctx.deps, "project_directory", None)


def _text_from_parts(parts: object, max_chars: int = 800) -> str:
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
    joined = "\n".join(texts).strip()
    if len(joined) > max_chars:
        return joined[: max_chars - 1] + "…"
    return joined


def _message_created_at(item: object) -> int:
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


def _status_label(status: object) -> str:
    if status is None:
        return "unknown"
    if isinstance(status, str):
        return status
    if isinstance(status, dict):
        return str(
            status.get("type")
            or status.get("state")
            or status.get("status")
            or "unknown"
        )
    return str(status)


async def _oc_request(
    method: str,
    path: str,
    *,
    directory: str | None = None,
    json_body: dict | None = None,
    params: dict | None = None,
    timeout: float = 15.0,
    expect_json: bool = True,
) -> tuple[bool, Any, str | None]:
    """HTTP helper that ensures server health first."""
    ensured = await opencode_manager.ensure()
    if not ensured.get("success"):
        return False, None, ensured.get("error") or "OpenCode server unavailable"

    url = f"{OPENCODE_API_URL}{path if path.startswith('/') else '/' + path}"
    headers = opencode_manager._directory_headers(directory)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                url,
                headers=headers or None,
                json=json_body,
                params=params,
            )
            if response.status_code == 204:
                return True, None, None
            if response.status_code >= 400:
                body = (response.text or "")[:300]
                return False, None, f"HTTP {response.status_code}: {body}"
            if not expect_json or not response.content:
                return True, None, None
            return True, response.json(), None
    except Exception as exc:
        return False, None, str(exc)


async def _notify_session_selected(ctx: RunContext[WebSocket], session_id: str) -> None:
    ctx.deps.selected_session_id = session_id
    try:
        await ctx.deps.send_json({"type": "opencode_session", "sessionId": session_id})
    except Exception:
        pass


async def _fetch_session_snapshot(
    session_id: str,
    *,
    directory: str | None = None,
    message_limit: int = 4,
) -> dict[str, Any]:
    """Bundle status + todos + recent messages + diff summary for one session."""
    status_ok, status_map, status_err = await _oc_request(
        "GET", "/session/status", directory=directory, timeout=8.0
    )
    status = None
    if status_ok and isinstance(status_map, dict):
        status = status_map.get(session_id)

    todos_ok, todos, _ = await _oc_request(
        "GET", f"/session/{session_id}/todo", directory=directory, timeout=8.0
    )
    msgs_ok, messages, _ = await _oc_request(
        "GET",
        f"/session/{session_id}/message",
        directory=directory,
        params={"limit": message_limit},
        timeout=10.0,
    )
    diff_ok, diffs, _ = await _oc_request(
        "GET", f"/session/{session_id}/diff", directory=directory, timeout=10.0
    )

    recent: list[dict] = []
    if msgs_ok and isinstance(messages, list):
        ordered = sorted(
            (m for m in messages if isinstance(m, dict)),
            key=_message_created_at,
        )[-message_limit:]
        for item in ordered:
            info = item.get("info") if isinstance(item.get("info"), dict) else {}
            recent.append(
                {
                    "role": info.get("role"),
                    "content": _text_from_parts(item.get("parts"), max_chars=500),
                }
            )

    todo_items: list[dict] = []
    if todos_ok and isinstance(todos, list):
        for t in todos[:12]:
            if not isinstance(t, dict):
                continue
            todo_items.append(
                {
                    "content": t.get("content") or t.get("title") or t.get("text") or "",
                    "status": t.get("status") or t.get("state") or "",
                }
            )

    diff_summary = {"files": 0, "additions": 0, "deletions": 0, "paths": []}
    if diff_ok and isinstance(diffs, list):
        paths: list[str] = []
        additions = 0
        deletions = 0
        for d in diffs:
            if not isinstance(d, dict):
                continue
            path = d.get("file") or d.get("path") or d.get("name")
            if path:
                paths.append(str(path))
            additions += int(d.get("additions") or d.get("add") or 0)
            deletions += int(d.get("deletions") or d.get("del") or 0)
        diff_summary = {
            "files": len(paths),
            "additions": additions,
            "deletions": deletions,
            "paths": paths[:15],
        }

    return {
        "session_id": session_id,
        "status": _status_label(status),
        "status_raw": status,
        "todos": todo_items,
        "todo_count": len(todo_items),
        "recent_messages": recent,
        "diff": diff_summary,
        "status_error": status_err if not status_ok else None,
    }


async def _queue_prompt(
    session_id: str,
    message: str,
    *,
    directory: str | None = None,
) -> tuple[bool, str | None]:
    ok, _, err = await _oc_request(
        "POST",
        f"/session/{session_id}/prompt_async",
        directory=directory,
        json_body={"parts": [{"type": "text", "text": message}]},
        timeout=20.0,
        expect_json=False,
    )
    return ok, err


@agent.tool(strict=False)
async def ensure_opencode_server(ctx: RunContext[WebSocket]) -> str:
    """Make sure the OpenCode HTTP server is running (auto-starts `opencode serve` if needed).

    Call this only if another OpenCode tool failed with a connection error, or if the user
    explicitly asks you to start OpenCode. Most coding tools already call this internally.
    """
    log_stage(logging.INFO, "tool.ensure_opencode_server", "called")
    result = await opencode_manager.ensure(force_start=True)
    return json.dumps(result)


@agent.tool(strict=False)
async def run_coding_task(
    ctx: RunContext[WebSocket],
    task: str,
    title: str | None = None,
    session_id: str | None = None,
    directory: str | None = None,
    wait_for_progress: bool = True,
    wait_seconds: float = 8.0,
) -> str:
    """PRIMARY coding tool. Hand a full coding job to OpenCode in one call.

    Use this whenever the user wants to build, fix, refactor, implement, or vibe-code something.
    It will: (1) ensure OpenCode server is up, (2) reuse the selected/active session or create
    a new one in the selected project directory, (3) queue a clear engineering prompt, and
    (4) optionally wait briefly and return status/todos/recent output.

    Prefer this over create+send separately. Write `task` as a concrete brief for a coding agent.
    Omit session_id to use the UI-selected session. Omit directory to use the UI-selected project.
    """
    selected_dir = _resolve_directory(ctx, directory)
    selected = _resolve_session_id(ctx, session_id)
    start = time.perf_counter()
    log_stage(
        logging.INFO,
        "tool.run_coding_task",
        "session=%s dir=%r task=%r",
        selected,
        selected_dir,
        task[:180],
    )

    ensured = await opencode_manager.ensure()
    if not ensured.get("success"):
        return json.dumps({"success": False, "error": ensured.get("error"), "phase": "server"})

    created = False
    session_title = title or (task.strip().split("\n")[0][:60] or "SpeakBro coding")

    if not selected:
        ok, data, err = await _oc_request(
            "POST",
            "/session",
            directory=selected_dir,
            json_body={"title": session_title},
            timeout=10.0,
        )
        if not ok or not isinstance(data, dict) or not data.get("id"):
            return json.dumps(
                {"success": False, "error": err or "Failed to create session", "phase": "create"}
            )
        selected = data["id"]
        created = True
        await _notify_session_selected(ctx, selected)

    # Brief OpenCode like a senior engineer, not like casual voice chat.
    kickoff = (
        "You are the coding agent for this project. Execute the following request fully.\n"
        "Be concrete: inspect the repo, make the changes, run checks if appropriate, and "
        "leave the workspace in a working state.\n\n"
        f"REQUEST:\n{task.strip()}"
    )
    if selected_dir:
        kickoff = f"Project directory: {selected_dir}\n\n{kickoff}"

    queued_ok, queue_err = await _queue_prompt(selected, kickoff, directory=selected_dir)
    if not queued_ok:
        return json.dumps(
            {
                "success": False,
                "error": queue_err or "Failed to queue task",
                "session_id": selected,
                "created": created,
                "phase": "queue",
            }
        )

    progress = None
    if wait_for_progress and wait_seconds > 0:
        await asyncio.sleep(min(max(wait_seconds, 1.0), 25.0))
        progress = await _fetch_session_snapshot(selected, directory=selected_dir)

    elapsed = time.perf_counter() - start
    log_stage(
        logging.INFO,
        "tool.run_coding_task",
        "done session=%s created=%s elapsed=%.2fs",
        selected,
        created,
        elapsed,
    )
    return json.dumps(
        {
            "success": True,
            "session_id": selected,
            "created": created,
            "directory": selected_dir,
            "queued": True,
            "title": session_title,
            "progress": progress,
            "elapsed_seconds": round(elapsed, 2),
            "speak_hint": (
                "Tell the user work is running in OpenCode. "
                "Mention progress todos or file changes if present. No raw IDs."
            ),
        }
    )


@agent.tool(strict=False)
async def create_opencode_session(
    ctx: RunContext[WebSocket],
    title: str = "SpeakBro session",
    message: str | None = None,
    directory: str | None = None,
) -> str:
    """Create a new OpenCode coding session, optionally kick off work with `message`.

    Prefer `run_coding_task` for most coding asks. Use this when you only need a fresh session
    shell, or the user explicitly wants a new session. Always pass the selected project
    directory when the UI has one.
    """
    selected_directory = _resolve_directory(ctx, directory)
    log_stage(
        logging.INFO,
        "tool.create_opencode_session",
        "title=%r directory=%r",
        title,
        selected_directory,
    )
    start = time.perf_counter()

    ok, data, err = await _oc_request(
        "POST",
        "/session",
        directory=selected_directory,
        json_body={"title": title},
        timeout=10.0,
    )
    if not ok or not isinstance(data, dict) or not data.get("id"):
        return json.dumps({"success": False, "error": err or "Failed to create OpenCode session"})

    session_id = data["id"]
    await _notify_session_selected(ctx, session_id)

    queued = False
    queue_error = None
    if message:
        queued, queue_error = await _queue_prompt(
            session_id, message, directory=selected_directory
        )

    elapsed = time.perf_counter() - start
    log_stage(
        logging.INFO,
        "tool.create_opencode_session",
        "session_id=%s queued=%s elapsed=%.2fs",
        session_id,
        queued,
        elapsed,
    )
    return json.dumps(
        {
            "success": True,
            "session_id": session_id,
            "title": data.get("title", title),
            "directory": selected_directory,
            "queued": queued,
            "queue_error": queue_error,
        }
    )


@agent.tool(strict=False)
async def list_opencode_sessions(ctx: RunContext[WebSocket]) -> str:
    """List OpenCode sessions with titles, directories, and live status.

    Use to discover sessions, pick one, or tell the user what coding work is active.
    """
    log_stage(logging.INFO, "tool.list_opencode_sessions", "called")
    directory = _resolve_directory(ctx)
    ok, sessions, err = await _oc_request("GET", "/session", directory=directory, timeout=8.0)
    if not ok:
        return json.dumps({"success": False, "error": err})

    status_ok, status_map, _ = await _oc_request(
        "GET", "/session/status", directory=directory, timeout=8.0
    )
    statuses = status_map if status_ok and isinstance(status_map, dict) else {}

    selected = getattr(ctx.deps, "selected_session_id", None)
    summaries = []
    if isinstance(sessions, list):
        for s in sessions:
            if not isinstance(s, dict):
                continue
            sid = s.get("id")
            summaries.append(
                {
                    "id": sid,
                    "title": s.get("title", "Untitled"),
                    "directory": s.get("directory"),
                    "status": _status_label(statuses.get(sid)) if sid else "unknown",
                    "selected": sid == selected,
                    "updated": (s.get("time") or {}).get("updated")
                    if isinstance(s.get("time"), dict)
                    else None,
                }
            )

    return json.dumps(
        {
            "success": True,
            "sessions": summaries,
            "count": len(summaries),
            "selected_session_id": selected,
            "project_directory": directory,
        }
    )


@agent.tool(strict=False)
async def select_opencode_session(
    ctx: RunContext[WebSocket],
    session_id: str,
) -> str:
    """Set the active OpenCode session SpeakBro will control (same as UI selection).

    Use after listing sessions when the user names one, or when switching workstreams.
    """
    if not session_id or not str(session_id).strip():
        return json.dumps({"success": False, "error": "session_id is required"})

    ok, data, err = await _oc_request("GET", f"/session/{session_id}", timeout=8.0)
    if not ok:
        return json.dumps({"success": False, "error": err or "Session not found"})

    await _notify_session_selected(ctx, session_id)
    title = data.get("title") if isinstance(data, dict) else None
    log_stage(logging.INFO, "tool.select_opencode_session", "session_id=%s", session_id)
    return json.dumps(
        {
            "success": True,
            "session_id": session_id,
            "title": title,
            "selected": True,
        }
    )


@agent.tool(strict=False)
async def send_opencode_work(
    ctx: RunContext[WebSocket],
    message: str,
    session_id: str | None = None,
) -> str:
    """Send a follow-up instruction or steer to an existing OpenCode session (async).

    Use for "also do X", "stop doing Y, do Z instead", "add tests", etc.
    Prefer `run_coding_task` for brand-new jobs. Omit session_id to use the selected session.
    """
    selected = _resolve_session_id(ctx, session_id)
    if not selected:
        return json.dumps(
            {
                "success": False,
                "error": (
                    "No session selected. Call run_coding_task / create_opencode_session, "
                    "or ask the user to select one."
                ),
            }
        )

    directory = _resolve_directory(ctx)
    log_stage(
        logging.INFO,
        "tool.send_opencode_work",
        "session_id=%s message=%r",
        selected,
        message[:200],
    )
    ok, err = await _queue_prompt(selected, message, directory=directory)
    if not ok:
        return json.dumps({"success": False, "error": err, "session_id": selected})
    return json.dumps({"success": True, "session_id": selected, "queued": True})


# Backwards-compatible alias name for any old prompt references
add_message_to_opencode_session = send_opencode_work


@agent.tool(strict=False)
async def check_opencode_progress(
    ctx: RunContext[WebSocket],
    session_id: str | None = None,
) -> str:
    """Get live OpenCode progress: status, todos, recent messages, and file diff summary.

    Use when the user asks "how's it going", "what did it do", "is it done", or before
    deciding to send more work / abort. Prefer this over raw message dumps.
    """
    selected = _resolve_session_id(ctx, session_id)
    if not selected:
        return json.dumps(
            {
                "success": False,
                "error": "No session selected. List sessions or create one first.",
            }
        )

    directory = _resolve_directory(ctx)
    log_stage(logging.INFO, "tool.check_opencode_progress", "session_id=%s", selected)
    snapshot = await _fetch_session_snapshot(selected, directory=directory)
    snapshot["success"] = True
    snapshot["speak_hint"] = (
        "Summarize status, open todos, and key file changes in one short spoken sentence."
    )
    return json.dumps(snapshot)


@agent.tool(strict=False)
async def view_opencode_messages(
    ctx: RunContext[WebSocket],
    session_id: str | None = None,
    limit: int = 6,
) -> str:
    """Read recent text messages from an OpenCode session.

    Use for detailed recall of what was said/done. For a quick spoken status update,
    prefer check_opencode_progress.
    """
    selected = _resolve_session_id(ctx, session_id)
    if not selected:
        return json.dumps(
            {
                "success": False,
                "error": "No session selected. List sessions or create one first.",
            }
        )

    limit = max(1, min(int(limit or 6), 20))
    directory = _resolve_directory(ctx)
    ok, messages, err = await _oc_request(
        "GET",
        f"/session/{selected}/message",
        directory=directory,
        params={"limit": limit},
        timeout=12.0,
    )
    if not ok:
        return json.dumps({"success": False, "error": err, "session_id": selected})

    result = []
    if isinstance(messages, list):
        ordered = sorted(
            (m for m in messages if isinstance(m, dict)),
            key=_message_created_at,
        )[-limit:]
        for item in ordered:
            info = item.get("info") if isinstance(item.get("info"), dict) else {}
            result.append(
                {
                    "id": info.get("id"),
                    "role": info.get("role"),
                    "created": (info.get("time") or {}).get("created")
                    if isinstance(info.get("time"), dict)
                    else None,
                    "content": _text_from_parts(item.get("parts"), max_chars=1000),
                }
            )

    return json.dumps(
        {
            "success": True,
            "session_id": selected,
            "message_count": len(result),
            "messages": result,
        }
    )


@agent.tool(strict=False)
async def summarize_opencode_session(
    ctx: RunContext[WebSocket],
    session_id: str | None = None,
) -> str:
    """Quick view of the last few OpenCode messages (alias of a short view_opencode_messages).

    Prefer check_opencode_progress for spoken status. Keep this for light history peeks.
    """
    return await view_opencode_messages(ctx, session_id=session_id, limit=3)


@agent.tool(strict=False)
async def abort_opencode_session(
    ctx: RunContext[WebSocket],
    session_id: str | None = None,
) -> str:
    """Abort the currently running OpenCode generation for a session.

    Use when the user says stop, cancel, abort, or the agent is stuck doing the wrong thing.
    """
    selected = _resolve_session_id(ctx, session_id)
    if not selected:
        return json.dumps(
            {
                "success": False,
                "error": "No session selected to abort.",
            }
        )

    directory = _resolve_directory(ctx)
    log_stage(logging.INFO, "tool.abort_opencode_session", "session_id=%s", selected)
    ok, data, err = await _oc_request(
        "POST",
        f"/session/{selected}/abort",
        directory=directory,
        timeout=10.0,
        expect_json=True,
    )
    if not ok:
        return json.dumps({"success": False, "error": err, "session_id": selected})
    return json.dumps({"success": True, "session_id": selected, "aborted": True, "result": data})


def safe_positive_int(value: object, default: int) -> int:
    """Parse a positive integer configuration value with a fallback default."""

    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def safe_sample_rate(value: object, default: int = DEFAULT_SAMPLE_RATE) -> int:
    return safe_positive_int(value, default)


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Boot OpenCode automatically so coding tools work without a manual serve step."""
    if OPENCODE_AUTO_START:
        result = await opencode_manager.ensure()
        if result.get("success"):
            log_stage(
                logging.INFO,
                "startup",
                "OpenCode ready at %s (started=%s version=%s)",
                result.get("url"),
                result.get("started"),
                result.get("version"),
            )
        else:
            log_stage(
                logging.WARNING,
                "startup",
                "OpenCode not available yet: %s",
                result.get("error"),
            )
    else:
        log_stage(
            logging.INFO,
            "startup",
            "OPENCODE_AUTO_START disabled; expecting server at %s",
            OPENCODE_API_URL,
        )
    try:
        yield
    finally:
        opencode_manager.stop()


app = FastAPI(title="SpeakBro", lifespan=lifespan)
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
async def healthz() -> dict:
    oc = await opencode_manager.health()
    return {
        "status": "ok",
        "opencode": {
            "url": OPENCODE_API_URL,
            "ok": bool(oc.get("ok")),
            "version": oc.get("version"),
            "auto_start": OPENCODE_AUTO_START,
        },
    }


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

        project_directory = getattr(websocket, "project_directory", None)
        # Compact controller context — keep spoken turns clean, give tools what they need.
        context_bits: list[str] = []
        if selected_session_id:
            context_bits.append(f"active_opencode_session={selected_session_id}")
        else:
            context_bits.append("active_opencode_session=none")
        if project_directory:
            context_bits.append(f"project_directory={project_directory}")
        else:
            context_bits.append("project_directory=none")
        user_prompt = (
            f"[controller_context {' | '.join(context_bits)}]\n{user_prompt}"
        )

        instructions = system_msg or SYSTEM_PROMPT
        controller_notes = [
            "You are the vibecoding controller for this turn.",
            "Omit session_id / directory on tools to use the active values from controller_context.",
            "For coding work prefer run_coding_task in a single tool call.",
            "Never speak raw session IDs or dump JSON to the user.",
        ]
        if selected_session_id:
            controller_notes.append(
                f"Active OpenCode session is selected — default all session tools to it "
                f"unless the user names another."
            )
        else:
            controller_notes.append(
                "No OpenCode session selected — create one via run_coding_task when coding is needed."
            )
        if project_directory:
            controller_notes.append(
                f"Selected project directory is '{project_directory}'. "
                "Always pass this exact path when creating sessions or running coding tasks."
            )
        else:
            controller_notes.append(
                "No project directory selected — coding still works, but prefer asking the user "
                "to pick a Project folder for repo-local work when it matters."
            )
        instructions = f"{instructions}\n\n## Live controller state\n" + "\n".join(
            f"- {note}" for note in controller_notes
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


def choose_project_directory_native() -> str:
    """Open a native folder picker and return the absolute local path."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        directory = filedialog.askdirectory(title="Choose OpenCode project directory")
        root.destroy()
        return directory or ""
    except Exception as exc:
        log_stage(logging.WARNING, "project.directory", "Native picker failed: %s", exc)
        return ""


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
    websocket.project_directory = None
    current_turn_task: asyncio.Task | None = None
    current_turn_interrupt: threading.Event | None = None

    async def send_status(message: str, phase: str = "idle", **extra: Any) -> None:
        """Send one consistent status event to the browser."""
        await websocket.send_json(
            {"type": "status", "phase": phase, "message": message, **extra}
        )

    def cancel_active_turn() -> None:
        """Stop the active voice/text pipeline, if one exists."""
        if current_turn_interrupt is not None:
            current_turn_interrupt.set()
        if current_turn_task is not None and not current_turn_task.done():
            current_turn_task.cancel()

    async def set_project_directory(directory: str | None) -> None:
        """Update the connection-scoped project and notify the browser."""
        normalized = (directory or "").strip()
        websocket.project_directory = normalized or None
        await websocket.send_json(
            {"type": "project_directory", "directory": normalized}
        )
        await send_status(
            f"Project directory set to {normalized}."
            if normalized
            else "No project directory selected."
        )

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

    async def process_text_turn(text: str) -> None:
        """Run a typed message through the same agent pipeline as voice input."""
        nonlocal current_turn_interrupt
        current_turn_interrupt = threading.Event()
        try:
            await websocket.send_json({"type": "transcript", "text": text})
            append_history(session_history, "user", text)
            await websocket.send_json({"type": "status", "phase": "thinking", "message": "Thinking..."})
            response = await generate_llm_response(session_history, websocket, websocket.selected_session_id)
            if current_turn_interrupt.is_set():
                return
            append_history(session_history, "assistant", response)
            await websocket.send_json({"type": "status", "phase": "speaking", "message": "Speaking the reply..."})
            audio_bytes, audio_mime = await asyncio.to_thread(synthesize_audio, response, current_turn_interrupt)
            if current_turn_interrupt.is_set():
                return
            await websocket.send_json({"type": "audio", "mime": audio_mime, "text": response})
            await websocket.send_bytes(audio_bytes)
            await websocket.send_json({"type": "status", "phase": "idle", "message": "Ready for the next turn."})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log_stage(logging.ERROR, "ws.text", "Typed turn failed: %s", exc, session_id=session_id, exc_info=True)
            await websocket.send_json({"type": "error", "phase": "idle", "message": "Text turn failed."})
        finally:
            current_turn_interrupt = None

    try:
        await websocket.send_json(
            {
                "type": "ready",
                "phase": "idle",
                "message": "Connected. Type a message or use the microphone.",
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

            if event_type == "text":
                text = str(payload.get("text", "")).strip()
                if text:
                    cancel_active_turn()
                    current_turn_task = asyncio.create_task(process_text_turn(text))

            elif event_type == "start":
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
                await send_status(
                    f"Recording at {turn.sample_rate} Hz.",
                    phase="recording",
                    sampleRate=turn.sample_rate,
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
                    cancel_active_turn()

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
                cancel_active_turn()
                await send_status("Interrupted. Ready for the next turn.")

            elif event_type == "clear_session":
                cancel_active_turn()
                session_history[:] = [{"role": "system", "content": SYSTEM_PROMPT}]
                turn.finish()
                await send_status("Session cleared. Ready for the next turn.")

            elif event_type == "choose_project_directory":
                directory = await asyncio.to_thread(choose_project_directory_native)
                await set_project_directory(directory)

            elif event_type == "set_project_directory":
                await set_project_directory(str(payload.get("directory", "")))

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
