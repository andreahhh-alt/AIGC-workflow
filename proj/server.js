// AIGC 影视工作流 v2
// 项目资料 → 按需知识分析 → 资产库 → 场次/15s分镜 → 提示词 → 审阅反馈
const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const app = express();
const aiRequestContext = new AsyncLocalStorage();
app.disable('x-powered-by');
// Render terminates HTTPS at a single reverse proxy. Trust exactly that hop so
// rate limiting uses the real client IP instead of rejecting X-Forwarded-For.
if (process.env.RENDER || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '2mb' }));

const corsOrigin = process.env.CORS_ORIGIN;
app.use((req, res, next) => {
  if (corsOrigin) res.header('Access-Control-Allow-Origin', corsOrigin);
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.AI_RATE_LIMIT || 40),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'AI 请求过于频繁，请稍后再试。' }
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.UPLOAD_RATE_LIMIT || 80),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '上传过于频繁，请稍后再试。' }
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 12 }
});
const uploadFilesMiddleware = (req, res, next) => {
  upload.array('files', 12)(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '单个文件不能超过 15MB。' });
    }
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: '一次最多上传 12 个文件。' });
    }
    return res.status(400).json({ error: `文件上传失败：${error.message || error}` });
  });
};
const uploadAssetImageMiddleware = (req, res, next) => {
  upload.single('image')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '资产图片不能超过 15MB。' });
    }
    return res.status(400).json({ error: `资产图片上传失败：${error.message || error}` });
  });
};

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'workflow.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const now = () => Date.now();
const uid = (prefix = 'rec') => `${prefix}_${crypto.randomUUID()}`;
const cleanRecord = record => {
  if (!record) return null;
  const { blob, blobBase64, ...rest } = record;
  return rest;
};

// ---------- 持久化：Postgres 优先，本地 JSON 回退 ----------
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL_DISABLE === '1' ? false : { rejectUnauthorized: false }
  });
}

const LocalStore = {
  read() { return readJSON(STATE_FILE, { records: [] }); },
  write(state) { writeJSON(STATE_FILE, state); },
  async put(record, blob = null) {
    const state = this.read();
    const copy = { ...record };
    const index = state.records.findIndex(item => item.id === record.id);
    if (blob) copy.blobBase64 = blob.toString('base64');
    else if (index >= 0 && state.records[index].blobBase64) copy.blobBase64 = state.records[index].blobBase64;
    if (index >= 0) state.records[index] = copy;
    else state.records.push(copy);
    this.write(state);
    return cleanRecord(copy);
  },
  async get(id, includeBlob = false) {
    const record = this.read().records.find(item => item.id === id);
    if (!record) return null;
    if (includeBlob && record.blobBase64) return { ...record, blob: Buffer.from(record.blobBase64, 'base64') };
    return cleanRecord(record);
  },
  async list(projectId, kind) {
    return this.read().records
      .filter(item => (!projectId || item.projectId === projectId || item.id === projectId) && (!kind || item.kind === kind))
      .sort((a, b) => (a.order || a.createdAt || 0) - (b.order || b.createdAt || 0))
      .map(cleanRecord);
  },
  async remove(id) {
    const state = this.read();
    state.records = state.records.filter(item => item.id !== id);
    this.write(state);
  }
};

const PgStore = {
  async put(record, blob = null) {
    await pool.query(
      `INSERT INTO workflow_records
        (id, project_id, kind, subtype, name, status, data, text_content, blob, sort_order, created_at, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(id) DO UPDATE SET
        project_id=EXCLUDED.project_id, kind=EXCLUDED.kind, subtype=EXCLUDED.subtype,
        name=EXCLUDED.name, status=EXCLUDED.status, data=EXCLUDED.data,
        text_content=EXCLUDED.text_content,
        blob=COALESCE(EXCLUDED.blob, workflow_records.blob),
        sort_order=EXCLUDED.sort_order, updated_at=EXCLUDED.updated_at`,
      [
        record.id, record.projectId || null, record.kind, record.subtype || null,
        record.name || '', record.status || 'draft', JSON.stringify(record.data || {}),
        record.textContent || null, blob, record.order || 0,
        record.createdAt || now(), record.updatedAt || now()
      ]
    );
    return this.get(record.id);
  },
  async get(id, includeBlob = false) {
    const columns = includeBlob ? '*' : 'id,project_id,kind,subtype,name,status,data,text_content,sort_order,created_at,updated_at';
    const result = await pool.query(`SELECT ${columns} FROM workflow_records WHERE id=$1`, [id]);
    return result.rows[0] ? mapRow(result.rows[0], includeBlob) : null;
  },
  async list(projectId, kind) {
    const values = [];
    const where = [];
    if (projectId) {
      values.push(projectId);
      where.push(`(project_id=$${values.length} OR id=$${values.length})`);
    }
    if (kind) {
      values.push(kind);
      where.push(`kind=$${values.length}`);
    }
    const result = await pool.query(
      `SELECT id,project_id,kind,subtype,name,status,data,text_content,sort_order,created_at,updated_at
       FROM workflow_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY sort_order, created_at`,
      values
    );
    return result.rows.map(row => mapRow(row));
  },
  async remove(id) { await pool.query('DELETE FROM workflow_records WHERE id=$1', [id]); }
};

function mapRow(row, includeBlob = false) {
  const record = {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    subtype: row.subtype,
    name: row.name,
    status: row.status,
    data: row.data || {},
    textContent: row.text_content,
    order: Number(row.sort_order),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (includeBlob) record.blob = row.blob;
  return record;
}

const Store = {
  put: (...args) => (pool ? PgStore : LocalStore).put(...args),
  get: (...args) => (pool ? PgStore : LocalStore).get(...args),
  list: (...args) => (pool ? PgStore : LocalStore).list(...args),
  remove: (...args) => (pool ? PgStore : LocalStore).remove(...args)
};

const WORKFLOW_SCHEMA_MIGRATIONS = [
  'ALTER TABLE workflow_records ALTER COLUMN sort_order TYPE bigint USING sort_order::bigint'
];

async function initStore() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS workflow_records(
      id text PRIMARY KEY,
      project_id text,
      kind text NOT NULL,
      subtype text,
      name text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft',
      data jsonb NOT NULL DEFAULT '{}'::jsonb,
      text_content text,
      blob bytea,
      sort_order bigint NOT NULL DEFAULT 0,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL
    )`);
    for (const migration of WORKFLOW_SCHEMA_MIGRATIONS) {
      await pool.query(migration);
    }
    await pool.query('CREATE INDEX IF NOT EXISTS workflow_project_kind_idx ON workflow_records(project_id,kind)');
    await pool.query(`CREATE TABLE IF NOT EXISTS feedback(
      id text PRIMARY KEY, pid text NOT NULL, txt text NOT NULL,
      ts bigint NOT NULL, analysis text, analyzed_at bigint
    )`);
  }
  const projects = await Store.list(null, 'project');
  if (!projects.length) await seedSijizhidi();
  await migrateUploadFilenames();
  await indexUploadedScriptScenes();
  await migrateExistingSceneLinks();
  await recoverInterruptedAIJobs();
}

function normalizeUploadFilename(value) {
  const original = String(value || '').trim();
  if (!original || [...original].some(char => char.charCodeAt(0) > 255)) return original;
  const decoded = Buffer.from(original, 'latin1').toString('utf8');
  if (!decoded || decoded.includes('\uFFFD') || decoded === original) return original;
  return /[\u3400-\u9fff]/u.test(decoded) ? decoded : original;
}

async function migrateUploadFilenames() {
  const projects = await Store.list(null, 'project');
  for (const project of projects) {
    const files = await Store.list(project.id, 'file');
    for (const file of files) {
      const repaired = normalizeUploadFilename(file.name);
      const inferredSubtype = classifyFile(repaired || file.name, file.data?.mime || '', 'auto');
      const shouldRepairName = Boolean(repaired && repaired !== file.name);
      const shouldRepairSubtype = file.subtype === 'document' && inferredSubtype !== 'document';
      if (!shouldRepairName && !shouldRepairSubtype) continue;
      if (shouldRepairName) file.name = repaired;
      if (shouldRepairSubtype) file.subtype = inferredSubtype;
      file.updatedAt = now();
      file.data = {
        ...file.data,
        ...(shouldRepairName ? { filenameEncodingRepaired: true } : {}),
        ...(shouldRepairSubtype ? { subtypeReclassified: true } : {})
      };
      const stored = await Store.get(file.id, true);
      await Store.put(file, stored?.blob || null);
    }
  }
}

async function indexUploadedScriptScenes() {
  const projects = await Store.list(null, 'project');
  for (const project of projects) {
    const files = await Store.list(project.id, 'file');
    const sourceFile = files
      .filter(file => file.subtype === 'script' && file.textContent)
      .sort((a, b) =>
        Number(Boolean(b.data?.authoritative)) - Number(Boolean(a.data?.authoritative))
        || (b.createdAt || 0) - (a.createdAt || 0)
      )[0];
    if (!sourceFile) continue;
    const blocks = parseScriptSceneBlocks(sourceFile.textContent, sourceFile.name);
    if (!blocks.length) continue;

    const existingScenes = await Store.list(project.id, 'scene');
    const counts = blocks.reduce((map, block) => {
      const sceneNo = normalizeSceneNo(block.sceneNo);
      map.set(sceneNo, (map.get(sceneNo) || 0) + 1);
      return map;
    }, new Map());
    const occurrences = new Map();

    for (const block of blocks) {
      const sceneNo = normalizeSceneNo(block.sceneNo);
      const occurrence = (occurrences.get(sceneNo) || 0) + 1;
      occurrences.set(sceneNo, occurrence);
      const normalized = normalizeSceneData(project.id, {
        sceneNo,
        heading: block.heading || '',
        summary: '已从最新剧本建立场次索引，等待AI分析。',
        sourceRefs: block.sourceRefs || [sourceFile.name],
        primaryLine: 'other',
        secondaryLines: [],
        characters: [],
        events: []
      }, project, {
        occurrence,
        duplicateSceneNo: (counts.get(sceneNo) || 0) > 1,
        sceneIndex: block.sceneIndex
      });
      const existing = existingScenes.find(scene =>
        scene.data?.canonicalKey === normalized.canonicalKey
        || (
          normalizeSceneNo(scene.data?.sceneNo) === sceneNo
          && Number(scene.data?.sceneOccurrence || 1) === occurrence
        )
      );
      const sourceRefs = [...new Set([
        ...(existing?.data?.sourceRefs || []),
        ...(block.sourceRefs || [sourceFile.name])
      ])];
      const indexedData = {
        ...normalized,
        ...(existing?.data || {}),
        sceneNo: normalized.sceneNo,
        sceneRef: normalized.sceneRef,
        displaySceneNo: normalized.displaySceneNo,
        sceneOccurrence: normalized.sceneOccurrence,
        sceneIndex: normalized.sceneIndex,
        numberingConflict: normalized.numberingConflict,
        canonicalKey: normalized.canonicalKey,
        sourceRefs,
        indexSourceFileId: sourceFile.id,
        indexedFromScript: true
      };
      await Store.put({
        id: existing?.id || normalized.sceneId,
        projectId: project.id,
        kind: 'scene',
        subtype: 'script_scene',
        name: existing?.name || `场${normalized.displaySceneNo} · ${normalized.heading}`,
        status: existing?.status || 'indexed',
        data: indexedData,
        textContent: existing?.textContent || block.sourceText || null,
        order: Number(block.sceneIndex || 0) * 100,
        createdAt: existing?.createdAt || now(),
        updatedAt: existing?.updatedAt || now()
      });
    }
  }
}

async function recoverInterruptedAIJobs() {
  const projects = await Store.list(null, 'project');
  for (const project of projects) {
    const jobs = await Store.list(project.id, 'job');
    for (const job of jobs) {
      if (job.status !== 'running') continue;
      job.status = 'failed';
      job.updatedAt = now();
      job.data = {
        ...job.data,
        error: '服务重启导致任务中断，请点击重新生成。',
        interrupted: true
      };
      await Store.put(job);
    }
  }
}

async function seedSijizhidi() {
  const projectId = 'sijizhidi';
  await Store.put({
    id: projectId,
    projectId,
    kind: 'project',
    subtype: 'film',
    name: '四季之地',
    status: 'active',
    data: {
      logline: '四季轮候生存制度下，一对跨季恋人追查灭刑真相并试图打破时间隔离。',
      scriptVersion: '7.13',
      styleLock: {
        photography: '自然主义纪实摄影，35mm film轻颗粒',
        color: '低饱和暖灰，高光偏冷、阴影偏暖',
        world: '近未来赛博山城，旧物与冷科技并置',
        emotion: '被规训的麻木，压抑中透出一线希望'
      }
    },
    order: 0,
    createdAt: now(),
    updatedAt: now()
  });
  const sceneTitles = [
    ['7', '休眠设施走廊 · 清晨', '刘夏从休眠舱苏醒，夏派新季开始。'],
    ['8', '休眠设施门口/石阶 · 日', '刘夏走出设施，进入湿热山城。'],
    ['9', '窄街 · 日', '刘夏遇到疯老头和城管机器人。'],
    ['10', '凉水摊 · 日', '刘夏与胖子谈及探洞计划。'],
    ['11', '轻轨车厢 · 日', '轻轨经过灭刑中心，制度阴影显现。'],
    ['12', '休眠设施另一辖区 · 日', '刘夏清洁隔间并撞见母亲苏吟的名字。']
  ];
  const groupMap = {
    7: [['7-1', '苏醒', 'D-1'], ['7-2', '戴上面罩', 'D-1']],
    8: [['8-1', '过曝的夏日', 'D-1'], ['8-2', '旺财跟随', 'D-1']],
    9: [['9-1', '疯老头的歌', 'D-3'], ['9-2', '城管机器人', 'D-1']],
    10: [['10-1', '凉水摊', 'D-1'], ['10-2', '探洞计划', 'D-1']],
    11: [['11-1', '轻轨掠过灭刑中心', 'D-1'], ['11-2', '沉默凝视', 'D-3']],
    12: [['12-1', '清洁隔间', 'D-1'], ['12-2', '越界擦血', 'D-2'], ['12-3', '撞见母亲的名字', 'D-3']]
  };
  let order = 1;
  for (const [sceneNo, heading, summary] of sceneTitles) {
    const sceneId = `scene_${sceneNo}`;
    await Store.put({
      id: sceneId, projectId, kind: 'scene', subtype: 'script_scene',
      name: `场${sceneNo} · ${heading}`, status: 'approved',
      data: {
        sceneNo,
        sceneRef: `${sceneNo}#1`,
        displaySceneNo: sceneNo,
        canonicalKey: canonicalSceneKey('film', sceneNo, 1),
        heading,
        summary,
        primaryLine: 'male',
        secondaryLines: sceneNo === '12' ? ['mystery'] : [],
        povCharacter: '刘夏',
        characters: sceneNo === '7' ? ['刘夏'] : ['刘夏', '旺财'],
        events: [],
        sourceRefs: ['legacy-site']
      },
      order: order++, createdAt: now(), updatedAt: now()
    });
    for (const [code, title, type] of groupMap[sceneNo]) {
      await Store.put({
        id: `group_${code}`, projectId, kind: 'shot_group', subtype: type,
        name: `${code} · ${title}`, status: 'approved',
        data: {
          code, title, sceneId, sceneNo, sceneRef: `${sceneNo}#1`,
          displaySceneNo: sceneNo, primaryLine: 'male',
          lineRefs: sceneNo === '12' ? ['male', 'mystery'] : ['male'],
          lineRefsSource: 'scene_inherited',
          duration: 15, promptStatus: 'legacy',
          targetModel: '通用', mode: 'T2V', colorCard: []
        },
        order: order++, createdAt: now(), updatedAt: now()
      });
    }
  }
}

