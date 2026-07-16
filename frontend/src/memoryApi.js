export async function fetchMemories() {
  const data = await fetchJSON("/memories");
  const memories = Array.isArray(data.memories) ? data.memories : [];
  return {
    memories,
    count: typeof data.count === "number" ? data.count : memories.length,
    containerTags: Array.isArray(data.containerTags) ? data.containerTags : [],
  };
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}
