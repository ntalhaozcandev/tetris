import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./src/supabase";
import { useDuel } from "./src/useDuel";

// ── PWA & Offline Config ───────────────────────────────────────────────────
const SCORE_API_URL = "https://YOUR_API_ENDPOINT/scores";

// IndexedDB Promise Wrapper
const initDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("tetris-db", 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("scores")) {
        const store = db.createObjectStore("scores", { keyPath: "id", autoIncrement: true });
        store.createIndex("synced", "synced", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveScoreOffline = async (scoreData) => {
  try {
    const db = await initDB();
    const transaction = db.transaction("scores", "readwrite");
    const store = transaction.objectStore("scores");
    
    // Aynı isim ve skorun zaten bekleyenler listesinde olup olmadığını kontrol et
    const existingScores = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
    });

    const isDuplicate = existingScores.some(s => 
      s.username === scoreData.username && 
      s.score === scoreData.score && 
      !s.synced
    );

    if (!isDuplicate) {
      await store.add({ ...scoreData, synced: false, date: new Date().toISOString() });
    }
    
    // Background Sync Registration
    if ("serviceWorker" in navigator && "SyncManager" in window) {
      const registration = await navigator.serviceWorker.ready;
      await registration.sync.register("sync-scores");
    }
  } catch (err) {
    console.error("IndexedDB error:", err);
  }
};

const triggerSyncManually = async () => {
  if ("serviceWorker" in navigator && "SyncManager" in window) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.sync.register("sync-scores");
    } catch (e) { console.warn("Manual sync registration failed:", e); }
  } else {
    // Fallback for browsers without SyncManager (Safari)
    console.log("SyncManager not supported, attempting manual upload...");
    // Here we would manually call the sync logic if needed, but the SW handles fetch anyway
  }
};

// ─── Sabitler ────────────────────────────────────────────────────────────────
const COLS = 10;
const ROWS = 20;
const CELL = 36;

const COLORS = {
  I: "#00f5ff", O: "#ffd700", T: "#bf00ff",
  S: "#39ff14", Z: "#ff2052", J: "#1e90ff", L: "#ff8c00",
};

// Hareket Hızı Ayarları (DAS/ARR) - Pro Level
const INITIAL_DELAY = 180; // İlk hareketten sonraki bekleme (ms)
const REPEAT_INTERVAL = 55; // Sürekli hareket hızı (ms)
const SWIPE_THRESHOLD = 14; // Hücre başına swipe mesafesi (px)
const LOCK_DELAY = 500;     // Yere değince kilitlenme süresi (ms)
const SOFT_LOCK_DELAY = 250; // Down tuşu ile kilitlenme süresi (ms)
const MAX_LOCK_RESETS = 15;  // Maksimum hareketle süre sıfırlama sayısı

const PIECES = {
  I: { shape: [[1,1,1,1]], color: "I" },
  O: { shape: [[1,1],[1,1]], color: "O" },
  T: { shape: [[0,1,0],[1,1,1],[0,0,0]], color: "T" },
  S: { shape: [[0,1,1],[1,1,0]], color: "S" },
  Z: { shape: [[1,1,0],[0,1,1]], color: "Z" },
  J: { shape: [[1,0,0],[1,1,1]], color: "J" },
  L: { shape: [[0,0,1],[1,1,1]], color: "L" },
};

// Gerçek Tetris Hız Tablosu (NES 60Hz Kare Hızları)
// Seviye 1 (NES 0) -> Level 29+ (Kill Screen)
const SPEED_TABLE = [
  800, 717, 633, 550, 467, 383, 300, 217, 133, 100, // Level 1-10
  83,  83,  83,                                     // Level 11-13
  67,  67,  67,                                     // Level 14-16
  50,  50,  50,                                     // Level 17-19
  33, 33, 33, 33, 33, 33, 33, 33, 33, 33,           // Level 20-29
  17                                                // Level 30+ (Kill Screen)
];

const SURVIVAL_SHADOW_SCORE_STEP = 900;
const SURVIVAL_MAX_SHADOW_ROWS = 8;

const getDropInterval = (level) => {
  const index = Math.max(0, level - 1);
  return index >= SPEED_TABLE.length ? SPEED_TABLE[SPEED_TABLE.length - 1] : SPEED_TABLE[index];
};

const getShadowRows = (score, isSurvivalMode = false) => {
  if (!isSurvivalMode) return 0;
  // Survival modunda başlangıçtan itibaren alttan baskı uygula.
  return Math.min(SURVIVAL_MAX_SHADOW_ROWS, 1 + Math.floor(score / SURVIVAL_SHADOW_SCORE_STEP));
};

// ─── Seeded PRNG (Deterministic Piece Shuffling) ───────────────────────────
class SeededRandom {
  constructor(seed) {
    this.seed = seed >>> 0; // Ensure unsigned 32-bit
  }

  next() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0; // LCG
    return this.seed / 0x100000000; // Convert to [0, 1)
  }

  nextInt(max) {
    return Math.floor(this.next() * max);
  }
}

// ─── Yardımcılar ──────────────────────────────────────────────────────────────
function rotate(matrix) {
  const rows = matrix.length, cols = matrix[0].length;
  const result = Array.from({ length: cols }, () => Array(rows).fill(0));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      result[c][rows - 1 - r] = matrix[r][c];
  return result;
}

function freshPiece(colorKey) {
  const p = PIECES[colorKey];
  return { shape: p.shape.map(r => [...r]), color: p.color, x: 3, y: 0 };
}

function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode === "??") return "🌎";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map(char => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}

function shuffleBag(rng = null) {
  const keys = Object.keys(PIECES);
  if (!rng) {
    // Standard Fisher-Yates with Math.random()
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
  } else {
    // Seeded Fisher-Yates
    for (let i = keys.length - 1; i > 0; i--) {
      const j = rng.nextInt(i + 1);
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
  }
  return keys;
}

function randomPiece(state) {
  if (!state.bag || state.bagIndex >= state.bag.length) {
    state.bag = shuffleBag();
    state.bagIndex = 0;
  }
  const key = state.bag[state.bagIndex++];
  return freshPiece(key);
}

function collides(board, piece, dx = 0, dy = 0, shape = null, shadowRows = 0) {
  const s = shape || piece.shape;
  const shadowStart = ROWS - shadowRows;
  for (let r = 0; r < s.length; r++)
    for (let c = 0; c < s[r].length; c++) {
      if (!s[r][c]) continue;
      const nx = piece.x + c + dx;
      const ny = piece.y + r + dy;
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
      if (shadowRows > 0 && ny >= shadowStart) return true;
      if (ny >= 0 && board[ny][nx]) return true;
    }
  return false;
}

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

// ─── Canvas çizim ─────────────────────────────────────────────────────────────
function drawCell(ctx, col, row, color) {
  const x = col * CELL, y = row * CELL;
  ctx.fillStyle = color;
  ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
  ctx.fillStyle = "rgba(255,255,255,0.26)";
  ctx.fillRect(x + 2, y + 2, CELL - 4, 5);
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fillRect(x + 2, y + 2, 4, CELL - 4);
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  ctx.fillRect(x + 2, y + CELL - 5, CELL - 4, 3);
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.8;
  ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
  ctx.restore();
}

function drawBoard(ctx, board, piece, gameOver, showGhost, shadowRows = 0) {
  ctx.fillStyle = "#060610";
  ctx.fillRect(0, 0, COLS * CELL, ROWS * CELL);
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 0.5;
  for (let r = 0; r <= ROWS; r++) {
    ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(COLS * CELL, r * CELL); ctx.stroke();
  }
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, ROWS * CELL); ctx.stroke();
  }
  ctx.restore();

  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (board[r][c]) drawCell(ctx, c, r, COLORS[board[r][c]]);

  if (shadowRows > 0) {
    const y = (ROWS - shadowRows) * CELL;
    const h = shadowRows * CELL;
    const grad = ctx.createLinearGradient(0, y - CELL * 0.4, 0, y + h);
    grad.addColorStop(0, "rgba(10,10,16,0.30)");
    grad.addColorStop(1, "rgba(2,2,6,0.92)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, y, COLS * CELL, h);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(COLS * CELL, y + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (!piece || gameOver) return;

  if (showGhost) {
    let ghostDY = 0;
    while (!collides(board, piece, 0, ghostDY + 1, null, shadowRows)) ghostDY++;
    if (ghostDY > 0) {
      ctx.save();
      for (let r = 0; r < piece.shape.length; r++)
        for (let c = 0; c < piece.shape[r].length; c++)
          if (piece.shape[r][c]) {
            const x = (piece.x + c) * CELL, y = (piece.y + r + ghostDY) * CELL;
            ctx.globalAlpha = 0.18;
            ctx.fillStyle = COLORS[piece.color];
            ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
            ctx.globalAlpha = 0.45;
            ctx.strokeStyle = COLORS[piece.color];
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.strokeRect(x + 1.5, y + 1.5, CELL - 3, CELL - 3);
          }
      ctx.restore();
    }
  }

  for (let r = 0; r < piece.shape.length; r++)
    for (let c = 0; c < piece.shape[r].length; c++)
      if (piece.shape[r][c])
        drawCell(ctx, piece.x + c, piece.y + r, COLORS[piece.color]);
}

// Hem NEXT hem HOLD için ortak preview canvas çizici
function drawPreview(ctx, w, h, piece, dimmed = false) {
  ctx.fillStyle = "#060610";
  ctx.fillRect(0, 0, w, h);
  if (!piece) return;
  const s = piece.shape;
  const cs = 26;
  const ox = (w - s[0].length * cs) / 2;
  const oy = (h - s.length * cs) / 2;
  ctx.save();
  if (dimmed) ctx.globalAlpha = 0.35;
  for (let r = 0; r < s.length; r++)
    for (let c = 0; c < s[r].length; c++)
      if (s[r][c]) {
        const color = COLORS[piece.color];
        const x = ox + c * cs, y = oy + r * cs;
        ctx.fillStyle = color;
        ctx.fillRect(x + 1, y + 1, cs - 2, cs - 2);
        ctx.fillStyle = "rgba(255,255,255,0.24)";
        ctx.fillRect(x + 2, y + 2, cs - 4, 4);
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.7;
        ctx.strokeRect(x + 1.5, y + 1.5, cs - 3, cs - 3);
      }
  ctx.restore();

  // Hold kilitli iken kilit ikonu
  if (dimmed) {
    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = "#fff";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🔒", w / 2, h - 12);
    ctx.restore();
  }
}

// ─── Rakip mini-board çizici ──────────────────────────────────────────────────
function drawMiniBoard(canvas, board) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const cw = canvas.width / COLS;
  const ch = canvas.height / ROWS;
  ctx.fillStyle = "#030308";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!board) return;
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 0.3;
  for (let r = 0; r <= ROWS; r++) {
    ctx.beginPath(); ctx.moveTo(0, r * ch); ctx.lineTo(canvas.width, r * ch); ctx.stroke();
  }
  for (let c = 0; c <= COLS; c++) {
    ctx.beginPath(); ctx.moveTo(c * cw, 0); ctx.lineTo(c * cw, canvas.height); ctx.stroke();
  }
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!board[r][c]) continue;
      const color = board[r][c] === "garbage" ? "#3a3a4a" : COLORS[board[r][c]];
      ctx.fillStyle = color;
      ctx.fillRect(c * cw + 0.5, r * ch + 0.5, cw - 1, ch - 1);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(c * cw + 1, r * ch + 1, cw - 2, 3);
      ctx.shadowColor = color;
      ctx.shadowBlur = 4;
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(c * cw + 1, r * ch + 1, cw - 2, ch - 2);
      ctx.shadowBlur = 0;
    }
  }
}

