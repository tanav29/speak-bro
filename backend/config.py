"""Application configuration and external client construction."""

import os
from urllib.parse import urlparse

import supermemory
from dotenv import load_dotenv
from exa_py import Exa
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

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

OPENCODE_API_URL = os.getenv("OPENCODE_API_URL").rstrip("/")
# SpeakBro connects to an externally managed OpenCode server (for example, a sandbox).
# Set true only if you explicitly want the backend to spawn a local server.
OPENCODE_AUTO_START = os.getenv("OPENCODE_AUTO_START", "false").lower() in {
    "1",
    "true",
    "yes",
    "on",
}
OPENCODE_CORS = [
    origin.strip()
    for origin in os.getenv(
        "OPENCODE_CORS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000",
    ).split(",")
    if origin.strip()
]
_parsed_opencode_url = urlparse(OPENCODE_API_URL)
OPENCODE_HOST = _parsed_opencode_url.hostname or "127.0.0.1"
OPENCODE_PORT = _parsed_opencode_url.port or 4096
