/* ═══════════════════════════════════════════════
   EsportsArena Mini App — Frontend Logic
   Vanilla JS, no frameworks
═══════════════════════════════════════════════ */

'use strict';

// ─── Telegram WebApp Init ─────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const TG_USER = tg?.initDataUnsafe?.user || null;
const USER_ID   = TG_USER?.id       || `guest_${Math.random().toString(36).slice(2,8)}`;
const USER_NAME = TG_USER?.username || TG_USER?.first_name || 'Гість';

// Display user info
document.getElementById('userName').textContent = `@${USER_NAME}`;
document.getElementById('userAvatar').textContent = USER_NAME.charAt(0).toUpperCase();

// ─── State ────────────────────────────────────────────────────────────────────
const STORAGE_KEY = `esports_predictions_${USER_ID}`;

function loadPredictionsFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePredictionsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(myPredictions));
  } catch {}
}

// Очищаємо застарілі ставки на завершені матчі при старті
function pruneFinishedMatches(matches) {
  let changed = false;
  // Залишаємо тільки ставки на матчі що ще є в списку (не видалені з сервера)
  const validIds = new Set(matches.map(m => m.id));
  for (const matchId of Object.keys(myPredictions)) {
    if (!validIds.has(matchId)) {
      delete myPredictions[matchId];
      changed = true;
    }
  }
  if (changed) savePredictionsToStorage();
}

let myPredictions = loadPredictionsFromStorage(); // { matchId: teamId }
let activeGame    = '';  // LFG filter

// ─── Helpers ─────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = d - now;

  if (Math.abs(diff) < 60000) return 'Зараз / Now';
  if (diff > 0) {
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h > 0) return `через ${h}г ${m}хв / in ${h}h ${m}m`;
    return `через ${m}хв / in ${m}m`;
  }
  const ago = Math.abs(diff);
  const h = Math.floor(ago / 3600000);
  const m = Math.floor((ago % 3600000) / 60000);
  if (h > 0) return `${h}г ${m}хв тому / ${h}h ${m}m ago`;
  return `${m}хв тому / ${m}m ago`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'щойно / just now';
  if (m < 60) return `${m}хв тому`;
  const h = Math.floor(m / 60);
  return `${h}г тому`;
}

const GAME_ICONS = {
  'CS2': '🔫',
  'Dota 2': '🧙',
  'Valorant': '🎯',
  'League of Legends': '⚔️',
  'Apex Legends': '🪂',
};

// ─── TABS ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');

    if (tab === 'leaderboard') loadLeaderboard();
    if (tab === 'lfg')         loadPlayers();
  });
});

// ─── MATCHES ─────────────────────────────────────────────────────────────────
async function loadMatches() {
  try {
    const res = await fetch('/matches');
    const matches = await res.json();
    pruneFinishedMatches(matches);
    renderMatches(matches);
  } catch (e) {
    document.getElementById('matchesList').innerHTML =
      `<div class="empty-state"><span class="empty-icon">⚠️</span>Помилка завантаження / Load error</div>`;
  }
}

function renderMatches(matches) {
  const container = document.getElementById('matchesList');
  if (!matches.length) {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">📭</span>Матчів немає / No matches</div>`;
    return;
  }

  container.innerHTML = matches.map(m => {
    const isFinished = m.status === 'finished';
    const myPick     = myPredictions[m.id];
    const winner     = m.winner;

    const teamAClass = myPick === m.teamA.id
      ? isFinished ? (winner === m.teamA.id ? 'winner-correct' : 'winner-wrong') : 'selected'
      : '';
    const teamBClass = myPick === m.teamB.id
      ? isFinished ? (winner === m.teamB.id ? 'winner-correct' : 'winner-wrong') : 'selected'
      : '';

    const disabled = isFinished || myPick ? 'disabled' : '';

    let statusBadge = '';
    if (isFinished) {
      statusBadge = `<span class="match-status-badge finished">Завершено / Finished</span>`;
    }

    const savedMsg = myPick
      ? `<p class="prediction-saved visible">✓ Прогноз: ${myPick === m.teamA.id ? m.teamA.name : m.teamB.name}</p>`
      : `<p class="prediction-saved" id="saved-${m.id}"></p>`;

    return `
      <div class="match-card">
        <div class="match-meta">
          <span class="match-game-tag">${m.game}</span>
          <span class="match-time">${formatTime(m.startTime)}</span>
          ${statusBadge}
        </div>
        <div class="teams-row">
          <button class="team-btn ${teamAClass}" ${disabled}
            onclick="predict('${m.id}', '${m.teamA.id}', '${m.teamA.name}', '${m.teamB.id}')">
            <span class="team-logo">${m.teamA.logo}</span>
            <span class="team-name">${m.teamA.name}</span>
          </button>
          <span class="vs-divider">VS</span>
          <button class="team-btn ${teamBClass}" ${disabled}
            onclick="predict('${m.id}', '${m.teamB.id}', '${m.teamB.name}', '${m.teamA.id}')">
            <span class="team-logo">${m.teamB.logo}</span>
            <span class="team-name">${m.teamB.name}</span>
          </button>
        </div>
        ${savedMsg}
      </div>
    `;
  }).join('');
}