// ─── Düello Lobi Ekranı ──────────────────────────────────────────────────────
function DuelLobby({ savedNickname, onCreateRoom, onJoinRoom, onClose }) {
  const nickRef = useRef(null);
  const codeRef = useRef(null);
  const [tab, setTab] = useState("create"); // "create" | "join"
  const [menuIndex, setMenuIndex] = useState(0); // 0: primary action, 1: cancel
  const [gameMode, setGameMode] = useState("survival"); // "survival" | "score"
  const [targetScoreInput, setTargetScoreInput] = useState("5000");

  const getTargetScoreValue = () => {
    const parsed = parseInt(targetScoreInput, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
  };

  const handleCreate = () => {
    const nick = nickRef.current?.value?.trim() || savedNickname || "Player";
    if (nick.length < 2) { alert("En az 2 karakterlik isim gir."); return; }
    onCreateRoom(nick, gameMode, getTargetScoreValue());
  };

  const handleJoin = () => {
    const nick = nickRef.current?.value?.trim() || savedNickname || "Player";
    const code = codeRef.current?.value?.trim();
    if (nick.length < 2) { alert("En az 2 karakterlik isim gir."); return; }
    if (!code || code.length < 6) { alert("Geçerli bir oda kodu gir."); return; }
    onJoinRoom(code, nick, gameMode, getTargetScoreValue());
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = e.target?.tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA";

      if ((e.key === "Backspace" || e.key === "Escape") && !isTyping) {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setTab("create");
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setTab("join");
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        setMenuIndex((prev) => (prev === 0 ? 1 : 0));
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (menuIndex === 0) {
          if (tab === "create") handleCreate();
          else handleJoin();
        } else {
          onClose();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuIndex, onClose, tab]);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.9)", backdropFilter: "blur(6px)" }}>
      <div style={{ background: "#0a0a1a", border: "1px solid rgba(255,50,82,0.5)", boxShadow: "0 0 60px rgba(255,50,82,0.15)", padding: "2.5rem", minWidth: 320, maxWidth: 380, width: "90vw", fontFamily: "'Press Start 2P', monospace", textAlign: "center" }}>
        <p style={{ fontSize: "1rem", color: "#ff2052", letterSpacing: "0.2em", marginBottom: "2rem", textShadow: "0 0 20px #ff2052" }}>⚔ DÜELLO</p>

        {/* Nick input */}
        <input
          ref={nickRef}
          type="text"
          placeholder="Kullanıcı Adı"
          defaultValue={savedNickname}
          maxLength={15}
          style={{ width: "100%", background: "#0d0d20", border: "1px solid #333", color: "#fff", padding: "0.8rem", fontSize: "0.4rem", outline: "none", fontFamily: "inherit", textAlign: "center", marginBottom: "1.5rem" }}
        />

        {/* Tabs */}
        <div style={{ display: "flex", marginBottom: "1.5rem", borderBottom: "1px solid #222" }}>
          {[["create","ODA OLUŞTUR"],["join","KODA GİR"]].map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} style={{ flex: 1, background: "transparent", border: "none", color: tab === t ? "#ff2052" : "#444", fontSize: "0.35rem", padding: "0.8rem 0", borderBottom: tab === t ? "2px solid #ff2052" : "2px solid transparent", cursor: "pointer", fontFamily: "inherit" }}>
              {label}
            </button>
          ))}
        </div>

        <div style={{ marginBottom: "1.5rem" }}>
          <button
            onClick={() => setGameMode("survival")}
            style={{
              width: "100%",
              background: gameMode === "survival" ? "#39ff1430" : "#39ff1412",
              border: "2px solid " + (gameMode === "survival" ? "#39ff14" : "#555"),
              color: gameMode === "survival" ? "#39ff14" : "#888",
              padding: "0.7rem 1rem",
              fontSize: "0.35rem",
              fontFamily: "inherit",
              cursor: "pointer",
              marginBottom: "0.5rem",
              boxShadow: gameMode === "survival" ? "0 0 15px rgba(57,255,20,0.2)" : "none",
            }}
          >
            HAYATTA KALMA
          </button>
          <button
            onClick={() => setGameMode("score")}
            style={{
              width: "100%",
              background: gameMode === "score" ? "#ffd70030" : "#ffd70012",
              border: "2px solid " + (gameMode === "score" ? "#ffd700" : "#555"),
              color: gameMode === "score" ? "#ffd700" : "#888",
              padding: "0.7rem 1rem",
              fontSize: "0.35rem",
              fontFamily: "inherit",
              cursor: "pointer",
              boxShadow: gameMode === "score" ? "0 0 15px rgba(255,215,0,0.2)" : "none",
            }}
          >
            PUAN HEDEFI
          </button>
        </div>
        {gameMode === "score" && (
          <div style={{ marginBottom: "1.5rem" }}>
            <label style={{ fontSize: "0.3rem", color: "#888", display: "block", marginBottom: "0.3rem" }}>HEDEF:</label>
            <input
              type="number"
              value={targetScoreInput}
              min={100}
              onChange={(e) => setTargetScoreInput(e.target.value)}
              onBlur={() => setTargetScoreInput(String(getTargetScoreValue()))}
              style={{
                width: "100%",
                padding: "0.5rem",
                fontSize: "0.35rem",
                fontFamily: "inherit",
                background: "#1a1a2e",
                border: "1px solid #ffd700",
                color: "#ffd700",
                textAlign: "center",
              }}
            />
          </div>
        )}

        {tab === "create" ? (
          <div>
            <button onClick={handleCreate} style={{ width: "100%", background: menuIndex === 0 ? "#ff205230" : "#ff205215", border: "2px solid #ff2052", color: "#ff2052", padding: "1rem", fontSize: "0.45rem", letterSpacing: "0.15em", cursor: "pointer", fontFamily: "inherit", boxShadow: menuIndex === 0 ? "0 0 26px rgba(255,32,82,0.3)" : "0 0 20px rgba(255,32,82,0.2)" }}
              onFocus={() => setMenuIndex(0)}
              onPointerEnter={e => e.currentTarget.style.background = "#ff205230"}
              onPointerLeave={e => e.currentTarget.style.background = "#ff205215"}>
              ODA OLUŞTUR
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <input ref={codeRef} type="text" placeholder="ODA KODU (6 hane)" maxLength={6}
              style={{ width: "100%", background: "#0d0d20", border: "1px solid #333", color: "#fff", padding: "0.8rem", fontSize: "0.4rem", outline: "none", fontFamily: "inherit", textAlign: "center", letterSpacing: "0.3em" }}
              onInput={e => { e.target.value = e.target.value.toUpperCase(); }}
            />
            <button onClick={handleJoin} style={{ width: "100%", background: menuIndex === 0 ? "#ff205230" : "#ff205215", border: "2px solid #ff2052", color: "#ff2052", padding: "1rem", fontSize: "0.45rem", letterSpacing: "0.15em", cursor: "pointer", fontFamily: "inherit", boxShadow: menuIndex === 0 ? "0 0 26px rgba(255,32,82,0.3)" : "none" }}
              onFocus={() => setMenuIndex(0)}
              onPointerEnter={e => e.currentTarget.style.background = "#ff205230"}
              onPointerLeave={e => e.currentTarget.style.background = "#ff205215"}>
              KATIL
            </button>
          </div>
        )}

        <button onClick={onClose} onFocus={() => setMenuIndex(1)} style={{ marginTop: "1.5rem", background: "transparent", border: "none", color: menuIndex === 1 ? "#aaa" : "#333", fontSize: "0.3rem", cursor: "pointer", fontFamily: "inherit", textDecoration: menuIndex === 1 ? "underline" : "none" }}>
          İPTAL
        </button>
      </div>
    </div>
  );
}

