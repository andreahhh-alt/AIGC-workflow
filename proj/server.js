// 《四季之地》提示词反馈 + AI 分析 · 最小后端
// 存储：有 DATABASE_URL 时用 Postgres（上线持久），否则用 data/*.json（本地）
// AI：默认 DeepSeek，可切 Anthropic。key 藏服务器端。
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
const FB = path.join(DATA, 'feedback.json');
const CFG = path.join(DATA, 'config.json');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

const ADMIN = process.env.ADMIN_PASSWORD || 'admin';
function cfg() { return readJSON(CFG, {}); }
function getProvider() { return cfg().provider || process.env.AI_PROVIDER || 'deepseek'; }
function getKey() {
  const c = cfg();
  if (c.apiKey) return c.apiKey;
  return getProvider() === 'deepseek' ? (process.env.DEEPSEEK_API_KEY || '') : (process.env.ANTHROPIC_API_KEY || '');
}
function getModel() {
  const c = cfg();
  if (c.model) return c.model;
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  return getProvider() === 'deepseek' ? 'deepseek-v4-flash' : 'claude-sonnet-4-5';
}
function isAdmin(req) { return (req.headers['x-admin-password'] || '') === ADMIN; }

let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  } catch (e) { console.error('检测到 DATABASE_URL 但缺少 pg 依赖，请确认 package.json 含 pg 并已 npm install。', e.message); }
}
async function initStore() {
  if (!pool) { console.log('存储：本地 JSON 文件（data/）'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS feedback(
    id text PRIMARY KEY, pid text NOT NULL, txt text NOT NULL,
    ts bigint NOT NULL, analysis text, analyzed_at bigint)`);
  console.log('存储：Render Postgres（持久）');
}
function rowToItem(r) { return { id: r.id, text: r.txt, ts: Number(r.ts), analysis: r.analysis, analyzedAt: r.analyzed_at ? Number(r.analyzed_at) : undefined }; }
const Store = {
  async byPid(pid) {
    if (pool) { const r = await pool.query('SELECT * FROM feedback WHERE pid=$1 ORDER BY ts', [pid]); return r.rows.map(rowToItem); }
    return readJSON(FB, {})[pid] || [];
  },
  async all() {
    if (pool) { const r = await pool.query('SELECT * FROM feedback ORDER BY ts'); const o = {}; for (const row of r.rows) (o[row.pid] = o[row.pid] || []).push(rowToItem(row)); return o; }
    return readJSON(FB, {});
  },
  async add(pid, item) {
    if (pool) { await pool.query('INSERT INTO feedback(id,pid,txt,ts,analysis,analyzed_at) VALUES($1,$2,$3,$4,NULL,NULL)', [item.id, pid, item.text, item.ts]); return; }
    const all = readJSON(FB, {}); (all[pid] = all[pid] || []).push(item); writeJSON(FB, all);
  },
  async del(pid, id) {
    if (pool) { await pool.query('DELETE FROM feedback WHERE pid=$1 AND id=$2', [pid, id]); return; }
    const all = readJSON(FB, {}); all[pid] = (all[pid] || []).filter(x => x.id !== id); writeJSON(FB, all);
  },
  async setAnalysis(pid, id, analysis) {
    if (pool) { await pool.query('UPDATE feedback SET analysis=$1, analyzed_at=$2 WHERE pid=$3 AND id=$4', [analysis, Date.now(), pid, id]); return; }
    const all = readJSON(FB, {}); const it = (all[pid] || []).find(x => x.id === id); if (it) { it.analysis = analysis; it.analyzedAt = Date.now(); writeJSON(FB, all); }
  }
};

app.get('/api/feedback', async (req, res) => {
  try { res.json(req.query.pid ? await Store.byPid(req.query.pid) : await Store.all()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/feedback', async (req, res) => {
  const { pid, text } = req.body || {};
  if (!pid || !text || !String(text).trim()) return res.status(400).json({ error: 'pid 和 text 必填' });
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: String(text).trim(), ts: Date.now(), analysis: null };
  try { await Store.add(pid, item); const list = await Store.byPid(pid); res.json({ item, index: list.length }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.delete('/api/feedback/:pid/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误' });
  try { await Store.del(req.params.pid, req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

const SYSTEM = [
  '你是资深 AIGC 影视提示词工程师，精通 aigc-film-prompts v4.7 规范：',
  'STYLE LOCK（摄影风格/色调/世界观美术/情绪；派别参数如夏派=高反差·短硬阴影·3500-5000K·强直射光）、',
  '机位与焦段自动绑定、运镜三铁律（单镜单向+速度词+Dolly≠Zoom）、15s 分镜描述、关键帧强制声明、台词四要素、限制字段。',
  '用户会给你【场次上下文】【原始提示词】和一条【使用反馈：生成效果的问题】。',
  '请分析并严格按如下结构输出，简洁、专业、不要寒暄：',
  '① 未达标原因：定位到提示词的哪个字段/规则缺失或冲突导致该问题，最多 3 点，每点一句。',
  '② 需修改处：具体到原提示词里的词句，指出删/改/加什么。',
  '③ 修改后的提示词：给出可直接复制的完整中文提示词（保持原 STYLE LOCK 与镜头结构，仅针对反馈修正），不加多余解释。'
].join('\n');
async function callDeepSeek(key, model, system, user) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({ model, max_tokens: 2000, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  });
  const raw = await r.text(); let data = {}; try { data = JSON.parse(raw); } catch (_) {}
  if (!r.ok) throw new Error((data.error && data.error.message) || ('DeepSeek HTTP ' + r.status + ': ' + raw.slice(0, 160)));
  return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}
async function callAnthropic(key, model, system, user) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: 'user', content: user }] })
  });
  const raw = await r.text(); let data = {}; try { data = JSON.parse(raw); } catch (_) {}
  if (!r.ok) throw new Error((data.error && data.error.message) || ('Anthropic HTTP ' + r.status + ': ' + raw.slice(0, 160)));
  return ((data.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n')).trim();
}
app.post('/api/analyze', async (req, res) => {
  const key = getKey(), provider = getProvider();
  if (!key) return res.status(400).json({ error: '服务器尚未配置 API Key，请在网站「⚙ AI 接入设置」中填入并保存，或在部署平台设置环境变量。' });
  const { pid, fid, prompt, feedback, context } = req.body || {};
  if (!prompt || !feedback) return res.status(400).json({ error: 'prompt 和 feedback 必填' });
  const userMsg = '【场次上下文 / STYLE LOCK】\n' + (context || '（无）') + '\n\n【原始提示词】\n' + prompt + '\n\n【使用反馈：生成效果的问题】\n' + feedback;
  try {
    const text = provider === 'anthropic' ? await callAnthropic(key, getModel(), SYSTEM, userMsg) : await callDeepSeek(key, getModel(), SYSTEM, userMsg);
    if (pid && fid) { try { await Store.setAnalysis(pid, fid, text); } catch (_) {} }
    res.json({ analysis: text });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.get('/api/config/status', (req, res) => {
  const c = cfg();
  res.json({ keyConfigured: !!getKey(), provider: getProvider(), model: getModel(),
    source: c.apiKey ? 'saved' : ((process.env.DEEPSEEK_API_KEY || process.env.ANTHROPIC_API_KEY) ? 'env' : 'none'),
    storage: pool ? 'postgres' : 'file' });
});
app.post('/api/config/key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误' });
  const { key, model, provider } = req.body || {};
  const c = cfg();
  if (typeof provider === 'string' && ['deepseek', 'anthropic'].includes(provider)) c.provider = provider;
  if (typeof key === 'string' && key.trim()) c.apiKey = key.trim();
  if (typeof model === 'string') c.model = model.trim();
  writeJSON(CFG, c);
  res.json({ ok: true, keyConfigured: !!getKey(), provider: getProvider(), model: getModel() });
});
app.delete('/api/config/key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误' });
  const c = cfg(); delete c.apiKey; writeJSON(CFG, c);
  res.json({ ok: true, keyConfigured: !!getKey() });
});

app.use(express.static(path.join(__dirname, 'public')));
const PORT = process.env.PORT || 3000;
initStore().catch(e => console.error('数据库初始化失败：', e.message)).finally(() => {
  app.listen(PORT, () => console.log('四季之地反馈后端已启动： http://localhost:' + PORT + '  （AI 默认 deepseek）'));
});
