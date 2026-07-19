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
const STORY_LINES = [
  ['all','全部分镜'],['male','男主线'],['female','女主线'],['supporting','配角线'],
  ['ensemble','群像线'],['romance','感情线'],['mystery','悬疑线'],['world','世界观线'],['other','其他线']
];
const STORY_LINE_NAMES = Object.fromEntries(STORY_LINES);
const ACTION_NAMES = {
  knowledge:'知识图谱分析', assets:'资产提取', scenes:'场次与15秒分镜拆分',
  prompt:'分镜提示词生成', audit:'质量与连续性检查'
};
const STATUS_NAMES = {
  ai_draft:'AI草稿', review:'待确认', approved:'已确认', locked:'已锁定',
  stale:'已过期', archived:'已归档', running:'生成中', completed:'已完成',
  failed:'失败', active:'进行中', parsed:'已解析', stored:'已保存'
};

const initialParams = new URLSearchParams(location.search);
const state = {
  data: null,
  projectId: initialParams.get('project') || '',
  view: initialParams.get('view') || 'overview',
  fileFilter: 'all',
  assetFilter: 'all',
  sceneLineFilter: initialParams.get('line') || 'all',
  selectedSceneId: initialParams.get('scene') || '',
  selectedShotGroupId: initialParams.get('group') || '',
  selectedAnalysisType: initialParams.get('graph') || '',
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
    switchView(state.view, false);
    revealSelectedShot();
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

function sceneLines(scene) {
  return [...new Set([
    scene.data?.primaryLine,
    ...(scene.data?.secondaryLines || [])
  ].filter(Boolean))];
}

function lineTag(line, primary = false) {
  return `<span class="line-tag ${escapeHtml(line)} ${primary ? 'primary' : ''}">${escapeHtml(STORY_LINE_NAMES[line] || line || '未分类')}</span>`;
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
      ${file.subtype === 'script' ? `<button class="text-button source-authority ${file.data?.authoritative ? 'active' : ''}" data-authoritative="${file.id}">${file.data?.authoritative ? '权威版本' : '设为权威'}</button>` : '<span></span>'}
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
        <span class="card-actions">${item ? `<button data-open-knowledge="${type}">查看图谱</button>` : ''}
        <button data-generate-one="${type}">${item ? '重新生成' : '单项生成'} →</button></span>
      </footer>
    </article>`;
  }).join('');
  $('#knowledge-count').textContent = state.selectedKnowledge.size ? `· ${state.selectedKnowledge.size}` : '';
  renderKnowledgeDetail();
}

function renderKnowledgeDetail() {
  const analyses = state.data.analyses.filter(item => item.subtype !== 'quality_audit');
  if (!state.selectedAnalysisType || !analyses.some(item => item.subtype === state.selectedAnalysisType)) {
    state.selectedAnalysisType = analyses[0]?.subtype || '';
  }
  const analysis = analyses.find(item => item.subtype === state.selectedAnalysisType);
  if (!analysis) {
    $('#knowledge-detail').innerHTML = '<div class="empty-state">生成知识分析后，可在这里查看节点，并从节点直接跳转到对应场次和分镜组。</div>';
    return;
  }
  const nodes = Array.isArray(analysis.data?.nodes) ? analysis.data.nodes : [];
  const edges = Array.isArray(analysis.data?.edges) ? analysis.data.edges : [];
  $('#knowledge-detail').innerHTML = `
    <div class="panel-head graph-head">
      <div><span class="kicker">LINKED GRAPH</span><h2>${escapeHtml(analysis.name)}</h2><p>${escapeHtml(analysis.data?.summary || '')}</p></div>
      <div class="graph-switcher">${analyses.map(item => `<button class="chip ${item.subtype === analysis.subtype ? 'active' : ''}" data-open-analysis="${item.subtype}">${escapeHtml(item.name)}</button>`).join('')}</div>
    </div>
    <div class="graph-stats"><span>${nodes.length} 个节点</span><span>${edges.length} 条关系</span><span>${analysis.data?.linkedSceneCount || 0} 个已链接场次</span></div>
    <div class="graph-node-list">${nodes.length ? nodes.map((node,index) => {
      const refs = Array.isArray(node.sceneRefs) ? node.sceneRefs : [];
      return `<article class="graph-node">
        <span class="node-index">${String(index + 1).padStart(2,'0')}</span>
        <div><h3>${escapeHtml(node.label || node.id || '未命名节点')}</h3><p>${escapeHtml(node.description || '')}</p>
          <div class="scene-ref-list">${refs.length ? refs.map(ref => ref.sceneId
            ? `<button data-scene-link="${escapeHtml(ref.sceneId)}">场${escapeHtml(ref.heading ? `${ref.sceneNo} · ${ref.heading}` : ref.sceneNo)}${ref.role ? ` · ${escapeHtml(ref.role)}` : ''} →</button>`
            : `<span class="scene-ref unresolved">场${escapeHtml(ref.sceneNo)} · ${ref.ambiguous ? '编号冲突待确认' : '尚未建立分镜'}</span>`
          ).join('') : '<span class="scene-ref unresolved">未关联场次</span>'}</div>
        </div>
      </article>`;
    }).join('') : '<div class="empty-state">这一分析还没有结构化节点，可点击“重新生成”升级为可导航图谱。</div>'}</div>`;
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
  $('#storyline-filters').innerHTML = STORY_LINES.map(([line,label]) => {
    const count = line === 'all'
      ? state.data.shotGroups.length
      : state.data.shotGroups.filter(group => (group.data?.lineRefs || []).includes(line)).length;
    return `<button class="chip ${state.sceneLineFilter === line ? 'active' : ''}" data-line-filter="${line}">${label} · ${count}组</button>`;
  }).join('');
  const filteredScenes = state.sceneLineFilter === 'all'
    ? scenes
    : scenes.filter(scene =>
      sceneLines(scene).includes(state.sceneLineFilter)
      || state.data.shotGroups.some(group =>
        group.data?.sceneId === scene.id && (group.data?.lineRefs || []).includes(state.sceneLineFilter)
      )
    );
  if (filteredScenes.length && !filteredScenes.some(scene => scene.id === state.selectedSceneId)) {
    state.selectedSceneId = filteredScenes[0].id;
  }
  $('#scene-list').innerHTML = filteredScenes.length ? filteredScenes.map(scene => {
    const allGroups = state.data.shotGroups.filter(group => group.data?.sceneId === scene.id);
    const groups = state.sceneLineFilter === 'all'
      ? allGroups
      : allGroups.filter(group => (group.data?.lineRefs || []).includes(state.sceneLineFilter));
    return `<button class="scene-button ${scene.id === state.selectedSceneId ? 'active' : ''}" data-scene="${scene.id}">
      <span>${escapeHtml(scene.data?.displaySceneNo || scene.data?.sceneNo || '—')}</span>
      <div><strong>${escapeHtml(scene.data?.heading || scene.name)}</strong>
      <small>${groups.length}个15s分镜组 · ${escapeHtml(STATUS_NAMES[scene.status] || scene.status)}</small>
      <div class="scene-line-tags">${sceneLines(scene).slice(0,3).map(line => lineTag(line,line === scene.data?.primaryLine)).join('')}</div></div>
    </button>`;
  }).join('') : '<div class="empty-state">当前线路没有匹配场次。可以切换“全部场次”或重新运行线路分析。</div>';
  const scene = scenes.find(item => item.id === state.selectedSceneId);
  if (!scene) {
    $('#scene-detail').innerHTML = '<div><span class="kicker">NO SCENE</span><h2>尚未建立场次</h2><p>上传剧本后，可按全部剧本或指定范围拆分。</p></div>';
    $('#shot-list').innerHTML = '';
    return;
  }
  const backlinks = state.data.analyses.flatMap(analysis =>
    (Array.isArray(analysis.data?.nodes) ? analysis.data.nodes : [])
      .filter(node => (node.sceneRefs || []).some(ref => ref.sceneId === scene.id))
      .map(node => ({ analysis, node }))
  );
  const events = Array.isArray(scene.data?.events) ? scene.data.events : [];
  $('#scene-detail').innerHTML = `<div class="scene-center">
    <div class="scene-center-head">
      <div><span class="kicker">SCENE ${escapeHtml(scene.data?.displaySceneNo || scene.data?.sceneNo || '')}</span>
        <h2>${escapeHtml(scene.data?.heading || scene.name)}</h2><p>${escapeHtml(scene.data?.summary || '')}</p></div>
      <div class="scene-center-status">${scene.data?.numberingConflict ? '<span class="status stale">编号冲突</span>' : ''}${statusTag(scene.status)}
        <button class="text-button" data-edit-lines="${scene.id}">编辑线路</button>
        <button class="text-button" data-approve="${scene.id}">确认场次</button></div>
    </div>
    <div class="scene-center-grid">
      <div><span>剧情线路</span><strong>${sceneLines(scene).map(line => lineTag(line,line === scene.data?.primaryLine)).join('') || '待分类'}</strong></div>
      <div><span>视角人物</span><strong>${escapeHtml(scene.data?.povCharacter || '待确认')}</strong></div>
      <div><span>出场人物</span><strong>${escapeHtml((scene.data?.characters || []).join(' · ') || '待提取')}</strong></div>
      <div><span>稳定坐标</span><strong class="mono">${escapeHtml(scene.data?.canonicalKey || scene.id)}</strong></div>
    </div>
    ${events.length ? `<div class="scene-events"><span>本场剧情事件</span>${events.map(event => `<i>${escapeHtml(event.label)}<small>${escapeHtml(event.type || '')}</small></i>`).join('')}</div>` : ''}
    <div class="scene-backlinks"><span>知识图谱反向引用</span>${backlinks.length
      ? backlinks.map(({analysis,node}) => `<button data-open-analysis="${escapeHtml(analysis.subtype)}">${escapeHtml(analysis.name)} · ${escapeHtml(node.label)} →</button>`).join('')
      : '<em>尚无知识节点链接到本场</em>'}</div>
    ${scene.textContent ? `<details class="source-excerpt"><summary>查看剧本来源摘要</summary><p>${escapeHtml(scene.textContent)}</p></details>` : ''}
  </div>`;
  const allGroups = state.data.shotGroups.filter(group => group.data?.sceneId === scene.id);
  const groups = state.sceneLineFilter === 'all'
    ? allGroups
    : allGroups.filter(group => (group.data?.lineRefs || []).includes(state.sceneLineFilter));
  $('#shot-list').innerHTML = groups.length ? groups.map(renderShotCard).join('') : '<div class="empty-state">本场还没有15秒分镜组。</div>';
}

function renderShotCard(group) {
  const beats = group.data?.beats || [];
  const colors = group.data?.colorCard || [];
  return `<article class="shot-card ${group.id === state.selectedShotGroupId ? 'targeted' : ''}" id="shot-${escapeHtml(group.id)}">
    <header class="shot-card-head">
      <span class="shot-code">${escapeHtml(group.data?.code || '')}</span>
      <div><h3>${escapeHtml(group.data?.title || group.name)}</h3><small>${escapeHtml(group.subtype)} · ${group.data?.duration || 15}s · ${escapeHtml(group.data?.mode || 'T2V')} · ${escapeHtml(group.data?.targetModel || '通用')}</small>
      <div class="scene-line-tags">${(group.data?.lineRefs || []).map(line => lineTag(line,line === group.data?.primaryLine)).join('')}</div></div>
      ${statusTag(group.status)}
    </header>
    <div class="shot-card-body">
      <div>
        <div class="beat-track">${beats.length ? beats.map(beat => `<div class="beat"><b>${escapeHtml(beat.time)}</b><span>${escapeHtml(beat.action)}</span></div>`).join('') : '<div class="beat"><b>待规划</b><span>点击AI生成分镜方案或提示词字段</span></div>'}</div>
        ${colors.length ? `<div class="color-strip">${colors.map(color => `<i style="background:${escapeHtml(color.hex)}" title="${escapeHtml(color.name)}"></i>`).join('')}</div>` : ''}
      </div>
      <div class="shot-actions">
        <button data-prompt="${group.id}">AI生成字段</button>
        <button data-edit-group-lines="${group.id}">编辑线路</button>
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

function syncRoute() {
  const params = new URLSearchParams();
  if (state.projectId) params.set('project',state.projectId);
  if (state.view !== 'overview') params.set('view',state.view);
  if (state.view === 'knowledge' && state.selectedAnalysisType) params.set('graph',state.selectedAnalysisType);
  if (state.view === 'storyboard' && state.selectedSceneId) params.set('scene',state.selectedSceneId);
  if (state.view === 'storyboard' && state.selectedShotGroupId) params.set('group',state.selectedShotGroupId);
  if (state.view === 'storyboard' && state.sceneLineFilter !== 'all') params.set('line',state.sceneLineFilter);
  history.replaceState(null,'',`${location.pathname}${params.size ? `?${params}` : ''}`);
}

function switchView(view, updateRoute = true) {
  state.view = view;
  $$('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  $('#sidebar').classList.remove('open');
  if (updateRoute) syncRoute();
  window.scrollTo({ top:0, behavior:updateRoute ? 'smooth' : 'auto' });
}

function jumpToScene(sceneId, groupId = '') {
  state.selectedSceneId = sceneId;
  state.selectedShotGroupId = groupId;
  state.sceneLineFilter = 'all';
  switchView('storyboard');
  renderStoryboard();
  revealSelectedShot();
}

function revealSelectedShot() {
  if (!state.selectedShotGroupId) return;
  requestAnimationFrame(() => document.getElementById(`shot-${state.selectedShotGroupId}`)?.scrollIntoView({ behavior:'smooth', block:'center' }));
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
    state.selectedSceneId = '';
    state.selectedShotGroupId = '';
    syncRoute();
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
  $('#file-list').addEventListener('click',async event => {
    const button = event.target.closest('[data-authoritative]');
    if (!button) return;
    try {
      await api(`/api/records/${encodeURIComponent(button.dataset.authoritative)}`,{
        method:'PATCH',
        body:JSON.stringify({status:'approved',data:{authoritative:true}})
      });
      await bootstrap(true);
      toast('已设为权威剧本，后续全剧拆分将优先使用这一版本');
    } catch (error) { toast(error.message,'error'); }
  });
  $('#knowledge-grid').addEventListener('click',event => {
    const open = event.target.closest('[data-open-knowledge]');
    if (open) {
      event.stopPropagation();
      state.selectedAnalysisType = open.dataset.openKnowledge;
      renderKnowledgeDetail();
      syncRoute();
      $('#knowledge-detail').scrollIntoView({ behavior:'smooth', block:'start' });
      return;
    }
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
  $('#knowledge-detail').addEventListener('click',event => {
    const sceneLink = event.target.closest('[data-scene-link]');
    if (sceneLink) return jumpToScene(sceneLink.dataset.sceneLink);
    const analysisLink = event.target.closest('[data-open-analysis]');
    if (!analysisLink) return;
    state.selectedAnalysisType = analysisLink.dataset.openAnalysis;
    renderKnowledgeDetail();
    syncRoute();
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
    state.selectedShotGroupId = '';
    renderStoryboard();
    syncRoute();
  });
  $('#storyline-filters').addEventListener('click',event => {
    const button = event.target.closest('[data-line-filter]');
    if (!button) return;
    state.sceneLineFilter = button.dataset.lineFilter;
    state.selectedShotGroupId = '';
    renderStoryboard();
    syncRoute();
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
    const editLines = event.target.closest('[data-edit-lines]');
    if (editLines) return editSceneLines(editLines.dataset.editLines);
    const analysisLink = event.target.closest('[data-open-analysis]');
    if (analysisLink) {
      state.selectedAnalysisType = analysisLink.dataset.openAnalysis;
      switchView('knowledge');
      renderKnowledgeDetail();
      $('#knowledge-detail').scrollIntoView({ behavior:'smooth', block:'start' });
    }
  });
  $('#shot-list').addEventListener('click',event => {
    const promptButton = event.target.closest('[data-prompt]');
    if (promptButton) return openPromptDialog(promptButton.dataset.prompt);
    const approve = event.target.closest('[data-approve]');
    if (approve) return approveRecord(approve.dataset.approve,'locked');
    const editLines = event.target.closest('[data-edit-group-lines]');
    if (editLines) return editGroupLines(editLines.dataset.editGroupLines);
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

async function editSceneLines(sceneId) {
  const scene = state.data.scenes.find(item => item.id === sceneId);
  if (!scene) return;
  const allowed = STORY_LINES.filter(([line]) => line !== 'all').map(([line]) => line).join(' / ');
  const primary = prompt(`主要线路（${allowed}）`,scene.data?.primaryLine || 'other');
  if (primary === null) return;
  if (!STORY_LINE_NAMES[primary] || primary === 'all') return toast('主要线路值不正确','error');
  const secondaryInput = prompt('次要线路，可用英文逗号分隔', (scene.data?.secondaryLines || []).join(','));
  if (secondaryInput === null) return;
  const secondaryLines = [...new Set(secondaryInput.split(/[,，]/u).map(value => value.trim()).filter(value => value && value !== primary && STORY_LINE_NAMES[value]))];
  try {
    await api(`/api/records/${encodeURIComponent(sceneId)}`,{
      method:'PATCH',
      body:JSON.stringify({ status:'review', data:{ primaryLine:primary, secondaryLines } })
    });
    await bootstrap(true);
    toast('场次线路已更新，等待确认');
  } catch (error) { toast(error.message,'error'); }
}

async function editGroupLines(groupId) {
  const group = state.data.shotGroups.find(item => item.id === groupId);
  if (!group) return;
  const input = prompt(
    `本分镜组所属线路，可用英文逗号分隔：${STORY_LINES.filter(([line]) => line !== 'all').map(([line]) => line).join(' / ')}`,
    (group.data?.lineRefs || []).join(',')
  );
  if (input === null) return;
  const lineRefs = [...new Set(input.split(/[,，]/u).map(value => value.trim()).filter(value => value && value !== 'all' && STORY_LINE_NAMES[value]))];
  if (!lineRefs.length) return toast('至少保留一条剧情线路','error');
  try {
    await api(`/api/records/${encodeURIComponent(groupId)}`,{
      method:'PATCH',
      body:JSON.stringify({
        status:'review',
        data:{ primaryLine:lineRefs[0], lineRefs, lineRefsSource:'manual_group' }
      })
    });
    await bootstrap(true);
    toast('分镜组线路已更新，等待确认');
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
