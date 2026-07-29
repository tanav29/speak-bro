import { useState, useRef, useCallback, useEffect } from "react";
import { Streamdown } from "streamdown";
import { OpenCodePanel } from "./OpenCodePanel";
import { MemoryPanel } from "./MemoryPanel";
import { fetchMemories } from "./memoryApi";
import {
  fetchSnapshot,
  createSession,
  deleteSession,
  opencodeUrl,
} from "./opencodeApi";

const TARGET_SAMPLE_RATE = 16000;
const MAX_TRANSCRIPTS = 12;
const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 5000;

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

function downsampleBuffer(inputBuffer, inputRate, outputRate) {
  if (outputRate === inputRate) return inputBuffer;
  if (outputRate > inputRate)
    throw new Error("outputRate must be <= inputRate");

  const ratio = inputRate / outputRate;
  const newLength = Math.round(inputBuffer.length / ratio);
  const result = new Float32Array(newLength);
  let resultOffset = 0;
  let bufferOffset = 0;

  while (resultOffset < result.length) {
    const nextBufferOffset = Math.round((resultOffset + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (
      let i = bufferOffset;
      i < nextBufferOffset && i < inputBuffer.length;
      i++
    ) {
      accum += inputBuffer[i];
      count++;
    }
    result[resultOffset] = count ? accum / count : 0;
    resultOffset++;
    bufferOffset = nextBufferOffset;
  }
  return result;
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const sample = Math.max(-1, Math.min(1, input[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

const PHASE_LABELS = {
  idle: "Hold to talk",
  listening: "Listening...",
  sending: "Sending...",
  thinking: "Thinking...",
  speaking: "Tap to interrupt",
  error: "Error",
  "requesting-mic": "Requesting mic...",
  transcribing: "Transcribing...",
  recording: "Recording...",
  transcribed: "Got it",
};

export default function App() {
  const [connectionState, setConnectionState] = useState("Disconnected");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Waiting for connection.");
  const [phase, setPhase] = useState("idle");
  const [chat, setChat] = useState([]);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [opencodeSnapshot, setOpencodeSnapshot] = useState(null);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [micError, setMicError] = useState(null);
  const [memoryEvents, setMemoryEvents] = useState([]);
  const [memoryRecords, setMemoryRecords] = useState([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState(null);
  const [talkMode, setTalkMode] = useState("hold"); // "hold" | "tap"
  const [activeTab, setActiveTab] = useState("orchestration"); // "orchestration" | "memory"
  const [textInput, setTextInput] = useState("");

  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const processorNodeRef = useRef(null);
  const monitorNodeRef = useRef(null);
  const playbackAudioRef = useRef(null);
  const isRecordingRef = useRef(false);
  const isHoldingRef = useRef(false);
  const pendingAudioMimeRef = useRef("audio/wav");
  const reconnectTimerRef = useRef(null);
  const reconnectDelayRef = useRef(RECONNECT_BASE_MS);
  const shouldReconnectRef = useRef(true);
  const startRecordingRef = useRef(null);
  const chatEndRef = useRef(null);
  const hasConnectedRef = useRef(false);
  const selectedSessionIdRef = useRef(null);

  const sendSelectedSession = useCallback((sessionId) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({ type: "select_session", sessionId }),
      );
    }
  }, []);

  const syncOpenCodeSnapshot = useCallback(async () => {
    try {
      const data = await fetchSnapshot();
      setOpencodeSnapshot(data);
    } catch (error) {
      setOpencodeSnapshot((prev) => ({
        ...(prev ?? {}),
        connected: false,
        loading: false,
        error: error.message,
      }));
    }
  }, []);

  const syncMemories = useCallback(async () => {
    setMemoryLoading(true);
    try {
      const data = await fetchMemories();
      setMemoryRecords(data.memories);
      setMemoryError(null);
    } catch (error) {
      setMemoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setMemoryLoading(false);
    }
  }, []);

  const selectOpenCodeSession = useCallback(
    (sessionId) => {
      setSelectedSessionId(sessionId);
      selectedSessionIdRef.current = sessionId;
      sendSelectedSession(sessionId);
    },
    [sendSelectedSession],
  );

  const createOpenCodeSession = useCallback(
    async (title) => {
      try {
        await createSession(title);
        await syncOpenCodeSnapshot();
      } catch (error) {
        setOpencodeSnapshot((prev) => ({
          ...(prev ?? {}),
          connected: false,
          loading: false,
          error: error.message,
        }));
      }
    },
    [syncOpenCodeSnapshot],
  );

  const removeOpenCodeSession = useCallback(
    async (id) => {
      try {
        await deleteSession(id);
        await syncOpenCodeSnapshot();
      } catch (error) {
        setOpencodeSnapshot((prev) => ({
          ...(prev ?? {}),
          error: error.message,
        }));
      }
    },
    [syncOpenCodeSnapshot],
  );

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearChatHistory = useCallback(() => {
    setChat([]);
    setStatus("History cleared. Type a message or use the microphone.");
  }, []);

  const sendTextMessage = useCallback(
    (event) => {
      event?.preventDefault();
      const text = textInput.trim();
      if (!text) return;
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        setStatus("Connecting...");
        connectSocket();
        return;
      }
      setTextInput("");
      setStatus("Thinking...");
      setPhase("thinking");
      socketRef.current.send(JSON.stringify({ type: "text", text }));
    },
    [textInput],
  );

  const scheduleReconnect = useCallback(() => {
    clearReconnectTimer();
    if (!shouldReconnectRef.current) return;
    const delay = reconnectDelayRef.current;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectSocket();
    }, delay);
    reconnectDelayRef.current = Math.min(
      reconnectDelayRef.current * 1.6,
      RECONNECT_MAX_MS,
    );
  }, []);

  const resetReconnectBackoff = useCallback(() => {
    clearReconnectTimer();
    reconnectDelayRef.current = RECONNECT_BASE_MS;
  }, []);

  const cleanupPlayback = useCallback(() => {
    if (playbackAudioRef.current) {
      playbackAudioRef.current.pause();
      playbackAudioRef.current.currentTime = 0;
      playbackAudioRef.current = null;
    }
  }, []);

  const appendEntry = useCallback((setter, prefix, text, role = "user") => {
    setter((prev) => {
      const next = [
        { prefix, text, role, id: Date.now() + Math.random(), ts: Date.now() },
        ...prev,
      ];
      return next.slice(0, MAX_TRANSCRIPTS);
    });
  }, []);

  const appendMemoryEvent = useCallback((event) => {
    setMemoryEvents((prev) => {
      const next = [
        { id: `${Date.now()}-${Math.random()}`, ts: Date.now(), ...event },
        ...prev,
      ];
      return next.slice(0, 12);
    });
  }, []);

  const updateMeter = useCallback((input) => {
    const peak = input.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    setVoiceLevel(Math.min(100, Math.round(peak * 140)));
  }, []);

  const stopRecording = useCallback(async (sendEnd = true) => {
    if (!isRecordingRef.current && !sendEnd) return;
    const wasRecording = isRecordingRef.current;
    isRecordingRef.current = false;

    if (
      sendEnd &&
      socketRef.current?.readyState === WebSocket.OPEN &&
      wasRecording
    ) {
      socketRef.current.send(JSON.stringify({ type: "end" }));
      setStatus("Sending...");
      setPhase("sending");
    }

    if (processorNodeRef.current) {
      processorNodeRef.current.disconnect();
      processorNodeRef.current = null;
    }
    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }
    if (monitorNodeRef.current) {
      monitorNodeRef.current.disconnect();
      monitorNodeRef.current = null;
    }
    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    setVoiceLevel(0);
    if (!sendEnd) setPhase("idle");
  }, []);

  const startRecording = useCallback(async () => {
    if (
      !socketRef.current ||
      socketRef.current.readyState !== WebSocket.OPEN ||
      isRecordingRef.current
    )
      return;

    try {
      setMicError(null);
      setStatus("Requesting microphone...");
      setPhase("requesting-mic");

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // If in hold mode and the user released the key/button during the mic request, abort.
      if (talkMode === "hold" && !isHoldingRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        setStatus("Ready. Hold the button and speak.");
        setPhase("idle");
        return;
      }

      const audioContext = new (
        window.AudioContext || window.webkitAudioContext
      )();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      const monitorNode = audioContext.createGain();
      monitorNode.gain.value = 0;

      processorNode.onaudioprocess = (event) => {
        if (
          !isRecordingRef.current ||
          !socketRef.current ||
          socketRef.current.readyState !== WebSocket.OPEN
        )
          return;
        const input = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleBuffer(
          input,
          audioContext.sampleRate,
          TARGET_SAMPLE_RATE,
        );
        const pcm16 = floatTo16BitPCM(downsampled);
        socketRef.current.send(pcm16.buffer);
        updateMeter(input);
      };

      sourceNode.connect(processorNode);
      processorNode.connect(monitorNode);
      monitorNode.connect(audioContext.destination);

      audioContextRef.current = audioContext;
      mediaStreamRef.current = stream;
      sourceNodeRef.current = sourceNode;
      processorNodeRef.current = processorNode;
      monitorNodeRef.current = monitorNode;
      isRecordingRef.current = true;

      setPhase("listening");
      setStatus("Listening...");

      socketRef.current.send(
        JSON.stringify({ type: "start", sampleRate: TARGET_SAMPLE_RATE }),
      );
    } catch (error) {
      await stopRecording(false);
      const msg = error?.message || "Microphone access was blocked.";
      setMicError(msg);
      setStatus(`Mic error: ${msg}`);
      setPhase("error");
    }
  }, [stopRecording, updateMeter, talkMode]);

  startRecordingRef.current = startRecording;

  const interruptSpeaking = useCallback(() => {
    cleanupPlayback();
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "interrupt" }));
    }
    setStatus("Interrupted. Ready for the next turn.");
    setPhase("idle");
  }, [cleanupPlayback]);

  const handlePointerDown = useCallback(
    (e) => {
      e.preventDefault();

      if (talkMode === "hold") {
        isHoldingRef.current = true;
      }

      if (phase === "speaking") {
        interruptSpeaking();
        if (talkMode === "hold") {
          if (
            typeof e.pointerId === "number" &&
            e.currentTarget.setPointerCapture
          ) {
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* ignore */
            }
          }
          startRecording();
        }
        return;
      }

      if (
        !socketRef.current ||
        socketRef.current.readyState !== WebSocket.OPEN
      ) {
        if (socketRef.current?.readyState === WebSocket.CONNECTING) return;
        setStatus("Connecting...");
        connectSocket();
        return;
      }

      if (talkMode === "tap") {
        if (isRecordingRef.current) {
          stopRecording();
        } else {
          startRecording();
        }
      } else {
        // Hold mode
        if (
          typeof e.pointerId === "number" &&
          e.currentTarget.setPointerCapture
        ) {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }
        startRecording();
      }
    },
    [phase, talkMode, interruptSpeaking, startRecording, stopRecording],
  );

  const handlePointerUp = useCallback(() => {
    if (talkMode === "hold") {
      isHoldingRef.current = false;
      if (isRecordingRef.current) {
        stopRecording();
      }
    }
  }, [talkMode, stopRecording]);

  useEffect(() => {
    const handler = () => {
      if (talkMode === "hold") {
        isHoldingRef.current = false;
      }
      if (isRecordingRef.current) stopRecording();
    };
    window.addEventListener("pointerup", handler);
    window.addEventListener("pointercancel", handler);
    window.addEventListener("blur", handler);
    return () => {
      window.removeEventListener("pointerup", handler);
      window.removeEventListener("pointercancel", handler);
      window.removeEventListener("blur", handler);
    };
  }, [talkMode, stopRecording]);

  useEffect(() => {
    const keyDown = (e) => {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        if (talkMode === "hold") {
          isHoldingRef.current = true;
        }
        if (phase === "speaking") {
          interruptSpeaking();
          if (talkMode === "hold") {
            startRecording();
          }
          return;
        }
        if (talkMode === "tap") {
          if (isRecordingRef.current) {
            stopRecording();
          } else {
            startRecording();
          }
        } else {
          if (!isRecordingRef.current) startRecording();
        }
      }
    };
    const keyUp = (e) => {
      if (e.code === "Space") {
        if (talkMode === "hold") {
          isHoldingRef.current = false;
          if (isRecordingRef.current) {
            stopRecording();
          }
        }
      }
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [phase, talkMode, interruptSpeaking, startRecording, stopRecording]);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [chat]);

  function connectSocket() {
    if (
      socketRef.current &&
      (socketRef.current.readyState === WebSocket.OPEN ||
        socketRef.current.readyState === WebSocket.CONNECTING)
    )
      return;

    const socket = new WebSocket(wsUrl());
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    setConnectionState("Connecting");
    setConnected(false);
    setStatus(hasConnectedRef.current ? "Reconnecting..." : "Connecting...");

    socket.onopen = () => {
      resetReconnectBackoff();
      hasConnectedRef.current = true;
      setConnectionState("Connected");
      setConnected(true);
      setStatus("Ready. Hold the button and speak.");
      setPhase("idle");
      if (selectedSessionIdRef.current) {
        socket.send(
          JSON.stringify({
            type: "select_session",
            sessionId: selectedSessionIdRef.current,
          }),
        );
      }
    };

    socket.onclose = () => {
      setConnectionState("Disconnected");
      setConnected(false);
      setStatus("Reconnecting...");
      setPhase("idle");
      socketRef.current = null;
      scheduleReconnect();
    };

    socket.onerror = () => setStatus("Connection error.");

    socket.onmessage = async (event) => {
      if (typeof event.data === "string") {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload.type === "ready") {
          setStatus(payload.message || "Connected.");
          setPhase(payload.phase || "idle");
          return;
        }
        if (payload.type === "status") {
          setStatus(payload.message || "Working...");
          setPhase(payload.phase);
          return;
        }
        if (payload.type === "transcript") {
          appendEntry(setChat, "You", payload.text || "", "user");
          setStatus("Transcript captured.");
          setPhase("transcribed");
          return;
        }
        if (payload.type === "audio") {
          if (isRecordingRef.current) {
            if (socketRef.current?.readyState === WebSocket.OPEN) {
              socketRef.current.send(JSON.stringify({ type: "interrupt" }));
            }
            return;
          }
          pendingAudioMimeRef.current = payload.mime || "audio/wav";
          appendEntry(setChat, "SpeakBro", payload.text || "", "assistant");
          setStatus("Playing reply... Tap to interrupt.");
          setPhase("speaking");
          cleanupPlayback();
          return;
        }
        if (payload.type === "error") {
          setStatus(payload.message || "Something went wrong.");
          setPhase("error");
          return;
        }
        if (payload.type === "opencode_session") {
          if (payload.sessionId) {
            setSelectedSessionId(payload.sessionId);
            selectedSessionIdRef.current = payload.sessionId;
            sendSelectedSession(payload.sessionId);
            syncOpenCodeSnapshot();
          }
          return;
        }
        if (payload.type === "memory_event") {
          appendMemoryEvent({
            action: payload.action || "unknown",
            category: payload.category || "uncategorized",
            reason: payload.reason || "",
            memory: payload.memory || "",
            memoryId: payload.memoryId || "",
            wordCount: payload.wordCount || 0,
          });
          if (payload.action === "saved") {
            void syncMemories();
          }
          return;
        }
        if (payload.type === "pong") return;
        return;
      }

      if (isRecordingRef.current) {
        return;
      }

      const blob =
        event.data instanceof Blob
          ? event.data
          : new Blob([event.data], { type: pendingAudioMimeRef.current });
      cleanupPlayback();

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      playbackAudioRef.current = audio;

      audio.onended = () => {
        URL.revokeObjectURL(url);
        playbackAudioRef.current = null;
        setStatus("Ready for the next turn.");
        setPhase("idle");
      };
      audio.onerror = () => {
        URL.revokeObjectURL(url);
        playbackAudioRef.current = null;
        setStatus("Audio playback failed.");
        setPhase("error");
      };

      try {
        await audio.play();
      } catch {
        URL.revokeObjectURL(url);
        playbackAudioRef.current = null;
        setStatus("Autoplay blocked. Tap to retry.");
        setPhase("idle");
      }
    };
  }

  useEffect(() => {
    connectSocket();
    return () => {
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    void syncMemories();
  }, [syncMemories]);

  useEffect(() => {
    let cancelled = false;

    void syncOpenCodeSnapshot();

    const stream = new EventSource(opencodeUrl("/event"));

    stream.onmessage = (event) => {
      if (cancelled) return;
      try {
        const globalEvent = JSON.parse(event.data);
        const { payload } = globalEvent;
        if (!payload) return;

        if (
          payload.type === "session.created" ||
          payload.type === "session.updated" ||
          payload.type === "session.deleted"
        ) {
          syncOpenCodeSnapshot();
          return;
        }

        if (payload.type === "session.status") {
          const { sessionID, status } = payload.properties;
          setOpencodeSnapshot((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              sessionStatus: { ...prev.sessionStatus, [sessionID]: status },
            };
          });
          return;
        }

        if (payload.type === "session.idle") {
          const { sessionID } = payload.properties;
          setOpencodeSnapshot((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              sessionStatus: {
                ...prev.sessionStatus,
                [sessionID]: { type: "idle" },
              },
            };
          });
          return;
        }
      } catch {
        /* ignore parse errors */
      }
    };

    stream.onerror = () => {
      if (cancelled) return;
      setOpencodeSnapshot((prev) => ({
        ...(prev ?? {}),
        connected: false,
        error:
          prev?.error ??
          "OpenCode stream disconnected. The browser will retry automatically.",
      }));
    };

    return () => {
      cancelled = true;
      stream.close();
    };
  }, [syncOpenCodeSnapshot]);

  const label =
    phase === "idle"
      ? isRecordingRef.current
        ? "Release to send"
        : "Hold to talk"
      : PHASE_LABELS[phase] || phase;

  return (
    <div className="h-screen w-full bg-zinc-950 text-white flex flex-col font-sans overflow-hidden select-none selection:bg-sky-500/30">
      {/* Modern Top Navbar */}
      <header className="h-14 shrink-0 border-b border-white/10 bg-zinc-950/80 backdrop-blur-md px-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 rounded-md bg-zinc-9000 flex items-center justify-center shadow-sm">
            <div className="h-1.5 w-1.5 bg-zinc-950 rounded-md" />
          </div>
          <h1 className="text-sm font-semibold tracking-tight">SpeakBro</h1>
        </div>

        {/* Center Tabs */}
        <div className="hidden md:flex items-center gap-1 bg-white/5 p-1 rounded-md border border-white/5">
          {["orchestration", "memory"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`relative px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-300 capitalize cursor-pointer ${
                activeTab === tab
                  ? "bg-white text-black shadow-sm"
                  : "text-zinc-400 hover:text-white hover:bg-white/5"
              }`}>
              {tab}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {connected && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-md bg-emerald-500 opacity-75" />
              )}
              <span
                className={`relative inline-flex rounded-md h-2 w-2 ${connected ? "bg-emerald-500" : connectionState === "Connecting" ? "bg-amber-500" : "bg-rose-500"}`}
              />
            </span>
            <span className="text-sm font-medium text-zinc-400">
              {connectionState}
            </span>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <main className="overflow-hidden flex flex-1 max-w-7xl w-full mx-auto">
        <div className="flex-1 overflow-hidden flex flex-col">
          {activeTab === "orchestration" && (
            <div className="flex h-full min-h-0 flex-col md:flex-row animate-in">
              <div className="flex min-w-0 flex-1 flex-col border-r border-white/5">
                <div className="flex items-center justify-between p-2 px-4 border-b border-white/5 shrink-0 bg-zinc-900/50">
                  <h2 className="text-sm font-semibold text-white tracking-wide">
                    Transcript
                  </h2>
                  <button
                    onClick={clearChatHistory}
                    disabled={chat.length === 0}
                    className="text-xs font-medium text-zinc-400 hover:text-white disabled:opacity-50 transition cursor-pointer bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-lg border border-white/5">
                    Clear
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
                  {chat.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
                      No interactions yet. Start speaking.
                    </div>
                  ) : (
                    chat.map((t) => (
                      <div
                        key={t.id}
                        className={`flex w-full animate-in ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-xl rounded-lg px-5 py-4 ${t.role === "user" ? "bg-white text-black rounded-tr-sm shadow-md" : "bg-zinc-900 border border-white/10 text-zinc-200 rounded-tl-sm"}`}>
                          <div
                            className={`text-xs font-medium mb-1.5 opacity-60 flex items-center gap-2 ${t.role === "user" ? "text-zinc-400 justify-end" : "text-zinc-400"}`}>
                            {t.prefix}
                            {t.ts && (
                              <span>
                                ·{" "}
                                {new Date(t.ts).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                            )}
                          </div>
                          <div className="text-sm leading-relaxed break-words font-sans">
                            <Streamdown>{t.text}</Streamdown>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
                <form
                  onSubmit={sendTextMessage}
                  className="flex items-center gap-2 border-t border-white/5 bg-zinc-900/50 p-2.5">
                  <input
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    placeholder="Message SpeakBro..."
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-zinc-400 focus:border-sky-500/50"
                  />
                  <button
                    type="button"
                    onPointerDown={handlePointerDown}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    aria-label="Use voice"
                    title="Use voice"
                    className={`flex h-10 shrink-0 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition active:scale-95 touch-none cursor-pointer ${phase === "listening" ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400" : phase === "error" ? "border-rose-500/40 bg-rose-500/15 text-rose-400" : phase === "thinking" || phase === "transcribing" || phase === "sending" ? "border-amber-500/40 bg-amber-500/15 text-amber-400" : "border-sky-500/30 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20"}`}>
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true">
                      <rect x="8" y="3" width="8" height="12" rx="4" />
                      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
                    </svg>
                    <span>{phase === "idle" ? "Voice" : label}</span>
                  </button>
                  <button
                    type="submit"
                    disabled={!textInput.trim()}
                    className="rounded-lg bg-white px-3.5 py-2.5 text-xs font-semibold text-black transition hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-40">
                    Send
                  </button>
                </form>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <OpenCodePanel
                  snapshot={opencodeSnapshot}
                  selectedSessionId={selectedSessionId}
                  onRefresh={syncOpenCodeSnapshot}
                  onSelectSession={selectOpenCodeSession}
                  onCreateSession={createOpenCodeSession}
                  onDeleteSession={removeOpenCodeSession}
                />
              </div>
            </div>
          )}

          {activeTab === "memory" && (
            <div className="animate-in h-full flex flex-col">
              <MemoryPanel
                events={memoryEvents}
                memories={memoryRecords}
                loading={memoryLoading}
                error={memoryError}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
