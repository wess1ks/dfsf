const express = require('express');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { HLTV } = require('hltv');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory storage ────────────────────────────────────────────────────────
const predictions = {};   // { userId: { username, picks: { matchId: teamId } } }
const lfgPlayers  = [];

// ─── Match cache ──────────────────────────────────────────────────────────────
let cachedMatches   = [];
let lastFetchTime   = 0;
const CACHE_TTL_MS  = 5 * 60 * 1000; // 5 хвилин

// ─── Config ───────────────────────────────────────────────────────────────────
// PandaScore: безкоштовний публічний API (CS2, Dota 2, Valorant, LoL)
// Без токена: ~100 запитів/год. З токеном — більше.
// Отримати безкоштовний токен: https://pandascore.co


// ─── HTTP helper ─────────────────────────────────────────────────────────────
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'EsportsArena-MiniApp/2.0',
        'Accept': 'application/json',
        ...headers,
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function gameEmoji(game) {
  const map = {
    'CS2': '🔫', 'CS:GO': '🔫', 'Dota 2': '🧙', 'Valorant': '🎯',
    'League of Legends': '⚔️', 'Apex Legends': '🪂',
    'Rocket League': '🚀', 'Overwatch': '🦸', 'Rainbow Six': '🛡️',
  };
  return map[game] || '🎮';
}

function normalizeGame(slug) {
  const map = {
    'cs-go': 'CS2', 'cs2': 'CS2', 'csgo': 'CS2',
    'dota-2': 'Dota 2', 'dota2': 'Dota 2',
    'valorant': 'Valorant',
    'league-of-legends': 'League of Legends', 'lol': 'League of Legends',
    'apex-legends': 'Apex Legends',
    'rocket-league': 'Rocket League',
    'overwatch-2': 'Overwatch',
    'r6-siege': 'Rainbow Six',
  };
  const key = (slug || '').toLowerCase().replace(/\s/g, '-');
  return map[key] || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}


async function fetchHLTVMatches() {
  try {
    const matches = await HLTV.getMatches();

    return matches.slice(0, 10).map(m => ({
      id: `hltv_${m.id}`,
      source: 'hltv',
      game: 'CS2',
      tournament: m.event?.name || 'HLTV Event',

      teamA: {
        id: `hltv_${m.id}_a`,
        name: m.team1?.name || 'TBD',
        logo: '🔫'
      },
      teamB: {
        id: `hltv_${m.id}_b`,
        name: m.team2?.name || 'TBD',
        logo: '🔫'
      },

      startTime: m.date
        ? new Date(m.date).toISOString()
        : new Date(Date.now() + 3600000).toISOString(),

      status: m.live ? 'live' : 'upcoming',
      winner: null,
      score: null,
      hltvUrl: m.id ? `https://www.hltv.org/matches/${m.id}` : null,
    }));

  } catch (e) {
    console.warn('[HLTV]', e.message);
    return [];
  }
}


// ─── OpenDota API — live Dota 2 матчі ────────────────────────────────────────
// Повністю безкоштовний, без ключа. https://docs.opendota.com
async function fetchOpenDotaLive() {
  try {
    const data = await fetchJson('https://api.opendota.com/api/live');
    if (!Array.isArray(data)) return [];

    return data
      .filter(m =>
        m.radiant_team?.name && m.dire_team?.name &&
        m.radiant_team.name !== 'Radiant' && m.dire_team.name !== 'Dire'
      )
      .slice(0, 4)
      .map(m => ({
        id: `dota_${m.match_id}`,
        source: 'opendota',
        game: 'Dota 2',
        tournament: m.league?.name || 'Dota 2 Pro Match',
        teamA: { id: `dota_${m.match_id}_a`, name: m.radiant_team.name, logo: '🧙' },
        teamB: { id: `dota_${m.match_id}_b`, name: m.dire_team.name,    logo: '🧙' },
        startTime: new Date(Date.now() - 20 * 60000).toISOString(),
        status: 'live',
        winner: null,
        score: { a: m.radiant_score || 0, b: m.dire_score || 0 },
        hltvUrl: null,
      }));
  } catch (e) {
    console.warn('[OpenDota]', e.message);
    return [];
  }
}

