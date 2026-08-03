"""Shared structured logging helpers."""

import logging

logger = logging.getLogger("speakbro")
logger.setLevel(logging.DEBUG)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
    )
    logger.addHandler(handler)


def log_stage(
    level: int,
    stage: str,
    message: str,
    *args,
    session_id: str | None = None,
    exc_info: bool = False,
) -> None:
    prefix = f"[{session_id}] {stage}" if session_id else stage
    logger.log(level, "%s: " + message, prefix, *args, exc_info=exc_info)
