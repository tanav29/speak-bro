import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { Streamdown } from "streamdown";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { OpenCodePanel } from "./OpenCodePanel";
import { MemoryPanel } from "./MemoryPanel";
import { fetchMemories } from "./memoryApi";
import {
  fetchSnapshot,
  createSession,
  deleteSession,
  opencodeUrl,
  formatSessionTitle,
} from "./opencodeApi";
import {
  Activity,
  Bell,
  Check,
  Mic,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

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
  listening: "Listening",
  sending: "Sending",
  thinking: "Thinking",
  speaking: "Tap to stop",
  error: "Error",
  "requesting-mic": "Requesting mic",
  transcribing: "Transcribing",
  recording: "Listening",
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
  const [textInput, setTextInput] = useState("");
  const [sessionNotice, setSessionNotice] = useState(null);
  const previousSessionStatusRef = useRef({});

  const trustScore = useMemo(() => {
    const hasMemory = memoryRecords.length > 0;
    const hasSession = Boolean(selectedSessionId);
    const hasConnection = connected;
    return (
      76 + (hasConnection ? 12 : 0) + (hasMemory ? 6 : 0) + (hasSession ? 6 : 0)
    );
  }, [connected, memoryRecords.length, selectedSessionId]);

  const activitySummary = useMemo(() => {
    if (phase === "thinking" || phase === "sending" || phase === "transcribing")
      return "Agent is working — review before it speaks";
    if (phase === "speaking") return "Response ready — tap Voice to interrupt";
    if (memoryEvents.length)
      return `${memoryEvents.length} memory decision${memoryEvents.length === 1 ? "" : "s"} recorded this session`;
    return "No agent actions yet. Your next request will appear here.";
  }, [memoryEvents.length, phase]);

  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const processorNodeRef = useRef(null);
  const monitorNodeRef = useRef(null);
  const playbackAudioRef = useRef(null);
  // Ignore audio packets that were already queued when the user interrupted.
  const suppressAudioRef = useRef(false);
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

  const enableSessionAlerts = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    try {
      await Notification.requestPermission();
    } catch {
      // The in-app completion banner remains available when notifications are blocked.
    }
  }, []);

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
        error: error instanceof Error ? error.message : String(error),
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
          error: error instanceof Error ? error.message : String(error),
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
          error: error instanceof Error ? error.message : String(error),
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
      suppressAudioRef.current = false;
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

  const clearChatHistory = useCallback(() => {
    cleanupPlayback();
    void stopRecording(false);
    setChat([]);
    setTextInput("");
    setSelectedSessionId(null);
    selectedSessionIdRef.current = null;
    sendSelectedSession(null);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "clear_session" }));
    }
    setStatus("History cleared. Type a message or use the microphone.");
    setPhase("idle");
  }, [cleanupPlayback, sendSelectedSession, stopRecording]);

  const startRecording = useCallback(async () => {
    if (
      !socketRef.current ||
      socketRef.current.readyState !== WebSocket.OPEN ||
      isRecordingRef.current
    )
      return;

    try {
      suppressAudioRef.current = false;
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
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext!
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
      const msg =
        error instanceof Error
          ? error.message
          : "Microphone access was blocked.";
      setMicError(msg);
      setStatus(`Mic error: ${msg}`);
      setPhase("error");
    }
  }, [stopRecording, updateMeter, talkMode]);

  startRecordingRef.current = startRecording;

  const interruptSpeaking = useCallback(() => {
    // Stop the element immediately and ignore any audio packet that is already
    // queued on the WebSocket. The backend cancellation may arrive slightly
    // after the browser receives that packet.
    suppressAudioRef.current = true;
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

      if (phase === "speaking" || playbackAudioRef.current) {
        interruptSpeaking();
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
          if (suppressAudioRef.current || isRecordingRef.current) {
            if (socketRef.current?.readyState === WebSocket.OPEN) {
              socketRef.current.send(JSON.stringify({ type: "interrupt" }));
            }
            return;
          }
          pendingAudioMimeRef.current = payload.mime || "audio/wav";
          appendEntry(setChat, "SpeakBro", payload.text || "", "assistant");
          setStatus("Speaking... Tap to stop.");
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

      if (suppressAudioRef.current || isRecordingRef.current) {
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
    const current = opencodeSnapshot?.sessionStatus ?? {};
    const previous = previousSessionStatusRef.current;
    const sessions = opencodeSnapshot?.sessions ?? [];

    Object.entries(current).forEach(([sessionId, status]) => {
      const before = previous[sessionId];
      const beforeType = typeof before === "string" ? before : before?.type;
      const currentType =
        typeof status === "string"
          ? status
          : (status as { type?: string })?.type;
      const wasRunning = ["busy", "running", "active"].includes(beforeType);
      const isDone = ["idle", "completed", "success"].includes(currentType);
      if (wasRunning && isDone) {
        const session = sessions.find((item) => item.id === sessionId);
        const title = session
          ? formatSessionTitle(session)
          : "OpenCode session";
        setSessionNotice({ id: Date.now(), title });
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          new Notification("OpenCode session complete", {
            body: `${title} is ready for review.`,
            tag: `opencode-${sessionId}`,
          });
        }

      }
    });
    previousSessionStatusRef.current = current;
  }, [opencodeSnapshot]);

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
    <div className="app-shell flex h-dvh w-full flex-col overflow-hidden font-sans">
      <header className="topbar z-10 flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight text-white drop-shadow-md">
              SpeakBro
            </h1>
          </div>
        </div>
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-cyan-300/70">
          Voice workspace
        </div>
        <div className="flex items-center gap-3">
          {typeof Notification !== "undefined" &&
            Notification.permission !== "granted" && (
              <button
                className="alert-button"
                type="button"
                onClick={enableSessionAlerts}
                title="Notify me when an OpenCode session finishes">
                <Bell className="size-3.5" />
                <span className="hidden lg:inline">Enable alerts</span>
              </button>
            )}
          <div
            className="trust-pill"
            title="Based on connection, active workspace, and memory availability">
            <ShieldCheck className="size-3.5" />
            <span>Trust</span>
            <strong>{trustScore}%</strong>
          </div>
          <div className="connection-pill">
            <span
              className={`status-dot ${connected ? "online" : connectionState === "Connecting" ? "pending" : "offline"}`}
            />{" "}
            <span className="hidden sm:inline">{connectionState}</span>
          </div>
        </div>
      </header>

      <main className="mx-auto h-full w-full max-w-[1500px] overflow-hidden">
        <div className="flex h-full min-h-0 w-full flex-col gap-3 p-3 lg:flex-row">
          {sessionNotice && (
            <div className="session-complete-notice" role="status">
              <div className="flex items-start gap-2">
                <Bell className="mt-0.5 size-4 text-emerald-300" />
                <div>
                  <strong>Session complete</strong>
                  <span>{sessionNotice.title} is ready for review.</span>
                </div>
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => setSessionNotice(null)}>
                <X className="size-4" />
              </button>
            </div>
          )}
          <div className="panel flex min-h-0 w-full flex-col lg:w-1/3">
            <div className="panel-header shrink-0 py-2">
              <span className="text-sm font-semibold text-zinc-100">Chat</span>
              <Button
                onClick={clearChatHistory}
                disabled={chat.length === 0}
                variant="ghost"
                size="sm">
                Clear
              </Button>
            </div>
            <div className="review-banner py-2">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-cyan-300" />
                <span>{activitySummary}</span>
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {chat.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
                  No interactions yet. Start speaking.
                </div>
              ) : (
                chat.map((t) => (
                  <div key={t.id} className={`flex flex-col w-full`}>
                    <div
                      className={`text-xs font-medium opacity-60 flex items-center gap-2 ${t.role === "user" ? "text-zinc-400 justify-end" : "text-zinc-400"}`}>
                      {t.prefix}
                      {t.ts && (
                        <span>
                          {new Date(t.ts).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      )}
                    </div>
                    <Streamdown
                      className={`text-sm w-full font-sans ${t.role === "user" ? "justify-end" : ""}`}>
                      {t.text}
                    </Streamdown>
                  </div>
                ))
              )}
              <div ref={chatEndRef} />
            </div>
            <form
              onSubmit={sendTextMessage}
              className="flex flex-col p-3 border-t border-white/5 bg-black/40 backdrop-blur-md rounded-b-xl shadow-[0_-10px_40px_rgba(0,0,0,0.2)]">
              <div className="relative flex flex-col rounded-xl bg-white/5 border border-white/10 p-2 transition-all duration-300 focus-within:bg-white/10 focus-within:border-cyan-500/50 focus-within:shadow-[0_0_20px_rgba(34,211,238,0.15)]">
                <textarea
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Message SpeakBro..."
                  className="flex-1 w-full min-h-[60px] max-h-[120px] resize-none bg-transparent p-2 text-sm text-zinc-100 focus:outline-none outline-none border-none placeholder:text-zinc-500 font-medium focus:border-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendTextMessage(e);
                    }
                  }}
                />
                <div className="flex gap-2 items-center justify-between mt-2 pt-2 border-t border-white/5">
                  <span
                    className="px-2 text-xs font-medium text-zinc-400"
                    title="All coding work runs inside the repository sandbox directory">
                    Project: Local Sandbox
                  </span>
                  <div className="flex gap-2 items-center">
                    <Button
                      type="button"
                      className={`transition-all duration-300 ${isRecordingRef.current ? "bg-emerald-500 hover:bg-emerald-400 text-black shadow-[0_0_20px_rgba(52,211,153,0.5)] scale-105" : "bg-white/10 hover:bg-white/20 text-white border border-white/10"}`}
                      size="sm"
                      onPointerDown={handlePointerDown}
                      onPointerUp={handlePointerUp}
                      onPointerCancel={handlePointerUp}
                      aria-label="Use voice"
                      title="Use voice">
                      <Mic
                        className={`${isRecordingRef.current ? "animate-pulse" : ""}`}
                      />
                      {phase === "idle" ? "Voice" : label}
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      className="bg-cyan-500 hover:bg-cyan-400 text-black font-semibold shadow-[0_0_15px_rgba(34,211,238,0.4)] transition-all"
                      disabled={!textInput.trim()}>
                      Send
                    </Button>
                  </div>
                </div>
              </div>
            </form>
          </div>
          <div className="flex min-h-0 min-w-0 w-full flex-col lg:w-1/3">
            <OpenCodePanel
              snapshot={opencodeSnapshot}
              selectedSessionId={selectedSessionId}
              onRefresh={syncOpenCodeSnapshot}
              onSelectSession={selectOpenCodeSession}
              onCreateSession={createOpenCodeSession}
              onDeleteSession={removeOpenCodeSession}
            />
          </div>
          <div className="flex min-h-0 min-w-0 w-full flex-col lg:w-1/3">
            <MemoryPanel
              events={memoryEvents}
              memories={memoryRecords}
              loading={memoryLoading}
              error={memoryError}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
