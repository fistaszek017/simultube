/* SymulTube - wspólne oglądanie YouTube
   Czysty WebRTC z ręczną sygnalizacją (kopiuj/wklej kody).
   Zero serwerów, zero kont, tylko darmowy STUN do wykrycia adresu. */

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

  // ---- Stan globalny ----
  let pc = null;          // RTCPeerConnection
  let dc = null;          // RTCDataChannel
  let role = null;        // "host" | "viewer"
  let player = null;
  let ytReady = false;
  let playerReady = false;
  let currentVideoId = null;
  let pendingState = null;

  // ---- UI ----
  const $ = (id) => document.getElementById(id);
  const ui = {
    status: $("status"),
    roleScreen: $("roleScreen"),
    roleHostBtn: $("roleHostBtn"),
    roleViewerBtn: $("roleViewerBtn"),
    // host
    hostSetup: $("hostSetup"),
    ytUrl: $("ytUrl"),
    createBtn: $("createBtn"),
    setupError: $("setupError"),
    hostExchange: $("hostExchange"),
    inviteOut: $("inviteOut"),
    copyInviteBtn: $("copyInviteBtn"),
    answerIn: $("answerIn"),
    connectHostBtn: $("connectHostBtn"),
    hostExchangeError: $("hostExchangeError"),
    // viewer
    viewerJoin: $("viewerJoin"),
    inviteIn: $("inviteIn"),
    genAnswerBtn: $("genAnswerBtn"),
    viewerJoinError: $("viewerJoinError"),
    viewerAnswer: $("viewerAnswer"),
    answerOut: $("answerOut"),
    copyAnswerBtn: $("copyAnswerBtn"),
    // player
    playerWrap: $("playerWrap"),
    viewerOverlay: $("viewerOverlay"),
    hostControls: $("hostControls"),
    viewerBar: $("viewerBar"),
    playBtn: $("playBtn"),
    pauseBtn: $("pauseBtn"),
    syncBtn: $("syncBtn"),
    unmuteBtn: $("unmuteBtn"),
  };

  // ---- Pomocnicze ----
  function setStatus(text, kind) {
    ui.status.textContent = text;
    ui.status.className = "status status--" + kind;
  }
  function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
  function clearError(el) { el.classList.add("hidden"); }
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }

  function encode(obj) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
  }
  function decode(str) {
    return JSON.parse(decodeURIComponent(escape(atob(str.trim()))));
  }

  async function copyToClipboard(text, btn, label) {
    try {
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Skopiowano ✓";
      setTimeout(() => (btn.textContent = old), 1500);
    } catch (_) {
      // fallback — zaznacz tekst
      if (label) label.select();
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

  // Czeka na zebranie kandydatów ICE (vanilla ICE = jeden kod, bez trickle)
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
      // zabezpieczenie: nie czekaj w nieskończoność
      setTimeout(resolve, 2500);
    });
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
  //  Kanał danych — wspólna obsługa
  // =====================================================================
  function setupDataChannel(channel) {
    dc = channel;
    channel.onopen = () => {
      setStatus("Połączono ✓", "on");
      if (role === "host") {
        // od razu prześlij pełny stan nowemu widzowi
        sendMsg(buildState());
        startHeartbeat();
      }
    };
    channel.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (role === "host") {
        if (msg.type === "hello") sendMsg(buildState());
      } else {
        applyRemote(msg);
      }
    };
    channel.onclose = () => setStatus("Rozłączono", "off");
    channel.onerror = () => setStatus("Błąd kanału", "off");
  }

  function sendMsg(msg) {
    if (dc && dc.readyState === "open") {
      try { dc.send(JSON.stringify(msg)); } catch (_) {}
    }
  }

  function watchConnection() {
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") setStatus("Połączono ✓", "on");
      else if (s === "connecting") setStatus("Łączenie…", "wait");
      else if (s === "failed") setStatus("Połączenie nieudane", "off");
      else if (s === "disconnected" || s === "closed") setStatus("Rozłączono", "off");
    };
  }

  // =====================================================================
  //  HOST
  // =====================================================================
  function initHostUi() {
    role = "host";
    hide(ui.roleScreen);
    show(ui.hostSetup);
    setStatus("Wybierz film", "wait");

    ui.createBtn.addEventListener("click", onCreateInvite);
    ui.connectHostBtn.addEventListener("click", onHostAcceptAnswer);
    ui.copyInviteBtn.addEventListener("click", () =>
      copyToClipboard(ui.inviteOut.value, ui.copyInviteBtn, ui.inviteOut));

    ui.playBtn.addEventListener("click", () => player && player.playVideo());
    ui.pauseBtn.addEventListener("click", () => player && player.pauseVideo());
    ui.syncBtn.addEventListener("click", broadcastSync);
  }

  async function onCreateInvite() {
    clearError(ui.setupError);
    const vid = parseVideoId(ui.ytUrl.value);
    if (!vid) {
      showError(ui.setupError, "Nieprawidłowy link do YouTube. Wklej pełny adres filmu.");
      return;
    }
    currentVideoId = vid;
    ui.createBtn.disabled = true;
    ui.createBtn.textContent = "Generuję…";
    setStatus("Tworzę kod…", "wait");

    try {
      pc = new RTCPeerConnection(RTC_CONFIG);
      watchConnection();
      const channel = pc.createDataChannel("sync", { ordered: true });
      setupDataChannel(channel);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIce(pc);

      ui.inviteOut.value = encode({ v: 1, videoId: vid, sdp: pc.localDescription });

      // Pokaż player hosta i panel wymiany kodów
      show(ui.playerWrap);
      show(ui.hostControls);
      createPlayer(vid, false);
      hide(ui.hostSetup);
      show(ui.hostExchange);
      setStatus("Czeka na widza…", "wait");
    } catch (err) {
      console.error(err);
      showError(ui.setupError, "Nie udało się utworzyć zaproszenia: " + err.message);
      ui.createBtn.disabled = false;
      ui.createBtn.textContent = "Generuj kod zaproszenia";
    }
  }

  async function onHostAcceptAnswer() {
    clearError(ui.hostExchangeError);
    let payload;
    try {
      payload = decode(ui.answerIn.value);
      if (!payload || !payload.sdp) throw new Error("brak sdp");
    } catch (_) {
      showError(ui.hostExchangeError, "Nieprawidłowy kod odpowiedzi.");
      return;
    }
    try {
      await pc.setRemoteDescription(payload.sdp);
      setStatus("Łączenie…", "wait");
      ui.connectHostBtn.disabled = true;
      ui.connectHostBtn.textContent = "Łączenie…";
    } catch (err) {
      console.error(err);
      showError(ui.hostExchangeError, "Nie udało się połączyć: " + err.message);
    }
  }

  function buildState() {
    const playing = playerReady && player.getPlayerState() === YT.PlayerState.PLAYING;
    return {
      type: "state",
      videoId: currentVideoId,
      t: playerReady ? player.getCurrentTime() : 0,
      playing,
    };
  }

  function onHostStateChange(e) {
    if (!playerReady) return;
    const t = player.getCurrentTime();
    if (e.data === YT.PlayerState.PLAYING) sendMsg({ type: "play", t, videoId: currentVideoId });
    else if (e.data === YT.PlayerState.PAUSED) sendMsg({ type: "pause", t });
    else if (e.data === YT.PlayerState.ENDED) sendMsg({ type: "pause", t });
  }

  function broadcastSync() {
    if (!playerReady) return;
    sendMsg({
      type: "sync",
      t: player.getCurrentTime(),
      playing: player.getPlayerState() === YT.PlayerState.PLAYING,
      videoId: currentVideoId,
    });
  }

  let heartbeat = null;
  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      if (dc && dc.readyState === "open" && playerReady) broadcastSync();
    }, 2000);
  }

  // =====================================================================
  //  WIDZ
  // =====================================================================
  function initViewerUi() {
    role = "viewer";
    hide(ui.roleScreen);
    show(ui.viewerJoin);
    setStatus("Wklej kod zaproszenia", "wait");

    ui.genAnswerBtn.addEventListener("click", onViewerGenerateAnswer);
    ui.copyAnswerBtn.addEventListener("click", () =>
      copyToClipboard(ui.answerOut.value, ui.copyAnswerBtn, ui.answerOut));
    ui.unmuteBtn.addEventListener("click", () => {
      if (!player) return;
      player.unMute();
      player.setVolume(100);
      ui.unmuteBtn.textContent = "🔊 Dźwięk włączony";
    });
  }

  async function onViewerGenerateAnswer() {
    clearError(ui.viewerJoinError);
    let payload;
    try {
      payload = decode(ui.inviteIn.value);
      if (!payload || !payload.sdp || !payload.videoId) throw new Error("brak danych");
    } catch (_) {
      showError(ui.viewerJoinError, "Nieprawidłowy kod zaproszenia.");
      return;
    }

    currentVideoId = payload.videoId;
    ui.genAnswerBtn.disabled = true;
    ui.genAnswerBtn.textContent = "Generuję…";
    setStatus("Tworzę odpowiedź…", "wait");

    try {
      pc = new RTCPeerConnection(RTC_CONFIG);
      watchConnection();
      pc.ondatachannel = (e) => setupDataChannel(e.channel);

      await pc.setRemoteDescription(payload.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIce(pc);

      ui.answerOut.value = encode({ v: 1, sdp: pc.localDescription });

      // Pokaż player widza (zablokowany) i panel z kodem odpowiedzi
      hide(ui.viewerJoin);
      show(ui.viewerAnswer);
      show(ui.playerWrap);
      show(ui.viewerBar);
      show(ui.viewerOverlay);
      createPlayer(currentVideoId, true);
      setStatus("Odeślij kod i czekaj…", "wait");
    } catch (err) {
      console.error(err);
      showError(ui.viewerJoinError, "Nie udało się utworzyć odpowiedzi: " + err.message);
      ui.genAnswerBtn.disabled = false;
      ui.genAnswerBtn.textContent = "Generuj kod odpowiedzi";
    }
  }

  function applyRemote(msg) {
    if (!msg || !msg.type) return;
    if (!playerReady) {
      if (msg.type === "state" || msg.type === "sync") pendingState = msg;
      return;
    }
    switch (msg.type) {
      case "state":
      case "sync":
        applyState(msg);
        break;
      case "play":
        ensureVideo(msg.videoId);
        safeSeek(msg.t, 1.0);
        player.playVideo();
        break;
      case "pause":
        safeSeek(msg.t, 0.2);
        player.pauseVideo();
        break;
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
    if (videoId && videoId !== currentVideoId) {
      currentVideoId = videoId;
      player.loadVideoById(videoId);
    }
  }

  function safeSeek(t, tolerance) {
    if (typeof t !== "number") return;
    const drift = Math.abs(player.getCurrentTime() - t);
    if (drift > tolerance) player.seekTo(t, true);
  }

  // =====================================================================
  //  Start
  // =====================================================================
  ui.roleHostBtn.addEventListener("click", initHostUi);
  ui.roleViewerBtn.addEventListener("click", initViewerUi);
})();
