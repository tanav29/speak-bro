1. Problem/pitch (15s) — "Local-first AI voice assistant that remembers you, runs privately."
2. Live app (main part) — npm run dev, open localhost:5173:

- Hold Space to talk → show STT transcription appear live.
- Release → watch LLM stream a markdown answer + hear Piper TTS speak back.
- Demonstrate memory: ask something personal, then in a new session ask again to prove it's recalled (SuperMemory).
- Show one agent tool: web search (Exa) or current time, or the OpenCode panel doing a coding task.

3. Architecture (20s) — flash the README diagram (privacy: audio never leaves machine; Ollama local LLM).
4. Closing (10s) — restate why it's different (privacy + persistent memory).
