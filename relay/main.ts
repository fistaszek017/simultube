/*
 * SymulTube — relay sygnalizacyjny (Twoja "skrytka na klucz")
 * ------------------------------------------------------------
 * Malutki serwer, który pośredniczy TYLKO przy nawiązaniu połączenia
 * (przekazuje dane WebRTC: offer/answer). Nie przechodzą przez niego
 * żadne dane wideo ani sterowania — te lecą bezpośrednio P2P.
 *
 * Hosting: https://dash.deno.com  (darmowe, logowanie GitHubem)
 *
 * PRZECHOWYWANIE:
 *  - Jeśli do aplikacji jest podłączona baza Deno KV — używa KV (najlepsze,
 *    działa niezawodnie między regionami).
 *  - Jeśli KV nie ma — używa pamięci RAM (działa od ręki, bez konfiguracji;
 *    wystarcza do zwykłego użytku, bo dane łączenia żyją tylko kilka sekund).
 *
 * Lokalnie:  deno run -A --unstable-kv relay/main.ts
 */

const TTL_MS = 10 * 60 * 1000; // dane znikają po 10 minutach

// ---- Abstrakcja przechowywania ----
interface Item { sdp: string; expireAt: number; }

interface Store {
  setOffer(room: string, id: string, sdp: string): Promise<void>;
  listOffers(room: string): Promise<Array<{ id: string; sdp: string }>>;
  setAnswer(room: string, id: string, sdp: string): Promise<void>;
  getAnswer(room: string, id: string): Promise<string | null>;
}

// Wariant: pamięć RAM
function memoryStore(): Store {
  const offers = new Map<string, Item>();   // klucz: room + "\0" + id
  const answers = new Map<string, Item>();
  const k = (room: string, id: string) => room + "\0" + id;
  const alive = (it?: Item) => it && it.expireAt > Date.now();
  const sweep = (m: Map<string, Item>) => {
    const now = Date.now();
    for (const [key, it] of m) if (it.expireAt <= now) m.delete(key);
  };
  return {
    async setOffer(room, id, sdp) { offers.set(k(room, id), { sdp, expireAt: Date.now() + TTL_MS }); },
    async listOffers(room) {
      sweep(offers); sweep(answers);
      const out: Array<{ id: string; sdp: string }> = [];
      const prefix = room + "\0";
      for (const [key, it] of offers) {
        if (!key.startsWith(prefix) || !alive(it)) continue;
        const id = key.slice(prefix.length);
        if (!alive(answers.get(k(room, id)))) out.push({ id, sdp: it.sdp });
      }
      return out;
    },
    async setAnswer(room, id, sdp) { answers.set(k(room, id), { sdp, expireAt: Date.now() + TTL_MS }); },
    async getAnswer(room, id) { const it = answers.get(k(room, id)); return alive(it) ? it!.sdp : null; },
  };
}

// Wariant: Deno KV
function kvStore(kv: Deno.Kv): Store {
  return {
    async setOffer(room, id, sdp) { await kv.set(["offer", room, id], { sdp }, { expireIn: TTL_MS }); },
    async listOffers(room) {
      const out: Array<{ id: string; sdp: string }> = [];
      for await (const e of kv.list<{ sdp: string }>({ prefix: ["offer", room] })) {
        const id = String(e.key[2]);
        const ans = await kv.get(["answer", room, id]);
        if (!ans.value) out.push({ id, sdp: e.value.sdp });
      }
      return out;
    },
    async setAnswer(room, id, sdp) { await kv.set(["answer", room, id], { sdp }, { expireIn: TTL_MS }); },
    async getAnswer(room, id) { const a = await kv.get<{ sdp: string }>(["answer", room, id]); return a.value?.sdp ?? null; },
  };
}

// Wybór magazynu — KV jeśli dostępne, inaczej pamięć
let store: Store;
try {
  const kv = await Deno.openKv();
  store = kvStore(kv);
  console.log("SymulTube relay: używam Deno KV");
} catch (_) {
  store = memoryStore();
  console.log("SymulTube relay: brak KV — używam pamięci RAM (fallback)");
}

// ---- HTTP ----
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve({ port: Number(Deno.env.get("PORT")) || 8000 }, async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname;

  try {
    if (req.method === "POST" && path === "/offer") {
      const { room, id, sdp } = await req.json();
      if (!room || !id || !sdp) return json({ error: "bad request" }, 400);
      await store.setOffer(room, id, sdp);
      return json({ ok: true });
    }

    if (req.method === "GET" && path === "/offers") {
      const room = url.searchParams.get("room");
      if (!room) return json({ error: "bad request" }, 400);
      return json({ offers: await store.listOffers(room) });
    }

    if (req.method === "POST" && path === "/answer") {
      const { room, id, sdp } = await req.json();
      if (!room || !id || !sdp) return json({ error: "bad request" }, 400);
      await store.setAnswer(room, id, sdp);
      return json({ ok: true });
    }

    if (req.method === "GET" && path === "/answer") {
      const room = url.searchParams.get("room");
      const id = url.searchParams.get("id");
      if (!room || !id) return json({ error: "bad request" }, 400);
      return json({ sdp: await store.getAnswer(room, id) });
    }

    if (path === "/") return new Response("SymulTube relay działa ✓", { headers: CORS });
    return json({ error: "not found" }, 404);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
