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
  prompt:'分镜提示词生成', asset_prompt:'资产提示词生成', audit:'质量与连续性检查'
};
const STATUS_NAMES = {
  ai_draft:'AI草稿', review:'待确认', approved:'已确认', locked:'已锁定',
  stale:'已过期', archived:'已归档', running:'生成中', completed:'已完成',
  failed:'失败', active:'进行中', parsed:'已解析', stored:'已保存', indexed:'已索引'
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
  selectedAssetId: '',
  selectedAnalysisType: initialParams.get('graph') || '',
  selectedKnowledge: new Set(),
  pendingFiles: [],
  activeUpload: null,
  aiProviderChoice: localStorage.getItem('aigc-ai-provider') || 'auto',
  monitoredJobs: new Map(),
  jobPollTimer: null,
  jobPollBusy: false,
  storyMapScroll: Object.create(null)
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

function loading(on, title = 'AI正在分析', detail = '结果会先保存为草稿') {
  $('#loading-title').textContent = title;
  $('#loading-detail').textContent = detail;
  $('#loading-overlay').classList.toggle('on', on);
  $('#loading-overlay').setAttribute('aria-hidden', on ? 'false' : 'true');
  if (!on) $('#cancel-upload').hidden = true;
}

function syncRunningJobs() {
  const currentIds = new Set((state.data?.jobs || []).map(job => job.id));
  for (const id of state.monitoredJobs.keys()) {
    if (!currentIds.has(id)) state.monitoredJobs.delete(id);
  }
  for (const job of state.data?.jobs || []) {
    if (job.status === 'running' && !state.monitoredJobs.has(job.id)) {
      state.monitoredJobs.set(job.id, { action: job.subtype, status: 'running' });
    }
  }
  if (state.monitoredJobs.size && !state.jobPollTimer) {
    state.jobPollTimer = setInterval(pollAIJobs, 5000);
  }
  if (!state.monitoredJobs.size && state.jobPollTimer) {
    clearInterval(state.jobPollTimer);
    state.jobPollTimer = null;
  }
}

function refreshAfterJobUpdate() {
  renderProjectSwitcher();
  renderNavigationCounts();
  renderOverview();
  renderReview();
  if (state.view === 'knowledge') renderKnowledge();
  if (state.view === 'assets') renderAssets();
  if ($('#asset-detail-dialog')?.open && state.selectedAssetId) renderAssetDetail();
  if (state.view === 'storyboard') renderStoryboard();
  renderSceneRail();
  renderContextCommand();
}

async function pollAIJobs() {
  if (state.jobPollBusy || !state.projectId) return;
  state.jobPollBusy = true;
  try {
    const latest = await api(`/api/workflow/bootstrap?projectId=${encodeURIComponent(state.projectId)}`);
    latest.comments ||= [];
    const completed = [];
    for (const job of latest.jobs || []) {
      const monitored = state.monitoredJobs.get(job.id);
      if (!monitored || job.status === 'running') continue;
      completed.push(job);
      state.monitoredJobs.delete(job.id);
    }
    state.data = latest;
    syncRunningJobs();
    if (completed.length) {
      refreshAfterJobUpdate();
    } else {
      renderProjectSwitcher();
      renderNavigationCounts();
      renderOverview();
      renderReview();
    }
    for (const job of completed) {
      if (job.status === 'completed') {
        toast(`${ACTION_NAMES[job.subtype] || job.name}已完成，结果保存为AI草稿`);
      } else {
        toast(job.data?.error || `${ACTION_NAMES[job.subtype] || job.name}生成失败`, 'error');
      }
    }
  } catch (error) {
    console.warn('AI job polling failed:', error);
  } finally {
    state.jobPollBusy = false;
  }
}

async function bootstrap(silent = false) {
  try {
    const query = state.projectId ? `?projectId=${encodeURIComponent(state.projectId)}` : '';
    state.data = await api(`/api/workflow/bootstrap${query}`);
    state.data.comments ||= [];
    syncRunningJobs();
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
  renderSceneRail();
  renderContextCommand();
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

function recordSceneIds(record) {
  const refs = Array.isArray(record?.data?.sceneRefs) ? record.data.sceneRefs : [];
  return [...new Set(refs.map(ref => typeof ref === 'string' ? ref : ref.sceneId).filter(Boolean))];
}

function lineOptions(selected) {
  return STORY_LINES
    .filter(([line]) => line !== 'all')
    .map(([line, label]) => `<option value="${escapeHtml(line)}" ${line === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
}

function renderProjectSwitcher() {
  const select = $('#project-select');
  select.innerHTML = state.data.projects.map(project =>
    `<option value="${escapeHtml(project.id)}" ${project.id === state.projectId ? 'selected' : ''}>${escapeHtml(project.name)}</option>`
  ).join('');
  const ai = state.data.ai;
  const providerSelect = $('#ai-provider-select');
  const providerOptions = [
    { id: 'auto', label: '自动推荐', configured: (ai.providers || []).some(item => item.configured) },
    ...(ai.providers || [])
  ];
  if (!providerOptions.some(item => item.id === state.aiProviderChoice && item.configured)) {
    state.aiProviderChoice = 'auto';
  }
  providerSelect.innerHTML = providerOptions.map(item =>
    `<option value="${escapeHtml(item.id)}" ${item.id === state.aiProviderChoice ? 'selected' : ''} ${item.configured ? '' : 'disabled'}>${escapeHtml(item.label)}${item.configured ? '' : '（需配置Key）'}</option>`
  ).join('');
  const status = $('#ai-status');
  const runningCount = state.data.jobs.filter(job => job.status === 'running').length;
  status.className = `system-pill ${runningCount ? 'working' : (ai.configured ? 'ready' : 'error')}`;
  status.innerHTML = `<i></i> ${runningCount
    ? `${runningCount} 个AI任务后台生成中`
    : (ai.configured ? `${escapeHtml(ai.provider)} · ${escapeHtml(ai.model)}` : 'AI未配置')}`;
  status.title = runningCount ? '点击查看后台任务' : 'AI服务状态';
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

function inferStoryLane(node, analysisType, index) {
  const explicit = String(node.lane || '').trim();
  if (explicit) return explicit;
  const text = `${node.label || ''} ${node.description || ''} ${node.eventType || ''}`;
  if (/情感|关系|爱情|信物|母亲|父亲|家人|承诺|回信|relationship|romance/i.test(text)) return '关系与信物';
  if (/制度|世界|规则|社会|组织|技术|季节|休眠|刑|world|system/i.test(text)) return '制度与外部压力';
  if (/伏笔|揭示|秘密|线索|回收|reveal|payoff|mystery/i.test(text)) return '信息与回收';
  if (analysisType === 'emotional_arc') return index % 3 === 1 ? '关系事件' : '情感状态';
  return '核心行动线';
}

function storyNodeDetails(node) {
  const fields = [
    ['目标', node.goal],
    ['行动', node.action],
    ['阻力', node.obstacle],
    ['选择', node.choice],
    ['代价', node.cost]
  ].filter(([,value]) => value);
  return fields.length
    ? `<dl>${fields.map(([label,value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`
    : `<p>${escapeHtml(node.description || '')}</p>`;
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
  const detail = $('#knowledge-detail');
  const previousCanvas = detail.querySelector('.story-map-canvas');
  if (previousCanvas) state.storyMapScroll[analysis.subtype] = previousCanvas.scrollLeft;
  const preparedNodes = nodes.map((node,index) => ({
    node,
    index,
    lane: inferStoryLane(node, analysis.subtype, index)
  }));
  const lanes = [...new Set(preparedNodes.map(item => item.lane))].slice(0,4);
  const normalizedNodes = preparedNodes.map(item => ({
    ...item,
    lane: lanes.includes(item.lane) ? item.lane : lanes[0] || '核心行动线'
  }));
  const outgoing = edges.reduce((map, edge) => {
    const labels = map.get(edge.from) || [];
    if (edge.label) labels.push(edge.label);
    map.set(edge.from, labels);
    return map;
  }, new Map());
  detail.innerHTML = `
    <div class="panel-head graph-head">
      <div><span class="kicker">LINKED GRAPH</span><h2>${escapeHtml(analysis.name)}</h2><p>${escapeHtml(analysis.data?.summary || '')}</p></div>
      <div class="graph-switcher">${analyses.map(item => `<button class="chip ${item.subtype === analysis.subtype ? 'active' : ''}" data-open-analysis="${item.subtype}">${escapeHtml(item.name)}</button>`).join('')}</div>
    </div>
    <div class="graph-stats"><span>${nodes.length} 个节点</span><span>${edges.length} 条关系</span><span>${analysis.data?.linkedSceneCount || 0} 个已链接场次</span></div>
    <div class="story-map-canvas" data-story-map="${escapeHtml(analysis.subtype)}">
      <div class="map-grid-lines"></div>
      <div class="story-map-heading"><div><span>${escapeHtml(analysis.name)}</span><small>多轨叙事结构 · 按时间/场次横向展开</small></div>
        <div class="story-map-legend">${lanes.map((lane,index) => `<i class="lane-${index}"></i><span>${escapeHtml(lane)}</span>`).join('')}</div>
      </div>
      ${nodes.length ? `<div class="story-map-stage" style="--story-columns:${nodes.length}">
        <div class="story-time-ruler"><b>时间 / 场次</b><div>${normalizedNodes.map(({node,index}) =>
          `<span style="grid-column:${index + 1}">${escapeHtml(node.timeLabel || node.sceneRefs?.[0]?.sceneNo ? (node.timeLabel || `场${node.sceneRefs?.[0]?.sceneNo}`) : `节点 ${index + 1}`)}</span>`
        ).join('')}</div></div>
        ${lanes.map((lane,laneIndex) => `<section class="story-track lane-${laneIndex}">
          <header><span>TRACK ${String(laneIndex + 1).padStart(2,'0')}</span><strong>${escapeHtml(lane)}</strong></header>
          <div class="story-track-events">${normalizedNodes.filter(item => item.lane === lane).map(({node,index}) => {
            const refs = Array.isArray(node.sceneRefs) ? node.sceneRefs : [];
            const edgeLabels = outgoing.get(node.id) || [];
            return `<article class="story-event importance-${escapeHtml(node.importance || 'normal')}" style="grid-column:${index + 1}">
              <div class="story-event-marker"><i></i><span>${String(index + 1).padStart(2,'0')}</span></div>
              <small>${escapeHtml(node.eventType || 'event')}</small>
              <h3>${escapeHtml(node.label || node.id || '未命名节点')}</h3>
              ${storyNodeDetails(node)}
              ${edgeLabels.length ? `<div class="edge-labels">${edgeLabels.slice(0,2).map(label => `<em>${escapeHtml(label)} →</em>`).join('')}</div>` : ''}
              <div class="scene-ref-list">${refs.length ? refs.map(ref => ref.sceneId
                ? `<button data-scene-link="${escapeHtml(ref.sceneId)}">场${escapeHtml(ref.heading ? `${ref.sceneNo} · ${ref.heading}` : ref.sceneNo)}${ref.role ? ` · ${escapeHtml(ref.role)}` : ''} →</button>`
                : `<span class="scene-ref unresolved">场${escapeHtml(ref.sceneNo)} · ${ref.ambiguous ? '编号冲突待确认' : '尚未建立分镜'}</span>`
              ).join('') : '<span class="scene-ref unresolved">未关联场次</span>'}</div>
            </article>`;
          }).join('')}</div>
        </section>`).join('')}
      </div>` : '<div class="empty-state">这一分析还没有结构化节点，可点击“重新生成”升级为可导航图谱。</div>'}
    </div>`;
  const canvas = detail.querySelector('.story-map-canvas');
  if (canvas) {
    canvas.scrollLeft = state.storyMapScroll[analysis.subtype] || 0;
    canvas.addEventListener('scroll', () => {
      state.storyMapScroll[analysis.subtype] = canvas.scrollLeft;
    }, { passive: true });
  }
}

function renderAssets() {
  $('#asset-tabs').innerHTML = ASSET_TYPES.map(([type,label]) => {
    const count = type === 'all' ? state.data.assets.length : state.data.assets.filter(item => item.subtype === type).length;
    return `<button class="chip ${state.assetFilter === type ? 'active' : ''}" data-asset-filter="${type}">${label} · ${count}</button>`;
  }).join('');
  const assets = state.data.assets.filter(asset => state.assetFilter === 'all' || asset.subtype === state.assetFilter);
  $('#asset-grid').innerHTML = assets.length ? assets.map((asset,index) => {
    const sceneIds = recordSceneIds(asset);
    const sceneLabels = sceneIds.map(id => state.data.scenes.find(scene => scene.id === id)?.data?.displaySceneNo).filter(Boolean);
    const image = asset.data?.hasImage
      ? `/api/assets/${encodeURIComponent(asset.id)}/image?v=${encodeURIComponent(asset.data.imageUpdatedAt || '')}`
      : (asset.data?.imageUrl || asset.data?.thumbnailUrl || '');
    return `<article class="asset-card asset-${escapeHtml(asset.subtype)}" data-open-asset="${escapeHtml(asset.id)}" data-asset-scenes="${escapeHtml(sceneIds.join(','))}" tabindex="0" role="button">
    <div class="asset-visual ${image ? 'has-image' : ''}" ${image ? `style="background-image:url('${escapeHtml(image)}')"` : ''}>
      <span>${escapeHtml(asset.subtype.toUpperCase())}</span><b>${String(index + 1).padStart(2,'0')}</b>
      ${!image ? `<em>${escapeHtml(asset.name.slice(0,2))}</em>` : ''}
    </div>
    <div class="asset-body">
      <h3>${escapeHtml(asset.name)}</h3>
      <p>${escapeHtml(asset.data?.description || '等待补充资产描述与视觉锚点。')}</p>
      <div class="asset-scenes">${sceneLabels.length ? sceneLabels.map(label => `<span>场${escapeHtml(label)}</span>`).join('') : '<span>尚未绑定场次</span>'}</div>
      <footer>${statusTag(asset.status)}<span class="asset-open-label">查看资产 →</span></footer>
    </div>
  </article>`;
  }).join('') : '<div class="empty-state">还没有资产。可以选择角色、场景、道具、风格或声音类别让AI提取，也可以人工新建。</div>';
}

function renderAssetDetail() {
  const host = $('#asset-detail-content');
  const asset = state.data.assets.find(item => item.id === state.selectedAssetId);
  if (!host || !asset) return;
  const sceneIds = recordSceneIds(asset);
  const image = asset.data?.hasImage
    ? `/api/assets/${encodeURIComponent(asset.id)}/image?v=${encodeURIComponent(asset.data.imageUpdatedAt || '')}`
    : (asset.data?.imageUrl || asset.data?.thumbnailUrl || '');
  const comments = state.data.comments.filter(item => item.subtype === 'asset_feedback' && item.data?.assetId === asset.id);
  host.innerHTML = `
    <div class="dialog-head">
      <div><span class="kicker">${escapeHtml(asset.subtype.toUpperCase())} ASSET</span><h2>${escapeHtml(asset.name)}</h2></div>
      <button type="button" data-close-asset aria-label="关闭">×</button>
    </div>
    <div class="asset-detail-layout">
      <section class="asset-detail-media">
        <div class="asset-detail-preview ${image ? 'has-image' : ''}" ${image ? `style="background-image:url('${escapeHtml(image)}')"` : ''}>
          ${image ? '' : `<span>${escapeHtml(asset.name.slice(0,2))}</span><small>尚未上传资产图</small>`}
        </div>
        <div class="asset-media-actions">
          <button type="button" class="secondary-button" data-upload-asset-image>${image ? '替换图片' : '上传图片'}</button>
          ${asset.data?.hasImage ? `<a class="ghost-button" href="/api/assets/${encodeURIComponent(asset.id)}/image?download=1">下载原图</a>` : ''}
        </div>
        <p>${escapeHtml(asset.data?.description || '等待补充资产描述与视觉锚点。')}</p>
        <div class="asset-detail-status">${statusTag(asset.status)}<button type="button" class="text-button" data-approve-asset="${escapeHtml(asset.id)}">${asset.status === 'locked' ? '已锁定' : '确认并锁定'}</button></div>
      </section>
      <section class="asset-detail-workspace">
        <article class="asset-work-block">
          <header><div><span class="kicker">AI PROMPT</span><h3>资产生成提示词</h3></div>
          <button type="button" class="primary-button" data-generate-asset-prompt="${escapeHtml(asset.id)}">${asset.data?.promptZh ? 'AI重新生成' : 'AI生成提示词'}</button></header>
          ${asset.data?.promptZh || asset.data?.promptEn ? `
            <label>中文提示词<textarea readonly>${escapeHtml(asset.data?.promptZh || '')}</textarea></label>
            <label>English Prompt<textarea readonly>${escapeHtml(asset.data?.promptEn || '')}</textarea></label>
            ${asset.data?.negativePrompt ? `<label>负面提示词<textarea readonly>${escapeHtml(asset.data.negativePrompt)}</textarea></label>` : ''}
            <button type="button" class="text-button" data-copy-asset-prompt>复制中文提示词</button>
          ` : '<div class="asset-empty-note">点击“AI生成提示词”，任务会在后台运行，你仍可继续浏览和编辑。</div>'}
        </article>
        <article class="asset-work-block">
          <header><div><span class="kicker">SCENE LINKS</span><h3>出现的场次</h3></div><button type="button" class="secondary-button" data-save-asset-scenes>保存关联</button></header>
          <div class="asset-linked-scenes">${sceneIds.length ? sceneIds.map(id => {
            const scene = state.data.scenes.find(item => item.id === id);
            return scene ? `<button type="button" data-asset-scene-link="${escapeHtml(id)}">场${escapeHtml(scene.data?.displaySceneNo || scene.data?.sceneNo)} · ${escapeHtml(scene.data?.heading || scene.name)} →</button>` : '';
          }).join('') : '<span>尚未关联场次</span>'}</div>
          <div class="asset-scene-picker">${state.data.scenes.map(scene => `
            <label><input type="checkbox" value="${escapeHtml(scene.id)}" ${sceneIds.includes(scene.id) ? 'checked' : ''}>
            <span>场${escapeHtml(scene.data?.displaySceneNo || scene.data?.sceneNo)} · ${escapeHtml(scene.data?.heading || scene.name)}</span></label>`).join('')}</div>
        </article>
        <article class="asset-work-block">
          <header><div><span class="kicker">FEEDBACK</span><h3>资产反馈</h3></div></header>
          <div class="feedback-list">${comments.length ? comments.map(comment => `
            <article class="${comment.data?.resolved ? 'resolved' : ''}"><div><b>${escapeHtml(comment.data?.role || '美术')}</b><span>${formatTime(comment.createdAt)}</span></div>
            <p>${escapeHtml(comment.data?.text || '')}</p>${comment.data?.resolved ? '' : `<button type="button" data-resolve-asset-comment="${escapeHtml(comment.id)}">标记已处理</button>`}</article>`).join('') : '<div class="asset-empty-note">暂无反馈。</div>'}</div>
          <form id="asset-feedback-form"><select name="role"><option>导演</option><option>美术</option><option>制片</option><option>摄影</option></select>
            <textarea name="text" required placeholder="例如：服装材质需要更旧，保持场15中的磨损位置。"></textarea>
            <button class="secondary-button" type="submit">提交反馈</button></form>
        </article>
      </section>
    </div>`;
}

function openAssetDetail(assetId) {
  state.selectedAssetId = assetId;
  renderAssetDetail();
  const dialog = $('#asset-detail-dialog');
  if (!dialog.open) dialog.showModal();
}

function renderStoryboard() {
  const scenes = state.data.scenes;
  $('#storyline-filters').innerHTML = STORY_LINES.map(([line,label]) => {
    const sceneCount = line === 'all'
      ? scenes.length
      : scenes.filter(scene => sceneLines(scene).includes(line)).length;
    const groupCount = line === 'all'
      ? state.data.shotGroups.length
      : state.data.shotGroups.filter(group => (group.data?.lineRefs || []).includes(line)).length;
    return `<button class="chip ${state.sceneLineFilter === line ? 'active' : ''}" data-line-filter="${line}">${label} · ${sceneCount}场 / ${groupCount}组</button>`;
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
    $('#shot-inspector').innerHTML = '<div class="inspector-empty">选择场次后，在这里查看分镜详情。</div>';
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
        <button class="text-button" data-approve="${scene.id}">确认场次</button></div>
    </div>
    <div class="scene-center-grid">
      <div class="scene-line-editor"><label for="scene-primary-line-${escapeHtml(scene.id)}">剧情线路</label>
        <select id="scene-primary-line-${escapeHtml(scene.id)}" data-scene-primary-line="${escapeHtml(scene.id)}">${lineOptions(scene.data?.primaryLine || 'other')}</select>
        <small>${(scene.data?.secondaryLines || []).length ? `同时属于：${scene.data.secondaryLines.map(line => escapeHtml(STORY_LINE_NAMES[line] || line)).join('、')}` : '可在这里直接选择主要线路'}</small>
      </div>
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
  if (groups.length && !groups.some(group => group.id === state.selectedShotGroupId)) {
    state.selectedShotGroupId = groups[0].id;
  }
  $('#shot-list').innerHTML = groups.length ? groups.map(renderShotCard).join('') : '<div class="empty-state">本场还没有15秒分镜组。</div>';
  renderShotInspector();
  renderSceneRail();
  renderContextCommand();
}

function renderShotCard(group) {
  const beats = group.data?.beats || [];
  const colors = group.data?.colorCard || [];
  const hasPrompt = Boolean(group.data?.promptZh || group.data?.promptEn);
  return `<article class="shot-frame ${group.id === state.selectedShotGroupId ? 'selected' : ''}" id="shot-${escapeHtml(group.id)}" data-select-shot="${escapeHtml(group.id)}" tabindex="0">
    <div class="shot-preview">
      <span class="shot-code">${escapeHtml(group.data?.code || '')}</span>
      <b>${escapeHtml(group.data?.duration || 15)}s</b>
      <em>${hasPrompt ? 'PROMPT READY' : 'AI DRAFT'}</em>
      ${colors.length ? `<div class="color-strip">${colors.map(color => `<i style="background:${escapeHtml(color.hex)}" title="${escapeHtml(color.name)}"></i>`).join('')}</div>` : ''}
    </div>
    <div class="shot-frame-body">
      <div class="shot-frame-title"><h3>${escapeHtml(group.data?.title || group.name)}</h3>${statusTag(group.status)}</div>
      <small>${escapeHtml(group.subtype)} · ${escapeHtml(group.data?.mode || 'T2V')} · ${escapeHtml(group.data?.targetModel || '通用')}</small>
      <div class="mini-beats">${beats.length ? beats.slice(0,4).map(beat => `<i title="${escapeHtml(beat.action)}"></i>`).join('') : '<i></i><i></i><i></i>'}</div>
      <div class="scene-line-tags">${(group.data?.lineRefs || []).slice(0,3).map(line => lineTag(line,line === group.data?.primaryLine)).join('')}</div>
    </div>
  </article>`;
}

function renderShotInspector() {
  const panel = $('#shot-inspector');
  if (!panel) return;
  const group = state.data.shotGroups.find(item => item.id === state.selectedShotGroupId);
  if (!group) {
    panel.innerHTML = '<div class="inspector-empty"><span>SHOT INSPECTOR</span><strong>选择一个分镜组</strong><p>提示词、色卡、线路与反馈会在这里集中处理。</p></div>';
    return;
  }
  const scene = state.data.scenes.find(item => item.id === group.data?.sceneId);
  const beats = Array.isArray(group.data?.beats) ? group.data.beats : [];
  const colors = Array.isArray(group.data?.colorCard) ? group.data.colorCard : [];
  const comments = (state.data.comments || []).filter(item => item.data?.shotGroupId === group.id);
  panel.innerHTML = `
    <div class="inspector-head"><span>SHOT INSPECTOR</span><b>${escapeHtml(group.data?.code || '')}</b></div>
    <h2>${escapeHtml(group.data?.title || group.name)}</h2>
    <p class="inspector-meta">场 ${escapeHtml(scene?.data?.displaySceneNo || '—')} · ${group.data?.duration || 15}s · ${escapeHtml(group.data?.mode || 'T2V')}</p>
    <div class="inspector-lines">${(group.data?.lineRefs || []).map(line => lineTag(line,line === group.data?.primaryLine)).join('') || '<span class="status">待分类</span>'}</div>
    <section class="inspector-section">
      <header><span>节奏 / 15秒</span><small>${beats.length} 个动作拍点</small></header>
      <div class="inspector-beats">${beats.length ? beats.map(beat => `<div><b>${escapeHtml(beat.time)}</b><p>${escapeHtml(beat.action)}</p></div>`).join('') : '<p class="muted-copy">尚未生成动作节奏。</p>'}</div>
    </section>
    <section class="inspector-section">
      <header><span>提示词</span><small>${group.data?.promptZh ? '已生成' : '等待生成'}</small></header>
      <p class="prompt-preview">${escapeHtml(group.data?.promptZh || '在保留人物、场景和连续性约束的前提下，由你决定何时调用 AI。')}</p>
      ${colors.length ? `<div class="inspector-palette">${colors.map(color => `<i style="background:${escapeHtml(color.hex)}"><span>${escapeHtml(color.name || color.hex)}</span></i>`).join('')}</div>` : ''}
      <div class="inspector-actions">
        <button data-prompt="${group.id}" class="primary-button">AI生成 / 再生成</button>
        ${colors.length ? `<a href="/api/records/${encodeURIComponent(group.id)}/color-card.svg">下载色卡图片</a>` : ''}
        <button data-copy="${group.id}">复制提示词</button>
        <button data-feedback="${group.id}">展开查看</button>
        <button data-edit-group-lines="${group.id}">编辑线路</button>
        <button data-approve="${group.id}">确认并锁定</button>
      </div>
    </section>
    <section class="inspector-section feedback-section">
      <header><span>时间码反馈</span><small>${comments.filter(item => !item.data?.resolved).length} 条待处理</small></header>
      <div class="feedback-list">${comments.length ? comments.map(comment => `<article class="${comment.data?.resolved ? 'resolved' : ''}">
        <div><b>${escapeHtml(comment.data?.timecode || '00:00')}</b><span>${escapeHtml(comment.data?.role || '导演')}</span></div>
        <p>${escapeHtml(comment.data?.text || comment.name)}</p>
        ${comment.data?.resolved ? '<small>已解决</small>' : `<button data-resolve-comment="${comment.id}">标记解决</button>`}
      </article>`).join('') : '<p class="muted-copy">还没有反馈。评论会固定在本分镜的时间码上。</p>'}</div>
      <form id="feedback-form">
        <div><select name="timecode"><option>00:00</option><option>00:03</option><option>00:06</option><option>00:09</option><option>00:12</option></select>
        <select name="role"><option value="导演">导演</option><option value="制片">制片</option><option value="客户">客户</option><option value="AI建议">AI建议</option></select></div>
        <textarea name="text" rows="2" placeholder="在这个时间点需要调整什么？" required></textarea>
        <button class="secondary-button" type="submit">添加反馈</button>
      </form>
    </section>`;
}

function renderSceneRail() {
  const rail = $('#scene-rail');
  if (!rail || !state.data) return;
  rail.innerHTML = state.data.scenes.length ? state.data.scenes.map(scene => {
    const primary = scene.data?.primaryLine || 'other';
    const count = state.data.shotGroups.filter(group => group.data?.sceneId === scene.id).length;
    return `<button class="rail-scene line-${escapeHtml(primary)} ${scene.id === state.selectedSceneId ? 'active' : ''}" data-rail-scene="${scene.id}" title="${escapeHtml(scene.data?.heading || scene.name)}">
      <b>${escapeHtml(scene.data?.displaySceneNo || scene.data?.sceneNo || '—')}</b><span>${count}</span>
    </button>`;
  }).join('') : '<span class="rail-empty">上传剧本后，全部场次会成为贯穿网站的导航坐标。</span>';
}

function renderContextCommand() {
  const bar = $('#context-command');
  if (!bar || !state.data) return;
  const scene = state.data.scenes.find(item => item.id === state.selectedSceneId);
  const group = state.data.shotGroups.find(item => item.id === state.selectedShotGroupId);
  bar.innerHTML = `<div><span>当前上下文</span><strong>${scene ? `场 ${escapeHtml(scene.data?.displaySceneNo || '')} · ${escapeHtml(scene.data?.heading || scene.name)}` : '项目全局'}${group ? ` / ${escapeHtml(group.data?.code || group.name)}` : ''}</strong></div>
    <div class="command-actions">
      ${group ? '<button data-command="prompt">✦ 生成提示词</button>' : ''}
      ${scene ? '<button data-command="map">↗ 查看关联图谱</button>' : ''}
      <button data-command="audit">◎ 连续性检查</button>
    </div>`;
}

function selectShot(groupId) {
  state.selectedShotGroupId = groupId;
  $$('.shot-frame').forEach(card => card.classList.toggle('selected', card.dataset.selectShot === groupId));
  renderShotInspector();
  renderContextCommand();
  syncRoute();
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
    <small>${escapeHtml((job.data?.targets || []).join(' · ') || job.data?.scope?.range || '项目范围')} · ${escapeHtml(job.data?.scope?.aiProvider || '默认引擎')} · ${formatTime(job.updatedAt)}</small>
    ${job.data?.error ? `<p class="job-error">${escapeHtml(job.data.error)}</p>` : ''}
    ${job.data?.result?.failed?.length ? `<p class="job-warning">部分项目未完成：${escapeHtml(job.data.result.failed.map(item => item.target).join('、'))}</p>` : ''}
    </div>
    ${job.status === 'failed' ? `<button class="job-retry" data-retry-job="${job.id}">重新生成</button>` : ''}
    ${statusTag(job.status)}
  </div>`).join('') : '<div class="empty-state">还没有AI任务。你可以从知识图谱、资产库或分镜工作台按需启动。</div>';
}

function retryJob(jobId) {
  const job = state.data.jobs.find(item => item.id === jobId);
  if (!job) return;
  const scope = { ...(job.data?.scope || {}) };
  delete scope.aiProvider;
  delete scope.aiMode;
  runAI(job.subtype, job.data?.targets || [], scope, `正在重新生成${ACTION_NAMES[job.subtype] || 'AI任务'}`);
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
  state.selectedShotGroupId = groupId || state.data.shotGroups.find(item => item.data?.sceneId === sceneId)?.id || '';
  state.sceneLineFilter = 'all';
  switchView('storyboard');
  renderStoryboard();
  revealSelectedShot();
}

function revealSelectedShot() {
  if (!state.selectedShotGroupId) return;
  requestAnimationFrame(() => document.getElementById(`shot-${state.selectedShotGroupId}`)?.scrollIntoView({ behavior:'smooth', block:'nearest', inline:'center' }));
}

async function runAI(action, targets, scope = {}, title = 'AI正在分析') {
  if (!state.data.ai.configured) {
    toast('请先在服务器环境变量中配置AI API Key。','error');
    return;
  }
  const duplicate = state.data.jobs.find(job => {
    const { aiProvider, aiMode, ...jobScope } = job.data?.scope || {};
    return job.status === 'running'
      && job.subtype === action
      && JSON.stringify(job.data?.targets || []) === JSON.stringify(targets)
      && JSON.stringify(jobScope) === JSON.stringify(scope)
      && (aiMode || 'auto') === state.aiProviderChoice;
  });
  if (duplicate) {
    toast('相同的AI任务已经在后台生成，可在“审阅与版本”查看进度');
    return { job: duplicate };
  }
  try {
    const result = await api(`/api/projects/${encodeURIComponent(state.projectId)}/ai/jobs`, {
      method:'POST', body:JSON.stringify({ action, targets, scope, provider: state.aiProviderChoice })
    });
    state.data.jobs.unshift(result.job);
    state.monitoredJobs.set(result.job.id, { action, status: 'running' });
    syncRunningJobs();
    renderProjectSwitcher();
    renderOverview();
    renderReview();
    toast(`${ACTION_NAMES[action]}已在后台开始生成，你可以继续浏览和操作`);
    return result;
  } catch (error) {
    toast(error.message,'error');
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
  if (state.pendingFiles.length > 12) return toast('一次最多上传 12 个文件','error');
  const oversized = state.pendingFiles.find(file => file.size > 15 * 1024 * 1024);
  if (oversized) return toast(`${oversized.name} 超过 15MB，请压缩或拆分后再上传`,'error');
  const body = new FormData();
  body.append('kind',kind);
  state.pendingFiles.forEach(file => body.append('files',file));
  loading(true,'正在上传资料','准备发送…');
  $('#cancel-upload').hidden = false;
  try {
    await uploadRequest(`/api/projects/${encodeURIComponent(state.projectId)}/files`, body, progress => {
      const percent = progress.total ? Math.min(100, Math.round(progress.loaded / progress.total * 100)) : 0;
      $('#loading-title').textContent = progress.uploaded ? '正在解析并保存资料' : `正在上传资料 ${percent}%`;
      $('#loading-detail').textContent = progress.uploaded
        ? '服务器正在提取文本，复杂 PDF 可能需要几十秒'
        : `${formatSize(progress.loaded)} / ${formatSize(progress.total)}`;
    });
    toast('资料已上传，基础文本解析完成');
    state.pendingFiles = [];
    await bootstrap(true);
    switchView('sources');
  } catch (error) {
    toast(error.name === 'AbortError' ? '上传已取消' : error.message,'error');
  } finally {
    state.activeUpload = null;
    loading(false);
  }
}

function uploadRequest(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    state.activeUpload = xhr;
    xhr.open('POST', url);
    xhr.responseType = 'json';
    xhr.timeout = 120000;
    xhr.upload.onprogress = event => onProgress?.({ loaded:event.loaded, total:event.total, uploaded:false });
    xhr.upload.onload = () => onProgress?.({ loaded:1, total:1, uploaded:true });
    xhr.onload = () => {
      const payload = xhr.response || (() => { try { return JSON.parse(xhr.responseText); } catch { return {}; } })();
      if (xhr.status >= 200 && xhr.status < 300) return resolve(payload);
      reject(new Error(payload?.error || `上传失败 HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('网络连接中断，请检查网络后重试。'));
    xhr.ontimeout = () => reject(new Error('上传或解析超过 2 分钟，请拆分文件后重试。'));
    xhr.onabort = () => reject(new DOMException('上传已取消','AbortError'));
    xhr.send(body);
  });
}

function bindEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click',() => switchView(button.dataset.view)));
  $$('[data-go]').forEach(button => button.addEventListener('click',() => switchView(button.dataset.go)));
  $('#mobile-menu').addEventListener('click',() => $('#sidebar').classList.toggle('open'));
  $('#ai-status').addEventListener('click',() => switchView('review'));
  $('#ai-provider-select').addEventListener('change',event => {
    state.aiProviderChoice = event.target.value;
    localStorage.setItem('aigc-ai-provider', state.aiProviderChoice);
    const label = event.target.selectedOptions[0]?.textContent || state.aiProviderChoice;
    toast(`后续AI任务将使用：${label}`);
  });
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
    const card = event.target.closest('[data-open-asset]');
    if (card) openAssetDetail(card.dataset.openAsset);
  });
  $('#asset-grid').addEventListener('keydown',event => {
    const card = event.target.closest('[data-open-asset]');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openAssetDetail(card.dataset.openAsset);
    }
  });
  $('#asset-grid').addEventListener('mouseover',event => {
    const card = event.target.closest('[data-asset-scenes]');
    if (!card) return;
    const ids = card.dataset.assetScenes.split(',').filter(Boolean);
    $$('.rail-scene').forEach(button => button.classList.toggle('related',ids.includes(button.dataset.railScene)));
  });
  $('#asset-grid').addEventListener('mouseout',event => {
    if (event.relatedTarget?.closest?.('[data-asset-scenes]') === event.target.closest('[data-asset-scenes]')) return;
    $$('.rail-scene.related').forEach(button => button.classList.remove('related'));
  });
  $('#asset-detail-dialog').addEventListener('click',async event => {
    if (event.target.closest('[data-close-asset]')) return $('#asset-detail-dialog').close();
    if (event.target.closest('[data-upload-asset-image]')) return $('#asset-image-input').click();
    const generate = event.target.closest('[data-generate-asset-prompt]');
    if (generate) return runAI('asset_prompt',[generate.dataset.generateAssetPrompt],{assetId:generate.dataset.generateAssetPrompt},'正在生成资产提示词');
    const approve = event.target.closest('[data-approve-asset]');
    if (approve) {
      await approveRecord(approve.dataset.approveAsset,'locked');
      return renderAssetDetail();
    }
    const sceneLink = event.target.closest('[data-asset-scene-link]');
    if (sceneLink) {
      $('#asset-detail-dialog').close();
      return jumpToScene(sceneLink.dataset.assetSceneLink);
    }
    if (event.target.closest('[data-copy-asset-prompt]')) {
      const asset = state.data.assets.find(item => item.id === state.selectedAssetId);
      if (asset?.data?.promptZh) {
        await navigator.clipboard.writeText(asset.data.promptZh);
        toast('资产中文提示词已复制');
      }
      return;
    }
    if (event.target.closest('[data-save-asset-scenes]')) {
      const sceneIds = [...$('#asset-detail-content').querySelectorAll('.asset-scene-picker input:checked')].map(input => input.value);
      const sceneRefs = sceneIds.map(id => {
        const scene = state.data.scenes.find(item => item.id === id);
        return {
          sceneId:id,
          sceneNo:scene?.data?.sceneNo || '',
          sceneRef:scene?.data?.sceneRef || '',
          heading:scene?.data?.heading || ''
        };
      });
      try {
        await api(`/api/records/${encodeURIComponent(state.selectedAssetId)}`,{method:'PATCH',body:JSON.stringify({status:'review',data:{sceneRefs}})});
        await bootstrap(true);
        renderAssetDetail();
        toast('资产场次关联已保存');
      } catch (error) { toast(error.message,'error'); }
      return;
    }
    const resolve = event.target.closest('[data-resolve-asset-comment]');
    if (resolve) {
      try {
        await api(`/api/records/${encodeURIComponent(resolve.dataset.resolveAssetComment)}`,{method:'PATCH',body:JSON.stringify({status:'approved',data:{resolved:true}})});
        await bootstrap(true);
        renderAssetDetail();
        toast('资产反馈已标记解决');
      } catch (error) { toast(error.message,'error'); }
    }
  });
  $('#asset-detail-dialog').addEventListener('submit',async event => {
    if (event.target.id !== 'asset-feedback-form') return;
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api(`/api/projects/${encodeURIComponent(state.projectId)}/records`,{
        method:'POST',
        body:JSON.stringify({
          kind:'comment',subtype:'asset_feedback',name:'资产反馈',status:'review',
          data:{assetId:state.selectedAssetId,role:form.get('role'),text:form.get('text'),resolved:false}
        })
      });
      await bootstrap(true);
      renderAssetDetail();
      toast('资产反馈已添加');
    } catch (error) { toast(error.message,'error'); }
  });
  $('#asset-image-input').addEventListener('change',async event => {
    const file = event.target.files?.[0];
    if (!file || !state.selectedAssetId) return;
    const form = new FormData();
    form.append('image',file);
    try {
      await api(`/api/assets/${encodeURIComponent(state.selectedAssetId)}/image`,{method:'POST',body:form});
      await bootstrap(true);
      renderAssetDetail();
      toast('资产图片已上传');
    } catch (error) { toast(error.message,'error'); }
    finally { event.target.value = ''; }
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
    const analysisLink = event.target.closest('[data-open-analysis]');
    if (analysisLink) {
      state.selectedAnalysisType = analysisLink.dataset.openAnalysis;
      switchView('knowledge');
      renderKnowledgeDetail();
      $('#knowledge-detail').scrollIntoView({ behavior:'smooth', block:'start' });
    }
  });
  $('#scene-detail').addEventListener('change',event => {
    const select = event.target.closest('[data-scene-primary-line]');
    if (select) updateScenePrimaryLine(select.dataset.scenePrimaryLine,select.value);
  });
  $('#shot-list').addEventListener('click',event => {
    const shot = event.target.closest('[data-select-shot]');
    if (shot) return selectShot(shot.dataset.selectShot);
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
  $('#shot-list').addEventListener('keydown',event => {
    const shot = event.target.closest('[data-select-shot]');
    if (shot && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      selectShot(shot.dataset.selectShot);
    }
  });
  $('#shot-inspector').addEventListener('click',async event => {
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
    const resolve = event.target.closest('[data-resolve-comment]');
    if (!resolve) return;
    try {
      await api(`/api/records/${encodeURIComponent(resolve.dataset.resolveComment)}`,{
        method:'PATCH',body:JSON.stringify({status:'approved',data:{resolved:true}})
      });
      await bootstrap(true);
      toast('反馈已标记解决');
    } catch (error) { toast(error.message,'error'); }
  });
  $('#shot-inspector').addEventListener('submit',async event => {
    if (event.target.id !== 'feedback-form') return;
    event.preventDefault();
    const group = state.data.shotGroups.find(item => item.id === state.selectedShotGroupId);
    if (!group) return;
    const form = new FormData(event.target);
    try {
      await api(`/api/projects/${encodeURIComponent(state.projectId)}/records`,{
        method:'POST',
        body:JSON.stringify({
          kind:'comment',subtype:'shot_feedback',name:'时间码反馈',status:'review',
          data:{
            sceneId:group.data?.sceneId,shotGroupId:group.id,
            timecode:form.get('timecode'),role:form.get('role'),
            text:form.get('text'),resolved:false
          }
        })
      });
      await bootstrap(true);
      toast('时间码反馈已添加');
    } catch (error) { toast(error.message,'error'); }
  });
  $('#scene-rail').addEventListener('click',event => {
    const button = event.target.closest('[data-rail-scene]');
    if (button) jumpToScene(button.dataset.railScene);
  });
  $('#rail-toggle').addEventListener('click',() => {
    const shell = $('#scene-rail-shell');
    shell.classList.toggle('collapsed');
    $('#rail-toggle').textContent = shell.classList.contains('collapsed') ? '⌃' : '⌄';
  });
  $('#context-command').addEventListener('click',event => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    if (button.dataset.command === 'prompt' && state.selectedShotGroupId) return openPromptDialog(state.selectedShotGroupId);
    if (button.dataset.command === 'map') {
      switchView('knowledge');
      return renderKnowledgeDetail();
    }
    if (button.dataset.command === 'audit') {
      return runAI('audit',['continuity','axis','action_density','light','prompt_compatibility'],{},'正在检查分镜连续性');
    }
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
  $('#cancel-upload').addEventListener('click',() => state.activeUpload?.abort());
  $('#refresh-button').addEventListener('click',() => bootstrap());
  ['#job-list','#recent-jobs'].forEach(selector => $(selector)?.addEventListener('click',event => {
    const button = event.target.closest('[data-retry-job]');
    if (button) retryJob(button.dataset.retryJob);
  }));
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

async function updateScenePrimaryLine(sceneId, primary) {
  const scene = state.data.scenes.find(item => item.id === sceneId);
  if (!scene) return;
  if (!STORY_LINE_NAMES[primary] || primary === 'all') return toast('主要线路值不正确','error');
  const secondaryLines = (scene.data?.secondaryLines || []).filter(line => line !== primary);
  try {
    await api(`/api/records/${encodeURIComponent(sceneId)}`,{
      method:'PATCH',
      body:JSON.stringify({ status:'review', data:{ primaryLine:primary, secondaryLines, primaryLineSource:'manual' } })
    });
    await bootstrap(true);
    toast(`场次已设为${STORY_LINE_NAMES[primary]}，图谱与分镜筛选会使用这一人工选择`);
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
