import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./src/supabase";

// ─── Sabitler ────────────────────────────────────────────────────────────────
const COLS = 10;
const ROWS = 20;
const CELL = 36;

const COLORS = {
  I: "#00f5ff", O: "#ffd700", T: "#bf00ff",
  S: "#39ff14", Z: "#ff2052", J: "#1e90ff", L: "#ff8c00",
};

// Hareket Hızı Ayarları (DAS/ARR)
const INITIAL_DELAY = 170; // İlk hareketten sonraki bekleme (ms)
const REPEAT_INTERVAL = 45; // Sürekli hareket hızı (ms)
const SWIPE_THRESHOLD = 14; // Hücre başına swipe mesafesi (px)

const PIECES = {
  I: { shape: [[1,1,1,1]], color: "I" },
  O: { shape: [[1,1],[1,1]], color: "O" },
  T: { shape: [[0,1,0],[1,1,1]], color: "T" },
  S: { shape: [[0,1,1],[1,1,0]], color: "S" },
  Z: { shape: [[1,1,0],[0,1,1]], color: "Z" },
  J: { shape: [[1,0,0],[1,1,1]], color: "J" },
  L: { shape: [[0,0,1],[1,1,1]], color: "L" },
};

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

function shuffleBag() {
  const keys = Object.keys(PIECES);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [keys[i], keys[j]] = [keys[j], keys[i]];
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

function collides(board, piece, dx = 0, dy = 0, shape = null) {
  const s = shape || piece.shape;
  for (let r = 0; r < s.length; r++)
    for (let c = 0; c < s[r].length; c++) {
      if (!s[r][c]) continue;
      const nx = piece.x + c + dx;
      const ny = piece.y + r + dy;
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
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

function drawBoard(ctx, board, piece, gameOver, showGhost) {
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

  if (!piece || gameOver) return;

  if (showGhost) {
    let ghostDY = 0;
    while (!collides(board, piece, 0, ghostDY + 1)) ghostDY++;
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
        transition: "background 0.08s, border-color 0.08s",
        ...extraStyle,
      }}
      onPointerEnter={e => { e.currentTarget.style.background = `${color}22`; e.currentTarget.style.borderColor = `${color}88`; }}
      onPointerLeave={e => { stop(); e.currentTarget.style.background = `${color}0f`; e.currentTarget.style.borderColor = `${color}44`; }}
    >
      {label}
    </button>
  );
}

// ─── Ana Bileşen ──────────────────────────────────────────────────────────────
export default function Tetris() {
  const canvasRef     = useRef(null);
  const nextCanvasRef = useRef(null);
  const holdCanvasRef = useRef(null);
  const rafRef        = useRef(null);
  const touchRef      = useRef(null);

  const g = useRef({
    board: emptyBoard(), piece: null, next: null,
    hold: null,       // hold slotundaki parça
    canHold: true,    // her parçada 1 kez hold hakkı
    bag: [], bagIndex: 0,
    score: 0, lines: 0, level: 1,
    gameOver: false, running: false, paused: false,
    lastTime: 0, dropInterval: 800, accumulated: 0,
  });

  const [ui, setUi]             = useState({ 
    score: 0, lines: 0, level: 1, 
    bestScore: Number(localStorage.getItem("tetris_best")) || 0,
    gameOver: false, running: false, paused: false 
  });
  const [settings, setSettings] = useState({ showButtons: true, showGhost: true });
  const [showSettings, setShowSettings] = useState(false);
  const [isTouch, setIsTouch] = useState(false);
  const [geo, setGeo] = useState({ city: "", country: "", countryCode: "" });
  const [leaderboard, setLeaderboard] = useState([]);
  const [userRank, setUserRank] = useState({ global: 0, country: 0, city: 0 });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setIsTouch('ontouchstart' in window || navigator.maxTouchPoints > 0);
    
    // Konum tespiti (Ücretsiz ve anahtarsız API)
    fetch("https://freeipapi.com/api/json")
      .then(res => res.json())
      .then(data => {
        setGeo({
          city: data.cityName || "Bilinmiyor",
          country: data.countryName || "Bilinmiyor",
          countryCode: data.countryCode || ""
        });
      })
      .catch(err => console.error("Konum tespiti hatası:", err));
  }, []);

  useEffect(() => {
    localStorage.setItem("tetris_best", ui.bestScore);
  }, [ui.bestScore]);

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const changeSetting = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  // ── Render ────────────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const cvs  = canvasRef.current;
    const nCvs = nextCanvasRef.current;
    const hCvs = holdCanvasRef.current;
    if (!cvs || !nCvs || !hCvs) return;
    const { board, piece, next, hold, canHold, gameOver } = g.current;
    drawBoard(cvs.getContext("2d"), board, piece, gameOver, settingsRef.current.showGhost);
    drawPreview(nCvs.getContext("2d"), 110, 82, next);
    drawPreview(hCvs.getContext("2d"), 110, 82, hold, !canHold);
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

    for (let r = 0; r < piece.shape.length; r++)
      for (let c = 0; c < piece.shape[r].length; c++)
        if (piece.shape[r][c]) {
          const ny = piece.y + r;
          if (ny < 0) {
            state.gameOver = true; state.running = false;
            setUi(u => ({ ...u, gameOver: true, running: false }));
            return;
          }
          board[ny][piece.x + c] = piece.color;
        }

    const cleared = clearLines();
    const pts = [0, 100, 300, 500, 800][cleared] || 0;
    state.score += pts * state.level;
    state.lines += cleared;
    state.level = Math.floor(state.lines / 10) + 1;
    state.dropInterval = Math.max(80, 800 - (state.level - 1) * 72);

    state.canHold = true; // yeni parçada hold hakkı sıfırlanır
    state.piece = { ...state.next, shape: state.next.shape.map(r => [...r]), x: 3, y: 0 };
    state.next = randomPiece(state);

    if (collides(board, state.piece)) { state.gameOver = true; state.running = false; }
    
    const newBest = Math.max(ui.bestScore, state.score);
    setUi({ 
      score: state.score, 
      lines: state.lines, 
      level: state.level, 
      bestScore: newBest,
      gameOver: state.gameOver, 
      running: state.running,
      paused: false
    });
  }, [clearLines, ui.bestScore]);

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

  // ── Döndür ────────────────────────────────────────────────────────────────
  const tryRotate = useCallback(() => {
    const state = g.current;
    if (!state.piece) return;
    const rotated = rotate(state.piece.shape);
    const offsets = [
      [0, 0], [1, 0], [-1, 0], [0, -1], [2, 0], [-2, 0], [1, -1], [-1, -1], [0, -2]
    ];
    for (const [dx, dy] of offsets) {
      if (!collides(state.board, state.piece, dx, dy, rotated)) {
        state.piece.shape = rotated;
        state.piece.x += dx;
        state.piece.y += dy;
        return;
      }
    }
  }, []);

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
    state.accumulated += delta;
    if (state.accumulated >= state.dropInterval) {
      state.accumulated = 0;
      if (!collides(state.board, state.piece, 0, 1)) state.piece.y++;
      else lockPiece();
    }
    render();
    rafRef.current = requestAnimationFrame(gameLoop);
  }, [render, lockPiece]);

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
    state.dropInterval = 800;
    state.accumulated = 0;
    state.bag = shuffleBag();
    state.bagIndex = 0;
    state.piece = randomPiece(state);
    state.next = randomPiece(state);
    state.hold = null;
    state.canHold = true;

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
    if (!s.running || s.gameOver) return;
    s.paused = !s.paused;
    setUi(prev => ({ ...prev, paused: s.paused }));
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
      const { data: globalRank } = await supabase.rpc('get_rank', { player_score: score });
      const { data: countryRank } = await supabase.rpc('get_rank_country', { player_score: score, country_name: geo.country });
      const { data: cityRank } = await supabase.rpc('get_rank_city', { player_score: score, city_name: geo.city });
      
      setUserRank({
        global: globalRank || 1,
        country: countryRank || 1,
        city: cityRank || 1
      });
    } catch (e) { console.error("Sıralama hatası:", e); }
  };

  const submitScore = async (username) => {
    if (!supabase) {
      alert("Liderlik tablosu henüz yapılandırılmamış (.env dosyasını kontrol edin).");
      return;
    }
    if (!username || username.trim().length < 2) {
      alert("Lütfen en az 2 karakterlik bir isim girin.");
      return;
    }
    
    setIsSubmitting(true);
    try {
      // Önce ismin benzersizliğini kontrol et (basit kontrol)
      const { data: existing } = await supabase.from('leaderboard').select('username').eq('username', username).single();
      if (existing) {
        alert("Bu isim zaten alınmış, lütfen başka bir isim seçin.");
        setIsSubmitting(false);
        return;
      }

      const { error } = await supabase.from('leaderboard').insert([{
        username,
        score: ui.bestScore,
        city: geo.city,
        country: geo.country,
        country_code: geo.countryCode
      }]);

      if (error) throw error;
      
      await getRanks(ui.bestScore);
      alert("Skorun kaydedildi!");
    } catch (e) {
      console.error("Skor kaydedilirken hata:", e);
      alert("Hata oluştu: " + e.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Aksiyon fonksiyonları ─────────────────────────────────────────────────
  const btnLeft = useCallback(() => {
    const s = g.current;
    if (!s.running || !s.piece || s.paused) return;
    if (!collides(s.board, s.piece, -1, 0)) { s.piece.x--; render(); }
  }, [render]);

  const btnRight = useCallback(() => {
    const s = g.current;
    if (!s.running || !s.piece || s.paused) return;
    if (!collides(s.board, s.piece, 1, 0)) { s.piece.x++; render(); }
  }, [render]);

  const btnDown = useCallback(() => {
    const s = g.current;
    if (!s.running || !s.piece || s.paused) return;
    if (!collides(s.board, s.piece, 0, 1)) { s.piece.y++; s.score += 1; render(); }
    else lockPiece();
  }, [render, lockPiece]);

  const btnRotate = useCallback(() => {
    const s = g.current;
    if (!s.running || s.paused) return;
    tryRotate(); render();
  }, [render, tryRotate]);

  const btnHardDrop = useCallback(() => {
    const s = g.current;
    if (!s.running || !s.piece || s.paused) return;
    let drop = 0;
    while (!collides(s.board, s.piece, 0, drop + 1)) drop++;
    s.piece.y += drop;
    s.score += drop * 2;
    lockPiece(); render();
  }, [render, lockPiece]);

  // ── Klavye ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e) => {
      const state = g.current;
      if (!state.running || !state.piece) return;
      switch (e.key) {
        case "ArrowLeft":  btnLeft();    break;
        case "ArrowRight": btnRight();   break;
        case "ArrowDown":  btnDown();    break;
        case "ArrowUp": case "x": case "X": btnRotate(); break;
        case " ": e.preventDefault(); btnHardDrop(); break;
        case "c": case "C": case "Shift": e.preventDefault(); btnHold(); break;
        case "p": case "P": case "Escape": e.preventDefault(); togglePause(); break;
        default: return;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [btnLeft, btnRight, btnDown, btnRotate, btnHardDrop, btnHold]);

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
        if (!collides(state.board, state.piece, dir, 0)) state.piece.x += dir;
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
      justifyContent: "flex-start", minHeight: "100vh",
      background: "radial-gradient(ellipse at 50% 0%, #0d0d2b 0%, #040408 70%)",
      fontFamily: "'Press Start 2P', monospace", color: "#fff",
      userSelect: "none", touchAction: "none",
      paddingTop: "0.8rem", paddingBottom: "2rem",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        button { cursor: pointer; font-family: inherit; }
      `}</style>

      {ui.paused && (
        <PauseOverlay settings={settings} onChange={changeSetting} onResume={resumeGame} onResetScore={resetBestScore} isTouch={isTouch} />
      )}

      {/* Üst bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: 700, padding: "0 1rem", marginBottom: "1rem" }}>
        <h1 style={{ fontSize: "clamp(1rem, 3vw, 1.5rem)", letterSpacing: "0.35em", color: "#00f5ff", textShadow: "0 0 24px #00f5ff, 0 0 50px #00f5ff44" }}>
          TETRIS
        </h1>
      </div>

      {/* Oyun alanı */}
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start" }}>

        {/* Sol panel: HOLD */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem", width: PW }}>
          <div>
            <p style={{ fontSize: "0.7rem", color: "#444", marginBottom: "0.5rem", letterSpacing: "0.15em" }}>HOLD</p>
            <canvas ref={holdCanvasRef} width={PW} height={PH}
              style={{ display: "block", border: "1px solid rgba(255,255,255,0.06)" }} />
            <p style={{ fontSize: "0.55rem", color: "#2a2a3a", marginTop: "0.5rem", marginBottom: "1.5rem", lineHeight: 1.8 }}>
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

        {/* Board */}
        <div style={{ position: "relative" }}>
          <canvas
            ref={canvasRef}
            width={COLS * CELL} height={ROWS * CELL}
            style={{ display: "block", border: "2px solid rgba(0,245,255,0.3)", boxShadow: "0 0 35px rgba(0,245,255,0.1)" }}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          />
          {!ui.running && (
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(4,4,12,0.95)", gap: "1.1rem", zIndex: 50, padding: "2rem" }}>
              {ui.gameOver && (
                <>
                  <p style={{ color: "#ff2052", fontSize: "1.1rem", textShadow: "0 0 15px #ff2052", letterSpacing: "0.15em" }}>GAME OVER</p>
                  <div style={{ textAlign: "center", lineHeight: 2.4 }}>
                    <p style={{ color: "#ffd700", fontSize: "0.75rem" }}>SCORE &nbsp; {ui.score}</p>
                    <p style={{ color: "#00f5ff", fontSize: "0.75rem" }}>BEST &nbsp;&nbsp; {ui.bestScore}</p>
                  </div>
                  
                  {/* Skor Kaydetme Bölümü */}
                  <div style={{ borderTop: "1px solid #222", paddingTop: "1.5rem", width: "100%", maxWidth: 260 }}>
                    <p style={{ fontSize: "0.4rem", color: "#555", marginBottom: "0.8rem", textAlign: "center" }}>LİDERLİK TABLOSUNA KATIL</p>
                    {userRank.global === 0 ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
                        <input
                          id="nickname-input"
                          type="text"
                          placeholder="Unique Nickname"
                          maxLength={15}
                          style={{
                            background: "#0a0a15", border: "1px solid #333", color: "#fff",
                            padding: "0.8rem", fontSize: "0.45rem", outline: "none",
                            fontFamily: "inherit", textAlign: "center"
                          }}
                        />
                        <button
                          disabled={isSubmitting}
                          onClick={() => submitScore(document.getElementById('nickname-input')?.value)}
                          style={{ background: "#00f5ff", color: "#000", border: "none", padding: "0.8rem", fontSize: "0.42rem", opacity: isSubmitting ? 0.5 : 1 }}
                        >
                          {isSubmitting ? "KAYDEDİLİYOR..." : "SKORU GÖNDER"}
                        </button>
                      </div>
                    ) : (
                      <div style={{ textAlign: "center" }}>
                        <p style={{ fontSize: "0.45rem", color: "#39ff14", marginBottom: "0.8rem" }}>SIRALAMALARIN</p>
                        <p style={{ fontSize: "0.38rem", color: "#ccc", margin: "0.4rem 0" }}>DÜNYA: #{userRank.global}</p>
                        <p style={{ fontSize: "0.38rem", color: "#ccc", margin: "0.4rem 0" }}>{geo.country.toUpperCase()}: #{userRank.country}</p>
                        <p style={{ fontSize: "0.38rem", color: "#ccc", margin: "0.4rem 0" }}>{geo.city.toUpperCase()}: #{userRank.city}</p>
                      </div>
                    )}
                  </div>
                </>
              )}
              <button
                onClick={startGame}
                style={{ background: "transparent", border: "2px solid #00f5ff", color: "#00f5ff", padding: "1rem 2.5rem", fontSize: "0.85rem", letterSpacing: "0.15em", textShadow: "0 0 10px #00f5ff", boxShadow: "0 0 20px rgba(0,245,255,0.25)", marginTop: "1rem" }}
              >
                {ui.gameOver ? "PLAY AGAIN" : "START GAME"}
              </button>
            </div>
          )}
        </div>

        {/* Sağ panel: NEXT + skor */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem", width: PW }}>
          <div>
            <p style={{ fontSize: "0.7rem", color: "#444", marginBottom: "0.5rem", letterSpacing: "0.15em" }}>NEXT</p>
            <canvas ref={nextCanvasRef} width={PW} height={PH}
              style={{ display: "block", border: "1px solid rgba(255,255,255,0.06)" }} />
          </div>
          {[
            { label: "BEST", value: ui.bestScore, color: "#00f5ff" },
            { label: "SCORE", value: ui.score, color: "#ffd700" },
            { label: "LINES", value: ui.lines, color: "#39ff14" },
            { label: "LEVEL", value: ui.level, color: "#bf00ff" },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <p style={{ fontSize: "0.6rem", color: "#3a3a4a", marginBottom: "0.3rem", letterSpacing: "0.1em" }}>{label}</p>
              <p style={{ fontSize: "1rem", color, textShadow: `0 0 10px ${color}` }}>{value}</p>
            </div>
          ))}
          <div style={{ fontSize: "0.55rem", color: "#252535", lineHeight: 2.3, marginTop: "0.5rem" }}>
            <p style={{ color: "#2e2e44", marginBottom: "0.4rem", fontSize: "0.6rem" }}>KEYS</p>
            <p>← → Hareket</p>
            <p>↑/X Döndür</p>
            <p>↓ Soft drop</p>
            <p>SPC Hard drop</p>
            <p>C/⇧ Hold</p>
          </div>
        </div>
      </div>

      {/* ── Mobil Butonlar ─────────────────────────────────────────── */}
      {isTouch && settings.showButtons && (
        <div style={{
          marginTop: "1.2rem",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: "1rem",
          width: "100%",
          maxWidth: 560,
          padding: "0 0.5rem",
        }}>
          {/* Sol grup: HOLD üstte, ← ↓ → altta */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem" }}>
            {/* Üst: HOLD sol, boş sağ */}
            <div style={{ display: "flex", gap: "0.45rem" }}>
              <MobileBtn
                label="HOLD"
                onAction={btnHold}
                color="#ffd700"
                style={{ width: 72, height: 58, fontSize: "0.55rem", fontFamily: "'Press Start 2P', monospace", letterSpacing: "0.05em" }}
              />
              <div style={{ width: 72 }} />
            </div>
            {/* Alt: ← ↓ → */}
            <div style={{ display: "flex", gap: "0.45rem" }}>
              <MobileBtn label="◀" onAction={btnLeft}  repeat color="#00f5ff" style={{ width: 72, height: 64, fontSize: "1.3rem" }} />
              <MobileBtn label="▼" onAction={btnDown}  repeat color="#39ff14" style={{ width: 72, height: 64, fontSize: "1.3rem" }} />
              <MobileBtn label="▶" onAction={btnRight} repeat color="#00f5ff" style={{ width: 72, height: 64, fontSize: "1.3rem" }} />
            </div>
          </div>

          {/* Sağ grup: Döndür + Hard Drop */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.45rem", alignItems: "center" }}>
            <MobileBtn label="↺"   onAction={btnRotate}   color="#bf00ff" style={{ width: 76, height: 58, fontSize: "1.5rem" }} />
            <MobileBtn label="DROP" onAction={btnHardDrop} color="#ff2052" style={{ width: 110, height: 64, fontSize: "0.6rem", fontFamily: "'Press Start 2P', monospace", letterSpacing: "0.05em" }} />
          </div>
        </div>
      )}
    </div>
  );
}