// ---------- AI 服务 ----------
function config() { return readJSON(CONFIG_FILE, {}); }
function provider(requested) {
  const selected = String(requested || process.env.AI_PROVIDER || config().provider || 'deepseek').trim();
  return ['anthropic', 'deepseek', 'kimi', 'openai_compatible'].includes(selected) ? selected : 'deepseek';
}
function normalizeApiKey(value) {
  let normalized = String(value || '').trim();
  const quoted =
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"));
  if (quoted) normalized = normalized.slice(1, -1).trim();
  return normalized.replace(/^Bearer\s+/i, '').trim();
}
function apiKey(selectedProvider = provider()) {
  const selected = provider(selectedProvider);
  const envKeys = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    kimi: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY,
    openai_compatible: process.env.AI_API_KEY
  };
  const savedKey = selected === provider() ? config().apiKey : '';
  return normalizeApiKey(envKeys[selected] || savedKey);
}
function model(selectedProvider = provider()) {
  const selected = provider(selectedProvider);
  const defaults = {
    anthropic: 'claude-sonnet-4-5',
    deepseek: 'deepseek-v4-flash',
    kimi: 'kimi-k3',
    openai_compatible: ''
  };
  const envModels = {
    anthropic: process.env.ANTHROPIC_MODEL,
    deepseek: process.env.DEEPSEEK_MODEL,
    kimi: process.env.KIMI_MODEL,
    openai_compatible: process.env.AI_COMPATIBLE_MODEL
  };
  const defaultProviderModel = selected === provider() ? (process.env.AI_MODEL || config().model) : '';
  return envModels[selected] || defaultProviderModel || defaults[selected] || '';
}
function aiBaseUrl(selectedProvider = provider()) {
  const selected = provider(selectedProvider);
  const urls = {
    deepseek: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    kimi: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
    openai_compatible: process.env.AI_BASE_URL || ''
  };
  return String(urls[selected] || '').replace(/\/+$/, '');
}
function keySource(selectedProvider = provider()) {
  const selected = provider(selectedProvider);
  const envConfigured = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    kimi: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY,
    openai_compatible: process.env.AI_API_KEY
  };
  return envConfigured[selected] ? 'env' : (selected === provider() && config().apiKey ? 'saved' : 'none');
}
function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD;
  return !!expected && (req.headers['x-admin-password'] || '') === expected;
}

async function callAI(system, user, options = {}) {
  const currentProvider = provider(options.provider || aiRequestContext.getStore()?.provider);
  const currentModel = model(currentProvider);
  const key = apiKey(currentProvider);
  if (!key) throw new Error('服务器尚未配置 AI API Key。');
  if (currentProvider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: currentModel, max_tokens: 6000, system,
        messages: [{ role: 'user', content: user }]
      })
    });
    const raw = await response.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    if (!response.ok) throw new Error(data?.error?.message || `Anthropic HTTP ${response.status}`);
    return (data.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n').trim();
  }
  const baseUrl = aiBaseUrl(currentProvider);
  if (!baseUrl) throw new Error('服务器尚未配置兼容接口的 AI_BASE_URL。');
  if (!currentModel) throw new Error('服务器尚未配置 AI_MODEL。');
  const requestBody = {
    model: currentModel,
    stream: false,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
  };
  if (currentProvider === 'kimi' && currentModel === 'kimi-k3') {
    requestBody.stream = true;
    requestBody.max_completion_tokens = options.json ? 16000 : 10000;
    requestBody.reasoning_effort = options.reasoningEffort || (options.json ? 'medium' : 'high');
    if (options.json) requestBody.response_format = { type: 'json_object' };
  } else {
    requestBody.max_tokens = options.json ? 12000 : 6000;
    if (currentProvider === 'deepseek') requestBody.thinking = { type: 'disabled' };
    if (options.json) requestBody.response_format = { type: 'json_object' };
  }
  let response;
  let raw = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(240000)
      });
    } catch (error) {
      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 800));
        continue;
      }
      throw new Error(`${currentProvider} 网络请求失败：${error.cause?.code || error.message || error}`);
    }
    if (response.ok) {
      raw = '';
      break;
    }
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 1) break;
    raw = await response.text();
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  if (!response) throw new Error(`${currentProvider} 未返回响应`);
  if (response.ok && requestBody.stream && response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let content = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const event = JSON.parse(payload);
          content += event?.choices?.[0]?.delta?.content || '';
        } catch {}
      }
    }
    if (content.trim()) return content.trim();
    throw new Error(`${currentProvider} 流式响应结束但没有返回正文`);
  }
  raw = raw || await response.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {}
  if (!response.ok) {
    const errorType = data?.error?.type ? ` ${data.error.type}` : '';
    const errorMessage = data?.error?.message || '请求失败';
    throw new Error(`${currentProvider} HTTP ${response.status}${errorType}: ${errorMessage}`);
  }
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

