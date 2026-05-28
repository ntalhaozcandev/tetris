# Duel Mode: Game Mode Selection & Seeded Pieces - Testing Guide

## Features Implemented

### 1. Game Mode Selection in Duel Lobby
- **Location:** "ODA OLUŞTUR" tab in Duel lobby
- **Options:**
  - HAYATTA KALMA MODU (Survival) - First player to die loses
  - PUAN HEDEFI MODU (Score Target) - First to reach target score wins

### 2. Target Score Input (Score Mode)
- **Appears when:** PUAN HEDEFI mode is selected
- **Default:** 5000 points
- **Custom range:** Any positive integer

### 3. Deterministic Piece Seeding
- **Implementation:** Linear Congruential Generator (LCG)
- **Result:** Both players get identical piece sequence in same order
- **How:** Seed generated in host, broadcasted via "init" event during countdown sync

## Testing Steps

### Test 1: Create Room with Survival Mode
1. Click DÜELLO → KODA GİR tab
2. Enter nickname (min 2 chars)
3. Click "ODA OLUŞTUR"
4. UI shows "OYUN MODU SEÇ" with mode buttons
5. "HAYATTA KALMA MODU" should be pre-highlighted (green)
6. Copy room code
7. **Expected:** Game starts as survival mode (die first = lose)

### Test 2: Create Room with Score Target Mode
1. Repeat Test 1 steps
2. In "OYUN MODU SEÇ" screen, click "PUAN HEDEFI MODU"
3. UI shows input field "HEDEF PUAN:" with default 5000
4. Change to custom value (e.g., 3000)
5. Copy room code
6. **Expected:** Game starts with score target 3000 (reach score = win)

### Test 3: Verify Identical Pieces (Seeded Generation)
1. **Player 1:** Create room with any mode
2. **Player 2:** Join same room on separate tab/window
3. Wait for countdown (3-2-1-GO)
4. Game starts on both
5. **Verify:** Both players see identical piece sequence
   - Same current piece color
   - Same next piece preview
   - Same order when pieces are used

### Test 4: Survival Mode Win Condition
1. Create room → select HAYATTA KALMA
2. Join from second window
3. Wait for countdown
4. **Player 1:** Play normally until board fills
5. **Player 2:** Can keep playing or intentionally fill board first
6. **Expected:** First player to fill board completely gets GAME OVER
   - Opponent sees "KAZANDIN" (You won)
   - Game Over player sees "KAYBETTİN" (You lost)

### Test 5: Score Target Mode Win Condition
1. Create room → select PUAN HEDEFI → set 500 (low for quick test)
2. Join from second window
3. Wait for countdown
4. **Player 1:** Play to reach 500 points
5. **Expected:** When Player 1 reaches 500+:
   - Player 1's board locks
   - Both see "KAZANDIN" / "KAYBETTİN"
   - Duel ends (both can't continue)

### Test 6: Rematch System
1. After game ends (either mode)
2. Both players click "RÖVANŞ"
3. UI shows "RÖVANŞ BEKLENİYOR"
4. Wait for opponent to also click
5. When both ready: Countdown starts
6. New game with SAME mode/score/seed
7. **Expected:** Immediate rematch transition

### Test 7: Mode/Seed Persistence Across Rounds
1. Complete first game with Score Target mode (target=500)
2. Both players ready rematch
3. Second game starts
4. **Verify:**
   - Mode remains PUAN HEDEFI
   - Target score still 500
   - Pieces follow NEW seed sequence (not repeat of game 1)

## Keyboard Navigation (Existing)
- **Arrow Left/Right:** Switch tabs (ODA OLUŞTUR ↔ KODA GİR)
- **Arrow Up/Down:** Switch mode buttons or input focus
- **Enter:** Confirm selection
- **Backspace/Esc:** Cancel/back

## Troubleshooting

### Issue: "OYUN MODU SEÇ" not appearing
- Check if status === "waiting" in duel state
- Verify DuelOverlay is receiving `gameMode` prop

### Issue: Pieces don't match between players
- Verify seed is broadcasted via "init" event
- Check SeededRandom class is being instantiated
- Ensure shuffleBag() called with rng parameter in duel mode

### Issue: Score target not triggering win
- Check `duelRef.current.targetScore` is set
- Verify `gameMode === "score"` check in lockPiece()
- Ensure score comparison: `state.score >= duelRef.current.targetScore`

## Expected Visual Indicators

### Mode Selection Screen (Waiting)
```
┌─────────────────────────┐
│    OYUN MODU SEÇ        │
├─────────────────────────┤
│ [HAYATTA KALMA MODU]    │ (green/selected)
│ [PUAN HEDEFI MODU]      │ (gray)
├─────────────────────────┤
│    HEDEF PUAN:          │ (only if score mode)
│    [____5000____]       │
├─────────────────────────┤
│ Rakip bekleniyor... (or)│
│ NickName bağlandı.      │
└─────────────────────────┘
```

### Finished Screen (Both modes)
```
┌─────────────────────────┐
│  KAZANDIN / KAYBETTİN   │
├─────────────────────────┤
│   SET SKORU: X - Y      │
├─────────────────────────┤
│ [RÖVANŞ BEKLENİYOR]     │
│ Rakip rövanş kabul etti │
│ [MENÜYE DÖN]            │
└─────────────────────────┘
```

## Code References

- **useDuel.js:** Seed sync, mode state, init broadcast
- **DuelOverlay.jsx:** Mode selection UI rendering
- **tetris.jsx:347-365:** DuelLobby mode selection (line ~359)
- **tetris.jsx:120-140:** SeededRandom class definition
- **tetris.jsx:175-188:** shuffleBag(rng) enhancement
- **tetris.jsx:1283-1295:** startGame() seed initialization
- **tetris.jsx:1067-1079:** Score mode win condition check
