import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

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
  if (action === "saved") return "default";
  if (action === "skipped") return "secondary";
  if (action === "error") return "destructive";
  return "secondary";
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
  if (status === "done") return "default";
  if (status === "queued" || status === "indexing" || status === "extracting")
    return "secondary";
  if (status === "failed") return "destructive";
  return "secondary";
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
          <span className="text-sm font-semibold text-zinc-100">Memory</span>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Badge variant="secondary">Total {memories.length}</Badge>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
        {loading && (
          <div className="text-sm font-medium text-zinc-400 text-center">
            Syncing database...
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
            Error loading memories: {error}
          </div>
        )}

        {!loading && !error && visibleMemories.length ? (
          <div className="grid gap-3">
            {visibleMemories.map((memory) => (
              <Card
                key={memory.id}
                className="border-white/10 bg-white/[0.03] transition-colors hover:bg-white/[0.06]">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="text-sm font-semibold text-white break-words">
                      {formatMemoryTitle(memory)}
                    </CardTitle>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <Badge variant={memoryStatusTone(memory.status)}>
                        {memory.status || "saved"}
                      </Badge>
                      <span className="text-xs font-medium text-zinc-400">
                        {formatMemoryTime(memory.updatedAt || memory.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="mt-1.5 font-mono text-xs tracking-wider text-zinc-400 flex items-center gap-2 flex-wrap">
                    <span className="text-sky-400 font-semibold uppercase">
                      {memory.type || "memory"}
                    </span>
                    {memory.filepath ? (
                      <>
                        <span className="text-zinc-600">·</span>
                        <span className="truncate max-w-xs text-zinc-200">
                          {memory.filepath}
                        </span>
                      </>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="text-sm leading-relaxed text-zinc-200 break-words">
                    {trimMemory(memory.content || memory.summary || "")}
                  </div>
                </CardContent>
              </Card>
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

        <Separator className="border-t-white/10 mt-2 pt-6" />

        <div className="flex items-center justify-between mb-4">
          <div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {events.length ? (
            events.map((event) => (
              <Card
                key={event.id}
                className="border-white/10 bg-white/[0.03] transition-colors hover:bg-white/[0.06]">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Badge variant={toneForAction(event.action)}>
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
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-white/10 bg-white/5 p-4 text-center text-xs text-zinc-400">
              No active session logs.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
