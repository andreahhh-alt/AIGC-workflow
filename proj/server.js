// 《四季之地》提示词反馈 + AI 分析 · 最小后端
// 运行：npm install && npm start   （Node 18+，自带 fetch）
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- CORS（允许前端在别处托管时调用；同源部署时无影响）---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- 存储：data/ 下两个 JSON 文件（反馈 + 配置），无需数据库 ---
const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
const FB = path.join(DATA, 'feedback.json');
const CFG = path.join(DATA, 'config.json');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));

const ADMIN = process.env.ADMIN_PASSWORD || 'admin';          // 管理员密码：请务必改
function getKey()   { return readJSON(CFG, {}).anthropicKey || process.env.ANTHROPIC_API_KEY || ''; }
function getModel() { return readJSON(CFG, {}).model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'; }
function isAdmin(req){ return (req.headers['x-admin-password'] || '') === ADMIN; }

// ========== 反馈 ==========
// 列表：/api/feedback  或  /api/feedback?pid=7-1
app.get('/api/feedback', (req, res) => {
  const all = readJSON(FB, {});
  if (req.query.pid) return res.json(all[req.query.pid] || []);
  res.json(all);
});
// 新增反馈：任何访客可提交
app.post('/api/feedback', (req, res) => {
  const { pid, text } = req.body || {};
  if (!pid || !text || !String(text).trim()) return res.status(400).json({ error: 'pid 和 text 必填' });
  const all = readJSON(FB, {});
  if (!all[pid]) all[pid] = [];
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: String(text).trim(), ts: Date.now(), analysis: null };
  all[pid].push(item);
  writeJSON(FB, all);
  res.json({ item, index: all[pid].length });
});
// 删除反馈：需要管理员密码
app.delete('/api/feedback/:pid/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误' });
  const all = readJSON(FB, {});
  all[req.params.pid] = (all[req.params.pid] || []).filter(x => x.id !== req.params.id);
  writeJSON(FB, all);
  res.json({ ok: true });
});

// ========== AI 分析 ==========
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

app.post('/api/analyze', async (req, res) => {
  const key = getKey();
  if (!key) return res.status(400).json({ error: '服务器尚未配置 API Key，请在网站「⚙ AI 接入设置」中填入并保存。' });
  const { pid, fid, prompt, feedback, context } = req.body || {};
  if (!prompt || !feedback) return res.status(400).json({ error: 'prompt 和 feedback 必填' });

  const userMsg =
    '【场次上下文 / STYLE LOCK】\n' + (context || '（无）') +
    '\n\n【原始提示词】\n' + prompt +
    '\n\n【使用反馈：生成效果的问题】\n' + feedback;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: getModel(), max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content: userMsg }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: (data.error && data.error.message) || ('AI 调用失败 HTTP ' + r.status) });
    const text = (data.content || []).filter(i => i.type === 'text').map(i => i.text).join('\n').trim();

    // 把分析结果回写到对应反馈项
    if (pid && fid) {
      const all = readJSON(FB, {});
      const it = (all[pid] || []).find(x => x.id === fid);
      if (it) { it.analysis = text; it.analyzedAt = Date.now(); writeJSON(FB, all); }
    }
    res.json({ analysis: text });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ========== 配置（key 藏在服务器端）==========
// 状态：只暴露"是否已配置"和模型，绝不回传 key 本身
app.get('/api/config/status', (req, res) => {
  const saved = !!readJSON(CFG, {}).anthropicKey;
  res.json({ keyConfigured: !!getKey(), model: getModel(), source: saved ? 'saved' : (process.env.ANTHROPIC_API_KEY ? 'env' : 'none') });
});
// 保存 key / 模型：需要管理员密码
app.post('/api/config/key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误' });
  const { key, model } = req.body || {};
  const c = readJSON(CFG, {});
  if (typeof key === 'string' && key.trim()) c.anthropicKey = key.trim();
  if (typeof model === 'string' && model.trim()) c.model = model.trim();
  writeJSON(CFG, c);
  res.json({ ok: true, keyConfigured: !!getKey(), model: getModel() });
});
// 清除已保存 key
app.delete('/api/config/key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误' });
  const c = readJSON(CFG, {}); delete c.anthropicKey; writeJSON(CFG, c);
  res.json({ ok: true, keyConfigured: !!getKey() });
});

// ========== 静态前端 ==========
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('四季之地反馈后端已启动： http://localhost:' + PORT));
