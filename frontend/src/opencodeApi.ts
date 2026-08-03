export const OPENCODE_API_BASE_URL = import.meta.env.VITE_OPENCODE_API_BASE_URL;

export function opencodeUrl(path) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${OPENCODE_API_BASE_URL}${normalizedPath}`;
}

export function formatStatusLabel(status) {
  if (!status) return "Unknown";
  if (typeof status === "string") return status;
  return status.type ?? status.state ?? status.status ?? "Unknown";
}

export function formatStatusMessage(status) {
  if (!status || typeof status === "string") return "";
  if (status.type === "retry") return status.message ?? "";
  return "";
}

export function formatSessionTitle(session) {
  if (!session) return "No session";
  return session.title || `Session ${(session.id ?? "").slice(0, 8)}`;
}

export function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

export async function fetchSessionStatus() {
  return fetchJSON(opencodeUrl("/session/status"));
}

export async function fetchSnapshot() {
  const [sessions, sessionStatus, config, pathInfo] = await Promise.all([
    fetchJSON(opencodeUrl("/session")),
    fetchJSON(opencodeUrl("/session/status")),
    fetchJSON(opencodeUrl("/config")),
    fetchJSON(opencodeUrl("/path")),
  ]);

  return {
    sessions,
    sessionStatus,
    config,
    path: pathInfo,
    connected: true,
    lastSyncAt: Date.now(),
  };
}

export async function createSession(title) {
  return fetchJSON(opencodeUrl("/session"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteSession(id) {
  return fetchJSON(opencodeUrl(`/session/${id}`), { method: "DELETE" });
}

export async function fetchSession(id) {
  return fetchJSON(opencodeUrl(`/session/${id}`));
}

export async function fetchSessionMessages(id, limit) {
  try {
    const query = limit ? `?limit=${encodeURIComponent(limit)}` : "";
    const data = await fetchJSON(opencodeUrl(`/session/${id}/message${query}`));
    const items = Array.isArray(data) ? data : [];
    return items.map((item) => ({
      info: item.info ?? {},
      parts: item.parts ?? [],
    }));
  } catch {
    return [];
  }
}

export async function sendMessageToSession(id, message) {
  return fetchJSON(opencodeUrl(`/session/${id}/prompt_async`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text: message }],
    }),
  });
}

async function fetchJSON(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}