async function predict(matchId, teamId, teamName, _otherId) {
  if (myPredictions[matchId]) return;

  myPredictions[matchId] = teamId;
  savePredictionsToStorage(); // зберігаємо одразу

  try {
    await fetch('/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, username: USER_NAME, matchId, teamId }),
    });
    toast(`✅ Прогноз збережено: ${teamName}`, 'success');
  } catch (e) {
    toast('❌ Помилка збереження / Save error', 'error');
    delete myPredictions[matchId];
    savePredictionsToStorage(); // відкат
  }
  loadMatches(); // re-render to show selection
}

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────
async function loadLeaderboard() {
  const body = document.getElementById('leaderboardBody');
  body.innerHTML = `<div class="lb-empty"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;

  try {
    const res  = await fetch('/leaderboard');
    const data = await res.json();
    renderLeaderboard(data);
  } catch {
    body.innerHTML = `<div class="lb-empty">⚠️ Помилка / Error</div>`;
  }
}

function renderLeaderboard(data) {
  const body = document.getElementById('leaderboardBody');
  if (!data.length) {
    body.innerHTML = `<div class="lb-empty">Ще немає прогнозів / No predictions yet</div>`;
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  body.innerHTML = data.map((p, i) => {
    const rankLabel = i < 3 ? medals[i] : `#${i + 1}`;
    const rankClass = i < 3 ? `rank-${i + 1}` : '';
    const isMe      = p.userId == USER_ID;
    return `
      <div class="lb-row" style="${isMe ? 'background:rgba(0,212,255,0.04);' : ''}">
        <span class="lb-rank ${rankClass}">${rankLabel}</span>
        <span class="lb-user">${isMe ? '⭐ ' : ''}${escHtml(p.username)}</span>
        <span class="lb-correct">${p.correct}</span>
        <span class="lb-total">${p.total}</span>
      </div>
    `;
  }).join('');
}

// ─── LFG ─────────────────────────────────────────────────────────────────────
document.getElementById('lfgSubmit').addEventListener('click', async () => {
  const game = document.getElementById('lfgGame').value;
  const role = document.getElementById('lfgRole').value;
  const rank = document.getElementById('lfgRank').value;

  if (!game || !role || !rank) {
    toast('⚠️ Заповніть всі поля / Fill all fields', 'error');
    return;
  }

  try {
    const res = await fetch('/lfg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID, username: USER_NAME, game, role, rank }),
    });
    const data = await res.json();
    if (data.success) {
      toast('✅ Профіль додано / Profile added', 'success');
      loadPlayers();
    } else {
      toast(`❌ ${data.error}`, 'error');
    }
  } catch {
    toast('❌ Помилка сервера / Server error', 'error');
  }
});

async function loadPlayers() {
  const container = document.getElementById('playersList');
  container.innerHTML = `<div class="empty-state"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;

  try {
    const url = activeGame ? `/players?game=${encodeURIComponent(activeGame)}` : '/players';
    const res  = await fetch(url);
    const data = await res.json();
    renderPlayers(data);
  } catch {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span>Помилка / Error</div>`;
  }
}

function renderPlayers(players) {
  const container = document.getElementById('playersList');
  if (!players.length) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">👤</span>
        Гравців не знайдено / No players found
      </div>`;
    return;
  }

  container.innerHTML = players.map(p => {
    const icon  = GAME_ICONS[p.game] || '🎮';
    const isMe  = p.userId == USER_ID;
    return `
      <div class="player-card">
        <div class="player-avatar">${icon}</div>
        <div class="player-info">
          <div class="player-name">${isMe ? '⭐ ' : ''}${escHtml(p.username)}</div>
          <div class="player-tags">
            <span class="player-tag tag-game">${escHtml(p.game)}</span>
            <span class="player-tag tag-role">${escHtml(p.role)}</span>
            <span class="player-tag tag-rank">${escHtml(p.rank)}</span>
          </div>
        </div>
        <span class="player-time">${timeAgo(p.joinedAt)}</span>
      </div>
    `;
  }).join('');
}

// ── Game filters ──
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeGame = chip.dataset.game;
    loadPlayers();
  });
});

// ─── Utils ────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadMatches();