// ─── Düello Bekleme / Sonuç Ekranı ────────────────────────────────────────────
function DuelStatusOverlay({ status, roomCode, opponentNickname, winner, countdownVal, onDisconnect }) {
  if (status === "idle" || status === "playing") return null;

  if (status === "finished") {
    const won = winner === "you";
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.92)", backdropFilter: "blur(8px)" }}>
        <div style={{ textAlign: "center", fontFamily: "'Press Start 2P', monospace" }}>
          <p style={{ fontSize: "2rem", marginBottom: "1rem", color: won ? "#39ff14" : "#ff2052", textShadow: `0 0 30px ${won ? "#39ff14" : "#ff2052"}`, animation: "pulse 1s ease infinite" }}>
            {won ? "🏆 KAZANDIN!" : "💀 KAYBETTİN"}
          </p>
          <p style={{ fontSize: "0.45rem", color: "#555", marginBottom: "2rem" }}>
            {won ? `${opponentNickname} oyunu bıraktı` : `${opponentNickname} kazandı`}
          </p>
          <button onClick={onDisconnect} style={{ background: "transparent", border: "2px solid #00f5ff", color: "#00f5ff", padding: "1rem 2rem", fontSize: "0.5rem", cursor: "pointer", fontFamily: "inherit" }}>
            MENÜYE DÖN
          </button>
        </div>
      </div>
    );
  }

  if (status === "countdown") {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)", pointerEvents: "none" }}>
        <p style={{ fontFamily: "'Press Start 2P', monospace", fontSize: countdownVal === 0 ? "3rem" : "5rem", color: countdownVal === 0 ? "#39ff14" : "#ff2052", textShadow: `0 0 40px ${countdownVal === 0 ? "#39ff14" : "#ff2052"}`, animation: "pop 0.4s ease-out" }}>
          {countdownVal === 0 ? "GO!" : countdownVal}
        </p>
      </div>
    );
  }

  // waiting
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.9)", backdropFilter: "blur(6px)" }}>
      <div style={{ textAlign: "center", fontFamily: "'Press Start 2P', monospace", padding: "2.5rem" }}>
        <p style={{ fontSize: "0.5rem", color: "#00f5ff", marginBottom: "2rem", letterSpacing: "0.2em" }}>ODA BEKLENİYOR</p>
        <p style={{ fontSize: "1.5rem", color: "#ffd700", letterSpacing: "0.4em", marginBottom: "0.5rem", textShadow: "0 0 20px #ffd700" }}>{roomCode}</p>
        <p style={{ fontSize: "0.3rem", color: "#444", marginBottom: "2rem" }}>Bu kodu rakibine ver</p>
        <button onClick={() => navigator.clipboard?.writeText(roomCode)} style={{ background: "#ffd70015", border: "1px solid #ffd700", color: "#ffd700", padding: "0.6rem 1.2rem", fontSize: "0.3rem", cursor: "pointer", fontFamily: "inherit", marginBottom: "1.5rem" }}>
          KODU KOPYALA
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", justifyContent: "center", marginBottom: "2rem" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00f5ff", animation: "pulse 1.2s ease infinite" }} />
          <p style={{ fontSize: "0.3rem", color: "#555" }}>Rakip bekleniyor...</p>
        </div>
        <button onClick={onDisconnect} style={{ background: "transparent", border: "none", color: "#333", fontSize: "0.3rem", cursor: "pointer", fontFamily: "inherit" }}>
          İPTAL
        </button>
      </div>
    </div>
  );
}

// ─── Ayarlar Paneli ───────────────────────────────────────────────────────────
function Toggle({ checked, onChange }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 50, height: 28, flexShrink: 0,
        background: checked ? "#00f5ff18" : "#111",
        border: `2px solid ${checked ? "#00f5ff" : "#333"}`,
        borderRadius: 14, position: "relative",
        transition: "all 0.2s",
        boxShadow: checked ? "0 0 12px rgba(0,245,255,0.35)" : "none",
      }}
    >
      <div style={{
        position: "absolute", top: 3,
        left: checked ? 23 : 3,
        width: 18, height: 18, borderRadius: "50%",
        background: checked ? "#00f5ff" : "#444",
        transition: "all 0.2s",
        boxShadow: checked ? "0 0 8px #00f5ff" : "none",
      }} />
    </button>
  );
}

