/* SymulTube - wspólne oglądanie YouTube (peer-to-peer, bez backendu) */

(() => {
  "use strict";

  // ---- Rola na podstawie adresu URL ----
  const params = new URLSearchParams(location.search);
  const roomId = params.get("room");
  const isHost = !roomId;

  // ---- Stan globalny ----
  let peer = null;
  let player = null;
  let ytReady = false;
  let playerReady = false;
  let currentVideoId = null;
  const connections = new Map(); // peerId -> DataConnection (tylko host)
  let pendingState = null;       // stan oczekujący, gdy player widza jeszcze nie gotowy
  let suppressEvents = false;    // blokuje echo zdarzeń u widza

  // ---- Elementy UI ----
  const $ = (id) => document.getElementById(id);
  const ui = {
    status: $("status"),
    setup: $("setup"),
    ytUrl: $("ytUrl"),
    createBtn: $("createBtn"),
    setupError: $("setupError"),
    sharePanel: $("sharePanel"),
    shareLink: $("shareLink"),
    copyBtn: $("copyBtn"),
    viewerCount: $("viewerCount"),
    joinScreen: $("joinScreen"),
    joinBtn: $("joinBtn"),
    joinError: $("joinError"),
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

  function showError(el, msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function clearError(el) {
    el.classList.add("hidden");
  }

  function parseVideoId(input) {
    if (!input) return null;
    input = input.trim();
    // Samo ID (11 znaków)
    if (/^[\w-]{11}$/.test(input)) return input;
    try {
      const url = new URL(input);
      if (url.hostname.includes("youtu.be")) {
        return url.pathname.slice(1, 12) || null;
      }
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const m = url.pathname.match(/\/(embed|shorts|v)\/([\w-]{11})/);
      if (m) return m[2];
    } catch (_) {
      const m = input.match(/[\w-]{11}/);
      if (m) return m[0];
    }
    return null;
  }

  // ---- YouTube IFrame API ----
  window.onYouTubeIframeAPIReady = function () {
    ytReady = true;
    maybeInit();
  };

  function createPlayer(videoId, asViewer) {
    player = new YT.Player("player", {
      host: "https://www.youtube-nocookie.com",
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
            player.mute(); // start wyciszony, by autoplay działał; przycisk włącza dźwięk
            if (pendingState) {
              applyState(pendingState);
              pendingState = null;
            }
          }
        },
        onStateChange: isHost ? onHostStateChange : undefined,
      },
    });
  }

  // =====================================================================
  //  HOST
  // =====================================================================
  function initHost() {
    ui.setup.classList.remove("hidden");

    ui.createBtn.addEventListener("click", () => {
      clearError(ui.setupError);
      const vid = parseVideoId(ui.ytUrl.value);
      if (!vid) {
        showError(ui.setupError, "Nieprawidłowy link do YouTube. Wklej pełny adres filmu.");
        return;
      }
      currentVideoId = vid;
      startHostSession(vid);
    });

    ui.playBtn.addEventListener("click", () => player && player.playVideo());
    ui.pauseBtn.addEventListener("click", () => player && player.pauseVideo());
    ui.syncBtn.addEventListener("click", broadcastSync);
  }

  function startHostSession(videoId) {
    ui.setup.classList.add("hidden");
    ui.playerWrap.classList.remove("hidden");
    ui.hostControls.classList.remove("hidden");
    ui.sharePanel.classList.remove("hidden");

    createPlayer(videoId, false);

    peer = new Peer();
    peer.on("open", (id) => {
      const link = `${location.origin}${location.pathname}?room=${id}`;
      ui.shareLink.value = link;
      setStatus("Pokój aktywny", "on");
    });

    peer.on("connection", (conn) => {
      conn.on("open", () => {
        connections.set(conn.peer, conn);
        updateViewerCount();
        // Wyślij nowemu widzowi pełny, aktualny stan
        conn.send(buildState());
      });
      conn.on("data", (msg) => {
        if (msg && msg.type === "hello") conn.send(buildState());
      });
      conn.on("close", () => {
        connections.delete(conn.peer);
        updateViewerCount();
      });
      conn.on("error", () => {
        connections.delete(conn.peer);
        updateViewerCount();
      });
    });

    peer.on("error", (err) => {
      setStatus("Błąd połączenia", "off");
      console.error("PeerJS:", err);
    });

    // Heartbeat synchronizujący pozycję
    setInterval(() => {
      if (connections.size > 0 && playerReady) broadcastSync();
    }, 2000);

    // Kopiowanie linku
    ui.copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(ui.shareLink.value);
        ui.copyBtn.textContent = "Skopiowano ✓";
        setTimeout(() => (ui.copyBtn.textContent = "Kopiuj"), 1500);
      } catch (_) {
        ui.shareLink.select();
      }
    });
  }

  function buildState() {
    const playing =
      playerReady && player.getPlayerState() === YT.PlayerState.PLAYING;
    return {
      type: "state",
      videoId: currentVideoId,
      t: playerReady ? player.getCurrentTime() : 0,
      playing,
    };
  }

  function sendAll(msg) {
    connections.forEach((conn) => {
      try { conn.send(msg); } catch (_) {}
    });
  }

  function onHostStateChange(e) {
    if (!playerReady) return;
    const t = player.getCurrentTime();
    if (e.data === YT.PlayerState.PLAYING) {
      sendAll({ type: "play", t, videoId: currentVideoId });
    } else if (e.data === YT.PlayerState.PAUSED) {
      sendAll({ type: "pause", t });
    } else if (e.data === YT.PlayerState.ENDED) {
      sendAll({ type: "pause", t });
    }
  }

  function broadcastSync() {
    if (!playerReady) return;
    sendAll({
      type: "sync",
      t: player.getCurrentTime(),
      playing: player.getPlayerState() === YT.PlayerState.PLAYING,
      videoId: currentVideoId,
    });
  }

  function updateViewerCount() {
    ui.viewerCount.textContent = String(connections.size);
  }

  // =====================================================================
  //  WIDZ
  // =====================================================================
  function initViewer() {
    ui.joinScreen.classList.remove("hidden");
    setStatus("Gotowy do dołączenia", "wait");

    ui.joinBtn.addEventListener("click", joinSession);
    ui.unmuteBtn.addEventListener("click", () => {
      if (!player) return;
      player.unMute();
      player.setVolume(100);
      ui.unmuteBtn.textContent = "🔊 Dźwięk włączony";
    });
  }

  function joinSession() {
    clearError(ui.joinError);
    ui.joinBtn.disabled = true;
    ui.joinBtn.textContent = "Łączenie…";
    setStatus("Łączenie z hostem…", "wait");

    ui.joinScreen.classList.add("hidden");
    ui.playerWrap.classList.remove("hidden");
    ui.viewerBar.classList.remove("hidden");
    ui.viewerOverlay.classList.remove("hidden");

    createPlayer(null, true);

    peer = new Peer();
    peer.on("open", () => {
      const conn = peer.connect(roomId, { reliable: true });

      conn.on("open", () => {
        setStatus("Połączono z hostem", "on");
        conn.send({ type: "hello" });
      });

      conn.on("data", (msg) => applyRemote(msg));

      conn.on("close", () => setStatus("Host rozłączony", "off"));
      conn.on("error", () => {
        showError(ui.joinError, "Nie udało się połączyć z hostem.");
        setStatus("Błąd połączenia", "off");
      });
    });

    peer.on("error", (err) => {
      console.error("PeerJS:", err);
      if (String(err).includes("peer-unavailable")) {
        setStatus("Pokój nieaktywny", "off");
        showError(ui.joinError, "Host nie jest dostępny. Poproś o nowy link.");
      } else {
        setStatus("Błąd połączenia", "off");
      }
    });
  }

  function applyRemote(msg) {
    if (!msg || !msg.type) return;
    if (!playerReady) {
      // Zapamiętaj najświeższy pełny stan do zastosowania po gotowości
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
    if (msg.playing && state !== YT.PlayerState.PLAYING) {
      player.playVideo();
    } else if (!msg.playing && state === YT.PlayerState.PLAYING) {
      player.pauseVideo();
    }
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
  function maybeInit() {
    if (!ytReady) return;
    if (isHost) initHost();
    else initViewer();
  }

  // PeerJS dostępne? (dla pewności)
  if (typeof Peer === "undefined") {
    setStatus("Błąd: brak biblioteki PeerJS", "off");
  }

  // Jeśli YT API już gotowe (np. cache), odpal od razu
  if (window.YT && window.YT.Player) {
    ytReady = true;
    maybeInit();
  }
})();