function parseAIJson(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch {
    const start = Math.min(...['{', '['].map(char => {
      const index = cleaned.indexOf(char);
      return index < 0 ? Infinity : index;
    }));
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (Number.isFinite(start) && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('AI返回内容不是有效JSON，请重试。');
  }
}

const STORY_LINES = new Set(['male', 'female', 'supporting', 'ensemble', 'world', 'romance', 'mystery', 'other']);
const normalizeSceneNo = value => String(value ?? '')
  .trim()
  .replace(/^第\s*/u, '')
  .replace(/^场\s*/u, '')
  .replace(/\s*场$/u, '')
  .replace(/\s+/g, '');
const canonicalSceneKey = (episodeNo, sceneNo, occurrence = 1) =>
  `${normalizeSceneNo(episodeNo || 'film')}:${normalizeSceneNo(sceneNo)}#${Number(occurrence) || 1}`;
const stableId = (prefix, value) =>
  `${prefix}_${crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20)}`;
const normalizeLine = value => STORY_LINES.has(String(value || '').toLowerCase())
  ? String(value).toLowerCase()
  : 'other';
const normalizeLineList = values => [...new Set((Array.isArray(values) ? values : [])
  .map(normalizeLine)
  .filter(Boolean))];

function normalizeGroupShots(group = {}) {
  const source = Array.isArray(group.shots) && group.shots.length
    ? group.shots
    : [{
        code: group.shotCode || `${group.code || 'SHOT'}-S1`,
        title: group.title || '15秒分镜',
        duration: 15,
        beats: Array.isArray(group.beats) ? group.beats : [],
        endState: group.endState || ''
      }];
  return source.map((shot, index) => ({
    ...shot,
    code: String(shot.code || `${group.code || 'SHOT'}-S${index + 1}`),
    title: String(shot.title || `${group.title || '分镜'} ${index + 1}`),
    duration: 15,
    sequenceIndex: index + 1,
    beats: Array.isArray(shot.beats) ? shot.beats : [],
    endState: String(shot.endState || '')
  }));
}

function normalizeSceneData(projectId, scene, project, options = {}) {
  const sceneNo = normalizeSceneNo(scene.sceneNo);
  const episodeNo = normalizeSceneNo(scene.episodeNo || project?.data?.episodeNo || 'film');
  const occurrence = Number(options.occurrence || scene.sceneOccurrence || 1);
  const duplicateSceneNo = !!options.duplicateSceneNo;
  const sceneRef = `${sceneNo}#${occurrence}`;
  const displaySceneNo = duplicateSceneNo ? `${sceneNo}${String.fromCharCode(64 + Math.min(occurrence, 26))}` : sceneNo;
  const canonicalKey = canonicalSceneKey(episodeNo, sceneNo, occurrence);
  const sceneId = stableId('scene', `${projectId}:${canonicalKey}`);
  const primaryLine = normalizeLine(scene.primaryLine);
  const secondaryLines = normalizeLineList(scene.secondaryLines).filter(line => line !== primaryLine);
  const events = (Array.isArray(scene.events) ? scene.events : []).map((event, index) => ({
    ...event,
    id: stableId('event', `${sceneId}:${event.label || event.name || index}`),
    label: String(event.label || event.name || `事件${index + 1}`)
  }));
  return {
    ...scene,
    sceneNo,
    sceneRef,
    displaySceneNo,
    sceneOccurrence: occurrence,
    sceneIndex: Number(options.sceneIndex || scene.sceneIndex || 0),
    numberingConflict: duplicateSceneNo,
    episodeNo,
    canonicalKey,
    sceneId,
    scriptVersion: scene.scriptVersion || project?.data?.scriptVersion || '',
    primaryLine,
    secondaryLines,
    povCharacter: String(scene.povCharacter || ''),
    characters: [...new Set((Array.isArray(scene.characters) ? scene.characters : []).map(String).filter(Boolean))],
    events
  };
}

function sceneReferenceNumbers(node) {
  const direct = Array.isArray(node?.sceneRefs) ? node.sceneRefs : [];
  const legacy = Array.isArray(node?.sceneNos) ? node.sceneNos : [];
  const sourceRefs = Array.isArray(node?.sourceRefs) ? node.sourceRefs : [];
  const candidates = [...direct, ...legacy, ...sourceRefs];
  const numbers = [];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && candidate.sceneNo) {
      numbers.push({
        sceneNo: normalizeSceneNo(candidate.sceneNo),
        sceneRef: String(candidate.sceneRef || ''),
        role: candidate.role || ''
      });
      continue;
    }
    const value = String(candidate || '');
    const explicit = value.match(/^(\d+(?:[-.]\d+)?)#(\d+)$/u);
    if (explicit) {
      numbers.push({ sceneNo: normalizeSceneNo(explicit[1]), sceneRef: `${normalizeSceneNo(explicit[1])}#${explicit[2]}`, role: '' });
      continue;
    }
    const matches = [
      ...value.matchAll(/(?:第\s*)?(\d+(?:[-.]\d+)?)\s*场/gu),
      ...value.matchAll(/(?:第\s*)?场\s*(\d+(?:[-.]\d+)?)/gu)
    ];
    if (matches.length) matches.forEach(match => numbers.push({ sceneNo: normalizeSceneNo(match[1]), sceneRef: '', role: '' }));
    else if (/^\d+(?:[-.]\d+)?$/u.test(value.trim())) numbers.push({ sceneNo: normalizeSceneNo(value), sceneRef: '', role: '' });
  }
  return numbers;
}

function linkAnalysisData(data, scenes) {
  const sceneRefMap = new Map(scenes.map(scene => [scene.data?.sceneRef || `${normalizeSceneNo(scene.data?.sceneNo)}#1`, scene]));
  const scenesByNumber = new Map();
  for (const scene of scenes) {
    const sceneNo = normalizeSceneNo(scene.data?.sceneNo);
    scenesByNumber.set(sceneNo, [...(scenesByNumber.get(sceneNo) || []), scene]);
  }
  const nodes = (Array.isArray(data?.nodes) ? data.nodes : []).map(node => {
    const refs = sceneReferenceNumbers(node)
      .map(ref => {
        const candidates = scenesByNumber.get(ref.sceneNo) || [];
        const scene = ref.sceneRef ? sceneRefMap.get(ref.sceneRef) : (candidates.length === 1 ? candidates[0] : null);
        return {
          sceneNo: ref.sceneNo,
          sceneRef: scene?.data?.sceneRef || ref.sceneRef || '',
          sceneId: scene?.id || '',
          heading: scene?.data?.heading || '',
          role: ref.role || '',
          ambiguous: !scene && candidates.length > 1,
          candidateSceneIds: !scene && candidates.length > 1 ? candidates.map(item => item.id) : []
        };
      })
      .filter((ref, index, all) => ref.sceneNo && all.findIndex(item => `${item.sceneRef || item.sceneNo}` === `${ref.sceneRef || ref.sceneNo}`) === index);
    return { ...node, sceneRefs: refs };
  });
  return { ...data, nodes, linkedSceneCount: new Set(nodes.flatMap(node => node.sceneRefs?.map(ref => ref.sceneId).filter(Boolean) || [])).size };
}

function recordSceneIds(record) {
  const refs = Array.isArray(record?.data?.sceneRefs) ? record.data.sceneRefs : [];
  return [...new Set(refs
    .map(ref => typeof ref === 'string' ? ref : ref?.sceneId)
    .filter(Boolean))];
}

async function relinkAnalyses(projectId) {
  const [scenes, analyses] = await Promise.all([
    Store.list(projectId, 'scene'),
    Store.list(projectId, 'analysis')
  ]);
  for (const analysis of analyses) {
    analysis.data = linkAnalysisData(analysis.data || {}, scenes);
    analysis.updatedAt = now();
    await Store.put(analysis);
  }
}

const ANALYSIS_LINE_MAP = {
  timeline_male: 'male',
  timeline_female: 'female',
  supporting_arcs: 'supporting'
};

function mergeSceneLineMembership(data, memberships) {
  const lines = normalizeLineList(memberships);
  const currentPrimary = normalizeLine(data?.primaryLine);
  const manualPrimary = data?.primaryLineSource === 'manual';
  let primaryLine = currentPrimary;
  if (!manualPrimary && (currentPrimary === 'other' || String(data?.primaryLineSource || '').startsWith('analysis'))) {
    primaryLine = lines.includes('male') && lines.includes('female')
      ? 'ensemble'
      : (['male', 'female', 'supporting'].find(line => lines.includes(line)) || currentPrimary);
  }
  const secondaryLines = normalizeLineList([
    ...(data?.secondaryLines || []),
    ...lines
  ]).filter(line => line !== primaryLine);
  return {
    ...data,
    primaryLine,
    secondaryLines,
    primaryLineSource: manualPrimary
      ? 'manual'
      : (primaryLine !== currentPrimary ? `analysis:${lines.join('+')}` : data?.primaryLineSource),
    analysisLineMemberships: lines
  };
}

async function syncSceneLinesFromAnalyses(projectId) {
  const [scenes, analyses, groups] = await Promise.all([
    Store.list(projectId, 'scene'),
    Store.list(projectId, 'analysis'),
    Store.list(projectId, 'shot_group')
  ]);
  const memberships = new Map();
  for (const analysis of analyses) {
    const line = ANALYSIS_LINE_MAP[analysis.subtype];
    if (!line) continue;
    for (const node of analysis.data?.nodes || []) {
      for (const ref of node.sceneRefs || []) {
        if (!ref.sceneId) continue;
        memberships.set(ref.sceneId, new Set([...(memberships.get(ref.sceneId) || []), line]));
      }
    }
  }
  for (const scene of scenes) {
    const lines = [...(memberships.get(scene.id) || [])];
    if (!lines.length) continue;
    const nextData = mergeSceneLineMembership(scene.data || {}, lines);
    if (JSON.stringify(nextData) !== JSON.stringify(scene.data || {})) {
      scene.data = nextData;
      scene.updatedAt = now();
      await Store.put(scene);
    }
    for (const group of groups.filter(item =>
      item.data?.sceneId === scene.id
      && item.status !== 'locked'
      && item.data?.lineRefsSource !== 'manual_group'
    )) {
      const lineRefs = normalizeLineList([...(group.data?.lineRefs || []), ...lines]);
      const primaryLine = normalizeLine(group.data?.primaryLine) === 'other'
        ? nextData.primaryLine
        : normalizeLine(group.data?.primaryLine);
      group.data = {
        ...group.data,
        primaryLine,
        lineRefs,
        analysisLineMemberships: lines
      };
      group.updatedAt = now();
      await Store.put(group);
    }
  }
}

async function relinkAssets(projectId) {
  const [scenes, assets] = await Promise.all([
    Store.list(projectId, 'scene'),
    Store.list(projectId, 'asset')
  ]);
  for (const asset of assets) {
    const linked = linkAnalysisData({ nodes: [asset.data || {}] }, scenes).nodes[0] || asset.data || {};
    if (JSON.stringify(linked) === JSON.stringify(asset.data || {})) continue;
    asset.data = linked;
    asset.updatedAt = now();
    await Store.put(asset);
  }
}

