const KNOWLEDGE_TYPES = [
  ['timeline_master','综合剧情时间线','按故事真实发生顺序整理全部关键事件。'],
  ['timeline_male','男主单线','只追踪男主目标、行动、阻力和人物弧光。'],
  ['timeline_female','女主单线','只追踪女主选择、秘密、代价和人物弧光。'],
  ['supporting_arcs','配角线','识别配角的功能、转折以及与主线的汇合点。'],
  ['relationships','人物关系','建立人物关系、利益、情感和冲突网络。'],
  ['worldbuilding','世界观体系','提取制度、空间、技术、社会规则与禁忌。'],
  ['emotional_arc','情感脉络','追踪情绪强度、关系变化和情感峰值。'],
  ['narrative_structure','叙事结构','分析幕、序列、转折点、高潮和结局。'],
  ['foreshadowing','伏笔与回收','建立伏笔、信息隐藏与回收关系。'],
  ['reveal_order','信息揭示顺序','分析观众和角色分别在何时知道什么。'],
  ['character_arcs','人物弧光','比较主要人物的起点、选择、代价与终点。'],
  ['logic_audit','剧情逻辑检查','发现时间、动机、因果和世界规则冲突。']
];
const ASSET_TYPES = [
  ['all','全部资产'],['character','角色'],['location','场景'],['prop','道具'],
  ['style','风格'],['sound','音效'],['music','音乐']
];
const ACTION_NAMES = {
  knowledge:'知识图谱分析', assets:'资产提取', scenes:'场次与15秒分镜拆分',
  prompt:'分镜提示词生成', audit:'质量与连续性检查'
};
const STATUS_NAMES = {
  ai_draft:'AI草稿', review:'待确认', approved:'已确认', locked:'已锁定',
  stale:'已过期', archived:'已归档', running:'生成中', completed:'已完成',
  failed:'失败', active:'进行中', parsed:'已解析', stored:'已保存'
};

const state = {
  data: null,
  projectId: new URLSearchParams(location.search).get('project') || '',
  view: 'overview',
  fileFilter: 'all',
  assetFilter: 'all',
  selectedSceneId: '',
  selectedKnowledge: new Set(),
  pendingFiles: []
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
}[char]));
const formatTime = timestamp => timestamp
  ? new Date(timestamp).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
  : '—';
const formatSize = size => {
  if (!size) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};
const statusTag = status => `<span class="status ${escapeHtml(status)}">${escapeHtml(STATUS_NAMES[status] || status || '未生成')}</span>`;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body instanceof FormData
      ? (options.headers || {})
      : { 'content-type':'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 HTTP ${response.status}`);
  return data;
}

function toast(message, type = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.className = 'toast', 3200);
}

function loading(on, title = 'AI正在分析') {
  $('#loading-title').textContent = title;
  $('#loading-overlay').classList.toggle('on', on);
  $('#loading-overlay').setAttribute('aria-hidden', on ? 'false' : 'true');
}

async function bootstrap(silent = false) {
  try {
    const query = state.projectId ? `?projectId=${encodeURIComponent(state.projectId)}` : '';
    state.data = await api(`/api/workflow/bootstrap${query}`);
    if (!state.projectId && state.data.project) state.projectId = state.data.project.id;
    if (!state.selectedSceneId || !state.data.scenes.some(scene => scene.id === state.selectedSceneId)) {
      state.selectedSceneId = state.data.scenes[0]?.id || '';
    }
    renderAll();
    if (!silent) toast('项目数据已同步');
  } catch (error) {
    $('#ai-status').className = 'system-pill error';
    $('#ai-status').innerHTML = '<i></i> 连接失败';
    toast(error.message, 'error');
  }
}

function renderAll() {
  if (!state.data) return;
  renderProjectSwitcher();
  renderOverview();
  renderSources();
  renderKnowledge();
  renderAssets();
  renderStoryboard();
  renderReview();
  renderNavigationCounts();
}

