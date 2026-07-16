import { useState, useCallback, useEffect } from "react";
import {
  formatSessionTitle,
  formatStatusLabel,
  fetchSession,
  fetchSessionMessages,
} from "./opencodeApi";

function Badge({ children, tone = "neutral" }) {
  const tones = {
    neutral: "border-white/8 bg-white/[0.04] text-slate-300",
    good: "border-emerald-500/20 bg-emerald-500/8 text-emerald-300",
    warning: "border-amber-500/20 bg-amber-500/8 text-amber-300",
    danger: "border-rose-500/20 bg-rose-500/8 text-rose-300",
  };

  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[8px] font-mono font-medium uppercase tracking-wider ${tones[tone] || tones.neutral}`}>
      {children}
    </span>
  );
}

function formatTime(value) {
  if (!value) return "\u2014";
  const ts = typeof value === "number" ? value : Date.parse(value);
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function formatRelativeTime(value) {
  if (!value) return "";
  const ts = typeof value === "number" ? value : Date.parse(value);
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function statusTone(status) {
  const label = formatStatusLabel(status).toLowerCase();
  if (label.includes("error") || label.includes("failed")) return "danger";
  if (
    label.includes("busy") ||
    label.includes("running") ||
    label.includes("active")
  )
    return "good";
  if (label.includes("retry")) return "warning";
  return "neutral";
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    },
    [text],
  );

  return (
    <button
      onClick={handleCopy}
      className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[8px] font-mono font-medium uppercase tracking-wider text-[#93a7c6] transition hover:bg-white/10 hover:text-white active:scale-95"
      type="button"
      title="Copy session ID">
      {copied ? "\u2713" : "ID"}
    </button>
  );
}

function renderTextParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text")
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function SessionField({ label, children, span = false }) {
  if (!children && children !== 0) return null;
  return (
    <div
      className={`rounded-lg border border-white/5 bg-white/[0.015] px-2.5 py-1.5 ${span ? "col-span-2" : ""}`}>
      <div className="text-[8px] font-mono tracking-widest text-[#5a7091] uppercase">
        {label}
      </div>
      <div className="break-all font-mono text-[10px] text-[#cfe0f5] mt-0.5">
        {children}
      </div>
    </div>
  );
}

function SessionDetail({ session, onBack, onDelete, deleting }) {
  const [messages, setMessages] = useState(null);
  const [fullSession, setFullSession] = useState(session);

  useEffect(() => {
    let cancelled = false;
    setMessages(null);
    setFullSession(session);
    void fetchSession(session.id)
      .then((data) => {
        if (!cancelled && data) setFullSession(data);
      })
      .catch(() => {});
    void fetchSessionMessages(session.id, 50).then((data) => {
      if (!cancelled) setMessages(data ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [session.id, session]);

  const s = fullSession ?? session;
  const diffs = s.summary?.diffs ?? [];

  return (
    <div className="flex h-full flex-col gap-2 animate-slide-in">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="rounded-lg border border-white/10 bg-white/6 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#93a7c6] transition hover:bg-white/10 hover:text-white active:scale-95"
          type="button">
          {"← Back"}
        </button>
        <span className="truncate text-xs font-semibold text-white">
          {formatSessionTitle(s)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-1.5 text-[9px] text-[#7f96b8]">
        {/* <SessionField label="Project ID" span>{s.projectID || "—"}</SessionField>
        <SessionField label="Version">{s.version || "—"}</SessionField> */}
        {/* <SessionField label="Parent ID">{s.parentID || "—"}</SessionField> */}
        <SessionField label="Created">
          {formatTime(s.time?.created)}
        </SessionField>
        <SessionField label="Updated">
          {formatRelativeTime(s.time?.updated ?? s.time?.created)}
        </SessionField>
        {s.time?.compacting ? (
          <SessionField label="Compacted">
            {formatTime(s.time.compacting)}
          </SessionField>
        ) : null}
        <SessionField label="Directory" span>
          {s.directory || "—"}
        </SessionField>
        {s.revert?.messageID && (
          <SessionField label="Revert" span>
            messageID: {s.revert.messageID}
            {s.revert.partID ? ` / partID: ${s.revert.partID}` : ""}
            {s.revert.snapshot ? ` / snapshot: ${s.revert.snapshot}` : ""}
          </SessionField>
        )}
      </div>

      <div className="flex items-center gap-2">
        <CopyButton text={s.id} />
        {s.share?.url && (
          <a
            href={s.share.url}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-emerald-400/20 bg-emerald-400/10 px-1.5 py-px text-[8px] font-bold uppercase tracking-wider text-emerald-300 transition hover:bg-emerald-400/20">
            Open share
          </a>
        )}
        {s.summary && (
          <span className="text-[9px] text-emerald-400/70">
            +{s.summary.additions}/-{s.summary.deletions} · {s.summary.files}{" "}
            files
          </span>
        )}
        <button
          onClick={() => onDelete(s.id)}
          disabled={deleting}
          className="ml-auto rounded border border-rose-400/25 bg-rose-400/10 px-1.5 py-px text-[8px] font-bold uppercase tracking-wider text-rose-300 transition hover:bg-rose-400/20 disabled:opacity-50"
          type="button">
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>

      {diffs.length > 0 && (
        <details className="rounded-lg border border-white/8 bg-white/[0.02] px-2 py-1 text-[9px]">
          <summary className="cursor-pointer uppercase tracking-wider text-[#5a7091]">
            Diffs ({diffs.length})
          </summary>
          <div className="mt-1 flex flex-col gap-1">
            {diffs.map((diff, i) => (
              <div
                key={i}
                className="rounded border border-white/8 bg-white/[0.03] px-1.5 py-1">
                <div className="text-[#cfe0f5]">
                  {diff.path ?? diff.file ?? "unknown"}
                </div>
                {diff.content && (
                  <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-sans text-[#9fb4d4]">
                    {diff.content}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto log-body">
        {messages === null ? (
          <div className="flex flex-1 items-center justify-center text-[10px] text-[#5a7091]">
            Loading transcript...
          </div>
        ) : messages.length ? (
          messages.map((m, i) => {
            const info = m.info ?? {};
            const role = (info.role ?? "assistant").toLowerCase();
            const text = renderTextParts(m.parts);
            if (!text) return null;
            const isUser = role === "user";
            return (
              <div
                key={info.id ?? i}
                className={`rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed ${
                  isUser
                    ? "border-sky-400/20 bg-sky-400/[0.06]"
                    : "border-white/8 bg-white/[0.03]"
                }`}>
                <div className="mb-0.5 flex items-center justify-between gap-1.5">
                  <span className="text-[8px] font-bold uppercase tracking-wider text-[#5a7091]">
                    {isUser ? "You" : "OpenCode"}
                  </span>
                  <span className="text-[7px] text-[#475569]">
                    {formatTime(info.time?.created)}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap break-words font-sans text-[#d4e4ff]">
                  {text}
                </pre>
              </div>
            );
          })
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-4 text-center text-[10px] text-[#7f96b8]">
            No messages in this session yet.
          </div>
        )}
      </div>
    </div>
  );
}

export function OpenCodePanel({
  snapshot,
  selectedSessionId,
  onRefresh,
  onSelectSession,
  onCreateSession,
  onDeleteSession,
}) {
  const sessions = snapshot?.sessions ?? [];
  const sessionStatus = snapshot?.sessionStatus ?? {};
  const connected = snapshot?.connected;
  const configInfo = snapshot?.config;

  const [view, setView] = useState("list");
  const [detailSession, setDetailSession] = useState(null);
  const [confirmingId, setConfirmingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [composing, setComposing] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [limit, setLimit] = useState(8);

  useEffect(() => {
    if (view === "detail" && detailSession) {
      const fresh = sessions.find((s) => s.id === detailSession.id);
      if (fresh) setDetailSession(fresh);
    }
  }, [sessions, view, detailSession]);

  const openDetail = useCallback((session) => {
    setDetailSession(session);
    setView("detail");
  }, []);

  const closeDetail = useCallback(() => {
    setView("list");
    setDetailSession(null);
  }, []);

  const handleCreate = useCallback(async () => {
    const title = newTitle.trim() || undefined;
    setComposing(false);
    setNewTitle("");
    await onCreateSession(title);
  }, [newTitle, onCreateSession]);

  const handleDelete = useCallback(
    async (id) => {
      setConfirmingId(null);
      setDeletingId(id);
      try {
        await onDeleteSession(id);
        if (detailSession?.id === id) closeDetail();
      } finally {
        setDeletingId(null);
      }
    },
    [onDeleteSession, detailSession, closeDetail],
  );

  return (
    <section className="flex flex-1 h-full flex-col min-h-0 bg-bg-200/50">
      {view === "detail" && detailSession ? (
        <div className="p-6 overflow-y-auto h-full">
          <SessionDetail
            session={detailSession}
            onBack={closeDetail}
            onDelete={handleDelete}
            deleting={deletingId === detailSession.id}
          />
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <h2 className="text-[13px] font-semibold text-white tracking-wide shrink-0">
                OpenCode
              </h2>
              <Badge tone={connected ? "good" : "danger"}>
                {connected ? "Online" : "Offline"}
              </Badge>
              {configInfo?.model && (
                <span className="text-[11px] font-medium text-gray-800 truncate hidden sm:inline">
                  {configInfo.model}
                </span>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <button
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-gray-900 transition hover:bg-white/10 hover:text-white cursor-pointer shadow-sm"
                onClick={onRefresh}
                type="button">
                Refresh
              </button>
              <button
                className="rounded-lg border border-accent-blue/20 bg-accent-blue/10 px-3 py-1.5 text-[11px] font-semibold text-accent-blue transition hover:bg-accent-blue/20 cursor-pointer shadow-sm"
                onClick={() => setComposing((v) => !v)}
                type="button">
                + New
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4">
            {!connected && (
              <div className="rounded-xl border border-accent-amber/20 bg-accent-amber/10 px-4 py-3 text-[12px] text-accent-amber">
                OpenCode offline. Run terminal workspace service to sync active
                environments.
              </div>
            )}

            {snapshot?.error && (
              <div className="rounded-xl border border-accent-rose/20 bg-accent-rose/10 px-4 py-3 text-[12px] text-accent-rose">
                {snapshot.error}
              </div>
            )}

            {composing && (
              <div className="flex items-center gap-3 animate-in rounded-xl border border-accent-blue/20 bg-accent-blue/10 px-4 py-3 shadow-sm">
                <input
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreate();
                    if (e.key === "Escape") {
                      setComposing(false);
                      setNewTitle("");
                    }
                  }}
                  placeholder="Workspace/Session Title..."
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-white placeholder:text-gray-800 outline-none"
                />
                <button
                  onClick={handleCreate}
                  className="rounded-lg bg-accent-blue text-white px-3 py-1.5 text-[11px] font-semibold transition hover:opacity-90 cursor-pointer shadow-sm"
                  type="button">
                  Create
                </button>
                <button
                  onClick={() => {
                    setComposing(false);
                    setNewTitle("");
                  }}
                  className="rounded-lg px-2 py-1.5 text-[12px] text-gray-800 transition hover:text-white cursor-pointer"
                  type="button">
                  ✕
                </button>
              </div>
            )}

            <div className="flex flex-col gap-3 flex-1 min-h-[200px]">
              {sessions.length ? (
                sessions.slice(0, limit).map((session) => {
                  const isActive = session.id === selectedSessionId;
                  const status = sessionStatus[session.id];
                  const confirming = confirmingId === session.id;
                  return (
                    <div
                      key={session.id}
                      className={`rounded-xl border px-4 py-3 transition shadow-sm ${
                        isActive
                          ? "border-accent-blue/30 bg-accent-blue/10"
                          : "border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20"
                      }`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2 flex-1">
                          <span
                            className={`truncate text-[13px] font-semibold ${isActive ? "text-accent-blue" : "text-white"}`}>
                            {formatSessionTitle(session)}
                          </span>
                          {session.share?.url && (
                            <span className="text-[10px] font-medium text-accent-emerald/90 shrink-0 border border-accent-emerald/20 px-1.5 rounded bg-accent-emerald/10">
                              Shared
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <CopyButton text={session.id} />
                          {status && (
                            <Badge tone={statusTone(status)}>
                              {formatStatusLabel(status)}
                            </Badge>
                          )}
                        </div>
                      </div>

                      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-800">
                        {session.directory && (
                          <span className="font-mono truncate max-w-[200px] bg-bg-200 px-1.5 py-0.5 rounded border border-white/5 text-gray-900">
                            {session.directory}
                          </span>
                        )}
                        <span className="shrink-0 font-medium">
                          {formatRelativeTime(
                            session.time?.updated ?? session.time?.created,
                          )}
                        </span>
                        {session.summary && (
                          <span className="shrink-0 text-accent-emerald/80 font-medium">
                            +{session.summary.additions}/-
                            {session.summary.deletions}
                          </span>
                        )}
                      </div>

                      <div className="mt-3 flex items-center gap-2">
                        <button
                          onClick={() =>
                            onSelectSession(isActive ? null : session.id)
                          }
                          className={`rounded-lg border px-3 py-1 text-[10px] font-semibold tracking-wide transition cursor-pointer ${
                            isActive
                              ? "border-accent-blue/40 bg-accent-blue text-white shadow-sm hover:opacity-90"
                              : "border-white/10 bg-white/5 text-gray-900 hover:bg-white/10 hover:text-white"
                          }`}
                          type="button">
                          {isActive ? "Selected" : "Select"}
                        </button>
                        <button
                          onClick={() => openDetail(session)}
                          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-semibold tracking-wide text-gray-900 transition hover:bg-white/10 hover:text-white cursor-pointer"
                          type="button">
                          Details
                        </button>
                        {confirming ? (
                          <div className="ml-auto flex items-center gap-2 bg-accent-rose/10 px-2 rounded-lg border border-accent-rose/20 py-0.5">
                            <span className="text-[10px] font-medium text-accent-rose">
                              Delete?
                            </span>
                            <button
                              onClick={() => handleDelete(session.id)}
                              disabled={deletingId === session.id}
                              className="rounded bg-accent-rose text-white px-2 py-0.5 text-[9px] font-semibold transition hover:opacity-90 disabled:opacity-50 cursor-pointer shadow-sm"
                              type="button">
                              {deletingId === session.id ? "..." : "Yes"}
                            </button>
                            <button
                              onClick={() => setConfirmingId(null)}
                              className="rounded px-1.5 py-0.5 text-[10px] text-gray-800 transition hover:text-white cursor-pointer"
                              type="button">
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmingId(session.id)}
                            className="ml-auto text-[11px] font-semibold text-gray-800 transition hover:text-accent-rose cursor-pointer px-2 py-1 rounded hover:bg-accent-rose/10"
                            type="button">
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="flex-1 flex items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/5 p-6 text-[13px] font-medium text-gray-800">
                  No sessions created yet
                </div>
              )}

              {sessions.length > limit && (
                <button
                  onClick={() => setLimit((l) => l + 8)}
                  className="mt-2 rounded-xl border border-white/10 bg-white/5 py-2.5 text-[11px] font-semibold text-gray-900 transition hover:bg-white/10 hover:text-white cursor-pointer shadow-sm"
                  type="button">
                  Load more sessions ({sessions.length - limit})
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