async function migrateExistingSceneLinks() {
  const projects = await Store.list(null, 'project');
  for (const project of projects) {
    const scenes = await Store.list(project.id, 'scene');
    const groups = await Store.list(project.id, 'shot_group');
    const counts = scenes.reduce((map, scene) => {
      const sceneNo = normalizeSceneNo(scene.data?.sceneNo);
      map.set(sceneNo, (map.get(sceneNo) || 0) + 1);
      return map;
    }, new Map());
    const occurrences = new Map();
    const migratedScenes = new Map();

    for (const [index, scene] of scenes.entries()) {
      const sceneNo = normalizeSceneNo(scene.data?.sceneNo || scene.name.match(/场\s*([^\s·]+)/u)?.[1] || index + 1);
      const occurrence = (occurrences.get(sceneNo) || 0) + 1;
      occurrences.set(sceneNo, occurrence);
      const duplicateSceneNo = (counts.get(sceneNo) || 0) > 1;
      const legacyMaleLine = project.id === 'sijizhidi'
        && ['7', '8', '9', '10', '11', '12'].includes(sceneNo)
        && (scene.data?.sourceRefs || []).includes('legacy-site');
      const primaryLine = scene.data?.primaryLine || (legacyMaleLine ? 'male' : 'other');
      const nextData = {
        ...scene.data,
        sceneNo,
        sceneRef: scene.data?.sceneRef || `${sceneNo}#${occurrence}`,
        displaySceneNo: scene.data?.displaySceneNo || (duplicateSceneNo ? `${sceneNo}${String.fromCharCode(64 + occurrence)}` : sceneNo),
        sceneOccurrence: scene.data?.sceneOccurrence || occurrence,
        sceneIndex: scene.data?.sceneIndex || index + 1,
        numberingConflict: scene.data?.numberingConflict ?? duplicateSceneNo,
        canonicalKey: scene.data?.canonicalKey || canonicalSceneKey(scene.data?.episodeNo || 'film', sceneNo, occurrence),
        primaryLine: normalizeLine(primaryLine),
        secondaryLines: normalizeLineList(scene.data?.secondaryLines || []),
        povCharacter: scene.data?.povCharacter || (legacyMaleLine ? '刘夏' : ''),
        characters: Array.isArray(scene.data?.characters) ? scene.data.characters : [],
        events: Array.isArray(scene.data?.events) ? scene.data.events : []
      };
      const changed = JSON.stringify(nextData) !== JSON.stringify(scene.data || {});
      scene.data = nextData;
      migratedScenes.set(scene.id, scene);
      if (changed) {
        scene.updatedAt = now();
        await Store.put(scene);
      }
    }

    for (const group of groups) {
      const scene = migratedScenes.get(group.data?.sceneId);
      if (!scene) continue;
      const normalizedShots = normalizeGroupShots(group.data || {});
      const nextData = {
        ...group.data,
        sceneNo: group.data?.sceneNo || scene.data.sceneNo,
        sceneRef: group.data?.sceneRef || scene.data.sceneRef,
        displaySceneNo: group.data?.displaySceneNo || scene.data.displaySceneNo,
        canonicalSceneKey: group.data?.canonicalSceneKey || scene.data.canonicalKey,
        primaryLine: group.data?.primaryLine || scene.data.primaryLine,
        lineRefs: normalizeLineList(group.data?.lineRefs?.length
          ? group.data.lineRefs
          : [scene.data.primaryLine, ...(scene.data.secondaryLines || [])]),
        lineRefsSource: group.data?.lineRefsSource || 'scene_inherited',
        shots: normalizedShots,
        shotCount: normalizedShots.length,
        duration: normalizedShots.length * 15
      };
      if (JSON.stringify(nextData) !== JSON.stringify(group.data || {})) {
        group.data = nextData;
        group.updatedAt = now();
        await Store.put(group);
      }
    }
    await relinkAnalyses(project.id);
    await relinkAssets(project.id);
    await syncSceneLinesFromAnalyses(project.id);
  }
}

const FILM_SYSTEM = `你是AIGC影视项目分析与分镜系统。所有结论必须依据用户提供的资料，不得把推断写成事实。
返回严格JSON，不要Markdown围栏，不要解释。
遵循 aigc-film-prompts v4.7：
1. 场次→15秒分镜组→2-4秒动作节拍；
2. 单段最多1个核心动作、1条台词、1个道具/环境细节；
3. D类提示词包含STYLE LOCK、情境映射、明确机位、焦段光圈、单镜单向且带速度的运镜；
4. 包含关键帧强制声明、必须有/不允许/状态延续、跨段衔接卡；
5. 台词拆解触发时机、音量语气、同步肢体、停顿节奏；
6. 中文主版与英文副版结构对应；
7. 每项注明sourceRefs或“AI推断”。`;

async function sourceContext(projectId) {
  const files = await Store.list(projectId, 'file');
  const usable = files
    .filter(file => file.textContent)
    .sort((a, b) => {
      const rank = file => {
        if (file.subtype === 'script' && file.data?.authoritative) return 4;
        if (file.subtype === 'script') return 3;
        return 1;
      };
      return rank(b) - rank(a) || (b.createdAt || 0) - (a.createdAt || 0);
    });
  const chunks = usable.map(file => `【文件：${file.name}｜类型：${file.subtype}】\n${file.textContent}`);
  return chunks.join('\n\n').slice(0, 140000);
}

async function saveJob(projectId, action, targets, scope) {
  const record = {
    id: uid('job'), projectId, kind: 'job', subtype: action,
    name: action, status: 'running',
    data: { action, targets, scope, progress: 10 },
    order: -now(), createdAt: now(), updatedAt: now()
  };
  await Store.put(record);
  return record;
}

async function finishJob(job, status, patch) {
  job.status = status;
  job.updatedAt = now();
  job.data = { ...job.data, ...patch, progress: status === 'completed' ? 100 : job.data.progress };
  await Store.put(job);
}

const KNOWLEDGE_SPECS = {
  timeline_master:{ chartType:'timeline', minNodes:10, minEdges:7, instruction:'全剧综合多轨时间线；按故事真实时间排序，标出并行线、交汇、跳时和关键转折。' },
  timeline_male:{ chartType:'timeline', minNodes:7, minEdges:5, instruction:'男主单线时间线；只收录男主主导目标、行动、阻力、选择、代价与弧光节点。' },
  timeline_female:{ chartType:'timeline', minNodes:7, minEdges:5, instruction:'女主单线时间线；只收录女主主导目标、行动、阻力、选择、代价与弧光节点。' },
  supporting_arcs:{ chartType:'timeline', minNodes:7, minEdges:4, instruction:'配角多轨时间线；按人物分lane，标出各自功能、转折以及与主线的汇合。' },
  relationships:{ chartType:'network', minNodes:6, minEdges:8, instruction:'人物关系网络；节点只能是人物，边必须写明关系性质、方向、阶段变化、冲突/利益和剧本证据。description不可嵌入JSON。' },
  worldbuilding:{ chartType:'mindmap', minNodes:9, minEdges:6, instruction:'世界观思维导图；按制度、空间、技术、社会结构、规则与禁忌分类，category必填，边表达隶属或影响。' },
  emotional_arc:{ chartType:'emotion', minNodes:8, minEdges:5, instruction:'多轨情绪曲线；节点填写0-100的intensity、人物/关系lane、触发事件与变化方向。' },
  narrative_structure:{ chartType:'beatboard', minNodes:9, minEdges:6, instruction:'幕与序列节拍板；节点填写act与phase，覆盖开端、诱因、转折、中点、危机、高潮、结局。' },
  foreshadowing:{ chartType:'causal', minNodes:8, minEdges:6, instruction:'伏笔—发展—回收因果图；每条线索至少含setup与payoff，边写清回收关系。' },
  reveal_order:{ chartType:'dualtrack', minNodes:8, minEdges:5, instruction:'观众/角色双轨揭示图；lane只能清楚区分观众已知、角色已知或双方，并按揭示顺序排列。' },
  character_arcs:{ chartType:'timeline', minNodes:8, minEdges:5, instruction:'主要人物弧光对照时间线；按人物分lane，写清起点、关键选择、代价与终点。' },
  logic_audit:{ chartType:'fishbone', minNodes:6, minEdges:0, instruction:'剧情逻辑鱼骨图；category使用时间连续性、人物动机、因果链、世界规则、信息连续性等，节点写问题、证据、严重度与修改建议。' }
};

function knowledgeQuality(target, item) {
  const spec = KNOWLEDGE_SPECS[target] || { minNodes:6, minEdges:3 };
  const nodes = Array.isArray(item?.nodes) ? item.nodes : [];
  const edges = Array.isArray(item?.edges) ? item.edges : [];
  const ids = new Set(nodes.map(node => String(node.id || '')));
  const validEdges = edges.filter(edge => ids.has(String(edge.from)) && ids.has(String(edge.to)));
  const problems = [];
  if (nodes.length < spec.minNodes) problems.push(`节点仅${nodes.length}个，至少需要${spec.minNodes}个`);
  if (validEdges.length < spec.minEdges) problems.push(`有效关系仅${validEdges.length}条，至少需要${spec.minEdges}条`);
  if (target === 'relationships' && nodes.some(node => /\{.*\}/s.test(String(node.description || '')))) problems.push('人物说明中嵌入了JSON');
  return { ok: !problems.length, problems, validEdges };
}

async function runKnowledgeJob(projectId, targets, context) {
  const scenes = await Store.list(projectId, 'scene');
  const sceneRegistry = scenes.map(scene => ({
    sceneId: scene.id,
    sceneNo: scene.data?.sceneNo,
    heading: scene.data?.heading,
    primaryLine: scene.data?.primaryLine,
    secondaryLines: scene.data?.secondaryLines
  }));
  const outcomes = await mapWithConcurrency(targets, 2, async (target, targetIndex) => {
    const spec = KNOWLEDGE_SPECS[target] || { chartType:'timeline', minNodes:6, minEdges:3, instruction:'影视知识结构图。' };
    const prompt = `只生成一个影视项目知识分析，分析类型必须为：${target}。
推荐图形：${spec.chartType}。分析要求：${spec.instruction}
输出严格JSON：
{"result":{"type":"${target}","chartType":"${spec.chartType}","title":"标题","summary":"摘要","rootLabel":"思维导图根节点（仅适用时）","nodes":[{"id":"稳定ID","label":"短标题/人物名","timeLabel":"年份/季节/阶段/场次","order":1,"lane":"人物/轨道","category":"分类","act":"幕","phase":"阶段","intensity":50,"eventType":"goal|action|obstacle|choice|reveal|turn|payoff|world|issue","importance":"major|normal|minor","description":"纯文本具体说明","goal":"目标","action":"行动","obstacle":"阻力","choice":"选择","cost":"代价","severity":"high|medium|low","recommendation":"修改建议","sceneRefs":[{"sceneNo":"12","sceneRef":"12#1","role":"发生/转折/回收"}],"sourceRefs":["文件/场次"]}],"edges":[{"from":"节点ID","to":"节点ID","label":"关系/因果/推动/对照/回收","type":"relationship|cause|parallel|conflict|payoff|contains","evidence":"剧本证据"}],"insights":["洞察"],"confidence":"high|medium|low"}}
要求：
1. 所有能定位到剧本场次的节点必须填写sceneRefs；使用索引给出的sceneRef，不得编造sceneId；
2. 节点不少于${spec.minNodes}个，有效边不少于${spec.minEdges}条；资料充分时给出12–24个关键节点，不要把多个重要场次压成一个泛泛节点；
3. 时间线必须组织为2–4条有意义的lane，突出并行线、交汇、长时段空白、关键转折和回收；
4. 人物线必须具体填写目标、行动、阻力、选择、代价；没有依据的字段留空，不得杜撰；
5. edges必须引用真实节点ID，用来表达跨节点因果和回收；
6. 每个结论标明sourceRefs；推断必须明确写“AI推断”。
当前已确认场次索引：
${JSON.stringify(sceneRegistry)}
资料如下：
${context}`;
    try {
      let data = parseAIJson(await callAI(FILM_SYSTEM, prompt, { json: true }));
      let item = data.result || (Array.isArray(data.results) ? data.results[0] : null);
      if (!item || !Array.isArray(item.nodes) || !item.nodes.length) {
        throw new Error('没有返回可用的结构化节点');
      }
      let quality = knowledgeQuality(target, item);
      if (!quality.ok) {
        const repairPrompt = `${prompt}
上一次结果未达到可视化质量：${quality.problems.join('；')}。
请完整重做，不要解释。尤其不能只返回一个节点，也不能把JSON对象塞进description字符串。
上一次结果：
${JSON.stringify(item)}`;
        data = parseAIJson(await callAI(FILM_SYSTEM, repairPrompt, { json: true }));
        item = data.result || (Array.isArray(data.results) ? data.results[0] : null);
        quality = knowledgeQuality(target, item);
      }
      if (!quality.ok) throw new Error(`结构质量不足：${quality.problems.join('；')}`);
      item.type = target;
      item.chartType = spec.chartType;
      item.edges = quality.validEdges;
      const linked = linkAnalysisData(item, scenes);
      await Store.put({
        id: `analysis_${projectId}_${target}`,
        projectId, kind: 'analysis', subtype: target,
        name: item.title || target, status: 'ai_draft',
        data: linked, order: targetIndex,
        createdAt: now(), updatedAt: now()
      });
      return { target, ok: true };
    } catch (error) {
      return { target, ok: false, error: String(error.message || error) };
    }
  });
  const completed = outcomes.filter(item => item.ok);
  const failed = outcomes.filter(item => !item.ok);
  if (!completed.length) {
    throw new Error(`知识分析失败：${failed.map(item => `${item.target}（${item.error}）`).join('；')}`);
  }
  await syncSceneLinesFromAnalyses(projectId);
  return { count: completed.length, failed };
}

