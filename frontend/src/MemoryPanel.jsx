import { useMemo, useState } from "react";

function Badge({ children, tone = "neutral" }) {
  const tones = {
    neutral: "border-white/10 bg-white/5 text-zinc-300",
    good: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    warning: "border-amber-500/20 bg-amber-500/10 text-amber-300",
    danger: "border-rose-500/20 bg-rose-500/10 text-rose-300",
  };

  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-medium ${tones[tone] || tones.neutral}`}>
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
    <section className="panel flex h-full w-full min-h-0 flex-col md:rounded-lg">
      <div className="panel-header shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white">Memory bank</h2>
          <div className="mt-1 text-xs text-zinc-500">
            Durable knowledge saved by the agent.
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge tone="neutral">Total {memories.length}</Badge>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
        {loading && <div className="text-sm font-medium text-zinc-400 text-center">Syncing database...</div>}

        {error && (
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
            Error loading memories: {error}
          </div>
        )}

        {!loading && !error && visibleMemories.length ? (
          <div className="grid gap-3">
            {visibleMemories.map((memory) => (
              <div
                key={memory.id}
                className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 transition-colors hover:bg-white/[0.06]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-white break-words">
                      {formatMemoryTitle(memory)}
                    </div>
                    <div className="mt-1.5 font-mono text-xs tracking-wider text-zinc-400 flex items-center gap-2 flex-wrap">
                      <span className="text-sky-400 font-semibold uppercase">{memory.type || "memory"}</span>
                      {memory.filepath ? (
                        <>
                          <span className="text-zinc-600">·</span>
                          <span className="truncate max-w-xs text-zinc-200">{memory.filepath}</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <Badge tone={memoryStatusTone(memory.status)}>
                      {memory.status || "saved"}
                    </Badge>
                    <span className="text-xs font-medium text-zinc-400">
                      {formatMemoryTime(memory.updatedAt || memory.createdAt)}
                    </span>
                  </div>
                </div>

                <div className="mt-3 text-sm leading-relaxed text-zinc-200 break-words">
                  {trimMemory(memory.content || memory.summary || "")}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-400 border border-dashed border-white/10 rounded-lg p-6 bg-white/5 my-auto">
            {loading
              ? "Reading memories..."
              : "No saved memories. Tell SpeakBro facts to remember."}
          </div>
        )}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 py-2.5 text-xs font-semibold text-zinc-200 hover:text-white transition hover:bg-white/10 cursor-pointer shadow-sm">
            Show all {memories.length} memories
          </button>
        )}

        <div className="pt-6 border-t border-white/10 mt-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white tracking-wide uppercase">Live Activity</h3>
              <div className="mt-1 text-xs text-zinc-400">Recent memory save, skip, and index operations.</div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {events.length ? (
              events.map((event) => (
                <div
                  key={event.id}
                  className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 transition-colors hover:bg-white/[0.06]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge tone={toneForAction(event.action)}>
                        {labelForAction(event.action)}
                      </Badge>
                      <span className="truncate text-xs font-mono tracking-wider text-zinc-400 uppercase font-semibold">
                        {event.category || "uncategorized"}
                      </span>
                    </div>
                    <span className="text-xs font-medium text-zinc-400">
                      {formatRelativeTime(event.ts)}
                    </span>
                  </div>

                  <div className="mt-2.5 text-sm leading-relaxed text-zinc-200 break-words">
                    {trimMemory(event.memory)}
                  </div>

                  {event.reason && (
                    <div className="mt-1.5 text-xs text-zinc-400 italic">
                      {event.reason}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-white/10 bg-white/5 p-4 text-center text-xs text-zinc-400">
                No active session logs.
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