function renderProjectSwitcher() {
  const select = $('#project-select');
  select.innerHTML = state.data.projects.map(project =>
    `<option value="${escapeHtml(project.id)}" ${project.id === state.projectId ? 'selected' : ''}>${escapeHtml(project.name)}</option>`
  ).join('');
  const ai = state.data.ai;
  const status = $('#ai-status');
  status.className = `system-pill ${ai.configured ? 'ready' : 'error'}`;
  status.innerHTML = `<i></i> ${ai.configured ? `${escapeHtml(ai.provider)} · ${escapeHtml(ai.model)}` : 'AI未配置'}`;
}

function renderNavigationCounts() {
  $('#nav-files').textContent = state.data.files.length;
  $('#nav-analyses').textContent = state.data.analyses.length;
  $('#nav-assets').textContent = state.data.assets.length;
  $('#nav-groups').textContent = state.data.shotGroups.length;
}

function renderOverview() {
  const project = state.data.project || {};
  $('#project-title').textContent = project.name || '未命名项目';
  $('#project-logline').textContent = project.data?.logline || '上传剧本和项目资料，建立你的AIGC影视工作流。';
  $('#stat-files').textContent = state.data.files.length;
  $('#stat-analysis').textContent = state.data.analyses.filter(item => item.subtype !== 'quality_audit').length;
  $('#stat-assets').textContent = state.data.assets.length;
  $('#stat-groups').textContent = state.data.shotGroups.length;
  const style = project.data?.styleLock || {};
  const styleRows = [
    ['摄影',style.photography],['色调',style.color],['世界观',style.world],['情绪',style.emotion]
  ].filter(([,value]) => value);
  $('#style-lock').innerHTML = styleRows.length
    ? styleRows.map(([key,value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')
    : '<div><dt>待建立</dt><dd>可由AI提供多套方案，人工确认后锁定。</dd></div>';
  $('#recent-jobs').innerHTML = renderJobs(state.data.jobs.slice(0,5));
}

function renderSources() {
  const files = state.data.files.filter(file => state.fileFilter === 'all' || file.subtype === state.fileFilter);
  $('#file-list').innerHTML = files.length ? files.map(file => {
    const ext = file.data?.extension?.replace('.','').toUpperCase() || (file.subtype === 'image' ? 'IMG' : 'FILE');
    return `<div class="file-row">
      <div class="file-icon">${escapeHtml(ext.slice(0,5))}</div>
      <div><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.data?.parseNote || file.subtype)}</small></div>
      <span>${escapeHtml(file.subtype)}</span>
      <time>${formatSize(file.data?.size)}</time>
      ${statusTag(file.status)}
    </div>`;
  }).join('') : '<div class="empty-state">还没有这一类别的资料。上传后系统会先提取事实文本，不会自动启动创作分析。</div>';
}

function renderKnowledge() {
  const analysisMap = new Map(state.data.analyses.map(item => [item.subtype,item]));
  $('#knowledge-grid').innerHTML = KNOWLEDGE_TYPES.map(([type,title,description],index) => {
    const item = analysisMap.get(type);
    const selected = state.selectedKnowledge.has(type);
    const summary = item?.data?.summary || description;
    return `<article class="knowledge-card ${selected ? 'selected' : ''}" data-knowledge="${type}">
      <input type="checkbox" aria-label="选择${escapeHtml(title)}" ${selected ? 'checked' : ''}>
      <span class="card-code">GRAPH ${String(index + 1).padStart(2,'0')}</span>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(summary)}</p>
      <footer>${item ? statusTag(item.status) : '<span class="status">未生成</span>'}
        <button data-generate-one="${type}">${item ? '重新生成' : '单项生成'} →</button>
      </footer>
    </article>`;
  }).join('');
  $('#knowledge-count').textContent = state.selectedKnowledge.size ? `· ${state.selectedKnowledge.size}` : '';
}

function renderAssets() {
  $('#asset-tabs').innerHTML = ASSET_TYPES.map(([type,label]) => {
    const count = type === 'all' ? state.data.assets.length : state.data.assets.filter(item => item.subtype === type).length;
    return `<button class="chip ${state.assetFilter === type ? 'active' : ''}" data-asset-filter="${type}">${label} · ${count}</button>`;
  }).join('');
  const assets = state.data.assets.filter(asset => state.assetFilter === 'all' || asset.subtype === state.assetFilter);
  $('#asset-grid').innerHTML = assets.length ? assets.map(asset => `<article class="asset-card">
    <div class="asset-visual"><span>${escapeHtml(asset.subtype.toUpperCase())}</span></div>
    <div class="asset-body">
      <h3>${escapeHtml(asset.name)}</h3>
      <p>${escapeHtml(asset.data?.description || '等待补充资产描述与视觉锚点。')}</p>
      <footer>${statusTag(asset.status)}<button class="text-button" data-approve="${asset.id}">${asset.status === 'locked' ? '已锁定' : '确认并锁定'}</button></footer>
    </div>
  </article>`).join('') : '<div class="empty-state">还没有资产。可以选择角色、场景、道具、风格或声音类别让AI提取，也可以人工新建。</div>';
}

function renderStoryboard() {
  const scenes = state.data.scenes;
  $('#scene-list').innerHTML = scenes.length ? scenes.map(scene => {
    const groups = state.data.shotGroups.filter(group => group.data?.sceneId === scene.id);
    return `<button class="scene-button ${scene.id === state.selectedSceneId ? 'active' : ''}" data-scene="${scene.id}">
      <span>${escapeHtml(scene.data?.sceneNo || '—')}</span>
      <div><strong>${escapeHtml(scene.data?.heading || scene.name)}</strong><small>${groups.length}个15s分镜组 · ${escapeHtml(STATUS_NAMES[scene.status] || scene.status)}</small></div>
    </button>`;
  }).join('') : '<div class="empty-state">请先上传剧本，再选择“AI拆分场次”。</div>';
  const scene = scenes.find(item => item.id === state.selectedSceneId);
  if (!scene) {
    $('#scene-detail').innerHTML = '<div><span class="kicker">NO SCENE</span><h2>尚未建立场次</h2><p>上传剧本后，可按全部剧本或指定范围拆分。</p></div>';
    $('#shot-list').innerHTML = '';
    return;
  }
  $('#scene-detail').innerHTML = `<div><span class="kicker">SCENE ${escapeHtml(scene.data?.sceneNo || '')}</span>
    <h2>${escapeHtml(scene.data?.heading || scene.name)}</h2><p>${escapeHtml(scene.data?.summary || '')}</p></div>
    <div>${statusTag(scene.status)} <button class="text-button" data-approve="${scene.id}">确认场次</button></div>`;
  const groups = state.data.shotGroups.filter(group => group.data?.sceneId === scene.id);
  $('#shot-list').innerHTML = groups.length ? groups.map(renderShotCard).join('') : '<div class="empty-state">本场还没有15秒分镜组。</div>';
}

function renderShotCard(group) {
  const beats = group.data?.beats || [];
  const colors = group.data?.colorCard || [];
  return `<article class="shot-card">
    <header class="shot-card-head">
      <span class="shot-code">${escapeHtml(group.data?.code || '')}</span>
      <div><h3>${escapeHtml(group.data?.title || group.name)}</h3><small>${escapeHtml(group.subtype)} · ${group.data?.duration || 15}s · ${escapeHtml(group.data?.mode || 'T2V')} · ${escapeHtml(group.data?.targetModel || '通用')}</small></div>
      ${statusTag(group.status)}
    </header>
    <div class="shot-card-body">
      <div>
        <div class="beat-track">${beats.length ? beats.map(beat => `<div class="beat"><b>${escapeHtml(beat.time)}</b><span>${escapeHtml(beat.action)}</span></div>`).join('') : '<div class="beat"><b>待规划</b><span>点击AI生成分镜方案或提示词字段</span></div>'}</div>
        ${colors.length ? `<div class="color-strip">${colors.map(color => `<i style="background:${escapeHtml(color.hex)}" title="${escapeHtml(color.name)}"></i>`).join('')}</div>` : ''}
      </div>
      <div class="shot-actions">
        <button data-prompt="${group.id}">AI生成字段</button>
        <button data-approve="${group.id}">确认/锁定</button>
        <button data-copy="${group.id}">复制中文提示词</button>
        <button data-feedback="${group.id}">查看提示词</button>
      </div>
    </div>
  </article>`;
}

function renderReview() {
  $('#job-list').innerHTML = renderJobs(state.data.jobs);
  const checkpoints = [
    ['资料权威版本',state.data.files.some(file => file.subtype === 'script' && file.status === 'approved')],
    ['人物与关系',state.data.analyses.some(item => item.subtype === 'relationships' && ['approved','locked'].includes(item.status))],
    ['世界观规则',state.data.analyses.some(item => item.subtype === 'worldbuilding' && ['approved','locked'].includes(item.status))],
    ['项目STYLE LOCK',!!state.data.project?.data?.styleLock?.photography],
    ['角色视觉锚点',state.data.assets.some(item => item.subtype === 'character' && item.status === 'locked')],
    ['场次拆分',state.data.scenes.length > 0 && state.data.scenes.every(item => ['approved','locked'].includes(item.status))],
    ['15秒分段',state.data.shotGroups.length > 0 && state.data.shotGroups.every(item => ['approved','locked'].includes(item.status))],
    ['最终提示词',state.data.shotGroups.some(item => item.status === 'locked' && item.data?.promptZh)]
  ];
  $('#checkpoint-list').innerHTML = checkpoints.map(([name,done],index) => `<div class="checkpoint ${done ? 'done' : ''}">
    <i>${done ? '✓' : String(index + 1).padStart(2,'0')}</i>
    <div><strong>${escapeHtml(name)}</strong><small>${done ? '已经人工确认' : '等待确认或锁定'}</small></div>
    <span class="status ${done ? 'approved' : ''}">${done ? '完成' : '待处理'}</span>
  </div>`).join('');
}

function renderJobs(jobs) {
  return jobs.length ? jobs.map(job => `<div class="job-item ${escapeHtml(job.status)}">
    <i></i><div><strong>${escapeHtml(ACTION_NAMES[job.subtype] || job.name)}</strong>
    <small>${escapeHtml((job.data?.targets || []).join(' · ') || job.data?.scope?.range || '项目范围')} · ${formatTime(job.updatedAt)}</small></div>
    ${statusTag(job.status)}
  </div>`).join('') : '<div class="empty-state">还没有AI任务。你可以从知识图谱、资产库或分镜工作台按需启动。</div>';
}

function switchView(view) {
  state.view = view;
  $$('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#sidebar').classList.remove('open');
  window.scrollTo({ top:0, behavior:'smooth' });
}

async function runAI(action, targets, scope = {}, title = 'AI正在分析') {
  if (!state.data.ai.configured) {
    toast('请先在服务器环境变量中配置AI API Key。','error');
    return;
  }
  loading(true,title);
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.projectId)}/ai/jobs`, {
      method:'POST', body:JSON.stringify({ action, targets, scope })
    });
    toast(`${ACTION_NAMES[action]}已完成，结果保存为AI草稿`);
    await bootstrap(true);
    return result;
  } catch (error) {
    toast(error.message,'error');
  } finally {
    loading(false);
  }
}

function openUpload(files = []) {
  state.pendingFiles = [...files];
  updateUploadSelection();
  $('#upload-dialog').showModal();
}
function updateUploadSelection() {
  const el = $('#upload-selection');
  el.textContent = state.pendingFiles.length
    ? `已选择 ${state.pendingFiles.length} 个文件：${state.pendingFiles.map(file => file.name).join('、')}`
    : '尚未选择文件';
}

async function uploadFiles(kind) {
  if (!state.pendingFiles.length) return toast('请先选择文件','error');
  const body = new FormData();
  body.append('kind',kind);
  state.pendingFiles.forEach(file => body.append('files',file));
  loading(true,'正在上传并解析资料');
  try {
    await api(`/api/projects/${encodeURIComponent(state.projectId)}/files`, { method:'POST',body });
    toast('资料已上传，基础文本解析完成');
    state.pendingFiles = [];
    await bootstrap(true);
    switchView('sources');
  } catch (error) { toast(error.message,'error'); }
  finally { loading(false); }
}

function bindEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click',() => switchView(button.dataset.view)));
  $$('[data-go]').forEach(button => button.addEventListener('click',() => switchView(button.dataset.go)));
  $('#mobile-menu').addEventListener('click',() => $('#sidebar').classList.toggle('open'));
  $('#project-select').addEventListener('change',event => {
    state.projectId = event.target.value;
    history.replaceState(null,'',`?project=${encodeURIComponent(state.projectId)}`);
    bootstrap(true);
  });
  $('#new-project-button').addEventListener('click',() => $('#project-dialog').showModal());
  $('#project-form').addEventListener('submit',async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const project = await api('/api/projects',{method:'POST',body:JSON.stringify(Object.fromEntries(form))});
      $('#project-dialog').close();
      state.projectId = project.id;
      event.currentTarget.reset();
      await bootstrap(true);
      toast('新项目已创建');
    } catch (error) { toast(error.message,'error'); }
  });
  $$('.upload-trigger').forEach(button => button.addEventListener('click',event => { event.stopPropagation(); openUpload(); }));
  $('#global-upload').addEventListener('click',() => openUpload());
  $('#drop-zone').addEventListener('click',event => {
    if (!event.target.closest('.upload-trigger')) $('#file-input').click();
  });
  $('#drop-zone').addEventListener('keydown',event => { if (event.key === 'Enter') $('#file-input').click(); });
  $('#dialog-file-picker').addEventListener('click',() => $('#file-input').click());
  $('#file-input').addEventListener('change',event => {
    state.pendingFiles = [...event.target.files];
    updateUploadSelection();
    if (!$('#upload-dialog').open) $('#upload-dialog').showModal();
    event.target.value = '';
  });
  ['dragenter','dragover'].forEach(type => $('#drop-zone').addEventListener(type,event => {
    event.preventDefault(); $('#drop-zone').classList.add('dragging');
  }));
  ['dragleave','drop'].forEach(type => $('#drop-zone').addEventListener(type,event => {
    event.preventDefault(); $('#drop-zone').classList.remove('dragging');
  }));
  $('#drop-zone').addEventListener('drop',event => openUpload(event.dataTransfer.files));
  $('#upload-form').addEventListener('submit',event => {
    event.preventDefault();
    const kind = new FormData(event.currentTarget).get('kind');
    $('#upload-dialog').close();
    uploadFiles(kind);
  });
  $('#file-filters').addEventListener('click',event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.fileFilter = button.dataset.filter;
    $$('#file-filters .chip').forEach(el => el.classList.toggle('active',el === button));
    renderSources();
  });
  $('#knowledge-grid').addEventListener('click',event => {
    const one = event.target.closest('[data-generate-one]');
    if (one) {
      event.stopPropagation();
      runAI('knowledge',[one.dataset.generateOne],{},'正在生成知识分析');
      return;
    }
    const card = event.target.closest('[data-knowledge]');
    if (!card) return;
    const type = card.dataset.knowledge;
    state.selectedKnowledge.has(type) ? state.selectedKnowledge.delete(type) : state.selectedKnowledge.add(type);
    renderKnowledge();
  });
  $('#select-all-knowledge').addEventListener('click',() => {
    if (state.selectedKnowledge.size === KNOWLEDGE_TYPES.length) state.selectedKnowledge.clear();
    else KNOWLEDGE_TYPES.forEach(([type]) => state.selectedKnowledge.add(type));
    renderKnowledge();
  });
  $('#generate-knowledge').addEventListener('click',() => {
    if (!state.selectedKnowledge.size) return toast('请先选择至少一项知识分析','error');
    runAI('knowledge',[...state.selectedKnowledge],{},'正在生成选中的知识图谱');
  });
  $('#asset-tabs').addEventListener('click',event => {
    const button = event.target.closest('[data-asset-filter]');
    if (!button) return;
    state.assetFilter = button.dataset.assetFilter;
    renderAssets();
  });
  $('#extract-assets').addEventListener('click',() => $('#asset-dialog').showModal());
  $('#asset-form').addEventListener('submit',event => {
    event.preventDefault();
    const targets = [...new FormData(event.currentTarget).getAll('assetTypes')];
    if (!targets.length) return toast('请选择资产类别','error');
    $('#asset-dialog').close();
    runAI('assets',targets,{},'正在提取生产资产');
  });
  $('#new-asset').addEventListener('click',async () => {
    const name = prompt('资产名称');
    if (!name?.trim()) return;
    const type = prompt('资产类型：character / location / prop / style / sound / music','character');
    if (!type?.trim()) return;
    try {
      await api(`/api/projects/${encodeURIComponent(state.projectId)}/records`,{
        method:'POST',body:JSON.stringify({kind:'asset',subtype:type.trim(),name:name.trim(),status:'review',data:{description:'人工创建，等待补充。'}})
      });
      await bootstrap(true); toast('人工资产已创建');
    } catch (error) { toast(error.message,'error'); }
  });
  $('#asset-grid').addEventListener('click',event => {
    const button = event.target.closest('[data-approve]');
    if (button) approveRecord(button.dataset.approve,'locked');
  });
  $('#scene-list').addEventListener('click',event => {
    const button = event.target.closest('[data-scene]');
    if (!button) return;
    state.selectedSceneId = button.dataset.scene;
    renderStoryboard();
  });
  $('#ai-split-scenes').addEventListener('click',() => {
    const range = prompt('拆分范围（可留空代表全部剧本；例如：场1-20）','');
    if (range === null) return;
    runAI('scenes',[],{range},'正在拆分场次与15秒分镜组');
  });
  $('#audit-storyboard').addEventListener('click',() =>
    runAI('audit',['continuity','axis','action_density','light','prompt_compatibility'],{},'正在检查分镜连续性')
  );
  $('#scene-detail').addEventListener('click',event => {
    const button = event.target.closest('[data-approve]');
    if (button) approveRecord(button.dataset.approve,'approved');
  });
  $('#shot-list').addEventListener('click',event => {
    const promptButton = event.target.closest('[data-prompt]');
    if (promptButton) return openPromptDialog(promptButton.dataset.prompt);
    const approve = event.target.closest('[data-approve]');
    if (approve) return approveRecord(approve.dataset.approve,'locked');
    const copy = event.target.closest('[data-copy]');
    if (copy) return copyPrompt(copy.dataset.copy);
    const feedback = event.target.closest('[data-feedback]');
    if (feedback) return previewPrompt(feedback.dataset.feedback);
  });
  $('#prompt-form').addEventListener('submit',event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const groupId = form.get('shotGroupId');
    const fields = form.getAll('fields');
    if (!fields.length) return toast('请选择至少一个生成字段','error');
    $('#prompt-dialog').close();
    runAI('prompt',[groupId],{
      shotGroupId:groupId,fields,targetModel:form.get('targetModel'),mode:form.get('mode')
    },'正在生成分镜字段');
  });
  $('#refresh-button').addEventListener('click',() => bootstrap());
}

function renderAssetChecks() {
  $('#asset-checks').innerHTML = ASSET_TYPES.filter(([type]) => type !== 'all').map(([type,label]) =>
    `<label><input type="checkbox" name="assetTypes" value="${type}"><span><b>${label}</b><small>从已上传资料中提取并建立资产草稿</small></span></label>`
  ).join('');
}

async function approveRecord(id,status) {
  try {
    await api(`/api/records/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({status})});
    await bootstrap(true);
    toast(status === 'locked' ? '已确认并锁定' : '已确认');
  } catch (error) { toast(error.message,'error'); }
}

function openPromptDialog(groupId) {
  const group = state.data.shotGroups.find(item => item.id === groupId);
  if (!group) return;
  const form = $('#prompt-form');
  form.elements.shotGroupId.value = groupId;
  form.elements.targetModel.value = group.data?.targetModel || '通用';
  form.elements.mode.value = group.data?.mode || 'T2V';
  $('#prompt-title').textContent = `${group.data?.code || ''} · ${group.data?.title || group.name}`;
  $('#prompt-dialog').showModal();
}

function copyPrompt(groupId) {
  const group = state.data.shotGroups.find(item => item.id === groupId);
  const text = group?.data?.promptZh;
  if (!text) return toast('这一分镜还没有中文提示词','error');
  navigator.clipboard.writeText(text).then(() => toast('中文提示词已复制')).catch(() => toast('复制失败','error'));
}

function previewPrompt(groupId) {
  const group = state.data.shotGroups.find(item => item.id === groupId);
  const text = group?.data?.promptZh || '尚未生成提示词。';
  const english = group?.data?.promptEn ? `\n\n英文版：\n${group.data.promptEn}` : '';
  alert(`中文版：\n${text}${english}`);
}

renderAssetChecks();
bindEvents();
bootstrap(true);