async function runAssetJob(projectId, targets, context) {
  const scenes = await Store.list(projectId, 'scene');
  const sceneRegistry = scenes.map(scene => ({
    sceneId: scene.id,
    sceneNo: scene.data?.sceneNo,
    sceneRef: scene.data?.sceneRef,
    heading: scene.data?.heading
  }));
  const outcomes = await mapWithConcurrency(targets, 2, async target => {
    const prompt = `只从资料中提取并整理一种资产类别：${target}。
输出严格JSON：
{"assets":[{"type":"${target}","name":"资产名","description":"可直接用于制作的具体描述","tags":["标签"],"visualAnchor":"视觉锚点或声音锚点","continuity":"连续性要求","sceneRefs":[{"sceneNo":"14","sceneRef":"14#1","role":"出现/使用"}],"sourceRefs":["来源"],"confidence":"high|medium|low"}]}
同名资产合并，不能凭空新增主要人物；每项必须能追溯到资料。
场次索引：
${JSON.stringify(sceneRegistry)}
资料如下：
${context}`;
    try {
      const data = parseAIJson(await callAI(FILM_SYSTEM, prompt, { json: true }));
      const assets = Array.isArray(data.assets) ? data.assets : [];
      for (const item of assets) {
        item.type = target;
        const linked = linkAnalysisData({ nodes: [item] }, scenes).nodes[0] || item;
        const stable = crypto.createHash('sha1').update(`${projectId}:${target}:${item.name}`).digest('hex').slice(0, 16);
        await Store.put({
          id: `asset_${stable}`, projectId, kind: 'asset', subtype: target,
          name: item.name, status: 'ai_draft', data: linked,
          order: now(), createdAt: now(), updatedAt: now()
        });
      }
      return { target, ok: true, count: assets.length };
    } catch (error) {
      return { target, ok: false, count: 0, error: String(error.message || error) };
    }
  });
  const completed = outcomes.filter(item => item.ok);
  const failed = outcomes.filter(item => !item.ok);
  if (!completed.length) {
    throw new Error(`资产提取失败：${failed.map(item => `${item.target}（${item.error}）`).join('；')}`);
  }
  return { count: completed.reduce((sum, item) => sum + item.count, 0), failed };
}

const SCRIPT_SCENE_PATTERNS = [
  /^场\s*(\d+(?:[-.]\d+)?)\s*[：:·.\s-]*(.*)$/u,
  /^(?:第\s*)?(\d+(?:[-.]\d+)?)\s*场(?:次)?\s*[：:·.\s-]*(.*)$/u
];

function parseScriptSceneBlocks(text, sourceName = '剧本') {
  const lines = String(text || '').split(/\r?\n/u);
  const scenes = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    let match = null;
    for (const pattern of SCRIPT_SCENE_PATTERNS) {
      match = trimmed.match(pattern);
      if (match) break;
    }
    if (match) {
      if (current) scenes.push(current);
      current = {
        sceneIndex: scenes.length + 1,
        sceneNo: normalizeSceneNo(match[1]),
        heading: String(match[2] || '').trim(),
        sourceText: '',
        sourceRefs: [`${sourceName} / 场${normalizeSceneNo(match[1])}`]
      };
      continue;
    }
    if (current && trimmed) current.sourceText += `${current.sourceText ? '\n' : ''}${trimmed}`;
  }
  if (current) scenes.push(current);
  return scenes;
}