function PauseOverlay({ settings, onChange, onResume, onResetScore, isTouch }) {
  const rows = [
    ...(isTouch ? [{ key: "showButtons", label: "Mobil Butonlar", desc: "Ekranda hareket butonlarını göster" }] : []),
    { key: "showGhost",   label: "Ghost Piece",    desc: "Parçanın düşeceği yeri göster" },
    { key: "hideLocation", label: "Konumu Gizle",  desc: "Sıralamada şehir/ülke bilgisini gizle" },
  ];
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)" }}
      onClick={onResume}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: "#0d0d22", border: "1px solid rgba(0,245,255,0.4)",
        boxShadow: "0 0 60px rgba(0,245,255,0.15)", padding: "2.5rem", minWidth: 320,
        fontFamily: "'Press Start 2P', monospace", textAlign: "center",
      }}>
        <p style={{ fontSize: "0.8rem", color: "#00f5ff", letterSpacing: "0.2em", marginBottom: "2rem" }}>⏸ PAUSED</p>
        
        <button
          onClick={onResume}
          style={{
            background: "#00f5ff15", border: "2px solid #00f5ff", color: "#00f5ff",
            padding: "1rem 2rem", fontSize: "0.6rem", letterSpacing: "0.2em",
            marginBottom: "1rem", width: "100%", cursor: "pointer",
            boxShadow: "0 0 15px rgba(0,245,255,0.2)"
          }}
          onPointerEnter={e => e.currentTarget.style.background = "#00f5ff33"}
          onPointerLeave={e => e.currentTarget.style.background = "#00f5ff15"}
        >
          RESUME
        </button>

        <button
          onClick={onResetScore}
          style={{
            background: "transparent", border: "1px solid #333", color: "#666",
            padding: "0.6rem", fontSize: "0.3rem", letterSpacing: "0.1em",
            marginBottom: "2.5rem", width: "100%", cursor: "pointer",
          }}
          onPointerEnter={e => { e.currentTarget.style.borderColor = "#ff205255"; e.currentTarget.style.color = "#ff2052"; }}
          onPointerLeave={e => { e.currentTarget.style.borderColor = "#333"; e.currentTarget.style.color = "#666"; }}
        >
          RESET BEST SCORE
        </button>

        <div style={{ textAlign: "left", opacity: 0.9 }}>
          <p style={{ fontSize: "0.4rem", color: "#444", marginBottom: "1rem", letterSpacing: "0.1em", borderBottom: "1px solid #222", paddingBottom: "0.5rem" }}>SETTINGS</p>
          {rows.map(({ key, label, desc }) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0.8rem 0" }}>
              <div style={{ flex: 1, marginRight: "1.5rem" }}>
                <p style={{ fontSize: "0.45rem", color: "#ccc", marginBottom: "0.4rem" }}>{label}</p>
                <p style={{ fontSize: "0.3rem", color: "#444", lineHeight: 1.6 }}>{desc}</p>
              </div>
              <Toggle checked={settings[key]} onChange={v => onChange(key, v)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Mobil Buton ─────────────────────────────────────────────────────────────
function MobileBtn({ label, onAction, repeat = false, color = "#00f5ff", style: extraStyle = {} }) {
  const intervalRef = useRef(null);
  const timeoutRef  = useRef(null);

  const start = useCallback(() => {
    onAction();
    if (repeat) {
      timeoutRef.current = setTimeout(() => {
        intervalRef.current = setInterval(onAction, REPEAT_INTERVAL);
      }, INITIAL_DELAY);
    }
  }, [onAction, repeat]);

  const stop = useCallback(() => {
    clearTimeout(timeoutRef.current);
    clearInterval(intervalRef.current);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return (
    <button
      onPointerDown={e => { e.preventDefault(); start(); }}
      onPointerUp={stop} onPointerCancel={stop}
      style={{
        background: `${color}0f`,
        border: `2px solid ${color}44`,
        borderRadius: 10, color,
        display: "flex", alignItems: "center", justifyContent: "center",
        touchAction: "none",
        WebkitTapHighlightColor: "transparent",
        boxShadow: `0 2px 14px ${color}18`,
        userSelect: "none",
        transition: "all 0.1s ease",
        ...extraStyle,
      }}
      className="m-btn"
      onPointerEnter={e => { e.currentTarget.style.background = `${color}22`; e.currentTarget.style.borderColor = `${color}88`; }}
      onPointerLeave={e => { stop(); e.currentTarget.style.background = `${color}0f`; e.currentTarget.style.borderColor = `${color}44`; }}
    >
      {label}
    </button>
  );
}

// ─── Ana Bileşen ──────────────────────────────────────────────────────────────
export default function Tetris() {
  const canvasRef         = useRef(null);
  const nextCanvasRef     = useRef(null);
  const holdCanvasRef     = useRef(null);
  const opponentCanvasRef = useRef(null);
  const rafRef            = useRef(null);
  const touchRef          = useRef(null);
  // duelRef: game-loop içinden erişilebilen duel köprüsü
  const duelRef = useRef({ active: false, pendingGarbage: 0, sendBoard: null, sendAttack: null, sendGameOver: null });

  const g = useRef({
    board: emptyBoard(), piece: null, next: null,
    hold: null,       // hold slotundaki parça
    canHold: true,    // her parçada 1 kez hold hakkı
    bag: [], bagIndex: 0,
    shadowRows: 0,
    inputs: {},       // Klavye giriş takibi { key: { held: bool, timer: number, repeating: bool } }
    score: 0, lines: 0, level: 1,
    gameOver: false, running: false, paused: false,
    lastTime: 0, dropInterval: 800, accumulated: 0,
    lockTimer: 0, lockResets: 0, 
    comboCount: -1, isBackToBack: false, lastMoveWasRotation: false, // Pro Scoring Vars
  });

  const [ui, setUi]             = useState({ 
    score: 0, lines: 0, level: 1, 
    bestScore: Number(localStorage.getItem("tetris_best")) || 0,
    savedNickname: localStorage.getItem("tetris_nick") || "", // Kalıcı nickname
    gameOver: false, running: false, paused: false,
    message: "" // Floating labels için
  });

  const [settings, setSettings] = useState(() => {
    const defaults = { showButtons: true, showGhost: true, hideLocation: false };
    const saved = localStorage.getItem("tetris_settings");
    if (!saved) return defaults;
    try {
      const parsed = JSON.parse(saved);
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  });

  const [showSettings, setShowSettings] = useState(false);
  const [isTouch, setIsTouch] = useState(false);
  const [geo, setGeo] = useState({ city: "", country: "", countryCode: "" });
  const [leaderboard, setLeaderboard] = useState([]);
  const [userRank, setUserRank] = useState({ global: 0, country: 0, city: 0 });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showDuelLobby, setShowDuelLobby] = useState(false);
  const [mainMenuIndex, setMainMenuIndex] = useState(0); // 0: start, 1: duel
  const [duelFinishMenuIndex, setDuelFinishMenuIndex] = useState(0); // 0: rematch, 1: back to menu

  // ── Duel Hook ─────────────────────────────────────────────────────────────
  const duel = useDuel({
    onGarbageReceived: (lines) => { duelRef.current.pendingGarbage += lines; },
    onOpponentGameOver: () => { /* kazandın overlay useDuel status'dan gelir */ },
  });

  const resetToMenu = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const state = g.current;
    state.board = emptyBoard();
    state.piece = null;
    state.next = null;
    state.hold = null;
    state.canHold = true;
    state.bag = [];
    state.bagIndex = 0;
    state.inputs = {};
    state.score = 0;
    state.lines = 0;
    state.level = 1;
    state.gameOver = false;
    state.running = false;
    state.paused = false;
    state.lastTime = 0;
    state.dropInterval = getDropInterval(1);
    state.accumulated = 0;
    state.lockTimer = 0;
    state.lockResets = 0;
    state.shadowRows = 0;
    state.comboCount = -1;
    state.isBackToBack = false;
    state.lastMoveWasRotation = false;
    duelRef.current.pendingGarbage = 0;
    setUi(prev => ({
      ...prev,
      score: 0,
      lines: 0,
      level: 1,
      gameOver: false,
      running: false,
      paused: false,
      message: "",
    }));
  }, []);

  const handleDuelCreateRoom = useCallback((nickname, mode = "survival", target = 5000) => {
    localStorage.setItem("tetris_nick", nickname);
    setUi(prev => ({ ...prev, savedNickname: nickname }));
    const code = duel.createRoom(nickname, mode, target);
    if (code) setShowDuelLobby(false);
  }, [duel]);

  const handleDuelJoinRoom = useCallback((code, nickname, mode = "survival", target = 5000) => {
    localStorage.setItem("tetris_nick", nickname);
    setUi(prev => ({ ...prev, savedNickname: nickname }));
    const joined = duel.joinRoom(code, nickname, mode, target);
    if (joined) setShowDuelLobby(false);
  }, [duel]);

  const handleDuelDisconnect = useCallback(() => {
    duel.disconnect();
    resetToMenu();
    setShowDuelLobby(false);
  }, [duel, resetToMenu]);

  const handleDuelRematch = useCallback(() => {
    duel.sendRematchRequest();
  }, [duel]);

  useEffect(() => {
    if (duel.status !== "finished") {
      setDuelFinishMenuIndex(0);
    }
  }, [duel.status]);

  // duelRef'i güncel tut (game loop'tan erişim için)
  useEffect(() => {
    duelRef.current.active      = duel.status === "playing";
    duelRef.current.sendBoard   = duel.sendBoard;
    duelRef.current.sendAttack  = duel.sendAttack;
    duelRef.current.sendGameOver = duel.sendGameOver;
    duelRef.current.seed        = duel.seed;
    duelRef.current.gameMode    = duel.gameMode;
    duelRef.current.targetScore = duel.targetScore;
  }, [duel.status, duel.sendBoard, duel.sendAttack, duel.sendGameOver, duel.seed, duel.gameMode, duel.targetScore]);

  // Duel playing başladığında oyunu başlat
  useEffect(() => {
    if (duel.status === "playing") {
      startGame();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duel.status]);

  // Rakibin board'u değişince mini canvas'a çiz
  useEffect(() => {
    drawMiniBoard(opponentCanvasRef.current, duel.opponentBoard);
  }, [duel.opponentBoard]);

  // Duel bittikten sonra oyunu durdur
  useEffect(() => {
    if (duel.status === "finished") {
      const s = g.current;
      s.running = false;
      cancelAnimationFrame(rafRef.current);
    }
  }, [duel.status]);

  useEffect(() => {
    setIsTouch('ontouchstart' in window || navigator.maxTouchPoints > 0);
    
    // Çok Kanallı Konum Tespiti (Fallback Sistemi)
    const fetchGeo = async () => {
      // 1. Birincil Deneme (IPWho.is)
      try {
        const res = await fetch("https://ipwho.is/");
        const data = await res.json();
        if (data.success !== false && data.city && data.country) {
          setGeo({ city: data.city, country: data.country, countryCode: data.country_code || "" });
          return;
        }
      } catch (e) { console.warn("Primary geo failed, trying fallback..."); }

      // 2. Yedek Deneme (IPApi.co)
      try {
        const res = await fetch("https://ipapi.co/json/");
        const data = await res.json();
        if (data.city && data.country_name) {
          setGeo({ city: data.city, country: data.country_name, countryCode: data.country_code || "" });
        }
      } catch (e) {
        console.error("All geo providers failed:", e);
        setGeo({ city: "Unknown", country: "Global", countryCode: "" });
      }
    };
    fetchGeo();
  }, []);

  useEffect(() => {
    localStorage.setItem("tetris_best", ui.bestScore);
  }, [ui.bestScore]);

  useEffect(() => {
    localStorage.setItem("tetris_settings", JSON.stringify(settings));
  }, [settings]);

  // Offline/Online Fallback
  useEffect(() => {
    const handleOnline = () => {
      console.log("Device is online, triggering sync...");
      triggerSyncManually();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const changeSetting = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  // ── Render ────────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const cvs  = canvasRef.current;
    const nCvs = nextCanvasRef.current;
    const hCvs = holdCanvasRef.current;
    if (!cvs || !nCvs || !hCvs) return;
    const { board, piece, next, hold, canHold, gameOver, shadowRows } = g.current;
    drawBoard(cvs.getContext("2d"), board, piece, gameOver, settingsRef.current.showGhost, shadowRows);
    drawPreview(nCvs.getContext("2d"), 110, 82, next);
    drawPreview(hCvs.getContext("2d"), 110, 82, hold, !canHold);
    // Duel board sync
    if (duelRef.current.active && duelRef.current.sendBoard) {
      duelRef.current.sendBoard(board, g.current.score);
    }
  }, []);

  // ── Satır silme ───────────────────────────────────────────────────────────
  const clearLines = useCallback(() => {
    const { board } = g.current;
    let cleared = 0;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (board[r].every(c => c !== null)) {
        board.splice(r, 1);
        board.unshift(Array(COLS).fill(null));
        cleared++; r++;
      }
    }
    return cleared;
  }, []);

  // ── Parçayı kilitle ───────────────────────────────────────────────────────
  const lockPiece = useCallback(() => {
    const state = g.current;
    const { piece, board } = state;
    if (!piece) return;

    // T-Spin Kontrolü (3-Corner Rule)
    let isTSpin = false;
    if (piece.color === "T" && state.lastMoveWasRotation) {
      let corners = 0;
      const cornerOffsets = [[0,0], [2,0], [0,2], [2,2]];
      for (const [cx, cy] of cornerOffsets) {
        const nx = piece.x + cx, ny = piece.y + cy;
        if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS || board[ny][nx]) corners++;
      }
      if (corners >= 3) isTSpin = true;
    }

    // Parçayı tahtaya yerleştir
    for (let r = 0; r < piece.shape.length; r++)
      for (let c = 0; c < piece.shape[r].length; c++)
        if (piece.shape[r][c]) {
          const ny = piece.y + r;
          if (ny < 0) {
            state.gameOver = true; state.running = false;
            setUi(u => ({ ...u, gameOver: true, running: false }));
            // Düello: game over bildir
            if (duelRef.current.active && duelRef.current.sendGameOver) {
              duelRef.current.sendGameOver();
            }
            return;
          }
          board[ny][piece.x + c] = piece.color;
        }

    const cleared = clearLines();
    let baseScore = 0;
    let msg = "";

    // Guideline Skor Tablosu
    if (isTSpin) {
      if (cleared === 0) baseScore = 400;
      else if (cleared === 1) baseScore = 800;
      else if (cleared === 2) baseScore = 1200;
      else if (cleared === 3) baseScore = 1600;
      msg = cleared > 0 ? `T-SPIN ${["","SINGLE","DOUBLE","TRIPLE"][cleared]}!` : "T-SPIN!";
    } else {
      if (cleared === 1) baseScore = 100;
      else if (cleared === 2) baseScore = 300;
      else if (cleared === 3) baseScore = 500;
      else if (cleared === 4) { baseScore = 1200; msg = "TETRIS!"; }
    }

    // Combo & Back-to-Back Logic
    if (cleared > 0) {
      state.comboCount++;
      if (state.comboCount > 0) {
        state.score += 50 * state.comboCount * state.level;
        msg += msg ? ` + COMBO ${state.comboCount}` : `COMBO ${state.comboCount}`;
      }

      // Difficult moves: Tetris or T-Spin with lines
      const isDifficult = cleared === 4 || (isTSpin && cleared > 0);
      if (isDifficult) {
        if (state.isBackToBack) {
          baseScore *= 1.5;
          msg = "B2B " + msg;
        }
        state.isBackToBack = true;
      } else {
        state.isBackToBack = false;
      }
    } else {
      state.comboCount = -1;
    }

    state.score += baseScore * state.level;
    state.lines += cleared;
    state.level = Math.floor(state.lines / 10) + 1;
    state.dropInterval = getDropInterval(state.level);

    if (msg) {
      setUi(prev => ({ ...prev, message: msg }));
      setTimeout(() => setUi(prev => ({ ...prev, message: "" })), 2000);
    }

    state.canHold = true;
    state.lockTimer = 0;
    state.lockResets = 0;
    state.lastMoveWasRotation = false;

    state.piece = { ...state.next, shape: state.next.shape.map(r => [...r]), x: 3, y: 0 };
    state.next = randomPiece(state);

    if (collides(board, state.piece, 0, 0, null, state.shadowRows)) {
      state.gameOver = true; state.running = false;
      if (duelRef.current.active && duelRef.current.sendGameOver) {
        duelRef.current.sendGameOver();
      }
    }

    // Score mode: check win condition (reached target score)
    if (duelRef.current.active && duelRef.current.gameMode === "score") {
      if (state.score >= duelRef.current.targetScore) {
        state.gameOver = true; state.running = false;
        if (duelRef.current.sendGameOver) {
          duelRef.current.sendGameOver(); // They win by reaching score
        }
      }
    }

    const isSurvivalMode = duelRef.current.active && duelRef.current.gameMode === "survival";
    const prevShadowRows = state.shadowRows;
    const nextShadowRows = getShadowRows(state.score, isSurvivalMode);
    if (nextShadowRows > prevShadowRows) {
      const start = ROWS - nextShadowRows;
      const end = ROWS - prevShadowRows;
      for (let r = start; r < end; r++) {
        board[r] = Array(COLS).fill(null);
      }
      state.shadowRows = nextShadowRows;
    }
    
    const newBest = Math.max(ui.bestScore, state.score);
    setUi(prev => ({ 
      ...prev,
      score: state.score, 
      lines: state.lines, 
      level: state.level, 
      bestScore: newBest,
      gameOver: state.gameOver, 
      running: state.running,
      paused: false
    }));
  }, [clearLines, ui.bestScore, ui.score, ui.level, ui.lines]);

  // ── Aksiyon fonksiyonları ─────────────────────────────────────────────────
  const btnLeft = useCallback(() => {
    const s = g.current;
    if (!s.running || !s.piece || s.paused) return;
    if (!collides(s.board, s.piece, -1, 0, null, s.shadowRows)) { 
      s.piece.x--; 
      s.lastMoveWasRotation = false; // Hareket rotasyonu bozar
      // Reset lock timer if grounded
      if (collides(s.board, s.piece, 0, 1, null, s.shadowRows) && s.lockResets < MAX_LOCK_RESETS) {
        s.lockTimer = 0;
        s.lockResets++;
      }
      render(); 
    }
  }, [render]);

  const btnRight = useCallback(() => {
    const s = g.current;
    if (!s.running || !s.piece || s.paused) return;
    if (!collides(s.board, s.piece, 1, 0, null, s.shadowRows)) { 
      s.piece.x++; 
      s.lastMoveWasRotation = false;
      // Reset lock timer if grounded
      if (collides(s.board, s.piece, 0, 1, null, s.shadowRows) && s.lockResets < MAX_LOCK_RESETS) {
        s.lockTimer = 0;
        s.lockResets++;
      }
      render(); 
    }
  }, [render]);

  const btnDown = useCallback(() => {
    const s = g.current;
    if (!s.running || !s.piece || s.paused) return;
    if (!collides(s.board, s.piece, 0, 1, null, s.shadowRows)) { 
      s.piece.y++; 
      s.score += 1; 
      s.lockTimer = 0;
      s.lastMoveWasRotation = false;
      render(); 
    } else {
      s.lockTimer += 100;
      if (s.lockTimer >= SOFT_LOCK_DELAY) lockPiece();
    }
  }, [render, lockPiece]);

  const tryRotate = useCallback(() => {
    const state = g.current;
    if (!state.piece) return;
    const rotated = rotate(state.piece.shape);
    const offsets = [
      [0, 0], [1, 0], [-1, 0], [0, -1], [2, 0], [-2, 0], [1, -1], [-1, -1], [0, -2]
    ];
    for (const [dx, dy] of offsets) {
      if (!collides(state.board, state.piece, dx, dy, rotated, state.shadowRows)) {
        state.piece.shape = rotated;
        state.piece.x += dx;
        state.piece.y += dy;
        return;
      }
    }
  }, []);

  const btnRotate = useCallback(() => {
    const s = g.current;
    if (!s.running || s.paused) return;
    tryRotate(); 
    s.lastMoveWasRotation = true; // Rotasyon flagini set et
    // Reset lock timer if grounded after rotation
    if (collides(s.board, s.piece, 0, 1, null, s.shadowRows) && s.lockResets < MAX_LOCK_RESETS) {
      s.lockTimer = 0;
      s.lockResets++;
    }
    render();
  }, [render, tryRotate]);

  const handleInputs = useCallback((delta) => {
    const s = g.current;
    if (!s.running || s.paused || !s.piece) return;

    const keys = ["ArrowLeft", "ArrowRight", "ArrowDown"];
    keys.forEach(key => {
      const input = s.inputs[key];
      if (!input || !input.held) return;

      input.timer += delta;
      const threshold = input.repeating ? REPEAT_INTERVAL : INITIAL_DELAY;

      if (input.timer >= threshold) {
        input.timer = 0;
        input.repeating = true;
        if (key === "ArrowLeft") btnLeft();
        if (key === "ArrowRight") btnRight();
        if (key === "ArrowDown") btnDown();
      }
    });
  }, [btnLeft, btnRight, btnDown]);




  // ── Hold ──────────────────────────────────────────────────────────────────
  const btnHold = useCallback(() => {
    const state = g.current;
    if (!state.running || !state.piece || !state.canHold) return;

    state.canHold = false;

    if (state.hold === null) {
      // Hold boş: mevcut parçayı hold'a al, next'i aktif et
      state.hold = freshPiece(state.piece.color);
      state.piece = { ...state.next, shape: state.next.shape.map(r => [...r]), x: 3, y: 0 };
      state.next = randomPiece();
    } else {
      // Hold dolu: swap yap
      const prevHold = freshPiece(state.hold.color);
      state.hold = freshPiece(state.piece.color);
      state.piece = prevHold;
    }
    render();
  }, [render]);



  // ── Oyun döngüsü ──────────────────────────────────────────────────────────
  const gameLoop = useCallback((time) => {
    const state = g.current;
    if (!state.running) return;

    if (state.paused) {
      state.lastTime = time;
      rafRef.current = requestAnimationFrame(gameLoop);
      return;
    }

    const delta = Math.min(time - state.lastTime, 200);
    state.lastTime = time;

    handleInputs(delta);

    const isGrounded = collides(state.board, state.piece, 0, 1, null, state.shadowRows);

    if (isGrounded) {
      // Yere değiyor: Kilitlenme zamanlayıcısını biriktir
      state.lockTimer += delta;
      if (state.lockTimer >= LOCK_DELAY) {
        lockPiece();
      }
    } else {
      // Havada: Normal yerçekimi
      state.lockTimer = 0;
      state.accumulated += delta;
      if (state.accumulated >= state.dropInterval) {
        state.accumulated = 0;
        state.piece.y++;
      }
    }

    render();
    rafRef.current = requestAnimationFrame(gameLoop);
  }, [render, lockPiece, handleInputs]);

  // ── Başlat ────────────────────────────────────────────────────────────────
  const startGame = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const state = g.current;
    
    // State sıfırla ve Bag başlat
    state.board = emptyBoard();
    state.score = 0;
    state.lines = 0;
    state.level = 1;
    state.gameOver = false;
    state.running = true;
    state.paused = false;
    state.dropInterval = getDropInterval(1);
    state.accumulated = 0;
    state.lockTimer = 0;
    state.lockResets = 0;

    const isSurvivalMode = duelRef.current.active && duelRef.current.gameMode === "survival";
    state.shadowRows = getShadowRows(0, isSurvivalMode);
    if (state.shadowRows > 0) {
      for (let r = ROWS - state.shadowRows; r < ROWS; r++) {
        state.board[r] = Array(COLS).fill(null);
      }
    }

    // Seeded piece generation for duel mode
    if (duelRef.current.seed) {
      const rng = new SeededRandom(duelRef.current.seed);
      state.bag = shuffleBag(rng);
    } else {
      state.bag = shuffleBag();
    }

    state.bagIndex = 0;
    state.piece = randomPiece(state);
    state.next = randomPiece(state);
    state.hold = null;
    state.canHold = true;
    // Duel: önceki turdan kalan çöp satırları temizle
    duelRef.current.pendingGarbage = 0;

    setUi(prev => ({ 
      ...prev,
      score: 0, lines: 0, level: 1, 
      gameOver: false, running: true, paused: false 
    }));
    setUserRank({ global: 0, country: 0, city: 0 });
    state.lastTime = performance.now();
    rafRef.current = requestAnimationFrame(gameLoop);
  }, [gameLoop]);

  const togglePause = useCallback(() => {
    const s = g.current;
    // Duel modunda pause yasak
    if (!s.running || s.gameOver || duelRef.current.active) return;
    s.paused = !s.paused;
    setUi(prev => ({ ...prev, paused: s.paused }));
  }, []);

  // Sekme/pencere odağı kaybolunca oyunu otomatik duraklat
  useEffect(() => {
    const autoPause = () => {
      const s = g.current;
      if (!s.running || s.gameOver || s.paused || duelRef.current.active) return;
      s.paused = true;
      // Focus kaybında basılı tuşlar takılı kalmasın
      Object.keys(s.inputs).forEach((key) => {
        s.inputs[key].held = false;
      });
      setUi(prev => ({ ...prev, paused: true }));
    };

    const onVisibilityChange = () => {
      if (document.hidden) autoPause();
    };

    window.addEventListener("blur", autoPause);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", autoPause);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const resumeGame = useCallback(() => {
    const s = g.current;
    if (!s.running || s.gameOver) return;
    s.paused = false;
    setUi(prev => ({ ...prev, paused: false }));
  }, []);

  const resetBestScore = useCallback(() => {
    if (confirm("En yüksek skoru sıfırlamak istiyor musun?")) {
      setUi(prev => ({ ...prev, bestScore: 0 }));
    }
  }, []);

  const getRanks = async (score) => {
    if (!supabase) return;
    try {
      // Kişisel sıralamalar
      const { data: globalRank } = await supabase.rpc('get_rank', { player_score: score });
      const { data: countryRank } = await supabase.rpc('get_rank_country', { player_score: score, country_name: geo.country });
      const { data: cityRank } = await supabase.rpc('get_rank_city', { player_score: score, city_name: geo.city });
      
      setUserRank({
        global: globalRank || 1,
        country: countryRank || 1,
        city: cityRank || 1
      });

      // Top 10 Listesi
      const { data: top10 } = await supabase
        .from('leaderboard')
        .select('*')
        .order('score', { ascending: false })
        .limit(10);
      
      if (top10) setLeaderboard(top10);
    } catch (e) { console.error("Sıralama hatası:", e); }
  };

  const submitScore = async (username, score) => {
    if (!supabase) {
      alert("Liderlik tablosu henüz yapılandırılmamış (.env dosyasını kontrol edin).");
      return;
    }
    if (!username || username.trim().length < 2) {
      alert("Lütfen en az 2 karakterlik bir isim girin.");
      return;
    }
    
    setIsSubmitting(true);
    const scoreData = {
      username,
      score: score,
      city: settings.hideLocation ? "Secret" : geo.city,
      country: settings.hideLocation ? "Global" : geo.country,
      country_code: settings.hideLocation ? "??" : geo.countryCode
    };

    try {
      // Direkt yeni skor ekle
      const { error: insertError } = await supabase.from('leaderboard').insert([scoreData]);
      if (insertError) throw insertError;
      
      // 3. IndexedDB'ye de yedekle (synced: true olarak)
      const db = await initDB();
      const tx = db.transaction("scores", "readwrite");
      await tx.objectStore("scores").add({ ...scoreData, synced: true, date: new Date().toISOString() });

      // Başarıyla kaydedildi: Nickname'i hatırla
      localStorage.setItem("tetris_nick", username);
      setUi(prev => ({ ...prev, savedNickname: username }));

      await getRanks(score);
      alert("Skorun kaydedildi!");
    } catch (e) {
      console.error("Skor kaydedilirken hata (Offline olabilir):", e);
      // 4. Hata durumunda offline kaydet
      await saveScoreOffline(scoreData);
      alert("Skorun cihazına kaydedildi. Bağlantı geldiğinde otomatik gönderilecek.");
      
      localStorage.setItem("tetris_nick", username);
      setUi(prev => ({ ...prev, savedNickname: username }));
    } finally {
      setIsSubmitting(false);
    }
  };



  const btnHardDrop = useCallback(() => {
    const s = g.current;
    if (!s.running || !s.piece || s.paused) return;
    let drop = 0;
    while (!collides(s.board, s.piece, 0, drop + 1, null, s.shadowRows)) drop++;
    s.piece.y += drop;
    s.score += drop * 2;
    lockPiece(); render();
  }, [render, lockPiece]);

  // ── Klavye ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e) => {
      const state = g.current;
      const tag = e.target?.tagName;
      const isTyping = tag === "INPUT" || tag === "TEXTAREA";

      // Pause toggle her durumda çalışsın (running ise)
      if (e.key === "p" || e.key === "P" || e.key === "Escape") {
        e.preventDefault();
        togglePause();
        return;
      }

      if (!isTyping && !ui.running && duel.status === "idle" && !showDuelLobby) {
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
          setMainMenuIndex((prev) => (prev === 0 ? 1 : 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (mainMenuIndex === 0) startGame();
          else setShowDuelLobby(true);
          return;
        }
      }

      if (!isTyping && duel.status === "finished") {
        if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
          setDuelFinishMenuIndex((prev) => (prev === 0 ? 1 : 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (duelFinishMenuIndex === 0) handleDuelRematch();
          else handleDuelDisconnect();
          return;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          handleDuelDisconnect();
          return;
        }
      }

      if (!isTyping && (duel.status === "waiting" || duel.status === "error")) {
        if (e.key === "Backspace" || e.key === "Escape") {
          e.preventDefault();
          handleDuelDisconnect();
          return;
        }
      }

      if (!state.running || !state.piece || state.paused) return;

      // DAS/ARR keys (Only initialize timer on first press)
      if (["ArrowLeft", "ArrowRight", "ArrowDown"].includes(e.key)) {
        e.preventDefault();
        if (!state.inputs[e.key] || !state.inputs[e.key].held) {
          state.inputs[e.key] = { held: true, timer: 0, repeating: false };
          if (e.key === "ArrowLeft") btnLeft();
          if (e.key === "ArrowRight") btnRight();
          if (e.key === "ArrowDown") {
             // Down key repeats faster than standard DAS? 
             // Standard Tetris: Soft drop is often instant ARR
             btnDown();
          }
        }
        return;
      }

      // Single-fire keys
      switch (e.key) {
        case "ArrowUp": case "x": case "X": 
          e.preventDefault(); 
          btnRotate(); 
          break;
        case " ": e.preventDefault(); btnHardDrop(); break;
        case "c": case "C": case "Shift": e.preventDefault(); btnHold(); break;
        default: break;
      }
    };

    const handleKeyUp = (e) => {
      const state = g.current;
      if (state.inputs[e.key]) {
        state.inputs[e.key].held = false;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    btnLeft, btnRight, btnDown, btnRotate, btnHardDrop, btnHold, togglePause,
    duel.status, duelFinishMenuIndex, handleDuelDisconnect, handleDuelRematch,
    mainMenuIndex, showDuelLobby, startGame, ui.running,
  ]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // ── Swipe ─────────────────────────────────────────────────────────────────
  const handleTouchStart = (e) => {
    const t = e.touches[0];
    touchRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
  };
  const handleTouchEnd = useCallback((e) => {
    const state = g.current;
    if (!state.running || !state.piece || !touchRef.current) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchRef.current.x;
    const dy = t.clientY - touchRef.current.y;
    const dt = Date.now() - touchRef.current.time;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (dt < 220 && adx < 15 && ady < 15) {
      btnRotate();
    } else if (adx > ady && adx > SWIPE_THRESHOLD) {
      const dir = dx > 0 ? 1 : -1;
      const steps = Math.min(Math.floor(adx / SWIPE_THRESHOLD), 5);
      for (let i = 0; i < steps; i++)
        if (!collides(state.board, state.piece, dir, 0, null, state.shadowRows)) state.piece.x += dir;
      render();
    } else if (ady > adx) {
      if (dy > 35) btnHardDrop();
      else if (dy < -25) btnRotate();
    }
  }, [render, btnRotate, btnHardDrop]);

  // ─── Render ───────────────────────────────────────────────────────────────
  const PW = 140, PH = 104; // preview canvas boyutu

  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "flex-start", minHeight: "100dvh", 
      width: "100%",
      background: "radial-gradient(ellipse at 50% 0%, #0d0d2b 0%, #040408 70%)",
      fontFamily: "'Press Start 2P', monospace", color: "#fff",
      userSelect: "none", touchAction: "none",
      paddingTop: "max(0.8rem, env(safe-area-inset-top))", 
      paddingBottom: "max(2rem, env(safe-area-inset-bottom))",
      overscrollBehavior: "none",
      overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        button { cursor: pointer; font-family: inherit; }
        
        .game-layout {
          display: flex;
          gap: 2rem;
          align-items: flex-start;
          transition: all 0.3s ease;
          position: relative;
        }

        .side-panel {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          width: 150px;
        }

        .duel-panel {
          display: flex;
          flex-direction: column;
          gap: 1.2rem;
          width: 120px;
        }

        .board-canvas {
          display: block;
          border: 2px solid rgba(0,245,255,0.3);
          box-shadow: 0 0 45px rgba(0,245,255,0.15);
          max-width: 100%;
          max-height: 75vh;
          width: auto;
          height: auto;
          background: rgba(0,0,0,0.6);
        }

        @media (max-width: 768px) {
          .game-layout {
            flex-direction: column;
            align-items: center;
            gap: 0;
            width: 100vw;
            padding: 0;
            margin-top: -1.2rem;
          }
          .board-canvas {
            max-height: 52vh !important;
            max-width: 82vw !important;
            border: 1px solid rgba(0,245,255,0.4);
            box-shadow: 0 0 50px rgba(0,245,255,0.15);
            border-radius: 6px;
          }
          .side-panel {
            display: none !important;
          }

          .duel-panel {
            width: min(76vw, 280px);
            margin-top: 0.75rem;
          }
          
          .mobile-overlay-panel {
            position: absolute;
            background: rgba(0,0,0,0.8);
            backdrop-filter: blur(15px);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 4px;
            padding: 0.2rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            z-index: 10;
          }
          
          .mobile-hold { top: 0.2rem; left: 0.2rem; border-color: rgba(255,215,0,0.4); }
          .mobile-next { top: 0.2rem; right: 0.2rem; border-color: rgba(191,0,255,0.4); }
          
          h1 {
            font-size: 0.7rem !important;
            margin-bottom: 0.8rem !important;
            letter-spacing: 0.4em !important;
            opacity: 0.7;
          }
          
          .stats-bar {
            display: flex;
            justify-content: space-between;
            width: 78vw;
            background: rgba(0,0,0,0.6);
            border: 1px solid rgba(255,255,255,0.1);
            border-top: none;
            border-radius: 0 0 16px 16px;
            padding: 0.4rem 1.2rem;
            margin-bottom: 1rem;
          }
          
          .control-deck {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.5rem 1.5rem calc(0.5rem + env(safe-area-inset-bottom)) 1.5rem;
            background: rgba(0,0,0,0.25);
            backdrop-filter: blur(8px);
            z-index: 40;
          }

          .m-btn {
            border-radius: 50% !important;
            background: rgba(255,255,255,0.03) !important;
            border: 2px solid rgba(255,255,255,0.15) !important;
            transition: all 0.08s ease-out;
            display: flex !important;
            align-items: center;
            justify-content: center;
            box-shadow: inset 0 0 20px rgba(0,0,0,0.5);
            -webkit-user-select: none;
            -webkit-tap-highlight-color: transparent;
          }
          
          .m-btn:active {
            transform: scale(0.9);
            background: rgba(255,255,255,0.1) !important;
            border-color: currentColor !important;
            box-shadow: inset 0 0 10px rgba(0,0,0,0.8), 0 0 20px currentColor;
          }
        }
      `}</style>

      {ui.paused && (
        <PauseOverlay settings={settings} onChange={changeSetting} onResume={resumeGame} onResetScore={resetBestScore} isTouch={isTouch} />
      )}

      {/* Üst bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: 700, padding: "0 1rem", marginBottom: "1rem" }}>
        <h1 style={{ fontSize: "clamp(1rem, 3vw, 1.5rem)", letterSpacing: "0.35em", color: "#00f5ff", textShadow: "0 0 24px #00f5ff, 0 0 50px #00f5ff44" }}>
          TETRIS
        </h1>

        {isTouch && ui.running && !ui.gameOver && (
          <button
            onClick={togglePause}
            style={{
              background: "rgba(0,245,255,0.1)",
              border: "2px solid rgba(0,245,255,0.4)",
              color: "#00f5ff",
              width: 42,
              height: 42,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "1.1rem",
              boxShadow: "0 0 15px rgba(0,245,255,0.15)",
              backdropFilter: "blur(10px)",
              transition: "all 0.1s ease",
              cursor: "pointer"
            }}
          >
            {ui.paused ? "▶" : "II"}
          </button>
        )}
      </div>

      {showDuelLobby && (
        <DuelLobby
          savedNickname={ui.savedNickname}
          onCreateRoom={handleDuelCreateRoom}
          onJoinRoom={handleDuelJoinRoom}
          onClose={() => setShowDuelLobby(false)}
        />
      )}

      <DuelStatusOverlay
        status={duel.status}
        roomCode={duel.roomCode}
        opponentNickname={duel.opponentNickname}
        winner={duel.winner}
        countdownVal={duel.countdownVal}
        onDisconnect={handleDuelDisconnect}
      />

      {/* Oyun alanı */}
      <div className="game-layout">

        {/* Sol panel: HOLD (Masaüstü) */}
        {!isTouch && (
          <div className="side-panel">
            <div>
              <p style={{ fontSize: "0.7rem", color: "#444", marginBottom: "0.5rem", letterSpacing: "0.15em" }}>HOLD</p>
              <canvas ref={holdCanvasRef} width={PW} height={PH}
                style={{ display: "block", border: "1px solid rgba(255,255,255,0.06)", width: "100%", height: "auto" }} />
              <p className="keys-hint" style={{ fontSize: "0.55rem", color: "#2a2a3a", marginTop: "0.5rem", marginBottom: "1.5rem", lineHeight: 1.8 }}>
                C / Shift<br />mobil: HOLD
              </p>

              {ui.running && !ui.gameOver && (
                <button
                  onClick={togglePause}
                  style={{
                    background: "transparent", border: "1px solid #2a2a3a", color: "#00f5ff",
                    width: 48, height: 48, borderRadius: 8, fontSize: "1.1rem",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    boxShadow: "0 0 15px rgba(0,245,255,0.1)", margin: "0 auto"
                  }}
                  onPointerEnter={e => { e.currentTarget.style.borderColor = "#00f5ff88"; e.currentTarget.style.background = "#00f5ff11"; }}
                  onPointerLeave={e => { e.currentTarget.style.borderColor = "#2a2a3a"; e.currentTarget.style.background = "transparent"; }}
                >
                  {ui.paused ? "▶" : "II"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Board */}
        <div style={{ position: "relative" }}>
          <canvas
            ref={canvasRef}
            width={COLS * CELL} height={ROWS * CELL}
            className="board-canvas"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          />
          
          {/* Mobil Overlays (Sadece mobilde görünür) */}
          {isTouch && (
            <>
              <div className="mobile-overlay-panel mobile-hold">
                <span style={{ fontSize: "0.4rem", color: "#555", marginBottom: "0.2rem" }}>HOLD</span>
                <canvas ref={holdCanvasRef} width={PW} height={PH} style={{ width: 45, height: 35 }} />
              </div>
              <div className="mobile-overlay-panel mobile-next">
                <span style={{ fontSize: "0.4rem", color: "#555", marginBottom: "0.2rem" }}>NEXT</span>
                <canvas ref={nextCanvasRef} width={PW} height={PH} style={{ width: 45, height: 35 }} />
              </div>
            </>
          )}

          {ui.message && (
            <div 
              key={ui.message}
              style={{
                position: "absolute", top: "45%", left: "50%",
                transform: "translate(-50%, -50%)",
                zIndex: 60, pointerEvents: "none",
                animation: "floatUp 1.2s ease-out forwards",
                color: "#00f5ff", fontSize: "0.8rem", fontWeight: "bold",
                textShadow: "0 0 15px #00f5ff, 0 0 30px #00f5ff",
                letterSpacing: "0.15em", textAlign: "center", width: "100%",
                fontFamily: "inherit"
              }}
            >
              {ui.message}
            </div>
          )}
          {!ui.running && duel.status === "idle" && !showDuelLobby && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(4,4,12,0.95)", gap: "1.1rem", zIndex: 50, padding: "2rem" }}>
              {ui.gameOver && (
                <>
                  <p style={{ color: "#ff2052", fontSize: "1.1rem", textShadow: "0 0 15px #ff2052", letterSpacing: "0.15em" }}>GAME OVER</p>
                  <div style={{ textAlign: "center", lineHeight: 2.4 }}>
                    <p style={{ color: "#ffd700", fontSize: "0.75rem" }}>SCORE &nbsp; {ui.score}</p>
                    <p style={{ color: "#00f5ff", fontSize: "0.75rem" }}>BEST &nbsp;&nbsp; {ui.bestScore}</p>
                  </div>
                  
                  {/* Skor Kaydetme Bölümü */}
                  <div style={{ borderTop: "1px solid #222", paddingTop: "1.5rem", width: "100%", maxWidth: 280 }}>
                    <p style={{ fontSize: "0.4rem", color: "#555", marginBottom: "0.8rem", textAlign: "center" }}>LİDERLİK TABLOSUNA KATIL</p>
                    {userRank.global === 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
                        <input
                          id="nickname-input"
                          type="text"
                          placeholder="Nickname"
                          defaultValue={ui.savedNickname}
                          maxLength={15}
                          style={{
                            background: "#0a0a15", border: "1px solid #333", color: "#fff",
                            padding: "0.8rem", fontSize: "0.45rem", outline: "none",
                            fontFamily: "inherit", textAlign: "center"
                          }}
                        />
                        <button
                          disabled={isSubmitting}
                          onClick={() => submitScore(document.getElementById('nickname-input')?.value, ui.score)}
                          style={{ background: "#00f5ff", color: "#000", border: "none", padding: "0.8rem", fontSize: "0.42rem", opacity: isSubmitting ? 0.5 : 1 }}
                        >
                          {isSubmitting ? "KAYDEDİLİYOR..." : "SKORU GÖNDER"}
                        </button>
                      </div>
                    ) : (
                      <div style={{ textAlign: "center" }}>
                        <p style={{ fontSize: "0.45rem", color: "#39ff14", marginBottom: "1rem" }}>SIRALAMALARIN</p>
                        <div style={{ fontSize: "0.35rem", color: "#ccc", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                          <p>DÜNYA : #{userRank.global}</p>
                          {!geo.country ? (
                            <p style={{ color: "#555" }}>KONUM YÜKLENİYOR...</p>
                          ) : (
                            <>
                              <p>{getFlagEmoji(geo.countryCode)} {geo.country.toUpperCase()} : #{userRank.country}</p>
                              <p>📍 {geo.city.toUpperCase()} : #{userRank.city}</p>
                            </>
                          )}
                        </div>

                        {/* Top 10 Listesi */}
                        {leaderboard.length > 0 && (
                          <div style={{ marginTop: "1.5rem", borderTop: "1px solid #222", paddingTop: "1.5rem" }}>
                            <p style={{ fontSize: "0.4rem", color: "#ffd700", marginBottom: "1rem" }}>TOP 10 DÜNYA LİDERLERİ</p>
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", textAlign: "left" }}>
                              {leaderboard.map((entry, i) => (
                                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.3rem", padding: "0.2rem 0", borderBottom: "1px solid #111" }}>
                                  <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                                    <span style={{ color: "#555", width: 25 }}>{i+1}.</span>
                                    <span style={{ color: i === 0 ? "#ffd700" : "#fff" }}>{entry.username.toUpperCase()}</span>
                                    <span>{getFlagEmoji(entry.country_code)}</span>
                                  </div>
                                  <span style={{ color: "#00f5ff" }}>{entry.score}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
              <button
                onClick={startGame}
                onPointerEnter={() => setMainMenuIndex(0)}
                style={{ background: mainMenuIndex === 0 ? "rgba(0,245,255,0.12)" : "transparent", border: "2px solid #00f5ff", color: "#00f5ff", padding: "1rem 2.5rem", fontSize: "0.85rem", letterSpacing: "0.15em", textShadow: "0 0 10px #00f5ff", boxShadow: mainMenuIndex === 0 ? "0 0 28px rgba(0,245,255,0.35)" : "0 0 20px rgba(0,245,255,0.25)" }}
              >
                {ui.gameOver ? "PLAY AGAIN" : "START GAME"}
              </button>
              <button
                onClick={() => setShowDuelLobby(true)}
                onPointerEnter={() => setMainMenuIndex(1)}
                style={{ background: mainMenuIndex === 1 ? "rgba(255,32,82,0.20)" : "rgba(255,32,82,0.10)", border: "2px solid #ff2052", color: "#ff2052", padding: "1rem 2rem", fontSize: "0.8rem", letterSpacing: "0.15em", boxShadow: mainMenuIndex === 1 ? "0 0 28px rgba(255,32,82,0.28)" : "0 0 20px rgba(255,32,82,0.18)" }}
              >
                ⚔ DÜELLO
              </button>
            </div>
          )}
        </div>

        {duel.status !== "idle" && (
          <div className="duel-panel">
            <div>
              <p style={{ fontSize: "0.55rem", color: "#ff2052", marginBottom: "0.35rem", letterSpacing: "0.1em" }}>RAKİP</p>
              <div style={{ marginBottom: "0.5rem", padding: "0.45rem", border: "1px solid rgba(255,32,82,0.2)", background: "rgba(0,0,0,0.35)" }}>
                <p style={{ fontSize: "0.34rem", color: "#ccc", marginBottom: "0.25rem", wordBreak: "break-word" }}>
                  {duel.opponentNickname || (duel.status === "waiting" ? "BEKLENİYOR" : "RAKİP BAĞLANTI")}
                </p>
                <p style={{ fontSize: "0.55rem", color: "#00f5ff", textShadow: "0 0 10px #00f5ff" }}>{duel.opponentScore}</p>
              </div>
              <canvas
                ref={opponentCanvasRef}
                width={84}
                height={168}
                style={{ display: "block", border: "1px solid rgba(255,255,255,0.06)", width: "100%", height: "auto", background: "rgba(0,0,0,0.45)" }}
              />
            </div>
          </div>
        )}

        {/* Sağ panel: NEXT + skor (Masaüstü) */}
        {!isTouch && (
          <div className="side-panel">
            <div>
              <p style={{ fontSize: "0.7rem", color: "#444", marginBottom: "0.5rem", letterSpacing: "0.15em" }}>NEXT</p>
              <canvas ref={nextCanvasRef} width={PW} height={PH}
                style={{ display: "block", border: "1px solid rgba(255,255,255,0.06)", width: "100%", height: "auto" }} />
            </div>
            {[
              { label: "BEST", value: ui.bestScore, color: "#00f5ff" },
              { label: "SCORE", value: ui.score, color: "#ffd700" },
              { label: "LINES", value: ui.lines, color: "#39ff14" },
              { label: "LEVEL", value: ui.level, color: "#bf00ff" },
            ].map(({ label, value, color }) => (
              <div key={label} className="keys-hint" style={{ display: 'flex', flexDirection: 'column' }}>
                <p style={{ fontSize: "0.6rem", color: "#3a3a4a", marginBottom: "0.3rem", letterSpacing: "0.1em" }}>{label}</p>
                <p style={{ fontSize: "1rem", color, textShadow: `0 0 10px ${color}` }}>{value}</p>
              </div>
            ))}
            <div className="keys-hint" style={{ fontSize: "0.55rem", color: "#252535", lineHeight: 2.3, marginTop: "0.5rem" }}>
              <p style={{ color: "#2e2e44", marginBottom: "0.4rem", fontSize: "0.6rem" }}>KEYS</p>
              <p>← → Hareket</p>
              <p>↑/X Döndür</p>
              <p>↓ Soft drop</p>
              <p>SPC Hard drop</p>
              <p>C/⇧ Hold</p>
            </div>
          </div>
        )}
      </div>

      {/* Stats Bar (Sadece mobilde board altında görünür) */}
      {isTouch && (
        <div className="stats-bar">
          {[
            { label: "SCORE", value: ui.score, color: "#ffd700" },
            { label: "LINES", value: ui.lines, color: "#39ff14" },
            { label: "LEVEL", value: ui.level, color: "#bf00ff" },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center" }}>
              <p style={{ fontSize: "0.3rem", color: "#555", marginBottom: "0.1rem" }}>{s.label}</p>
              <p style={{ fontSize: "0.6rem", color: s.color, fontWeight: "bold" }}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Mobil Butonlar (Pro Elite Style) ─────────────────────────────────────────── */}
      {isTouch && settings.showButtons && (
        <div className="control-deck">
          {/* Sol: Hareket (D-Pad Style) */}
          <div style={{ position: "relative", width: 150, height: 150 }}>
             <div style={{ position: "absolute", left: 0, top: 44 }}>
                <MobileBtn label="◀" onAction={btnLeft} repeat color="#00f5ff" style={{ width: 60, height: 60, fontSize: "1.3rem !important" }} />
             </div>
             <div style={{ position: "absolute", right: 0, top: 44 }}>
                <MobileBtn label="▶" onAction={btnRight} repeat color="#00f5ff" style={{ width: 60, height: 60, fontSize: "1.3rem !important" }} />
             </div>
             <div style={{ position: "absolute", left: 45, bottom: 0 }}>
                <MobileBtn label="▼" onAction={btnDown} repeat color="#39ff14" style={{ width: 60, height: 60, fontSize: "1.3rem !important" }} />
             </div>
          </div>

          {/* Sağ: Aksiyon (Pro Cluster) */}
          <div style={{ position: "relative", width: 160, height: 160 }}>
             {/* Rotate (Primary) */}
             <div style={{ position: "absolute", right: 0, top: 0 }}>
               <MobileBtn 
                 label="↻" 
                 onAction={btnRotate} 
                 color="#bf00ff" 
                 style={{ 
                   width: 85, height: 85, 
                   fontSize: "1.8rem !important",
                   borderWidth: "3px !important"
                 }} 
               />
             </div>
             {/* Hold (Top Left of Action Cluster) */}
             <div style={{ position: "absolute", left: 0, top: 0 }}>
                <MobileBtn label="H" onAction={btnHold} color="#ffd700" 
                  style={{ 
                    width: 54, height: 54, 
                    fontSize: "0.8rem !important",
                    borderStyle: "dashed !important",
                    opacity: 0.8
                  }} />
             </div>
             {/* Hard Drop (Bottom right of Action Cluster) */}
             <div style={{ position: "absolute", right: 10, bottom: 0 }}>
               <MobileBtn 
                 label="↡" 
                 onAction={btnHardDrop} 
                 color="#ff2052" 
                 style={{ 
                   width: 54, height: 54,
                   fontSize: "1.3rem !important"
                 }} 
               />
             </div>
          </div>
        </div>
      )}
    </div>
  );
}
