import { useMemo, useState } from "react";

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

function formatRelativeTime(value) {
  if (!value) return "";
  const diff = Date.now() - value;
  if (diff < 15_000) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function toneForAction(action) {
  if (action === "saved") return "good";
  if (action === "skipped") return "warning";
  if (action === "error") return "danger";
  return "neutral";
}

function labelForAction(action) {
  if (action === "saved") return "Saved";
  if (action === "skipped") return "Skipped";
  if (action === "error") return "Error";
  return action || "Event";
}

function trimMemory(memory) {
  if (!memory) return "No detail captured.";
  if (memory.length <= 180) return memory;
  return `${memory.slice(0, 177)}...`;
}

function formatMemoryTitle(memory) {
  if (!memory) return "Untitled memory";
  return memory.title || memory.summary || trimMemory(memory.content || "");
}

function formatMemoryTime(value) {
  if (!value) return "";
  const ts = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ts)) return "";
  return formatRelativeTime(ts);
}

function memoryStatusTone(status) {
  if (status === "done") return "good";
  if (status === "queued" || status === "indexing" || status === "extracting")
    return "warning";
  if (status === "failed") return "danger";
  return "neutral";
}

export function MemoryPanel({
  events = [],
  memories = [],
  loading = false,
  error = null,
}) {
  const stats = useMemo(() => {
    return events.reduce(
      (acc, event) => {
        if (event.action === "saved") acc.saved += 1;
        else if (event.action === "skipped") acc.skipped += 1;
        else if (event.action === "error") acc.errors += 1;
        return acc;
      },
      { saved: 0, skipped: 0, errors: 0 },
    );
  }, [events]);
  const [showAll, setShowAll] = useState(false);
  const visibleMemories = showAll ? memories : memories.slice(0, 10);
  const hiddenCount = Math.max(0, memories.length - 10);

  return (
    <section className="flex h-full w-full flex-col min-h-0 bg-bg-200/50">
      <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-white tracking-wide">Memory Bank</h2>
          <div className="mt-1 text-[11px] text-gray-800">
            Durable knowledge dynamically saved by the agent.
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <Badge tone="neutral">Total {memories.length}</Badge>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        {loading && <div className="text-[12px] font-medium text-gray-800 text-center">Syncing database...</div>}

        {error && (
          <div className="rounded-xl border border-accent-rose/20 bg-accent-rose/10 px-4 py-3 text-[12px] text-accent-rose">
            Error loading memories: {error}
          </div>
        )}

        {!loading && !error && visibleMemories.length ? (
          <div className="grid gap-3">
            {visibleMemories.map((memory) => (
              <div
                key={memory.id}
                className="rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-all duration-200 px-4 py-3 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-white break-words">
                      {formatMemoryTitle(memory)}
                    </div>
                    <div className="mt-1.5 font-mono text-[10px] tracking-wider text-gray-800 flex items-center gap-2 flex-wrap">
                      <span className="text-accent-blue font-semibold uppercase">{memory.type || "memory"}</span>
                      {memory.filepath ? (
                        <>
                          <span className="text-gray-400">·</span>
                          <span className="truncate max-w-[200px] text-gray-900">{memory.filepath}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge tone={memoryStatusTone(memory.status)}>
                      {memory.status || "saved"}
                    </Badge>
                    <span className="text-[10px] font-medium text-gray-800">
                      {formatMemoryTime(memory.updatedAt || memory.createdAt)}
                    </span>
                  </div>
                </div>

                <div className="mt-3 text-[12px] leading-relaxed text-gray-900 break-words">
                  {trimMemory(memory.content || memory.summary || "")}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-[13px] text-gray-800 border border-dashed border-white/10 rounded-2xl p-6 bg-white/5 my-auto">
            {loading
              ? "Reading memories..."
              : "No saved memories. Tell SpeakBro facts to remember."}
          </div>
        )}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 py-2.5 text-[11px] font-semibold text-gray-900 hover:text-white transition hover:bg-white/10 cursor-pointer shadow-sm">
            Show all {memories.length} memories
          </button>
        )}

        <div className="pt-6 border-t border-white/10 mt-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-[12px] font-semibold text-white tracking-wide uppercase">Live Activity</h3>
              <div className="mt-1 text-[11px] text-gray-800">Recent memory save, skip, and index operations.</div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {events.length ? (
              events.map((event) => (
                <div
                  key={event.id}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:bg-white/10 transition shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone={toneForAction(event.action)}>
                        {labelForAction(event.action)}
                      </Badge>
                      <span className="truncate text-[10px] font-mono tracking-wider text-gray-800 uppercase font-semibold">
                        {event.category || "uncategorized"}
                      </span>
                    </div>
                    <span className="text-[10px] font-medium text-gray-800">
                      {formatRelativeTime(event.ts)}
                    </span>
                  </div>

                  <div className="mt-2.5 text-[12px] leading-relaxed text-gray-900 break-words">
                    {trimMemory(event.memory)}
                  </div>

                  {event.reason && (
                    <div className="mt-1.5 text-[11px] text-gray-800 italic">
                      {event.reason}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-white/10 bg-white/5 p-4 text-center text-[11px] text-gray-800">
                No active session logs.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
