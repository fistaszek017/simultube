/* SymulTube - wspólne oglądanie YouTube
   Czysty WebRTC, ręczna sygnalizacja. Zero serwerów, zero kont.
   - Zaproszenie = spersonalizowany link (#join=...)
   - Multi-user: jeden host, wielu widzów (gwiazda)
   - Kod zwrotny skompresowany gzip (krótki) */

(() => {
  "use strict";

  // ---- Konfiguracja WebRTC: tylko publiczne serwery STUN ----
  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ],
  };

  // ---- Stan ----
  let role = null;              // "host" | "viewer"
  let player = null;
  let ytReady = false;
  let playerReady = false;
  let currentVideoId = null;
  let pendingState = null;

  const hostPeers = [];         // [{pc, dc, els, n}] — tylko host
  let viewerPc = null;          // tylko widz
  let viewerDc = null;

  // ---- UI ----
  const $ = (id) => document.getElementById(id);
  const ui = {
    status: $("status"),
    roleScreen: $("roleScreen"),
    roleHostBtn: $("roleHostBtn"),
    roleViewerBtn: $("roleViewerBtn"),
    hostSetup: $("hostSetup"),
    ytUrl: $("ytUrl"),
    createBtn: $("createBtn"),
    setupError: $("setupError"),
    hostRoom: $("hostRoom"),
    inviteList: $("inviteList"),
    addInviteBtn: $("addInviteBtn"),
    viewerJoin: $("viewerJoin"),
    inviteIn: $("inviteIn"),
    genAnswerBtn: $("genAnswerBtn"),
    viewerJoinError: $("viewerJoinError"),
    viewerAnswer: $("viewerAnswer"),
    answerOut: $("answerOut"),
    copyAnswerBtn: $("copyAnswerBtn"),
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

  // ---- Pomocnicze UI ----
  function setStatus(text, kind) { ui.status.textContent = text; ui.status.className = "status status--" + kind; }
  function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
  function clearError(el) { el.classList.add("hidden"); }
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  async function copyToClipboard(text, btn, fallbackEl) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Skopiowano ✓";
      setTimeout(() => (btn.textContent = old), 1500);
    } catch (_) {
      if (fallbackEl) { fallbackEl.focus(); fallbackEl.select(); }
    }
  }

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

  // ---- Kodowanie / kompresja kodów ----
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
    // obsłuż wklejony cały link (#join=...)
    const hashIdx = code.indexOf("#join=");
    if (hashIdx !== -1) code = code.slice(hashIdx + 6);
    const tag = code[0];
    const bytes = bytesFromB64url(code.slice(1));
    if (tag === "G") {
      if (!window.DecompressionStream) throw new Error("Przeglądarka nie wspiera dekompresji.");
      const txt = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
      return JSON.parse(txt);
    }
    return JSON.parse(new TextDecoder().decode(bytes));
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

  function inviteLink(code) {
    return `${location.origin}${location.pathname}#join=${code}`;
  }

  // ---- YouTube IFrame API ----
  window.onYouTubeIframeAPIReady = function () { ytReady = true; };

  function createPlayer(videoId, asViewer) {
    if (player) return;
    const build = () => {
      player = new YT.Player("player", {
        videoId: videoId || undefined,
        playerVars: {
          autoplay: 0,
          controls: asViewer ? 0 : 1,
          disablekb: asViewer ? 1 : 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          origin: location.origin,
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
    ui.addInviteBtn.addEventListener("click", () => createInvite());
    ui.playBtn.addEventListener("click", () => player && player.playVideo());
    ui.pauseBtn.addEventListener("click", () => player && player.pauseVideo());
    ui.syncBtn.addEventListener("click", broadcastSync);
  }

  function onCreateRoom() {
    clearError(ui.setupError);
    const vid = parseVideoId(ui.ytUrl.value);
    if (!vid) {
      showError(ui.setupError, "Nieprawidłowy link do YouTube. Wklej pełny adres filmu.");
      return;
    }
    currentVideoId = vid;
    hide(ui.hostSetup);
    show(ui.playerWrap);
    show(ui.hostControls);
    show(ui.hostRoom);
    createPlayer(vid, false);
    setStatus("Pokój utworzony", "on");
    createInvite(); // od razu pierwszy link
  }

  let inviteCounter = 0;
  async function createInvite() {
    inviteCounter += 1;
    const n = inviteCounter;

    const entry = { pc: new RTCPeerConnection(RTC_CONFIG), dc: null, n, els: null };
    entry.dc = entry.pc.createDataChannel("sync", { ordered: true });
    setupHostChannel(entry);
    entry.pc.onconnectionstatechange = () => {
      const s = entry.pc.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") {
        setInviteStatus(entry, "rozłączony", "off");
      }
    };
    hostPeers.push(entry);

    const els = buildInviteCard(entry);
    entry.els = els;
    ui.inviteList.appendChild(els.card);
    setInviteStatus(entry, "generuję link…", "wait");

    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      await waitForIce(entry.pc);
      const code = await pack({ s: entry.pc.localDescription.sdp, v: currentVideoId });
      els.link.value = inviteLink(code);
      setInviteStatus(entry, "oczekuje na widza", "wait");
    } catch (err) {
      console.error(err);
      setInviteStatus(entry, "błąd: " + err.message, "off");
    }
  }

  function buildInviteCard(entry) {
    const card = document.createElement("div");
    card.className = "invite";

    const head = document.createElement("div");
    head.className = "invite__head";
    const title = document.createElement("strong");
    title.textContent = "Widz #" + entry.n;
    const status = document.createElement("span");
    status.className = "invite__status";
    head.append(title, status);

    const linkLabel = document.createElement("label");
    linkLabel.className = "invite__label";
    linkLabel.textContent = "Link zaproszenia (wyślij widzowi):";
    const link = document.createElement("textarea");
    link.className = "code-area";
    link.rows = 2;
    link.readOnly = true;
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn";
    copyBtn.textContent = "Kopiuj link";
    copyBtn.addEventListener("click", () => copyToClipboard(link.value, copyBtn, link));

    const ansLabel = document.createElement("label");
    ansLabel.className = "invite__label";
    ansLabel.textContent = "Kod zwrotny od widza:";
    const answer = document.createElement("textarea");
    answer.className = "code-area";
    answer.rows = 2;
    answer.placeholder = "Wklej kod zwrotny, który odesłał widz…";
    const connectBtn = document.createElement("button");
    connectBtn.className = "btn btn--primary";
    connectBtn.textContent = "Połącz";
    connectBtn.addEventListener("click", () => acceptAnswer(entry, answer.value, connectBtn));

    card.append(head, linkLabel, link, copyBtn, ansLabel, answer, connectBtn);
    return { card, status, link, answer, connectBtn };
  }

  function setInviteStatus(entry, text, kind) {
    if (!entry.els) return;
    entry.els.status.textContent = text;
    entry.els.status.className = "invite__status invite__status--" + kind;
  }

  async function acceptAnswer(entry, code, btn) {
    let payload;
    try {
      payload = await unpack(code);
      if (!payload || !payload.s) throw new Error("brak danych");
    } catch (_) {
      setInviteStatus(entry, "nieprawidłowy kod zwrotny", "off");
      return;
    }
    try {
      await entry.pc.setRemoteDescription({ type: "answer", sdp: payload.s });
      btn.disabled = true;
      btn.textContent = "Łączenie…";
      setInviteStatus(entry, "łączenie…", "wait");
    } catch (err) {
      console.error(err);
      setInviteStatus(entry, "błąd: " + err.message, "off");
    }
  }

  function setupHostChannel(entry) {
    const ch = entry.dc;
    ch.onopen = () => {
      setInviteStatus(entry, "połączony ✓", "on");
      if (entry.els) entry.els.connectBtn.textContent = "Połączono";
      updateHostStatus();
      sendTo(ch, buildState());
      startHeartbeat();
    };
    ch.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.type === "hello") sendTo(ch, buildState());
    };
    ch.onclose = () => { setInviteStatus(entry, "rozłączony", "off"); updateHostStatus(); };
    ch.onerror = () => setInviteStatus(entry, "błąd kanału", "off");
  }

  function updateHostStatus() {
    const n = hostPeers.filter((e) => e.dc && e.dc.readyState === "open").length;
    setStatus(n > 0 ? `Podłączeni widzowie: ${n}` : "Pokój utworzony", n > 0 ? "on" : "wait");
  }

  function sendTo(ch, msg) {
    if (ch && ch.readyState === "open") { try { ch.send(JSON.stringify(msg)); } catch (_) {} }
  }
  function broadcast(msg) {
    hostPeers.forEach((e) => sendTo(e.dc, msg));
  }

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
    heartbeat = setInterval(() => { if (playerReady) broadcastSync(); }, 2000);
  }

  // =====================================================================
  //  WIDZ
  // =====================================================================
  function initViewerUi(prefill) {
    role = "viewer";
    hide(ui.roleScreen);
    show(ui.viewerJoin);
    setStatus("Wklej link/kod zaproszenia", "wait");
    if (prefill) ui.inviteIn.value = prefill;

    ui.genAnswerBtn.addEventListener("click", onViewerGenerateAnswer);
    ui.copyAnswerBtn.addEventListener("click", () => copyToClipboard(ui.answerOut.value, ui.copyAnswerBtn, ui.answerOut));
    ui.unmuteBtn.addEventListener("click", () => {
      if (!player) return;
      player.unMute(); player.setVolume(100);
      ui.unmuteBtn.textContent = "🔊 Dźwięk włączony";
    });
  }

  async function onViewerGenerateAnswer() {
    clearError(ui.viewerJoinError);
    let payload;
    try {
      payload = await unpack(ui.inviteIn.value);
      if (!payload || !payload.s || !payload.v) throw new Error("brak danych");
    } catch (_) {
      showError(ui.viewerJoinError, "Nieprawidłowy link lub kod zaproszenia.");
      return;
    }

    currentVideoId = payload.v;
    ui.genAnswerBtn.disabled = true;
    ui.genAnswerBtn.textContent = "Generuję…";
    setStatus("Tworzę kod zwrotny…", "wait");

    try {
      viewerPc = new RTCPeerConnection(RTC_CONFIG);
      viewerPc.onconnectionstatechange = () => {
        const s = viewerPc.connectionState;
        if (s === "connected") setStatus("Połączono ✓", "on");
        else if (s === "failed") setStatus("Połączenie nieudane", "off");
        else if (s === "disconnected" || s === "closed") setStatus("Rozłączono", "off");
      };
      viewerPc.ondatachannel = (e) => setupViewerChannel(e.channel);

      await viewerPc.setRemoteDescription({ type: "offer", sdp: payload.s });
      const answer = await viewerPc.createAnswer();
      await viewerPc.setLocalDescription(answer);
      await waitForIce(viewerPc);

      ui.answerOut.value = await pack({ s: viewerPc.localDescription.sdp });

      hide(ui.viewerJoin);
      show(ui.viewerAnswer);
      show(ui.playerWrap);
      show(ui.viewerBar);
      show(ui.viewerOverlay);
      createPlayer(currentVideoId, true);
      setStatus("Odeślij kod i czekaj…", "wait");
    } catch (err) {
      console.error(err);
      showError(ui.viewerJoinError, "Nie udało się utworzyć kodu zwrotnego: " + err.message);
      ui.genAnswerBtn.disabled = false;
      ui.genAnswerBtn.textContent = "Generuj kod zwrotny";
    }
  }

  function setupViewerChannel(channel) {
    viewerDc = channel;
    channel.onopen = () => setStatus("Połączono ✓", "on");
    channel.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } applyRemote(m); };
    channel.onclose = () => setStatus("Host rozłączony", "off");
    channel.onerror = () => setStatus("Błąd kanału", "off");
  }

  function applyRemote(msg) {
    if (!msg || !msg.type) return;
    if (!playerReady) {
      if (msg.type === "state" || msg.type === "sync") pendingState = msg;
      return;
    }
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
  function safeSeek(t, tolerance) {
    if (typeof t !== "number") return;
    if (Math.abs(player.getCurrentTime() - t) > tolerance) player.seekTo(t, true);
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
  //  Start — auto-wykrycie linku zaproszenia
  // =====================================================================
  ui.roleHostBtn.addEventListener("click", initHostUi);
  ui.roleViewerBtn.addEventListener("click", () => initViewerUi());

  const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
  const joinCode = hashParams.get("join");
  if (joinCode) initViewerUi(joinCode);
})();
