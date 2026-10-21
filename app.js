/* SymulTube - wspólne oglądanie YouTube
   WebRTC + lekki relay sygnalizacyjny (Twoja "skrytka").
   - Jeden link dla wszystkich widzów, zero kodów do przepisywania
   - Multi-user: jeden host, wielu widzów (gwiazda)
   - Przez relay lecą TYLKO dane łączenia; wideo/sterowanie idą P2P */

(() => {
  "use strict";

  // === KONFIGURACJA ===
  // Wpisz tu adres swojego relaya z Deno Deploy PRZED publikacją na GitHub Pages.
  // Możesz też ustawić go tymczasowo w przeglądarce (ekran "Skonfiguruj relay").
  // UWAGA: adres MUSI zaczynać się od https:// — bez tego fetch potraktuje go jako
  // ścieżkę względną i trafi na GitHub Pages (błąd 405). Poniżej i tak to dokładamy.
  const RELAY_DEFAULT = "https://happy-mandrill-6605.fistaszek017.deno.net";

  function normalizeRelay(u) {
    u = (u || "").trim().replace(/\/+$/, "");
    if (u && !/^https?:\/\//i.test(u)) u = "https://" + u; // dodaj schemat, jeśli brakuje
    return u;
  }
  let RELAY_URL = normalizeRelay(localStorage.getItem("symultube_relay") || RELAY_DEFAULT);

  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ],
  };

  // ---- Stan ----
  let role = null;
  let player = null;
  let ytReady = false;
  let playerReady = false;
  let currentVideoId = null;
  let roomId = null;
  let pendingState = null;

  const hostPeers = new Map();   // viewerId -> {pc}
  let viewerPc = null;
  let viewerDc = null;

  // ---- UI ----
  const $ = (id) => document.getElementById(id);
  const ui = {
    status: $("status"),
    relayMissing: $("relayMissing"),
    relayInput: $("relayInput"),
    relaySaveBtn: $("relaySaveBtn"),
    roleScreen: $("roleScreen"),
    roleHostBtn: $("roleHostBtn"),
    roleViewerBtn: $("roleViewerBtn"),
    hostSetup: $("hostSetup"),
    ytUrl: $("ytUrl"),
    createBtn: $("createBtn"),
    setupError: $("setupError"),
    hostRoom: $("hostRoom"),
    methodRelay: $("methodRelay"),
    shareLink: $("shareLink"),
    copyLinkBtn: $("copyLinkBtn"),
    relayDownNote: $("relayDownNote"),
    inviteList: $("inviteList"),
    addInviteBtn: $("addInviteBtn"),
    viewerCount: $("viewerCount"),
    viewerJoin: $("viewerJoin"),
    viewerJoinMsg: $("viewerJoinMsg"),
    viewerJoinError: $("viewerJoinError"),
    viewerManual: $("viewerManual"),
    answerOut: $("answerOut"),
    copyAnswerBtn: $("copyAnswerBtn"),
    viewerManualError: $("viewerManualError"),
    playerWrap: $("playerWrap"),
    viewerOverlay: $("viewerOverlay"),
    hostControls: $("hostControls"),
    viewerBar: $("viewerBar"),
    playBtn: $("playBtn"),
    pauseBtn: $("pauseBtn"),
    syncBtn: $("syncBtn"),
    unmuteBtn: $("unmuteBtn"),
    cinemaBtnHost: $("cinemaBtnHost"),
    cinemaBtnViewer: $("cinemaBtnViewer"),
    fsBtnHost: $("fsBtnHost"),
    fsBtnViewer: $("fsBtnViewer"),
    viewerProgress: $("viewerProgress"),
    curTime: $("curTime"),
    durTime: $("durTime"),
    progressFill: $("progressFill"),
  };

  function setStatus(t, k) { ui.status.textContent = t; ui.status.className = "status status--" + k; }
  function showError(el, m) { el.textContent = m; el.classList.remove("hidden"); }
  function clearError(el) { el.classList.add("hidden"); }
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function relayConfigured() { return /^https?:\/\//i.test(RELAY_URL) && !RELAY_URL.includes("CHANGE-ME"); }

  function parseVideoId(input) {
    if (!input) return null;
    input = input.trim();
    if (/^[\w-]{11}$/.test(input)) return input;
    try {
      const url = new URL(input);
      if (url.hostname.includes("youtu.be")) return url.pathname.slice(1, 12) || null;
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const m = url.pathname.match(/\/(embed|shorts|v)\/([\w-]{11})/);
      if (m) return m[2];
    } catch (_) {
      const m = input.match(/[\w-]{11}/);
      if (m) return m[0];
    }
    return null;
  }

  function randomId(len) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    const arr = new Uint32Array(len);
    crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) s += chars[arr[i] % chars.length];
    return s;
  }

  function waitForIce(connection) {
    return new Promise((resolve) => {
      if (connection.iceGatheringState === "complete") return resolve();
      const check = () => {
        if (connection.iceGatheringState === "complete") {
          connection.removeEventListener("icegatheringstatechange", check);
          resolve();
        }
      };
      connection.addEventListener("icegatheringstatechange", check);
      setTimeout(resolve, 2500);
    });
  }

  // ---- Kodowanie/kompresja kodów (tryb awaryjny) ----
  function b64urlFromBytes(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function bytesFromB64url(str) {
    str = str.replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function pack(obj) {
    const json = JSON.stringify(obj);
    if (window.CompressionStream) {
      const cs = new CompressionStream("gzip");
      const buf = await new Response(new Blob([json]).stream().pipeThrough(cs)).arrayBuffer();
      return "G" + b64urlFromBytes(new Uint8Array(buf));
    }
    return "R" + b64urlFromBytes(new TextEncoder().encode(json));
  }
  async function unpack(code) {
    code = (code || "").trim();
    const idx = code.indexOf("#join=");
    if (idx !== -1) code = code.slice(idx + 6);
    const tag = code[0];
    const bytes = bytesFromB64url(code.slice(1));
    if (tag === "G") {
      if (!window.DecompressionStream) throw new Error("brak dekompresji");
      const txt = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      return JSON.parse(txt);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function manualLink(code) {
    return `${location.origin}${location.pathname}#join=${code}`;
  }

  // ---- Relay (fetch z ponawianiem) ----
  // Nowy Deno Deploy po wdrożeniu "rozgrzewa" izolat i potrafi chwilowo
  // zwracać 5xx (np. 501). Ponawiamy na błędach serwera/sieci; 4xx rzucamy od razu.
  async function relayFetch(path, options, tries = 4) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(RELAY_URL + path, options);
        if (r.ok) return r.json();
        if (r.status < 500) throw new Error("relay " + r.status); // 4xx = nie ponawiaj
        lastErr = new Error("relay " + r.status);
      } catch (e) {
        lastErr = e;
        if (/relay 4\d\d/.test(e.message)) throw e;
      }
      if (i < tries - 1) await new Promise((res) => setTimeout(res, 800));
    }
    throw lastErr;
  }
  function relayPost(path, body) {
    return relayFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  function relayGet(path) {
    return relayFetch(path, undefined);
  }

  // ---- YouTube ----
  window.onYouTubeIframeAPIReady = function () { ytReady = true; };

  function createPlayer(videoId, asViewer) {
    if (player) return;
    const build = () => {
      player = new YT.Player("player", {
        videoId: videoId || undefined,
        playerVars: {
          autoplay: 0, controls: asViewer ? 0 : 1, disablekb: asViewer ? 1 : 0,
          modestbranding: 1, rel: 0, playsinline: 1, origin: location.origin,
        },
        events: {
          onReady: () => {
            playerReady = true;
            if (asViewer) {
              player.mute();
              if (pendingState) { applyState(pendingState); pendingState = null; }
              startProgressLoop();
            }
          },
          onStateChange: role === "host" ? onHostStateChange : undefined,
        },
      });
    };
    if (ytReady) build();
    else {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { ytReady = true; if (prev) prev(); build(); };
    }
  }

  // =====================================================================
  //  HOST
  // =====================================================================
  function initHostUi() {
    role = "host";
    hide(ui.roleScreen);
    show(ui.hostSetup);
    setStatus("Wybierz film", "wait");
    ui.createBtn.addEventListener("click", onCreateRoom);
    ui.addInviteBtn.addEventListener("click", () => createManualInvite());
    ui.playBtn.addEventListener("click", () => player && player.playVideo());
    ui.pauseBtn.addEventListener("click", () => player && player.pauseVideo());
    ui.syncBtn.addEventListener("click", broadcastSync);
    ui.copyLinkBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(ui.shareLink.value);
        ui.copyLinkBtn.textContent = "Skopiowano ✓";
        setTimeout(() => (ui.copyLinkBtn.textContent = "Kopiuj"), 1500);
      } catch (_) { ui.shareLink.select(); }
    });
  }

  function onCreateRoom() {
    clearError(ui.setupError);
    const vid = parseVideoId(ui.ytUrl.value);
    if (!vid) { showError(ui.setupError, "Nieprawidłowy link do YouTube."); return; }
    currentVideoId = vid;

    hide(ui.hostSetup);
    show(ui.playerWrap);
    show(ui.hostControls);
    show(ui.hostRoom);
    createPlayer(vid, false);

    if (relayConfigured()) {
      roomId = randomId(8);
      ui.shareLink.value = `${location.origin}${location.pathname}#room=${roomId}&v=${vid}`;
      startHostPolling();
    } else {
      // Bez relaya: ukryj łatwy link, zostaje tryb awaryjny
      hide(ui.methodRelay);
    }
    setStatus("Pokój otwarty — czeka na widzów", "on");
    startHeartbeat();
  }

  // ---- HOST: tryb awaryjny (ręczny kod) ----
  let inviteCounter = 0;
  async function createManualInvite() {
    inviteCounter += 1;
    const key = "m" + inviteCounter;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel("sync", { ordered: true });
    hostPeers.set(key, { pc, dc });
    setupHostChannel(key, dc);
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") setInviteStatus(els, "połączony ✓", "on");
      else if (s === "failed" || s === "closed" || s === "disconnected") { hostPeers.delete(key); updateViewerCount(); setInviteStatus(els, "rozłączony", "off"); }
    };

    const els = buildInviteCard(key);
    ui.inviteList.appendChild(els.card);
    setInviteStatus(els, "generuję link…", "wait");

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);
      const code = await pack({ s: pc.localDescription.sdp, v: currentVideoId });
      els.link.value = manualLink(code);
      setInviteStatus(els, "wyślij link i czekaj na kod zwrotny", "wait");
    } catch (err) {
      console.error(err);
      setInviteStatus(els, "błąd: " + err.message, "off");
    }
  }

  function buildInviteCard(key) {
    const card = document.createElement("div");
    card.className = "invite";
    const head = document.createElement("div");
    head.className = "invite__head";
    const title = document.createElement("strong");
    title.textContent = "Widz awaryjny #" + key.slice(1);
    const status = document.createElement("span");
    status.className = "invite__status";
    head.append(title, status);

    const linkLabel = document.createElement("label");
    linkLabel.className = "invite__label";
    linkLabel.textContent = "Link awaryjny (wyślij widzowi):";
    const link = document.createElement("textarea");
    link.className = "code-area"; link.rows = 2; link.readOnly = true;
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn"; copyBtn.textContent = "Kopiuj link";
    copyBtn.addEventListener("click", () => copyText(link.value, copyBtn, link));

    const ansLabel = document.createElement("label");
    ansLabel.className = "invite__label";
    ansLabel.textContent = "Kod zwrotny od widza:";
    const answer = document.createElement("textarea");
    answer.className = "code-area"; answer.rows = 2;
    answer.placeholder = "Wklej kod zwrotny, który odesłał widz…";
    const connectBtn = document.createElement("button");
    connectBtn.className = "btn btn--primary"; connectBtn.textContent = "Połącz";

    const els = { card, status, link, answer, connectBtn };
    connectBtn.addEventListener("click", () => acceptManualAnswer(key, answer.value, els));

    card.append(head, linkLabel, link, copyBtn, ansLabel, answer, connectBtn);
    return els;
  }

  function setInviteStatus(els, text, kind) {
    if (!els) return;
    els.status.textContent = text;
    els.status.className = "invite__status invite__status--" + kind;
  }

  async function acceptManualAnswer(key, code, els) {
    const entry = hostPeers.get(key);
    if (!entry) return;
    let payload;
    try {
      payload = await unpack(code);
      if (!payload || !payload.s) throw new Error("brak danych");
    } catch (_) {
      setInviteStatus(els, "nieprawidłowy kod zwrotny", "off");
      return;
    }
    try {
      await entry.pc.setRemoteDescription({ type: "answer", sdp: payload.s });
      els.connectBtn.disabled = true;
      els.connectBtn.textContent = "Łączenie…";
      setInviteStatus(els, "łączenie…", "wait");
    } catch (err) {
      console.error(err);
      setInviteStatus(els, "błąd: " + err.message, "off");
    }
  }

  async function copyText(text, btn, fallbackEl) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Skopiowano ✓";
      setTimeout(() => (btn.textContent = old), 1500);
    } catch (_) { if (fallbackEl) { fallbackEl.focus(); fallbackEl.select(); } }
  }

  const handledViewers = new Set();
  let hostPolling = false;
  let relayFailStreak = 0;
  function startHostPolling() {
    setInterval(async () => {
      if (hostPolling || !relayConfigured()) return;
      hostPolling = true;
      try {
        const { offers } = await relayGet(`/offers?room=${encodeURIComponent(roomId)}`);
        relayFailStreak = 0;
        hide(ui.relayDownNote);
        for (const o of offers || []) {
          if (handledViewers.has(o.id)) continue;
          handledViewers.add(o.id);
          answerViewer(o.id, o.sdp);
        }
      } catch (_) {
        relayFailStreak++;
        if (relayFailStreak >= 3) show(ui.relayDownNote); // relay wygląda na niedostępny
      } finally { hostPolling = false; }
    }, 1500);
  }

  async function answerViewer(viewerId, offerSdp) {
    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      hostPeers.set(viewerId, { pc, dc: null });
      pc.ondatachannel = (e) => setupHostChannel(viewerId, e.channel);
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === "failed" || s === "closed" || s === "disconnected") {
          hostPeers.delete(viewerId);
          updateViewerCount();
        }
      };
      await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIce(pc);
      await relayPost("/answer", { room: roomId, id: viewerId, sdp: pc.localDescription.sdp });
    } catch (err) {
      console.error("answerViewer:", err);
      hostPeers.delete(viewerId);
    }
  }

  function setupHostChannel(viewerId, ch) {
    const entry = hostPeers.get(viewerId);
    if (entry) entry.dc = ch;
    ch.onopen = () => { updateViewerCount(); sendTo(ch, buildState()); };
    ch.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } if (m.type === "hello") sendTo(ch, buildState()); };
    ch.onclose = () => { hostPeers.delete(viewerId); updateViewerCount(); };
    ch.onerror = () => {};
  }

  function updateViewerCount() {
    let n = 0;
    hostPeers.forEach((e) => { if (e.dc && e.dc.readyState === "open") n++; });
    ui.viewerCount.textContent = String(n);
    setStatus(n > 0 ? `Oglądających: ${n}` : "Pokój otwarty — czeka na widzów", n > 0 ? "on" : "wait");
  }

  function sendTo(ch, msg) { if (ch && ch.readyState === "open") { try { ch.send(JSON.stringify(msg)); } catch (_) {} } }
  function broadcast(msg) { hostPeers.forEach((e) => sendTo(e.dc, msg)); }

  function buildState() {
    const playing = playerReady && player.getPlayerState() === YT.PlayerState.PLAYING;
    return { type: "state", videoId: currentVideoId, t: playerReady ? player.getCurrentTime() : 0, playing };
  }
  function onHostStateChange(e) {
    if (!playerReady) return;
    const t = player.getCurrentTime();
    if (e.data === YT.PlayerState.PLAYING) broadcast({ type: "play", t, videoId: currentVideoId });
    else if (e.data === YT.PlayerState.PAUSED) broadcast({ type: "pause", t });
    else if (e.data === YT.PlayerState.ENDED) broadcast({ type: "pause", t });
  }
  function broadcastSync() {
    if (!playerReady) return;
    broadcast({ type: "sync", t: player.getCurrentTime(), playing: player.getPlayerState() === YT.PlayerState.PLAYING, videoId: currentVideoId });
  }
  let heartbeat = null;
  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => { if (playerReady && hostPeers.size) broadcastSync(); }, 2000);
  }

  // =====================================================================
  //  WIDZ
  // =====================================================================
  async function initViewerAuto(room, vid) {
    role = "viewer";
    hide(ui.roleScreen);
    show(ui.viewerJoin);
    setStatus("Łączę z hostem…", "wait");

    ui.unmuteBtn.addEventListener("click", () => {
      if (!player) return;
      player.unMute(); player.setVolume(100);
      ui.unmuteBtn.textContent = "🔊 Dźwięk włączony";
    });

    currentVideoId = vid || null;
    roomId = room;
    const viewerId = randomId(10);

    try {
      viewerPc = new RTCPeerConnection(RTC_CONFIG);
      viewerPc.onconnectionstatechange = () => {
        const s = viewerPc.connectionState;
        if (s === "connected") setStatus("Połączono ✓", "on");
        else if (s === "failed") { setStatus("Połączenie nieudane", "off"); showError(ui.viewerJoinError, "Nie udało się połączyć z hostem (możliwa blokada sieci / NAT)."); }
      };
      viewerDc = viewerPc.createDataChannel("sync", { ordered: true });
      setupViewerChannel(viewerDc);

      const offer = await viewerPc.createOffer();
      await viewerPc.setLocalDescription(offer);
      await waitForIce(viewerPc);

      await relayPost("/offer", { room, id: viewerId, sdp: viewerPc.localDescription.sdp });
      ui.viewerJoinMsg.textContent = "Czekam, aż host odbierze połączenie…";

      // Pokaż player (zablokowany) od razu
      show(ui.playerWrap);
      show(ui.viewerBar);
      show(ui.viewerOverlay);
      createPlayer(currentVideoId, true);

      pollForAnswer(room, viewerId);
    } catch (err) {
      console.error(err);
      showError(ui.viewerJoinError, "Błąd łączenia: " + err.message);
      setStatus("Błąd", "off");
    }
  }

  function pollForAnswer(room, viewerId) {
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      if (tries > 40) { // ~60 s
        clearInterval(timer);
        if (viewerPc.connectionState !== "connected") {
          showError(ui.viewerJoinError, "Host nie odebrał połączenia. Upewnij się, że ma otwartą stronę, i odśwież.");
          setStatus("Host nie odpowiada", "off");
        }
        return;
      }
      try {
        const { sdp } = await relayGet(`/answer?room=${encodeURIComponent(room)}&id=${encodeURIComponent(viewerId)}`);
        if (sdp) {
          clearInterval(timer);
          await viewerPc.setRemoteDescription({ type: "answer", sdp });
          hide(ui.viewerJoin);
          setStatus("Łączenie…", "wait");
        }
      } catch (_) { /* retry */ }
    }, 1500);
  }

  function setupViewerChannel(channel) {
    channel.onopen = () => { setStatus("Połączono ✓", "on"); hide(ui.viewerJoin); hide(ui.viewerManual); sendTo(channel, { type: "hello" }); };
    channel.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } applyRemote(m); };
    channel.onclose = () => setStatus("Host rozłączony", "off");
    channel.onerror = () => {};
  }

  function applyRemote(msg) {
    if (!msg || !msg.type) return;
    if (!playerReady) { if (msg.type === "state" || msg.type === "sync") pendingState = msg; return; }
    switch (msg.type) {
      case "state":
      case "sync": applyState(msg); break;
      case "play": ensureVideo(msg.videoId); safeSeek(msg.t, 1.0); player.playVideo(); break;
      case "pause": safeSeek(msg.t, 0.2); player.pauseVideo(); break;
    }
  }
  function applyState(msg) {
    ensureVideo(msg.videoId);
    safeSeek(msg.t, 1.0);
    const state = player.getPlayerState();
    if (msg.playing && state !== YT.PlayerState.PLAYING) player.playVideo();
    else if (!msg.playing && state === YT.PlayerState.PLAYING) player.pauseVideo();
  }
  function ensureVideo(videoId) {
    if (videoId && videoId !== currentVideoId) { currentVideoId = videoId; player.loadVideoById(videoId); }
  }
  function safeSeek(t, tol) {
    if (typeof t !== "number") return;
    if (Math.abs(player.getCurrentTime() - t) > tol) player.seekTo(t, true);
  }

  // ---- WIDZ: tryb awaryjny (z linku #join=...) ----
  async function initViewerManual(joinCode) {
    role = "viewer";
    hide(ui.roleScreen);
    hide(ui.relayMissing);
    show(ui.viewerManual);
    setStatus("Tworzę kod zwrotny…", "wait");

    ui.unmuteBtn.addEventListener("click", () => {
      if (!player) return;
      player.unMute(); player.setVolume(100);
      ui.unmuteBtn.textContent = "🔊 Dźwięk włączony";
    });
    ui.copyAnswerBtn.addEventListener("click", () => copyText(ui.answerOut.value, ui.copyAnswerBtn, ui.answerOut));

    let payload;
    try {
      payload = await unpack(joinCode);
      if (!payload || !payload.s || !payload.v) throw new Error("brak danych");
    } catch (_) {
      showError(ui.viewerManualError, "Nieprawidłowy link awaryjny.");
      setStatus("Błąd", "off");
      return;
    }

    currentVideoId = payload.v;
    try {
      viewerPc = new RTCPeerConnection(RTC_CONFIG);
      viewerPc.onconnectionstatechange = () => {
        const s = viewerPc.connectionState;
        if (s === "connected") setStatus("Połączono ✓", "on");
        else if (s === "failed") { setStatus("Połączenie nieudane", "off"); showError(ui.viewerManualError, "Nie udało się połączyć (możliwa blokada sieci / NAT)."); }
      };
      viewerPc.ondatachannel = (e) => setupViewerChannel(e.channel);

      await viewerPc.setRemoteDescription({ type: "offer", sdp: payload.s });
      const answer = await viewerPc.createAnswer();
      await viewerPc.setLocalDescription(answer);
      await waitForIce(viewerPc);

      ui.answerOut.value = await pack({ s: viewerPc.localDescription.sdp });
      setStatus("Odeślij kod i czekaj…", "wait");

      show(ui.playerWrap);
      show(ui.viewerBar);
      show(ui.viewerOverlay);
      createPlayer(currentVideoId, true);
    } catch (err) {
      console.error(err);
      showError(ui.viewerManualError, "Błąd: " + err.message);
      setStatus("Błąd", "off");
    }
  }

  // ---- Pasek postępu (widz) ----
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }
  let progressTimer = null;
  function startProgressLoop() {
    if (progressTimer) return;
    show(ui.viewerProgress);
    progressTimer = setInterval(updateProgress, 500);
    updateProgress();
  }
  function updateProgress() {
    if (!playerReady || role !== "viewer") return;
    let cur = 0, dur = 0;
    try { cur = player.getCurrentTime() || 0; dur = player.getDuration() || 0; } catch (_) { return; }
    ui.curTime.textContent = fmtTime(cur);
    ui.durTime.textContent = fmtTime(dur);
    ui.progressFill.style.width = (dur > 0 ? Math.min(100, (cur / dur) * 100) : 0) + "%";
  }

  // =====================================================================
  //  Tryb kinowy i pełny ekran
  // =====================================================================
  function toggleCinema() {
    const on = document.body.classList.toggle("cinema");
    [ui.cinemaBtnHost, ui.cinemaBtnViewer].forEach((b) => b && b.classList.toggle("btn--active", on));
  }
  function toggleFullscreen() {
    const el = ui.playerWrap;
    if (!document.fullscreenElement) (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    else (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  }
  function onFsChange() {
    const on = !!document.fullscreenElement;
    [ui.fsBtnHost, ui.fsBtnViewer].forEach((b) => b && b.classList.toggle("btn--active", on));
  }
  [ui.cinemaBtnHost, ui.cinemaBtnViewer].forEach((b) => b && b.addEventListener("click", toggleCinema));
  [ui.fsBtnHost, ui.fsBtnViewer].forEach((b) => b && b.addEventListener("click", toggleFullscreen));
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (ui.playerWrap.classList.contains("hidden")) return;
    const k = e.key.toLowerCase();
    if (k === "t") { e.preventDefault(); toggleCinema(); }
    else if (k === "f") { e.preventDefault(); toggleFullscreen(); }
    else if (k === " " && role === "host" && player) {
      e.preventDefault();
      if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
      else player.playVideo();
    }
  });

  // =====================================================================
  //  Start
  // =====================================================================
  function boot() {
    const hp = new URLSearchParams(location.hash.replace(/^#/, ""));
    const room = hp.get("room");
    const vid = hp.get("v");
    const joinCode = hp.get("join");

    // Tryb awaryjny (link #join=...) NIE wymaga relaya — ma pierwszeństwo
    if (joinCode) { initViewerManual(joinCode); return; }

    // Link przez relay (#room=...) wymaga skonfigurowanego relaya
    if (room) {
      if (relayConfigured()) initViewerAuto(room, vid);
      else askForRelay(() => initViewerAuto(room, vid));
      return;
    }

    // Brak linku → ekran wyboru roli (host). Host działa nawet bez relaya (tryb awaryjny).
    show(ui.roleScreen);
    setStatus("Wybierz rolę", "wait");
    ui.roleHostBtn.addEventListener("click", initHostUi);
    ui.roleViewerBtn.addEventListener("click", () => {
      const paste = prompt("Wklej link, który wysłał Ci host:");
      if (!paste) return;
      const h = paste.indexOf("#");
      if (h === -1) { alert("To nie wygląda na prawidłowy link."); return; }
      location.hash = paste.slice(h);
      location.reload();
    });
  }

  function askForRelay(cb) {
    show(ui.relayMissing);
    ui.relayInput.value = RELAY_URL.includes("CHANGE-ME") ? "" : RELAY_URL;
    ui.relaySaveBtn.addEventListener("click", () => {
      const val = normalizeRelay(ui.relayInput.value);
      if (!val) return;
      localStorage.setItem("symultube_relay", val);
      RELAY_URL = val;
      hide(ui.relayMissing);
      cb();
    });
    setStatus("Brak relaya", "off");
  }

  boot();
})();