// ─── Головна функція збору матчів ─────────────────────────────────────────────
async function fetchAllMatches() {
  console.log('[Fetch] Querying open esports APIs...');

  const [hltvResult, dotaResult] = await Promise.allSettled([
    fetchHLTVMatches(),
    fetchOpenDotaLive(),
  ]);

  let allMatches = [];

  if (hltvResult.status === 'fulfilled' && hltvResult.value.length > 0) {
    console.log(`[HLTV]`);
    allMatches.push(...hltvResult.value);
  }

  if (dotaResult.status === 'fulfilled' && dotaResult.value.length > 0) {
    console.log(`[OpenDota] ✅ ${dotaResult.value.length} live Dota matches`);
    allMatches.push(...dotaResult.value);
  }

  // Дедублікація: якщо той самий матч і з PandaScore і з OpenDota
  const seen = new Set();
  allMatches = allMatches.filter(m => {
    const key = `${m.game}|${m.teamA.name}|${m.teamB.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Прибираємо матчі "TBD vs TBD" — не мають сенсу для ставок
  allMatches = allMatches.filter(m =>
    m.teamA.name && m.teamB.name &&
    m.teamA.name !== 'TBD' && m.teamB.name !== 'TBD'
  );

  if (allMatches.length > 0) {
    console.log(`[Fetch] ✅ Total: ${allMatches.length} matches`);
    return allMatches;
  }

  console.warn('[Fetch] No data from APIs');
  return null;
}

// ─── Fallback — реалістичні демо матчі ───────────────────────────────────────
function getFallbackMatches() {
  const now = Date.now();
  return [
    {
      id: 'fb_1', source: 'demo', game: 'CS2',
      tournament: 'ESL Pro League Season 19',
      teamA: { id: 'fb_1_a', name: 'NAVI',          logo: '🏆' },
      teamB: { id: 'fb_1_b', name: 'Team Vitality',  logo: '🐝' },
      startTime: new Date(now + 1.5 * 3600000).toISOString(),
      status: 'upcoming', winner: null, score: null, hltvUrl: null,
    },
    {
      id: 'fb_2', source: 'demo', game: 'CS2',
      tournament: 'ESL Pro League Season 19',
      teamA: { id: 'fb_2_a', name: 'G2 Esports',  logo: '⚡' },
      teamB: { id: 'fb_2_b', name: 'FaZe Clan',   logo: '💀' },
      startTime: new Date(now + 3 * 3600000).toISOString(),
      status: 'upcoming', winner: null, score: null, hltvUrl: null,
    },
    {
      id: 'fb_3', source: 'demo', game: 'CS2',
      tournament: 'BLAST Premier Spring',
      teamA: { id: 'fb_3_a', name: 'Heroic',   logo: '⚔️' },
      teamB: { id: 'fb_3_b', name: 'ENCE',     logo: '🎯' },
      startTime: new Date(now - 2 * 3600000).toISOString(),
      status: 'finished', winner: 'fb_3_a', score: { a: 2, b: 0 }, hltvUrl: null,
    },
    {
      id: 'fb_4', source: 'demo', game: 'CS2',
      tournament: 'ESL Pro League Season 19',
      teamA: { id: 'fb_4_a', name: 'Astralis', logo: '🌟' },
      teamB: { id: 'fb_4_b', name: 'NIP',      logo: '🎮' },
      startTime: new Date(now + 5 * 3600000).toISOString(),
      status: 'upcoming', winner: null, score: null, hltvUrl: null,
    },
    {
      id: 'fb_5', source: 'demo', game: 'Dota 2',
      tournament: 'The International 2024',
      teamA: { id: 'fb_5_a', name: 'Team Spirit', logo: '👻' },
      teamB: { id: 'fb_5_b', name: 'OG',          logo: '🌿' },
      startTime: new Date(now + 6 * 3600000).toISOString(),
      status: 'upcoming', winner: null, score: null, hltvUrl: null,
    },
    {
      id: 'fb_6', source: 'demo', game: 'Valorant',
      tournament: 'VCT Champions 2024',
      teamA: { id: 'fb_6_a', name: 'Sentinels', logo: '🎯' },
      teamB: { id: 'fb_6_b', name: 'Cloud9',    logo: '☁️' },
      startTime: new Date(now + 8 * 3600000).toISOString(),
      status: 'upcoming', winner: null, score: null, hltvUrl: null,
    },
    {
      id: 'fb_7', source: 'demo', game: 'League of Legends',
      tournament: 'LEC Spring 2024',
      teamA: { id: 'fb_7_a', name: 'G2 Esports', logo: '⚡' },
      teamB: { id: 'fb_7_b', name: 'Team BDS',   logo: '🛡️' },
      startTime: new Date(now + 10 * 3600000).toISOString(),
      status: 'upcoming', winner: null, score: null, hltvUrl: null,
    },
  ];
}

// ─── Кеш ─────────────────────────────────────────────────────────────────────
async function refreshMatchCache() {
  const now = Date.now();
  if (now - lastFetchTime < CACHE_TTL_MS && cachedMatches.length > 0) {
    return cachedMatches;
  }

  const fresh = await fetchAllMatches();

  if (fresh && fresh.length > 0) {
    const prevMap = {};
    cachedMatches.forEach(m => { prevMap[m.id] = m; });

    cachedMatches = fresh.map(m => {
      const prev = prevMap[m.id];
      if (prev && prev.status === 'finished' && !m.winner) {
        return { ...m, status: 'finished', winner: prev.winner, score: prev.score };
      }
      return m;
    });

    cachedMatches.sort((a, b) => {
      const order = { live: 0, upcoming: 1, finished: 2 };
      const sd = (order[a.status] ?? 1) - (order[b.status] ?? 1);
      return sd !== 0 ? sd : new Date(a.startTime) - new Date(b.startTime);
    });

    lastFetchTime = now;
    console.log(`[Cache] ✅ ${cachedMatches.length} matches cached`);
  } else {
    if (cachedMatches.length === 0) {
      cachedMatches = getFallbackMatches();
      console.warn('[Cache] Using demo fallback data');
    }
    lastFetchTime = now;
  }

  return cachedMatches;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/matches', async (req, res) => {
  try {
    const matches = await refreshMatchCache();
    res.json(matches);
  } catch (err) {
    console.error('[GET /matches]', err);
    res.json(cachedMatches.length ? cachedMatches : getFallbackMatches());
  }
});

app.get('/matches/status', (req, res) => {
  const matches = cachedMatches.length ? cachedMatches : getFallbackMatches();
  res.json({
    count: matches.length,
    live: matches.filter(m => m.status === 'live').length,
    upcoming: matches.filter(m => m.status === 'upcoming').length,
    finished: matches.filter(m => m.status === 'finished').length,
    lastUpdate: new Date(lastFetchTime).toISOString(),
    sources: [...new Set(matches.map(m => m.source))],
  });
});

app.post('/predict', (req, res) => {
  const { userId, username, matchId, teamId } = req.body;
  if (!userId || !matchId || !teamId)
    return res.status(400).json({ error: 'Missing fields' });

  const match = cachedMatches.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.status === 'finished')
    return res.status(400).json({ error: 'Match already finished' });

  if (!predictions[userId]) predictions[userId] = { username, picks: {} };
  predictions[userId].username = username || predictions[userId].username || `User${userId}`;
  predictions[userId].picks[matchId] = teamId;

  res.json({ success: true, message: 'Прогноз збережено / Prediction saved' });
});

app.get('/leaderboard', (req, res) => {
  const board = Object.entries(predictions).map(([userId, data]) => {
    let correct = 0, total = 0;
    for (const [matchId, teamId] of Object.entries(data.picks)) {
      const match = cachedMatches.find(m => m.id === matchId);
      if (match && match.status === 'finished') {
        total++;
        if (match.winner === teamId) correct++;
      }
    }
    return { userId, username: data.username || `User${userId}`, correct, total };
  });
  board.sort((a, b) => b.correct - a.correct || b.total - a.total);
  res.json(board);
});

app.post('/lfg', (req, res) => {
  const { userId, username, game, role, rank } = req.body;
  if (!userId || !game || !role || !rank)
    return res.status(400).json({ error: 'Missing fields' });

  const existing = lfgPlayers.findIndex(p => p.userId === userId);
  const player = {
    userId, username: username || `User${userId}`,
    game, role, rank, joinedAt: new Date().toISOString(),
  };

  if (existing !== -1) lfgPlayers[existing] = player;
  else lfgPlayers.push(player);

  res.json({ success: true });
});

app.get('/players', (req, res) => {
  const { game } = req.query;
  res.json(game ? lfgPlayers.filter(p => p.game === game) : lfgPlayers);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🎮 EsportsArena Mini App → http://localhost:${PORT}`);
  console.log(`📡 Data sources:`);
  console.log(`   • HLTV (CS2 matches)                     — hltv.org`);
  console.log(`   • OpenDota API (Dota 2 live)                  — opendota.com`);
  if (!PANDASCORE_TOKEN) {
    console.log(`\n💡 Optional: set PANDASCORE_TOKEN for higher rate limits`);
    console.log(`   Get free token at https://pandascore.co\n`);
  }
  await refreshMatchCache();
  console.log(`✅ Ready! ${cachedMatches.length} matches loaded\n`);

  setInterval(() => {
    lastFetchTime = 0;
    refreshMatchCache().catch(console.error);
  }, CACHE_TTL_MS);
});
