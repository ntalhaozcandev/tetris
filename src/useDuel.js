import { useState, useRef, useCallback, useEffect } from "react";
import { supabase } from "./supabase";

// ── Çöp satır hesaplama ───────────────────────────────────────────────────────
function calcGarbage(cleared, isTSpin) {
  if (isTSpin) {
    if (cleared === 1) return 2;
    if (cleared === 2) return 3;
    if (cleared >= 3) return 4;
    return 1; // T-Spin mini
  }
  return ({ 2: 1, 3: 2, 4: 4 })[cleared] || 0;
}

// Görünen isim aynı kalır; DB'de benzersizlik için gizli suffix
function makePlayerId(nickname) {
  return `${nickname}#${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────
// Callbacks:
//   onGarbageReceived(lines)  – gelen çöp satır sayısı
//   onOpponentGameOver()      – rakip oyunu kaybetti → sen kazandın
export function useDuel({ onGarbageReceived, onOpponentGameOver } = {}) {
  // idle | waiting | countdown | playing | finished | error
  const [status, setStatus]               = useState("idle");
  const [roomCode, setRoomCode]           = useState("");
  const [opponentNickname, setOpponentNickname] = useState("");
  const [opponentBoard, setOpponentBoard] = useState(null);
  const [opponentScore, setOpponentScore] = useState(0);
  const [winner, setWinner]               = useState(null); // "you" | "opponent"
  const [countdownVal, setCountdownVal]   = useState(null); // 3,2,1,0
  const [errorMessage, setErrorMessage]   = useState("");
  const [duelScore, setDuelScore]         = useState({ you: 0, opponent: 0 });
  const [rematchReady, setRematchReady]   = useState(false);
  const [opponentRematchReady, setOpponentRematchReady] = useState(false);
  const [gameMode, setGameMode]          = useState("survival"); // "survival" | "score"
  const [targetScore, setTargetScore]    = useState(5000);
  const [seed, setSeed]                  = useState(null);

  const channelRef        = useRef(null);
  const playerIdRef       = useRef("");
  const nicknameRef       = useRef("");
  const isHostRef         = useRef(false);
  const lastBoardSendRef  = useRef(0);
  const finishedRef       = useRef(false);
  const countdownStartedRef = useRef(false);
  const cbGarbageRef      = useRef(onGarbageReceived);
  const cbGameOverRef     = useRef(onOpponentGameOver);
  cbGarbageRef.current    = onGarbageReceived;
  cbGameOverRef.current   = onOpponentGameOver;

  const failWithMessage = useCallback((message) => {
    setErrorMessage(message);
    setStatus("error");
  }, []);

  const hasSupabase = () => Boolean(supabase);

  const teardownChannel = useCallback(() => {
    if (channelRef.current) {
      supabase?.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    countdownStartedRef.current = false;
  }, []);

  // ── Geri sayım (sadece host gönderir) ──────────────────────────────────────
  const runCountdown = useCallback((ch) => {
    let val = 3;
    const tick = () => {
      ch.send({ type: "broadcast", event: "countdown", payload: { value: val } });
      setCountdownVal(val);
      if (val > 0) { val--; setTimeout(tick, 1000); }
      else setTimeout(() => { setCountdownVal(null); setStatus("playing"); countdownStartedRef.current = false; }, 800);
    };
    tick();
  }, []);

  const prepareNewRound = useCallback(() => {
    setWinner(null);
    setOpponentBoard(null);
    setOpponentScore(0);
    setCountdownVal(null);
    setRematchReady(false);
    setOpponentRematchReady(false);
    finishedRef.current = false;
  }, []);

  const maybeStartRematch = useCallback((ch, isHost) => {
    if (!rematchReady || !opponentRematchReady) return;
    prepareNewRound();
    setStatus("countdown");
    if (isHost && !countdownStartedRef.current) {
      countdownStartedRef.current = true;
      runCountdown(ch);
    }
  }, [opponentRematchReady, prepareNewRound, rematchReady, runCountdown]);

  // ── Kanalı kur ────────────────────────────────────────────────────────────
  const buildChannel = useCallback((code, nickname, isHost) => {
    if (!hasSupabase()) {
      failWithMessage("Supabase bağlantısı bulunamadı. VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY değerlerini kontrol et.");
      return false;
    }

    teardownChannel();

    const playerId = makePlayerId(nickname);
    playerIdRef.current  = playerId;
    nicknameRef.current  = nickname;
    isHostRef.current    = isHost;
    finishedRef.current  = false;
    countdownStartedRef.current = false;
    setErrorMessage("");

    const ch = supabase.channel(`duel:${code}`, {
      config: {
        broadcast: { self: false },
        presence:  { key: playerId },
      },
    });

    // Modu ve seed'i duyur (host tarafından joiner'a iletilir)
    ch.on("broadcast", { event: "init" }, ({ payload }) => {
      if (payload.from === playerIdRef.current) return;
      setGameMode(payload.mode || "survival");
      setTargetScore(payload.targetScore || 5000);
      setSeed(payload.seed || null);
    });
    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState();
      const keys  = Object.keys(state);
      if (keys.length >= 2) {
        const opKey = keys.find(k => k !== playerIdRef.current);
        if (opKey && state[opKey]?.[0]) {
          setOpponentNickname(state[opKey][0].nickname);
        }
        setStatus("countdown");
        if (isHostRef.current && !countdownStartedRef.current) {
          // Host'un init mesajını gönder
          ch.send({
            type: "broadcast", event: "init",
            payload: { from: playerIdRef.current, mode: gameMode, targetScore, seed },
          });
          countdownStartedRef.current = true;
          runCountdown(ch);
        }
      }
    });

    // Countdown (host'tan joiner'a)
    ch.on("broadcast", { event: "countdown" }, ({ payload }) => {
      if (payload.value === 3) {
        prepareNewRound();
      }
      setCountdownVal(payload.value);
      if (payload.value === 0) setTimeout(() => { setCountdownVal(null); setStatus("playing"); countdownStartedRef.current = false; }, 800);
    });

    // Board sync
    ch.on("broadcast", { event: "board" }, ({ payload }) => {
      if (payload.pid === playerIdRef.current) return;
      setOpponentBoard(payload.board);
      setOpponentScore(payload.score);
    });

    // Saldırı – çöp satır (devre dışı)
    ch.on("broadcast", { event: "attack" }, ({ payload }) => {
      if (payload.from === playerIdRef.current) return;
      // İstenen oyun modu: alttan yükselen rastgele satırlar tamamen kapalı.
      // Bu yüzden saldırı mesajları bilerek yok sayılıyor.
    });

    // Rakip Game Over
    ch.on("broadcast", { event: "gameover" }, ({ payload }) => {
      if (payload.from === playerIdRef.current) return;
      if (!finishedRef.current) {
        finishedRef.current = true;
        setWinner("you");
        setDuelScore(prev => ({ ...prev, you: prev.you + 1 }));
        setRematchReady(false);
        setOpponentRematchReady(false);
        setStatus("finished");
        cbGameOverRef.current?.();
      }
    });

    ch.on("broadcast", { event: "rematch" }, ({ payload }) => {
      if (payload.from === playerIdRef.current) return;
      setOpponentRematchReady(true);
    });

    ch.subscribe(() => { ch.track({ nickname }); });
    channelRef.current = ch;
    return true;
  }, [prepareNewRound, runCountdown]);

  // Rematch hazır durumları tamamlanınca yeni round başlat.
  // Host countdown yayınlar, joiner countdown event'ini dinler.
  useEffect(() => {
    if (!channelRef.current || status !== "finished") return;
    maybeStartRematch(channelRef.current, isHostRef.current);
  }, [maybeStartRematch, status, rematchReady, opponentRematchReady]);

  // ── Public API ─────────────────────────────────────────────────────────────
  const createRoom = useCallback((nickname, mode = "survival", target = 5000) => {
    if (!hasSupabase()) {
      failWithMessage("Düello için Supabase kurulumu gerekli.");
      return null;
    }
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const newSeed = Math.floor(Math.random() * 999999999);
    setGameMode(mode);
    setTargetScore(target);
    setSeed(newSeed);
    setRoomCode(code);
    setStatus("waiting");
    const ok = buildChannel(code, nickname, true);
    return ok ? code : null;
  }, [buildChannel, failWithMessage]);

  const joinRoom = useCallback((code, nickname, mode = "survival", target = 5000) => {
    if (!hasSupabase()) {
      failWithMessage("Düello için Supabase kurulumu gerekli.");
      return false;
    }
    const upper = code.trim().toUpperCase();
    setGameMode(mode);
    setTargetScore(target);
    setRoomCode(upper);
    setStatus("waiting");
    return buildChannel(upper, nickname, false);
  }, [buildChannel, failWithMessage]);

  const updateMatchSettings = useCallback((mode, target = 5000) => {
    const normalizedMode = mode === "score" ? "score" : "survival";
    const normalizedTarget = Number.isFinite(target) ? Math.max(100, Math.floor(target)) : 5000;

    setGameMode(normalizedMode);
    setTargetScore(normalizedMode === "score" ? normalizedTarget : 5000);

    // Host'sa, presense sync sırasında otomatik gönderilecek.
    // Joiner'sa göndermeye gerek yok; host'un init'ini bekle.
    if (!channelRef.current || !isHostRef.current || status !== "waiting") return;

    try {
      channelRef.current.send({
        type: "broadcast",
        event: "init",
        payload: {
          from: playerIdRef.current,
          mode: normalizedMode,
          targetScore: normalizedMode === "score" ? normalizedTarget : 5000,
          seed,
        },
      }).catch(err => {
        console.warn("Mode update broadcast failed:", err);
      });
    } catch (e) {
      console.warn("Mode update error:", e);
    }
  }, [seed, status]);

  const sendBoard = useCallback((board, score) => {
    if (!channelRef.current || !hasSupabase()) return;
    const now = Date.now();
    if (now - lastBoardSendRef.current < 150) return;
    lastBoardSendRef.current = now;
    channelRef.current.send({
      type: "broadcast", event: "board",
      payload: { pid: playerIdRef.current, board, score },
    });
  }, []);

  const sendAttack = useCallback((cleared, isTSpin) => {
    // İstenen oyun modu: çöp satırı mekaniği tamamen kapalı.
    // API uyumluluğu için fonksiyon korunuyor fakat mesaj gönderilmiyor.
    void cleared;
    void isTSpin;
  }, []);

  const sendGameOver = useCallback(() => {
    if (!channelRef.current || finishedRef.current || !hasSupabase()) return;
    finishedRef.current = true;
    channelRef.current.send({
      type: "broadcast", event: "gameover",
      payload: { from: playerIdRef.current },
    });
    setWinner("opponent");
    setDuelScore(prev => ({ ...prev, opponent: prev.opponent + 1 }));
    setRematchReady(false);
    setOpponentRematchReady(false);
    setStatus("finished");
  }, []);

  const sendRematchRequest = useCallback(() => {
    if (!channelRef.current || !hasSupabase() || status !== "finished") return;
    setRematchReady(true);
    channelRef.current.send({
      type: "broadcast", event: "rematch",
      payload: { from: playerIdRef.current },
    });
  }, [status]);

  const disconnect = useCallback(() => {
    teardownChannel();
    setStatus("idle");
    setRoomCode("");
    setOpponentNickname("");
    setOpponentBoard(null);
    setOpponentScore(0);
    setWinner(null);
    setCountdownVal(null);
    setErrorMessage("");
    setDuelScore({ you: 0, opponent: 0 });
    setRematchReady(false);
    setOpponentRematchReady(false);
    finishedRef.current = false;
  }, [teardownChannel]);

  return {
    status, roomCode, opponentNickname, opponentBoard, opponentScore,
    winner, countdownVal, errorMessage, duelScore,
    rematchReady, opponentRematchReady, playerNickname: nicknameRef.current,
    gameMode, targetScore, seed,
    createRoom, joinRoom, updateMatchSettings,
    sendBoard, sendAttack, sendGameOver, sendRematchRequest, disconnect,
  };
}
