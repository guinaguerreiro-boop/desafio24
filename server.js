const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const IS_PROD = process.env.NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';

if (IS_PROD && !DATABASE_URL) {
  console.error('DATABASE_URL é obrigatória em produção.');
  process.exit(1);
}
if (IS_PROD && !ADMIN_TOKEN) {
  console.error('ADMIN_TOKEN é obrigatório em produção.');
  process.exit(1);
}

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5,
}) : null;

const localScores = path.join(ROOT, 'data', 'scores.json');
const localQuestions = path.join(ROOT, 'data', 'questions.json');

function json(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

function readLocal(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeLocal(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 100000) { reject(new Error('payload too large')); req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function validName(name) { return typeof name === 'string' && name.trim().length >= 2 && name.trim().length <= 24; }
function validScore(score) { return Number.isFinite(score) && score >= 0 && score <= 1000000; }

// Basic process-local rate limit. The hosting platform can add stronger edge protection later.
const hits = new Map();
function rateLimited(req, key, limit = 30, windowMs = 60000) {
  const now = Date.now();
  const k = key + ':' + (req.socket.remoteAddress || 'unknown');
  const old = hits.get(k) || [];
  const fresh = old.filter(t => now - t < windowMs);
  fresh.push(now);
  hits.set(k, fresh);
  return fresh.length > limit;
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(24) NOT NULL,
      score INTEGER NOT NULL CHECK (score >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS scores_score_idx ON scores (score DESC, created_at ASC);
  `);
}

async function getRanking() {
  if (!pool) return readLocal(localScores).sort((a,b) => b.score - a.score).slice(0,50);
  const r = await pool.query('SELECT name, score, created_at AS date FROM scores ORDER BY score DESC, created_at ASC LIMIT 50');
  return r.rows;
}

async function saveScore(name, score) {
  if (!pool) {
    const a = readLocal(localScores);
    a.push({ name, score, date: new Date().toISOString() });
    writeLocal(localScores, a);
    return;
  }
  await pool.query('INSERT INTO scores (name, score) VALUES ($1, $2)', [name, score]);
}

async function addQuestion(b) {
  if (!pool) {
    const a = readLocal(localQuestions);
    const id = Math.max(0, ...a.map(x => Number(x.id) || 0)) + 1;
    const item = { ...b, id };
    a.push(item); writeLocal(localQuestions, a); return item;
  }
  // Questions remain managed as JSON for this pilot; the public score data is in PostgreSQL.
  const a = readLocal(localQuestions);
  const id = Math.max(0, ...a.map(x => Number(x.id) || 0)) + 1;
  const item = { ...b, id };
  a.push(item); writeLocal(localQuestions, a); return item;
}

async function api(req, res) {
  const u = url.parse(req.url, true);
  try {
    if (u.pathname === '/api/health' && req.method === 'GET') {
      if (pool) await pool.query('SELECT 1');
      return json(res, 200, { ok: true, database: !!pool, version: '1.2.0' });
    }

    if (u.pathname === '/api/questions' && req.method === 'GET') {
      return json(res, 200, readLocal(localQuestions));
    }

    if (u.pathname === '/api/ranking' && req.method === 'GET') {
      return json(res, 200, await getRanking());
    }

    if (u.pathname === '/api/score' && req.method === 'POST') {
      if (rateLimited(req, 'score', 20)) return json(res, 429, { error: 'muitas tentativas; aguarde um minuto' });
      const b = await parseBody(req);
      if (!validName(b.name) || !validScore(b.score)) return json(res, 400, { error: 'dados inválidos' });
      const name = b.name.trim().replace(/[<>]/g, '');
      const score = Math.floor(b.score);
      await saveScore(name, score);
      return json(res, 201, { ok: true });
    }

    if (u.pathname === '/api/admin/questions' && req.method === 'POST') {
      const supplied = req.headers['x-admin-token'];
      if (!ADMIN_TOKEN || supplied !== ADMIN_TOKEN) return json(res, 401, { error: 'não autorizado' });
      if (rateLimited(req, 'admin', 20)) return json(res, 429, { error: 'muitas tentativas; aguarde um minuto' });
      const b = await parseBody(req);
      if (typeof b.question !== 'string' || !b.question.trim() || !Array.isArray(b.options) || b.options.length !== 4 || b.options.some(x => typeof x !== 'string' || !x.trim()) || !Number.isInteger(b.answer) || b.answer < 0 || b.answer > 3) {
        return json(res, 400, { error: 'pergunta inválida' });
      }
      const item = await addQuestion({
        question: b.question.trim().slice(0, 300),
        options: b.options.map(x => x.trim().slice(0, 120)),
        answer: b.answer,
        category: typeof b.category === 'string' ? b.category.trim().slice(0, 40) : 'Geral'
      });
      return json(res, 201, item);
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'erro interno' });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return api(req, res);
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const publicRoot = path.resolve(path.join(ROOT, 'public'));
  const file = path.resolve(path.join(publicRoot, p));
  if (!file.startsWith(publicRoot + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    const ext = path.extname(file);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': (types[ext] || 'text/plain') + '; charset=utf-8' });
    res.end(data);
  });
});

initDb().then(() => server.listen(PORT, () => console.log(`DESAFIO24 v1.2 online na porta ${PORT}`)))
  .catch(err => { console.error('Falha ao inicializar banco:', err); process.exit(1); });
