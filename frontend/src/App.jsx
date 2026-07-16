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
import { PixelAvatar } from "./PixelAvatar";

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

const PHASE_STYLES = {
  idle: {
    gradient: "from-sky-400 via-blue-500 to-indigo-600",
    shadow: "rgba(79,70,229,0.28)",
    glow: "rgba(56,189,248,0.55)",
  },
  listening: {
    gradient: "from-emerald-400 via-emerald-500 to-emerald-600",
    shadow: "rgba(16,185,129,0.28)",
    glow: "rgba(52,211,153,0.6)",
  },
  sending: {
    gradient: "from-amber-400 via-amber-500 to-amber-600",
    shadow: "rgba(245,158,11,0.28)",
    glow: "rgba(251,191,36,0.6)",
  },
  thinking: {
    gradient: "from-violet-400 via-violet-500 to-violet-600",
    shadow: "rgba(139,92,246,0.28)",
    glow: "rgba(167,139,250,0.6)",
  },
  speaking: {
    gradient: "from-purple-400 via-purple-500 to-purple-600",
    shadow: "rgba(139,92,246,0.28)",
    glow: "rgba(192,132,252,0.6)",
  },
  error: {
    gradient: "from-rose-400 via-red-500 to-red-600",
    shadow: "rgba(239,68,68,0.24)",
    glow: "rgba(251,113,133,0.55)",
  },
};

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
  const [activeTab, setActiveTab] = useState("chat"); // "chat" | "opencode" | "memory"
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  const prevChatLengthRef = useRef(0);

  useEffect(() => {
    if (activeTab === "chat") {
      setUnreadChatCount(0);
      prevChatLengthRef.current = chat.length;
    } else {
      if (chat.length > prevChatLengthRef.current) {
        setUnreadChatCount(
          (c) => c + (chat.length - prevChatLengthRef.current),
        );
      }
      prevChatLengthRef.current = chat.length;
    }
  }, [chat, activeTab]);

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
    setStatus("History cleared. Hold the button and speak.");
  }, []);

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

  const style = PHASE_STYLES[phase] || PHASE_STYLES.idle;
  const label =
    phase === "idle"
      ? isRecordingRef.current
        ? "Release to send"
        : "Hold to talk"
      : PHASE_LABELS[phase] || phase;

  const connDot = connected
    ? { bg: "#34d399", ring: "rgba(52,211,153,0.6)", text: "text-emerald-300" }
    : connectionState === "Connecting"
      ? { bg: "#fbbf24", ring: "rgba(251,191,36,0.6)", text: "text-amber-300" }
      : { bg: "#fb7185", ring: "rgba(251,113,133,0.6)", text: "text-rose-300" };

  const showReconnect = !connected && hasConnectedRef.current;

  return (
    <div className="h-screen w-full bg-bg-100 text-gray-1000 flex flex-col font-sans overflow-hidden select-none selection:bg-accent-blue/30">
      {/* Modern Top Navbar */}
      <header className="h-14 shrink-0 border-b border-white/10 bg-bg-100/80 backdrop-blur-md px-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-3">
          <div className="h-4 w-4 rounded-full bg-gray-1000 flex items-center justify-center shadow-[0_0_12px_rgba(255,255,255,0.3)]">
            <div className="h-1.5 w-1.5 bg-bg-100 rounded-full" />
          </div>
          <h1 className="text-[14px] font-semibold tracking-tight">
            SpeakBro{" "}
            <span className="text-gray-800 font-normal ml-1 border border-white/10 px-1.5 py-0.5 rounded text-[10px]">
              v1.2
            </span>
          </h1>
        </div>

        {/* Center Tabs */}
        <div className="hidden md:flex items-center gap-1 bg-white/5 p-1 rounded-full border border-white/5">
          {["chat", "opencode", "memory"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`relative px-4 py-1.5 rounded-full text-[12px] font-medium transition-all duration-300 capitalize cursor-pointer ${
                activeTab === tab
                  ? "bg-white text-black shadow-sm"
                  : "text-gray-800 hover:text-white hover:bg-white/5"
              }`}>
              {tab}
              {tab === "chat" && unreadChatCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 bg-accent-blue text-white rounded-full text-[9px] flex items-center justify-center font-bold">
                  {unreadChatCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex bg-white/5 border border-white/10 p-0.5 rounded-lg text-[11px] font-medium">
            <button
              onClick={() => setTalkMode("hold")}
              className={`px-3 py-1 rounded-md transition-all duration-200 cursor-pointer ${talkMode === "hold" ? "bg-white/15 text-white" : "text-gray-800 hover:text-white"}`}>
              Hold
            </button>
            <button
              onClick={() => setTalkMode("tap")}
              className={`px-3 py-1 rounded-md transition-all duration-200 cursor-pointer ${talkMode === "tap" ? "bg-white/15 text-white" : "text-gray-800 hover:text-white"}`}>
              Tap
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {connected && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent-emerald opacity-75" />
              )}
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${connected ? "bg-accent-emerald" : connectionState === "Connecting" ? "bg-accent-amber" : "bg-accent-rose"}`}
              />
            </span>
            <span className="text-[12px] font-medium text-gray-800">
              {connectionState}
            </span>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <main className="flex-1 flex overflow-hidden p-6 gap-6 max-w-[1400px] w-full mx-auto max-md:flex-col max-md:p-4">
        {/* Left Sidebar (Assistant) */}
        <aside className="w-full md:w-[320px] flex flex-col gap-4 shrink-0">
          <div className="geist-panel rounded-2xl p-6 flex flex-col flex-1 relative overflow-hidden group">
            {/* Subtle background glow based on phase */}
            <div
              className="absolute inset-0 opacity-15 transition-all duration-700 pointer-events-none"
              style={{
                background:
                  phase === "listening"
                    ? "radial-gradient(circle at center, var(--color-accent-emerald) 0%, transparent 70%)"
                    : phase === "speaking"
                      ? "radial-gradient(circle at center, var(--color-accent-purple) 0%, transparent 70%)"
                      : phase === "thinking"
                        ? "radial-gradient(circle at center, var(--color-accent-blue) 0%, transparent 70%)"
                        : "transparent",
              }}
            />

            {showReconnect && (
              <div className="mb-4 flex items-center justify-center gap-2 rounded-lg border border-accent-amber/20 bg-accent-amber/10 px-3 py-2 text-[11px] font-medium text-accent-amber animate-in">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-amber animate-pulse" />
                Reconnecting...
              </div>
            )}

            <div className="flex-1 flex flex-col items-center justify-center py-4 relative z-10">
              <div className="relative w-28 h-28 flex items-center justify-center mb-8">
                {/* Avatar with pulse ring */}
                {(phase === "listening" || phase === "speaking") && (
                  <div className="absolute inset-0 rounded-full animate-pulse-slow border border-white/20 scale-125" />
                )}
                <div className="relative z-10 w-full h-full transition-transform duration-300 hover:scale-105">
                  <PixelAvatar
                    phase={phase}
                    voiceLevel={voiceLevel}
                    className="w-full h-full"
                  />
                </div>
              </div>

              {/* Status and Visualizer */}
              <div className="flex flex-col items-center gap-4 w-full">
                <div className="h-8 flex items-end justify-center gap-[3px] w-full max-w-[160px]">
                  {[...Array(12)].map((_, i) => {
                    const active =
                      phase === "listening" || phase === "speaking";
                    const multiplier = 1 + Math.sin((i / 12) * Math.PI) * 2;
                    const level = active
                      ? Math.max(
                          10,
                          Math.min(100, voiceLevel * multiplier * 1.5),
                        )
                      : 2 + Math.sin(Date.now() / 300 + i) * 50;
                    return (
                      <div
                        key={i}
                        className="w-1 rounded-full transition-all duration-100 opacity-90"
                        style={{
                          height: `${level}%`,
                          backgroundColor:
                            phase === "listening"
                              ? "var(--color-accent-emerald)"
                              : phase === "speaking"
                                ? "var(--color-accent-purple)"
                                : "var(--color-gray-800)",
                        }}
                      />
                    );
                  })}
                </div>
                <div className="text-[13px] font-medium text-gray-900 tracking-wide mt-2 min-h-[20px]">
                  {status}
                </div>
              </div>
            </div>

            <div className="mt-auto relative z-10 flex flex-col gap-3">
              {micError && (
                <div className="rounded-xl border border-accent-rose/20 bg-accent-rose/10 p-3 text-center animate-in">
                  <div className="text-[12px] font-semibold text-accent-rose">
                    Microphone Error
                  </div>
                  <div className="mt-1 text-[11px] text-accent-rose/80">
                    {micError}
                  </div>
                  <button
                    onClick={() => {
                      setMicError(null);
                      startRecording();
                    }}
                    className="mt-2 text-[11px] font-semibold text-white bg-white/10 px-3 py-1.5 rounded-lg hover:bg-white/20 transition cursor-pointer">
                    Retry
                  </button>
                </div>
              )}

              <button
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="w-full rounded-xl py-3.5 text-[13px] font-semibold transition-all duration-200 cursor-pointer active:scale-[0.98] select-none touch-none shadow-[0_0_20px_rgba(255,255,255,0.05)] border"
                style={{
                  backgroundColor:
                    phase === "listening"
                      ? "var(--color-accent-emerald)"
                      : phase === "speaking"
                        ? "var(--color-bg-200)"
                        : phase === "error"
                          ? "var(--color-accent-rose)"
                          : "var(--color-gray-1000)",
                  color:
                    phase === "listening" || phase === "error"
                      ? "#ffffff"
                      : phase === "speaking"
                        ? "var(--color-gray-1000)"
                        : "#000000",
                  borderColor:
                    phase === "speaking"
                      ? "rgba(255,255,255,0.2)"
                      : "transparent",
                }}>
                <div className="flex items-center justify-center gap-2">
                  <span>
                    {phase === "idle"
                      ? talkMode === "hold"
                        ? "Hold to Speak"
                        : "Tap to Speak"
                      : phase === "speaking"
                        ? talkMode === "hold"
                          ? "Hold to Speak"
                          : "Tap to Interrupt"
                        : label}
                  </span>
                </div>
              </button>

              {opencodeSnapshot?.config?.model && (
                <div className="text-[10px] text-gray-800 text-center font-mono uppercase tracking-widest mt-1 opacity-60">
                  {opencodeSnapshot.config.model}
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* Right Content Area */}
        <main className="flex-1 flex flex-col min-h-0 relative">
          {/* Mobile Tabs */}
          <div className="md:hidden flex items-center gap-2 mb-4 bg-white/5 p-1 rounded-xl border border-white/10">
            {["chat", "opencode", "memory"].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-2 rounded-lg text-[12px] font-medium capitalize ${activeTab === tab ? "bg-white text-black" : "text-gray-800 hover:text-white"}`}>
                {tab}
              </button>
            ))}
          </div>

          <div className="flex-1 geist-panel rounded-2xl overflow-hidden flex flex-col">
            {activeTab === "chat" && (
              <div className="flex flex-col h-full animate-fade-in">
                <div className="flex items-center justify-between p-4 border-b border-white/5 shrink-0 bg-bg-200/50">
                  <h2 className="text-[13px] font-semibold text-white tracking-wide">
                    Transcript
                  </h2>
                  <button
                    onClick={clearChatHistory}
                    disabled={chat.length === 0}
                    className="text-[11px] font-medium text-gray-800 hover:text-white disabled:opacity-50 transition cursor-pointer bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-lg border border-white/5">
                    Clear
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
                  {chat.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center text-[13px] text-gray-800">
                      No interactions yet. Start speaking.
                    </div>
                  ) : (
                    chat.map((t) => (
                      <div
                        key={t.id}
                        className={`flex w-full animate-fade-in ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[85%] rounded-2xl px-5 py-4 ${t.role === "user" ? "bg-white text-black rounded-tr-sm shadow-md" : "bg-bg-200 border border-white/10 text-gray-900 rounded-tl-sm"}`}>
                          <div
                            className={`text-[10px] font-medium mb-1.5 opacity-60 flex items-center gap-2 ${t.role === "user" ? "text-gray-800 justify-end" : "text-gray-800"}`}>
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
                          <div className="text-[14px] leading-relaxed break-words font-sans">
                            <Streamdown>{t.text}</Streamdown>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
              </div>
            )}

            {activeTab === "opencode" && (
              <div className="animate-fade-in h-full flex flex-col">
                <OpenCodePanel
                  snapshot={opencodeSnapshot}
                  selectedSessionId={selectedSessionId}
                  onRefresh={syncOpenCodeSnapshot}
                  onSelectSession={selectOpenCodeSession}
                  onCreateSession={createOpenCodeSession}
                  onDeleteSession={removeOpenCodeSession}
                />
              </div>
            )}

            {activeTab === "memory" && (
              <div className="animate-fade-in h-full flex flex-col">
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
      </main>
    </div>
  );
}
