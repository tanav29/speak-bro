import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  formatSessionTitle,
  formatStatusLabel,
  fetchSession,
  fetchSessionMessages,
  fetchSessionStatus,
} from "./opencodeApi";
import { Check, Copy, RotateCcw, Trash, X } from "lucide-react";

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

function statusKind(status) {
  const label = formatStatusLabel(status).toLowerCase();
  if (label.includes("error") || label.includes("failed")) return "error";
  if (
    label.includes("busy") ||
    label.includes("running") ||
    label.includes("active")
  )
    return "busy";
  return "idle";
}

function statusTone(status) {
  const label = formatStatusLabel(status).toLowerCase();
  if (label.includes("error") || label.includes("failed")) return "destructive";
  if (
    label.includes("busy") ||
    label.includes("running") ||
    label.includes("active")
  )
    return "default";
  if (label.includes("retry")) return "warning";
  return "secondary";
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
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <button onClick={handleCopy} type="button" title="Copy session ID">
            <Copy className="w-3 h-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Copy session ID</TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
      className={`rounded-lg border border-white/5 bg-white/5 px-2.5 py-1.5 ${span ? "col-span-2" : ""}`}>
      <div className="text-xs font-mono tracking-widest text-slate-500 uppercase">
        {label}
      </div>
      <div className="break-all font-mono text-xs text-slate-200 mt-0.5">
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
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-slate-300 transition-all hover:bg-white/10 hover:text-white active:scale-95 shadow-sm"
          type="button">
          {"\u2190 Back"}
        </button>
        <span className="truncate text-sm font-bold text-white drop-shadow-sm">
          {formatSessionTitle(s)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs text-slate-300">
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
          {s.directory || "\u2014"}
        </SessionField>
        {s.revert?.messageID && (
          <SessionField label="Revert" span>
            messageID: {s.revert.messageID}
            {s.revert.partID ? ` / partID: ${s.revert.partID}` : ""}
            {s.revert.snapshot ? ` / snapshot: ${s.revert.snapshot}` : ""}
          </SessionField>
        )}
      </div>

      <div className="flex items-center gap-3 mt-1">
        <CopyButton text={s.id} />
        {s.share?.url && (
          <a
            href={s.share.url}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-px text-xs font-bold uppercase tracking-wider text-emerald-400 transition hover:bg-emerald-500/20">
            Open share
          </a>
        )}
        {s.summary && (
          <span className="text-xs text-emerald-400/70">
            +{s.summary.additions}/-{s.summary.deletions} \u00b7{" "}
            {s.summary.files} files
          </span>
        )}
        <button
          onClick={() => onDelete(s.id)}
          disabled={deleting}
          className="ml-auto rounded border border-rose-500/25 bg-rose-500/10 px-2 py-px text-xs font-bold uppercase tracking-wider text-rose-400 transition hover:bg-rose-500/20 disabled:opacity-50"
          type="button">
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>

      {diffs.length > 0 && (
        <details className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs">
          <summary className="cursor-pointer uppercase tracking-wider text-slate-500">
            Diffs ({diffs.length})
          </summary>
          <div className="mt-1 flex flex-col gap-1">
            {diffs.map((diff, i) => (
              <div
                key={i}
                className="rounded border border-white/10 bg-white/5 px-2 py-1">
                <div className="text-slate-200">
                  {diff.path ?? diff.file ?? "unknown"}
                </div>
                {diff.content && (
                  <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words font-sans text-slate-300">
                    {diff.content}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto scrollbar-thin">
        {messages === null ? (
          <div className="flex flex-1 items-center justify-center text-xs text-slate-500">
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
                className={`rounded-xl border px-3 py-2 text-xs leading-relaxed shadow-sm transition-colors ${
                  isUser
                    ? "border-cyan-500/30 bg-cyan-950/20 shadow-[0_2px_10px_rgba(34,211,238,0.05)]"
                    : "border-white/10 bg-white/5"
                }`}>
                <div className="mb-1 flex items-center justify-between gap-2 border-b border-white/5 pb-1">
                  <span className={`text-xs font-bold uppercase tracking-wider ${isUser ? "text-cyan-400" : "text-slate-400"}`}>
                    {isUser ? "You" : "OpenCode"}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">
                    {formatTime(info.time?.created)}
                  </span>
                </div>
                <pre className="whitespace-pre-wrap break-words font-sans text-slate-200 mt-1">
                  {text}
                </pre>
              </div>
            );
          })
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-white/10 bg-white/5 p-4 text-center text-xs text-slate-400">
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
  const [liveStatus, setLiveStatus] = useState(sessionStatus);

  useEffect(() => {
    setLiveStatus(sessionStatus);
  }, [snapshot?.sessionStatus]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await fetchSessionStatus();
        if (!cancelled && next && typeof next === "object") setLiveStatus(next);
      } catch {
        // The connection badge and snapshot error communicate server failures.
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
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
    <section className="panel flex h-full min-h-0 flex-1 flex-col">
      {view === "detail" && detailSession ? (
        <div className="h-full overflow-y-auto p-4">
          <SessionDetail
            session={detailSession}
            onBack={closeDetail}
            onDelete={handleDelete}
            deleting={deletingId === detailSession.id}
          />
        </div>
      ) : (
        <>
          <div className="panel-header shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div>
              </div>
              {configInfo?.model && (
                <span className="text-xs font-medium text-zinc-400 truncate hidden sm:inline">
                  {configInfo.model}
                </span>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="outline" size="icon" onClick={onRefresh}>
                <RotateCcw />
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!connected && (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
                OpenCode offline. Run terminal workspace service to sync active
                environments.
              </div>
            )}

            {snapshot?.error && (
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
                {snapshot.error}
              </div>
            )}

            <div className="flex h-full flex-1 flex-col p-4">
              {sessions.length ? (
                <div className="flex min-h-0 flex-1 gap-2">
                  {["busy", "idle"].map((column) => {
                    const columnSessions = sessions
                      .slice(0, limit)
                      .filter(
                        (session) =>
                          statusKind(liveStatus[session.id]) === column,
                      );
                    return (
                      <div
                        key={column}
                        className="flex min-w-0 flex-1 flex-col bg-white/[0.02] border border-white/5 rounded-xl backdrop-blur-md p-2 shadow-inner">
                        <div className="mb-2 flex items-center justify-between px-2 pt-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold uppercase tracking-widest text-cyan-400/80">
                              {column}
                            </span>
                          </div>
                          <span className="flex items-center justify-center h-5 px-2 rounded-full bg-white/10 text-[10px] font-mono font-bold text-zinc-300 shadow-sm">
                            {columnSessions.length}
                          </span>
                        </div>
                        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 pb-1">
                          {columnSessions.length ? (
                            columnSessions.map((session) => {
                              const isActive = session.id === selectedSessionId;
                              const confirming = confirmingId === session.id;

                              return (
                                <div
                                  key={session.id}
                                  className={`rounded-xl p-3 transition-all duration-300 border ${
                                    isActive
                                      ? "border-cyan-500/50 bg-cyan-950/30 shadow-[0_4px_15px_rgba(34,211,238,0.15)] scale-[1.02]"
                                      : "border-white/5 bg-white/[0.03] hover:bg-white/[0.08] hover:border-white/15"
                                  }`}>
                                  <div className="flex items-start justify-between gap-1">
                                    <button
                                      onClick={() => openDetail(session)}
                                      className="min-w-0 truncate text-left text-xs font-bold text-zinc-100 hover:text-white transition-colors cursor-pointer drop-shadow-sm"
                                      type="button"
                                      title={formatSessionTitle(session)}>
                                      {formatSessionTitle(session)}
                                    </button>
                                    <CopyButton text={session.id} />
                                  </div>
                                  <div className="mt-1 flex items-center gap-1 text-xs text-zinc-400">
                                    <span className="truncate font-mono">
                                      {session.directory?.split(/[\\/]/).pop() || "No directory"}
                                    </span>
                                    <span className="ml-auto shrink-0">
                                      {formatRelativeTime(
                                        session.time?.updated ??
                                          session.time?.created,
                                      )}
                                    </span>
                                  </div>
                                  <div className="mt-1.5 flex items-center gap-1">
                                    <button
                                      onClick={() =>
                                        onSelectSession(
                                          isActive ? null : session.id,
                                        )
                                      }
                                      className={`rounded-lg border h-5 w-5 font-semibold flex items-center justify-center transition-all ${
                                        isActive
                                          ? "border-cyan-400/50 bg-cyan-500 text-black shadow-[0_0_10px_rgba(34,211,238,0.5)]"
                                          : "border-white/10 hover:border-white/30 text-zinc-200 hover:bg-white/5 hover:text-white"
                                      }`}
                                      type="button">
                                      {isActive && (
                                        <Check className="w-3.5 h-3.5" />
                                      )}
                                    </button>
                                    {session.summary && (
                                      <span className="text-xs text-emerald-400/80">
                                        +{session.summary.additions}/-
                                        {session.summary.deletions}
                                      </span>
                                    )}
                                    {confirming ? (
                                      <>
                                        <button
                                          onClick={() =>
                                            handleDelete(session.id)
                                          }
                                          className="ml-auto text-xs text-rose-400"
                                          type="button">
                                          <Check className="w-3 h-3" />
                                        </button>
                                        <button
                                          onClick={() => setConfirmingId(null)}
                                          className="text-xs text-zinc-400"
                                          type="button">
                                          <X className="w-3 h-3" />
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        onClick={() =>
                                          setConfirmingId(session.id)
                                        }
                                        className="ml-auto text-xs text-zinc-400 hover:text-rose-400"
                                        type="button">
                                        <Trash className="w-3 h-3" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div className="py-5 text-center text-xs text-zinc-400">
                              No {column} sessions
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-white/10 bg-white/5 p-6 text-xs text-zinc-400">
                  No sessions created yet
                </div>
              )}

              {sessions.length > limit && (
                <button
                  onClick={() => setLimit((l) => l + 8)}
                  className="mt-2 rounded-lg border border-white/10 bg-white/5 py-2.5 text-xs font-semibold text-zinc-200 transition hover:bg-white/10 hover:text-white cursor-pointer shadow-sm"
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