function filterSceneBlocks(blocks, scope) {
  const range = String(scope || '').match(/(\d+)\s*[-—至到]\s*(\d+)/u);
  if (!range) return blocks;
  const start = Number(range[1]);
  const end = Number(range[2]);
  return blocks.filter(block => {
    const number = Number.parseFloat(block.sceneNo);
    return Number.isFinite(number) && number >= start && number <= end;
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function runSceneJob(projectId, scope, context) {
  const project = await Store.get(projectId);
  const files = await Store.list(projectId, 'file');
  const scriptFiles = files
    .filter(file => file.subtype === 'script' && file.textContent)
    .sort((a, b) => {
      const rank = value => value.data?.authoritative ? 2 : (['approved', 'locked'].includes(value.status) ? 1 : 0);
      return rank(b) - rank(a) || (b.createdAt || 0) - (a.createdAt || 0);
    });
  const sourceFile = scriptFiles[0];
  const parsedBlocks = filterSceneBlocks(
    sourceFile ? parseScriptSceneBlocks(sourceFile.textContent, sourceFile.name) : [],
    scope
  );
  const batches = [];
  for (let index = 0; index < parsedBlocks.length; index += 8) batches.push(parsedBlocks.slice(index, index + 8));

  const buildPrompt = sourceScenes => `为以下已经确定边界的剧本场次规划15秒分镜组和剧情线路标签。${scope ? `范围：${scope}` : ''}
场次号、sceneIndex、场次顺序和原文不得修改、合并或遗漏。每个15秒单元内部按2-4秒动作节拍拆分。
每个场次同时完成剧情线路标注。primaryLine只能是：
male（男主主导）、female（女主主导）、supporting（配角主导）、ensemble（群像/男女共同）、world（世界观）、romance（感情线）、mystery（悬疑线）、other。
secondaryLines允许多个。不要因为人物出场就判定为其单线，必须依据本场叙事目标和视角。
输出格式：
分镜组是剪辑与视觉连续性的上层容器；每个分镜组必须包含1个或以上shots，每个shot固定15秒。色卡属于分镜组，不属于单个shot。
输出格式：
{"scenes":[{"sceneIndex":1,"sceneNo":"1","episodeNo":"film","heading":"内/外景·地点·时间","summary":"本场事件与功能","primaryLine":"male|female|supporting|ensemble|world|romance|mystery|other","secondaryLines":["romance"],"povCharacter":"叙事视角人物","characters":["实际出场人物"],"events":[{"label":"剧情事件","type":"goal|action|obstacle|choice|reveal|turn|payoff"}],"sourceText":"对应原文摘要","sourceRefs":["文件名/场次"],"shotGroups":[{"code":"1-G1","title":"分镜组短标题","type":"D-1|D-2|D-3|D-SEQ","lineRefs":["male"],"eventRefs":["剧情事件名称"],"shots":[{"code":"1-G1-S1","title":"15秒分镜短标题","duration":15,"beats":[{"time":"0-4s","action":"单一核心动作"}],"endState":"末帧状态"}]}]}]}
输入场次：
${JSON.stringify(sourceScenes)}`;

  let scenes;
  if (batches.length) {
    const batchResults = await mapWithConcurrency(batches, 3, async batch => {
      const data = parseAIJson(await callAI(FILM_SYSTEM, buildPrompt(batch), { json: true }));
      const generated = Array.isArray(data.scenes) ? data.scenes : [];
      return batch.map((sourceScene, index) => {
        const result = generated.find(item => Number(item.sceneIndex) === Number(sourceScene.sceneIndex))
          || generated[index]
          || {};
        return {
          ...result,
          sceneIndex: sourceScene.sceneIndex,
          sceneNo: sourceScene.sceneNo,
          heading: sourceScene.heading || result.heading || '',
          sourceText: sourceScene.sourceText,
          sourceRefs: sourceScene.sourceRefs,
          shotGroups: Array.isArray(result.shotGroups) ? result.shotGroups : []
        };
      });
    });
    scenes = batchResults.flat();
  } else {
    const fallbackPrompt = `${buildPrompt([])}\n未能确定性识别场次标题，请直接从以下资料识别全部场次：\n${context}`;
    const data = parseAIJson(await callAI(FILM_SYSTEM, fallbackPrompt, { json: true }));
    scenes = Array.isArray(data.scenes) ? data.scenes : [];
  }
  const incompleteScenes = parsedBlocks.length
    ? scenes.filter(scene => !Array.isArray(scene.shotGroups) || !scene.shotGroups.length)
    : [];
  if (incompleteScenes.length) {
    throw new Error(`AI未完成以下场次的分镜拆分：${incompleteScenes.map(scene => scene.sceneNo).join('、')}。未写入不完整结果，请重试。`);
  }
  const sceneNumberCounts = scenes.reduce((counts, scene) => {
    const sceneNo = normalizeSceneNo(scene.sceneNo);
    counts.set(sceneNo, (counts.get(sceneNo) || 0) + 1);
    return counts;
  }, new Map());
  const existingScenes = await Store.list(projectId, 'scene');
  const existingGroups = await Store.list(projectId, 'shot_group');
  const usedSceneIds = new Set();
  const usedGroupIds = new Set();
  const seenSceneNumbers = new Map();
  let order = 1;
  for (const [sceneIndex, scene] of scenes.entries()) {
    const rawSceneNo = normalizeSceneNo(scene.sceneNo);
    const occurrence = (seenSceneNumbers.get(rawSceneNo) || 0) + 1;
    seenSceneNumbers.set(rawSceneNo, occurrence);
    let normalized = normalizeSceneData(projectId, scene, project, {
      occurrence,
      duplicateSceneNo: (sceneNumberCounts.get(rawSceneNo) || 0) > 1,
      sceneIndex: sceneIndex + 1
    });
    const matchedExistingScene = existingScenes.find(item =>
      item.data?.canonicalKey === normalized.canonicalKey
      || (
        !normalized.numberingConflict
        && normalizeSceneNo(item.data?.sceneNo) === normalized.sceneNo
        && Number(item.data?.sceneOccurrence || 1) === occurrence
      )
    );
    const sceneId = matchedExistingScene?.id || normalized.sceneId;
    normalized.sceneId = sceneId;
    usedSceneIds.add(sceneId);
    const existingScene = await Store.get(sceneId);
    if (existingScene?.data?.povCharacterSource === 'manual') {
      normalized.povCharacter = existingScene.data.povCharacter;
      normalized.povCharacterSource = 'manual';
    }
    if (existingScene?.data?.charactersSource === 'manual') {
      normalized.characters = existingScene.data.characters;
      normalized.charactersSource = 'manual';
    }
    if (existingScene?.status === 'locked') {
      normalized = { ...normalized, ...existingScene.data, sceneId };
      order += 1;
    } else {
      await Store.put({
        id: sceneId, projectId, kind: 'scene', subtype: 'script_scene',
        name: `场${normalized.displaySceneNo} · ${normalized.heading}`, status: 'ai_draft',
        data: normalized, textContent: normalized.sourceText || null,
        order: order++, createdAt: existingScene?.createdAt || now(), updatedAt: now()
      });
    }
    for (const [groupIndex, group] of (normalized.shotGroups || []).entries()) {
      const shots = normalizeGroupShots(group);
      const code = normalized.numberingConflict
        ? `${normalized.displaySceneNo}-${groupIndex + 1}`
        : (group.code || `${normalized.sceneNo}-${groupIndex + 1}`);
      const matchedExistingGroup = existingGroups.find(item =>
        item.data?.sceneId === sceneId && String(item.data?.code || '') === String(code)
      );
      const groupId = matchedExistingGroup?.id || stableId('group', `${sceneId}:${code}`);
      usedGroupIds.add(groupId);
      const existingGroup = await Store.get(groupId);
      if (existingGroup?.status === 'locked') continue;
      await Store.put({
        id: groupId, projectId, kind: 'shot_group',
        subtype: group.type || 'D-1', name: `${code} · ${group.title}`,
        status: 'ai_draft',
        data: {
          ...group,
          code,
          sceneId,
          sceneNo: normalized.sceneNo,
          sceneRef: normalized.sceneRef,
          displaySceneNo: normalized.displaySceneNo,
          canonicalSceneKey: normalized.canonicalKey,
          primaryLine: normalized.primaryLine,
          lineRefs: normalizeLineList(group.lineRefs?.length ? group.lineRefs : [normalized.primaryLine, ...normalized.secondaryLines]),
          lineRefsSource: group.lineRefs?.length ? 'ai_group' : 'scene_inherited',
          eventRefs: Array.isArray(group.eventRefs) ? group.eventRefs : [],
          shots,
          shotCount: shots.length,
          duration: shots.length * 15,
          promptStatus: existingGroup?.data?.promptStatus || 'not_generated'
        },
        order: order++, createdAt: existingGroup?.createdAt || now(), updatedAt: now()
      });
    }
  }
  if (!String(scope || '').trim()) {
    for (const scene of existingScenes.filter(item => !usedSceneIds.has(item.id))) {
      scene.data = { ...scene.data, staleReason: '最新全剧拆分中未找到该场次' };
      if (scene.status !== 'locked') scene.status = 'stale';
      scene.updatedAt = now();
      await Store.put(scene);
    }
    for (const group of existingGroups.filter(item => !usedGroupIds.has(item.id))) {
      group.data = { ...group.data, staleReason: '所属场次或分镜已在最新全剧拆分中变化' };
      if (group.status !== 'locked') group.status = 'stale';
      group.updatedAt = now();
      await Store.put(group);
    }
  }
  await relinkAnalyses(projectId);
  await syncSceneLinesFromAnalyses(projectId);
  return { scenes: scenes.length, groups: scenes.reduce((sum, scene) => sum + (scene.shotGroups || []).length, 0) };
}

async function runPromptJob(projectId, targets, scope) {
  const groupId = scope?.shotGroupId || targets[0];
  const group = await Store.get(groupId);
  if (!group || group.kind !== 'shot_group') throw new Error('未找到分镜组。');
  const project = await Store.get(projectId);
  const assets = await Store.list(projectId, 'asset');
  const scene = group.data.sceneId ? await Store.get(group.data.sceneId) : null;
  const shots = normalizeGroupShots(group.data || {});
  const fields = Array.isArray(scope?.fields) && scope.fields.length ? scope.fields : ['prompt', 'colorCard', 'continuity'];
  const prompt = `为以下分镜组生成用户选择的字段：${fields.join('、')}。
层级关系必须严格遵守：场次 > 分镜组 > 一个或以上15秒分镜。色卡只在分镜组层生成一张，由组内全部15秒分镜共用；不要给每个15秒分镜重复生成色卡。
项目STYLE LOCK：${JSON.stringify(project?.data?.styleLock || {})}
场次：${JSON.stringify(scene?.data || {})}
分镜组：${JSON.stringify(group.data)}
组内15秒分镜：${JSON.stringify(shots)}
可用资产：${JSON.stringify(assets.slice(0, 80).map(item => ({ type: item.subtype, name: item.name, data: item.data })))}
目标模型：${scope?.targetModel || group.data.targetModel || '通用'}
模式：${scope?.mode || group.data.mode || 'T2V'}
严格执行D类影视提示词v4.7：每个时间段最多一个核心动作；台词包含触发时机、音量语气、同步肢体、停顿节奏；运镜为单一方向并带速度；Dolly与Zoom不得混用；包含关键帧强制声明和连续性约束。
输出严格JSON：
{"groupSummary":"分镜组叙事功能","styleLock":"本组共用STYLE LOCK","mode":"T2V|I2V","colorCard":[{"hex":"#RRGGBB","name":"颜色名","usage":"组内用途"}],"groupContinuity":["组内全部分镜共用的连续性要求"],"shots":[{"shotCode":"对应输入code","title":"15秒分镜标题","promptZh":"完整结构化中文提示词","promptEn":"结构完全对应英文提示词","camera":{"position":"机位位置、高度与角度","shotSize":"景别","lens":"焦段mm","aperture":"光圈F值","movement":"单向且带速度的运镜"},"timeline":[{"time":"0-4s","shotSize":"景别","movement":"运镜","action":"唯一核心动作","dialoguePerformance":"台词四要素；无台词则空"}],"keyframes":[{"time":"约Xs","frame":"精确画面"}],"constraints":{"must":["必须有"],"avoid":["不允许"],"continuity":["状态延续"]},"sound":["环境与动作音效"],"transitionCard":"到下一15秒分镜的跨段衔接卡"}]}
shots数量与输入完全一致；没有要求的字段可留空字符串或空数组。`;
  const data = parseAIJson(await callAI(FILM_SYSTEM, prompt, { json: true }));
  const generatedShots = Array.isArray(data.shots) ? data.shots : [];
  const shotPrompts = shots.map((shot, index) => {
    const generated = generatedShots.find(item => item.shotCode === shot.code) || generatedShots[index] || {};
    return {
      ...generated,
      shotCode: shot.code,
      title: generated.title || shot.title,
      duration: 15,
      timeline: Array.isArray(generated.timeline) ? generated.timeline : (Array.isArray(data.fields?.beats) ? data.fields.beats : []),
      keyframes: Array.isArray(generated.keyframes) ? generated.keyframes : (Array.isArray(data.fields?.keyframes) ? data.fields.keyframes : []),
      constraints: generated.constraints || data.fields?.constraints || {},
      camera: generated.camera || {
        position: data.fields?.camera || '',
        lens: data.fields?.lens || '',
        movement: data.fields?.movement || ''
      }
    };
  });
  const combinedPromptZh = shotPrompts.map(item => `【${item.shotCode} · ${item.title}】\n${item.promptZh || ''}`).join('\n\n');
  const combinedPromptEn = shotPrompts.map(item => `[${item.shotCode} · ${item.title}]\n${item.promptEn || ''}`).join('\n\n');
  group.status = 'ai_draft';
  group.updatedAt = now();
  group.data = {
    ...group.data,
    promptStatus: 'ai_draft',
    targetModel: scope?.targetModel || group.data.targetModel || '通用',
    mode: scope?.mode || group.data.mode || 'T2V',
    shots,
    shotCount: shots.length,
    duration: shots.length * 15,
    groupSummary: data.groupSummary || group.data.groupSummary || '',
    groupStyleLock: data.styleLock || group.data.groupStyleLock || '',
    groupContinuity: Array.isArray(data.groupContinuity) ? data.groupContinuity : (group.data.groupContinuity || []),
    shotPrompts,
    promptZh: combinedPromptZh || data.promptZh || group.data.promptZh || '',
    promptEn: combinedPromptEn || data.promptEn || group.data.promptEn || '',
    colorCard: data.colorCard || group.data.colorCard || [],
    generatedFields: { ...(group.data.generatedFields || {}), ...(data.fields || {}) },
    lastGeneratedAt: now()
  };
  await Store.put(group);
  return { groupId };
}

async function runAssetPromptJob(projectId, targets, context) {
  const project = await Store.get(projectId);
  const outcomes = await mapWithConcurrency(targets, 2, async assetId => {
    try {
      const asset = await Store.get(assetId);
      if (!asset || asset.kind !== 'asset') throw new Error('未找到资产。');
      const scenes = await Store.list(projectId, 'scene');
      const linkedScenes = recordSceneIds(asset)
        .map(id => scenes.find(scene => scene.id === id))
        .filter(Boolean)
        .map(scene => ({
          sceneNo: scene.data?.displaySceneNo || scene.data?.sceneNo,
          heading: scene.data?.heading,
          summary: scene.data?.summary,
          sourceText: scene.textContent
        }));
      const prompt = `为一个影视生产资产生成可直接使用的双语图像/声音提示词。
资产类别：${asset.subtype}
资产名称：${asset.name}
资产资料：${JSON.stringify(asset.data || {})}
关联场次：${JSON.stringify(linkedScenes)}
项目STYLE LOCK：${JSON.stringify(project?.data?.styleLock || {})}
输出严格JSON：
{"promptZh":"完整中文生成提示词","promptEn":"结构对应英文提示词","negativePrompt":"负面提示词","visualNotes":["造型/材质/色彩/连续性锚点"],"sourceRefs":["依据"]}
角色必须保持身份与服装连续性；场景必须说明空间结构、时间、天气和光线；道具必须说明材质、尺度和磨损；声音资产说明声源、空间与动态。没有依据的内容标记“AI推断”。
项目资料节选：
${context.slice(0, 70000)}`;
      const data = parseAIJson(await callAI(FILM_SYSTEM, prompt, { json: true }));
      asset.status = 'ai_draft';
      asset.updatedAt = now();
      asset.data = {
        ...asset.data,
        promptZh: data.promptZh || '',
        promptEn: data.promptEn || '',
        negativePrompt: data.negativePrompt || '',
        visualNotes: Array.isArray(data.visualNotes) ? data.visualNotes : [],
        promptSourceRefs: Array.isArray(data.sourceRefs) ? data.sourceRefs : [],
        lastPromptGeneratedAt: now()
      };
      await Store.put(asset);
      return { assetId, ok: true };
    } catch (error) {
      return { assetId, ok: false, error: String(error.message || error) };
    }
  });
  const completed = outcomes.filter(item => item.ok);
  const failed = outcomes.filter(item => !item.ok);
  if (!completed.length) {
    throw new Error(`资产提示词生成失败：${failed.map(item => `${item.assetId}（${item.error}）`).join('；')}`);
  }
  return { count: completed.length, failed };
}

async function runAuditJob(projectId, targets) {
  const project = await Store.get(projectId);
  const scenes = await Store.list(projectId, 'scene');
  const groups = await Store.list(projectId, 'shot_group');
  const assets = await Store.list(projectId, 'asset');
  const prompt = `检查以下影视项目数据，检查类型：${targets.join('、')}。
重点：场次遗漏、人物/道具连续性、180度线、单段动作过密、光线漂移、末帧衔接、提示词与目标模型冲突。
输出格式：{"issues":[{"severity":"high|medium|low","type":"类型","targetId":"对象ID","title":"问题","detail":"依据","suggestion":"修复建议"}]}
项目：${JSON.stringify(project)}
场次：${JSON.stringify(scenes)}
分镜：${JSON.stringify(groups)}
资产：${JSON.stringify(assets)}`;
  const data = parseAIJson(await callAI(FILM_SYSTEM, prompt, { json: true }));
  await Store.put({
    id: `analysis_${projectId}_quality_audit`, projectId, kind: 'analysis',
    subtype: 'quality_audit', name: '质量与连续性检查', status: 'ai_draft',
    data, order: 999, createdAt: now(), updatedAt: now()
  });
  return { issues: data.issues?.length || 0 };
}

// ---------- 文件解析 ----------
function decodePlainText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(buffer); }
    catch { return buffer.toString('utf8'); }
  }
}

async function extractText(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (['.txt', '.md', '.csv', '.json', '.srt'].includes(extension)) {
    return decodePlainText(file.buffer);
  }
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  if (extension === '.pdf') {
    const result = await pdfParse(file.buffer);
    return result.text;
  }
  return '';
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function classifyFile(filename, mime, requested) {
  if (requested && requested !== 'auto') return requested;
  const name = filename.toLowerCase();
  if (/人物|小传|character/.test(name)) return 'character_bio';
  if (/世界观|设定|world/.test(name)) return 'worldbuilding';
  if (/剧本|script|screenplay/.test(name)) return 'script';
  if (/参考|reference|style/.test(name)) return 'reference';
  if (mime.startsWith('image/')) return 'image';
  return 'document';
}

// ---------- 工作流 API ----------
app.get('/api/workflow/bootstrap', async (req, res) => {
  try {
    const projects = await Store.list(null, 'project');
    const projectId = req.query.projectId || projects[0]?.id;
    if (!projectId) return res.json({ projects: [], project: null });
    const all = await Store.list(projectId);
    const byKind = kind => all.filter(item => item.kind === kind);
    res.json({
      projects,
      project: all.find(item => item.kind === 'project' && item.id === projectId) || await Store.get(projectId),
      files: byKind('file'),
      analyses: byKind('analysis'),
      assets: byKind('asset'),
      scenes: byKind('scene'),
      shotGroups: byKind('shot_group'),
      comments: byKind('comment'),
      jobs: byKind('job').slice(0, 80),
      ai: {
        configured: !!apiKey(), provider: provider(), model: model(),
        providers: [
          { id: 'kimi', label: 'Kimi K3 · 深度', model: model('kimi'), configured: !!apiKey('kimi') },
          { id: 'deepseek', label: 'DeepSeek V4 Flash · 快速', model: model('deepseek'), configured: !!apiKey('deepseek') }
        ],
        storage: pool ? 'postgres' : 'file'
      }
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post('/api/projects', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '项目名称必填。' });
  const project = {
    id: uid('project'), kind: 'project', subtype: 'film', name,
    status: 'active', data: {
      logline: String(req.body?.logline || '').trim(),
      scriptVersion: String(req.body?.scriptVersion || '').trim(),
      styleLock: req.body?.styleLock || {}
    },
    order: now(), createdAt: now(), updatedAt: now()
  };
  project.projectId = project.id;
  try { res.json(await Store.put(project)); }
  catch (error) { res.status(500).json({ error: String(error.message || error) }); }
});

app.post('/api/projects/:projectId/files', uploadLimiter, uploadFilesMiddleware, async (req, res) => {
  try {
    const project = await Store.get(req.params.projectId);
    if (!project) return res.status(404).json({ error: '项目不存在。' });
    const saved = [];
    for (const file of req.files || []) {
      const filename = normalizeUploadFilename(file.originalname);
      file.originalname = filename;
      const text = await withTimeout(
        extractText(file),
        45 * 1000,
        `${filename} 解析超过 45 秒，请检查文件是否损坏或先转换为 DOCX/TXT。`
      );
      const record = {
        id: uid('file'), projectId: req.params.projectId, kind: 'file',
        subtype: classifyFile(filename, file.mimetype, req.body?.kind),
        name: filename, status: text || file.mimetype.startsWith('image/') ? 'parsed' : 'stored',
        data: {
          mime: file.mimetype, size: file.size,
          extension: path.extname(filename).toLowerCase(),
          textLength: text.length,
          parseNote: text ? '文本已提取，等待人工确认。' : '二进制资料已保存。'
        },
        textContent: text, order: now(), createdAt: now(), updatedAt: now()
      };
      saved.push(await Store.put(record, file.buffer));
    }
    res.json({ files: saved });
  } catch (error) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
    res.status(status).json({ error: String(error.message || error) });
  }
});

const escapeXml = value => String(value ?? '').replace(/[<>&'"]/g, char => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
}[char]));

app.get('/api/records/:id/color-card.svg', async (req, res) => {
  try {
    const group = await Store.get(req.params.id);
    if (!group || group.kind !== 'shot_group') return res.status(404).send('Color card not found');
    const colors = Array.isArray(group.data?.colorCard) ? group.data.colorCard : [];
    if (!colors.length) return res.status(404).send('Color card is empty');
    const scene = group.data?.sceneId ? await Store.get(group.data.sceneId) : null;
    const width = 1600;
    const height = 520;
    const gap = 16;
    const left = 36;
    const swatchWidth = (width - left * 2 - gap * (colors.length - 1)) / colors.length;
    const swatches = colors.map((color, index) => {
      const x = left + index * (swatchWidth + gap);
      const hex = /^#[0-9a-f]{3,8}$/i.test(String(color.hex || '')) ? color.hex : '#243342';
      return `<rect x="${x}" y="138" width="${swatchWidth}" height="276" fill="${escapeXml(hex)}"/>
        <text x="${x}" y="452" fill="#8fa4b8" font-family="Arial, sans-serif" font-size="19">${escapeXml(String(hex).toUpperCase())}  ${escapeXml(color.name || `色彩 ${index + 1}`)}</text>
        <text x="${x}" y="482" fill="#586c80" font-family="Arial, sans-serif" font-size="15">${escapeXml(color.usage || '')}</text>`;
    }).join('');
    const title = `场${scene?.data?.displaySceneNo || '—'} · ${group.data?.title || group.name}`;
    const subtitle = `${group.data?.code || ''} · ${group.data?.shotCount || normalizeGroupShots(group.data || {}).length}个15秒分镜共用 · ${scene?.data?.heading || scene?.name || ''}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#0b1017"/>
      <text x="36" y="58" fill="#edf2f5" font-family="serif" font-size="34">${escapeXml(title)}</text>
      <text x="36" y="98" fill="#52677a" font-family="Arial, sans-serif" font-size="18">${escapeXml(subtitle)}</text>
      ${swatches}
    </svg>`;
    const filename = `${group.data?.code || group.id}_color-card.svg`;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${filename}"`);
    res.send(svg);
  } catch (error) {
    res.status(500).send(String(error.message || error));
  }
});

app.post('/api/assets/:id/image', uploadLimiter, uploadAssetImageMiddleware, async (req, res) => {
  try {
    const asset = await Store.get(req.params.id);
    if (!asset || asset.kind !== 'asset') return res.status(404).json({ error: '资产不存在。' });
    if (!req.file) return res.status(400).json({ error: '请选择一张资产图片。' });
    if (!String(req.file.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ error: '资产文件必须是图片格式。' });
    }
    const filename = normalizeUploadFilename(req.file.originalname || `${asset.name}.png`);
    asset.data = {
      ...(asset.data || {}),
      hasImage: true,
      imageName: filename,
      imageMime: req.file.mimetype,
      imageSize: req.file.size,
      imageUpdatedAt: now()
    };
    asset.updatedAt = now();
    res.json(await Store.put(asset, req.file.buffer));
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get('/api/assets/:id/image', async (req, res) => {
  try {
    const asset = await Store.get(req.params.id, true);
    if (!asset || asset.kind !== 'asset' || !asset.blob) return res.status(404).send('Asset image not found');
    const mime = String(asset.data?.imageMime || 'application/octet-stream');
    const rawName = normalizeUploadFilename(asset.data?.imageName || `${asset.name}.png`);
    const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'asset-image';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (String(req.query.download || '') === '1') {
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`
      );
    }
    res.send(asset.blob);
  } catch (error) {
    res.status(500).send(String(error.message || error));
  }
});

app.post('/api/projects/:projectId/records', async (req, res) => {
  try {
    const project = await Store.get(req.params.projectId);
    if (!project || project.kind !== 'project') {
      return res.status(404).json({ error: '项目不存在' });
    }

    const allowedKinds = new Set(['asset', 'scene', 'shot_group', 'analysis', 'comment']);
    const kind = String(req.body?.kind || '').trim();
    const name = String(req.body?.name || '').trim();

    if (!allowedKinds.has(kind)) {
      return res.status(400).json({ error: '不支持的记录类型' });
    }
    if (!name) {
      return res.status(400).json({ error: '名称不能为空' });
    }

    const record = {
      id: uid(kind),
      projectId: project.id,
      kind,
      subtype: String(req.body?.subtype || 'manual'),
      name,
      status: String(req.body?.status || 'review'),
      data: req.body?.data && typeof req.body.data === 'object' ? req.body.data : {},
      order: now(),
      createdAt: now(),
      updatedAt: now()
    };
    if (kind === 'shot_group') {
      const shots = normalizeGroupShots(record.data || {});
      record.data = { ...record.data, shots, shotCount: shots.length, duration: shots.length * 15 };
    }

    res.status(201).json(await Store.put(record));
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.patch('/api/records/:id', async (req, res) => {
  try {
    const record = await Store.get(req.params.id);
    if (!record) return res.status(404).json({ error: '记录不存在。' });
    const allowedStatuses = ['ai_draft', 'review', 'approved', 'locked', 'stale', 'archived'];
    if (req.body?.status && allowedStatuses.includes(req.body.status)) record.status = req.body.status;
    if (req.body?.name) record.name = String(req.body.name);
    if (req.body?.data && typeof req.body.data === 'object') record.data = { ...record.data, ...req.body.data };
    if (record.kind === 'scene' && req.body?.data && ('primaryLine' in req.body.data || 'secondaryLines' in req.body.data)) {
      record.data.primaryLineSource = 'manual';
    }
    record.updatedAt = now();
    const saved = await Store.put(record);
    if (record.kind === 'file' && record.subtype === 'script' && req.body?.data?.authoritative === true) {
      const files = await Store.list(record.projectId, 'file');
      for (const file of files.filter(item => item.id !== record.id && item.subtype === 'script' && item.data?.authoritative)) {
        file.data = { ...file.data, authoritative: false };
        file.updatedAt = now();
        await Store.put(file);
      }
    }
    if (record.kind === 'scene' && req.body?.data && ('primaryLine' in req.body.data || 'secondaryLines' in req.body.data)) {
      const groups = await Store.list(record.projectId, 'shot_group');
      const inheritedLines = normalizeLineList([record.data.primaryLine, ...(record.data.secondaryLines || [])]);
      for (const group of groups.filter(item =>
        item.data?.sceneId === record.id
        && item.status !== 'locked'
        && item.data?.lineRefsSource !== 'ai_group'
      )) {
        group.data = {
          ...group.data,
          primaryLine: normalizeLine(record.data.primaryLine),
          lineRefs: inheritedLines
        };
        group.status = group.status === 'approved' ? 'review' : group.status;
        group.updatedAt = now();
        await Store.put(group);
      }
      await relinkAnalyses(record.projectId);
    }
    res.json(saved);
  } catch (error) { res.status(500).json({ error: String(error.message || error) }); }
});

app.delete('/api/records/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '需要管理员权限。' });
  try { await Store.remove(req.params.id); res.json({ ok: true }); }
  catch (error) { res.status(500).json({ error: String(error.message || error) }); }
});

function selectJobProvider(requested, action, targets) {
  const complexKnowledge = new Set([
    'relationships', 'emotional_arc', 'narrative_structure',
    'foreshadowing', 'character_arcs', 'logic_audit'
  ]);
  let selected = requested;
  if (!['kimi', 'deepseek'].includes(selected)) {
    selected = action === 'audit'
      || (action === 'knowledge' && targets.some(target => complexKnowledge.has(target)))
      ? 'kimi'
      : 'deepseek';
  }
  if (!apiKey(selected)) {
    const fallback = selected === 'kimi' ? 'deepseek' : 'kimi';
    if (apiKey(fallback)) selected = fallback;
  }
  return selected;
}

async function executeAIJob(job, projectId, action, targets, scope, selectedProvider) {
  return aiRequestContext.run({ provider: selectedProvider }, async () => {
   try {
    const context = ['knowledge', 'assets', 'scenes', 'asset_prompt'].includes(action) ? await sourceContext(projectId) : '';
    if (['knowledge', 'assets', 'scenes'].includes(action) && !context.trim()) {
      throw new Error('请先上传并解析剧本或项目资料。');
    }
    let result;
    if (action === 'knowledge') result = await runKnowledgeJob(projectId, targets, context);
    if (action === 'assets') result = await runAssetJob(projectId, targets, context);
    if (action === 'scenes') result = await runSceneJob(projectId, scope?.range, context);
    if (action === 'prompt') result = await runPromptJob(projectId, targets, scope);
    if (action === 'asset_prompt') result = await runAssetPromptJob(projectId, targets, context);
    if (action === 'audit') result = await runAuditJob(projectId, targets);
    await finishJob(job, 'completed', { result });
  } catch (error) {
    await finishJob(job, 'failed', { error: String(error.message || error) });
    console.error(`AI job ${job.id} failed:`, error);
   }
  });
}

app.post('/api/projects/:projectId/ai/jobs', aiLimiter, async (req, res) => {
  const projectId = req.params.projectId;
  const action = String(req.body?.action || '');
  const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
  const scope = req.body?.scope || {};
  const requestedProvider = String(req.body?.provider || 'auto');
  if (!['knowledge', 'assets', 'scenes', 'prompt', 'asset_prompt', 'audit'].includes(action)) {
    return res.status(400).json({ error: '不支持的AI任务。' });
  }
  if (!targets.length && action !== 'scenes') return res.status(400).json({ error: '请选择至少一个生成目标。' });
  try {
    const project = await Store.get(projectId);
    if (!project || project.kind !== 'project') return res.status(404).json({ error: '项目不存在。' });
    const selectedProvider = selectJobProvider(requestedProvider, action, targets);
    if (!apiKey(selectedProvider)) {
      return res.status(400).json({ error: `${selectedProvider === 'deepseek' ? 'DeepSeek' : 'Kimi'} API Key 尚未配置。` });
    }
    const jobScope = { ...scope, aiProvider: selectedProvider, aiMode: requestedProvider };
    const job = await saveJob(projectId, action, targets, jobScope);
    res.status(202).json({ job });
    setImmediate(() => {
      void executeAIJob(job, projectId, action, targets, jobScope, selectedProvider);
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

// ---------- 现有反馈 API（兼容旧页面） ----------
const FeedbackStore = {
  async all() {
    if (pool) {
      const result = await pool.query('SELECT * FROM feedback ORDER BY ts');
      const output = {};
      for (const row of result.rows) {
        (output[row.pid] = output[row.pid] || []).push({
          id: row.id, text: row.txt, ts: Number(row.ts),
          analysis: row.analysis, analyzedAt: row.analyzed_at ? Number(row.analyzed_at) : undefined
        });
      }
      return output;
    }
    return readJSON(FEEDBACK_FILE, {});
  },
  async byPid(pid) { return (await this.all())[pid] || []; },
  async add(pid, item) {
    if (pool) {
      await pool.query(
        'INSERT INTO feedback(id,pid,txt,ts,analysis,analyzed_at) VALUES($1,$2,$3,$4,NULL,NULL)',
        [item.id, pid, item.text, item.ts]
      );
      return;
    }
    const all = await this.all();
    (all[pid] = all[pid] || []).push(item);
    writeJSON(FEEDBACK_FILE, all);
  },
  async remove(pid, id) {
    if (pool) { await pool.query('DELETE FROM feedback WHERE pid=$1 AND id=$2', [pid, id]); return; }
    const all = await this.all();
    all[pid] = (all[pid] || []).filter(item => item.id !== id);
    writeJSON(FEEDBACK_FILE, all);
  },
  async setAnalysis(pid, id, analysis) {
    if (pool) {
      await pool.query('UPDATE feedback SET analysis=$1,analyzed_at=$2 WHERE pid=$3 AND id=$4', [analysis, now(), pid, id]);
      return;
    }
    const all = await this.all();
    const item = (all[pid] || []).find(entry => entry.id === id);
    if (item) {
      item.analysis = analysis;
      item.analyzedAt = now();
      writeJSON(FEEDBACK_FILE, all);
    }
  }
};

app.get('/api/feedback', async (req, res) => {
  try { res.json(req.query.pid ? await FeedbackStore.byPid(req.query.pid) : await FeedbackStore.all()); }
  catch (error) { res.status(500).json({ error: String(error.message || error) }); }
});
app.post('/api/feedback', async (req, res) => {
  const pid = String(req.body?.pid || '');
  const text = String(req.body?.text || '').trim();
  if (!pid || !text) return res.status(400).json({ error: 'pid 和 text 必填。' });
  const item = { id: uid('fb'), text, ts: now(), analysis: null };
  try { await FeedbackStore.add(pid, item); res.json({ item }); }
  catch (error) { res.status(500).json({ error: String(error.message || error) }); }
});
app.delete('/api/feedback/:pid/:id', async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误。' });
  try { await FeedbackStore.remove(req.params.pid, req.params.id); res.json({ ok: true }); }
  catch (error) { res.status(500).json({ error: String(error.message || error) }); }
});

const FEEDBACK_SYSTEM = `你是资深AIGC影视提示词工程师，精通aigc-film-prompts v4.7。
请按三部分输出：①未达标原因；②需修改处；③修改后的完整中文提示词。
遵守单段单核心动作、关键帧声明、台词四要素、运镜三铁律和跨段衔接。`;
app.post('/api/analyze', aiLimiter, async (req, res) => {
  const { pid, fid, prompt, feedback, context } = req.body || {};
  if (!prompt || !feedback) return res.status(400).json({ error: 'prompt 和 feedback 必填。' });
  try {
    const text = await callAI(
      FEEDBACK_SYSTEM,
      `【场次上下文】\n${context || '无'}\n\n【原始提示词】\n${prompt}\n\n【生成反馈】\n${feedback}`
    );
    if (pid && fid) await FeedbackStore.setAnalysis(pid, fid, text);
    res.json({ analysis: text });
  } catch (error) { res.status(502).json({ error: String(error.message || error) }); }
});

// ---------- 配置状态 ----------
app.get('/api/config/status', (req, res) => {
  res.json({
    keyConfigured: !!apiKey(), provider: provider(), model: model(),
    source: keySource(),
    storage: pool ? 'postgres' : 'file'
  });
});
app.post('/api/config/key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误。' });
  const next = config();
  if (['deepseek', 'anthropic', 'kimi', 'openai_compatible'].includes(req.body?.provider)) next.provider = req.body.provider;
  if (typeof req.body?.key === 'string' && req.body.key.trim()) next.apiKey = req.body.key.trim();
  if (typeof req.body?.model === 'string') next.model = req.body.model.trim();
  writeJSON(CONFIG_FILE, next);
  res.json({ ok: true, keyConfigured: !!apiKey(), provider: provider(), model: model() });
});
app.delete('/api/config/key', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: '管理员密码错误。' });
  const next = config();
  delete next.apiKey;
  writeJSON(CONFIG_FILE, next);
  res.json({ ok: true, keyConfigured: !!apiKey() });
});

// 新工作台为唯一正式入口；旧地址统一回到当前工作台。
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'workflow.html')));
app.get('/legacy', (req, res) => res.redirect(302, '/'));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: '服务器处理失败，请稍后重试。' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  initStore()
    .then(() => app.listen(PORT, () => {
      console.log(`AIGC影视工作流已启动：http://localhost:${PORT}`);
      console.log(`存储：${pool ? 'Postgres' : '本地JSON'}｜AI：${provider()} ${model()}`);
    }))
    .catch(error => {
      console.error('初始化失败：', error);
      process.exitCode = 1;
    });
}

module.exports = {
  app,
  initStore,
  normalizeSceneData,
  linkAnalysisData,
  parseScriptSceneBlocks,
  canonicalSceneKey,
  stableId,
  provider,
  apiKey,
  model,
  aiBaseUrl,
  callAI,
  normalizeUploadFilename,
  mergeSceneLineMembership,
  normalizeGroupShots,
  WORKFLOW_SCHEMA_MIGRATIONS
};
