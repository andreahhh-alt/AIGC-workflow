const { spawn } = require('child_process');

const port = 3210;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    RENDER: 'true',
    DATABASE_URL: '',
    AI_PROVIDER: 'kimi',
    AI_MODEL: 'kimi-k3',
    ADMIN_PASSWORD: 'test-admin',
    MOONSHOT_API_KEY: 'test-key',
    AI_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    ANTHROPIC_API_KEY: ''
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', chunk => { stderr += chunk.toString(); });

const waitForServer = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/workflow/bootstrap`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`服务器未就绪：${stderr}`);
};

const jsonRequest = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  return payload;
};

(async () => {
  try {
    const bootstrap = await waitForServer();
    if (!bootstrap.project?.id) throw new Error('缺少种子项目');
    if (!bootstrap.ai?.configured || bootstrap.ai.provider !== 'kimi' || bootstrap.ai.model !== 'kimi-k3') {
      throw new Error('Kimi 提供商环境变量未生效');
    }
    if (
      !bootstrap.ai.providers?.find(item => item.id === 'kimi' && item.configured)
      || bootstrap.ai.providers?.find(item => item.id === 'deepseek')?.configured
    ) {
      throw new Error('AI 提供商可用状态不正确');
    }
    if (bootstrap.jobs?.some(job => job.status === 'running')) {
      throw new Error('服务重启后仍有遗留的运行中 AI 任务');
    }
    const migratedLegacyScene = bootstrap.scenes.find(item => item.id === 'scene_7');
    if (migratedLegacyScene && (!migratedLegacyScene.data?.sceneRef || migratedLegacyScene.data?.primaryLine !== 'male')) {
      throw new Error('旧场次数据迁移失败');
    }
    const pageResponse = await fetch(base);
    const pageHtml = await pageResponse.text();
    const workflowJs = await (await fetch(`${base}/workflow.js`)).text();
    if (
      !pageResponse.ok
      || !pageHtml.includes('storyline-filters')
      || !pageHtml.includes('knowledge-detail')
      || !pageHtml.includes('scene-rail')
      || !pageHtml.includes('shot-inspector')
      || !pageHtml.includes('asset-detail-dialog')
      || !workflowJs.includes('data-scene-primary-line')
      || !workflowJs.includes('downloadColorCard')
      || !workflowJs.includes('structured-prompt-card')
      || (pageHtml.match(/data-dialog-close/g) || []).length < 8
      || !workflowJs.includes("closest('[data-dialog-close]')")
      || !workflowJs.includes('data-dialog-close aria-label')
      || pageHtml.includes('<button value="cancel"')
      || workflowJs.includes('data-close-asset')
      || workflowJs.includes('data-edit-lines')
      || pageHtml.includes('href="/legacy"')
      || !Array.isArray(bootstrap.comments)
    ) {
      throw new Error('跨模块导航界面未加载');
    }

    const projectId = bootstrap.project.id;
    const form = new FormData();
    form.append('files', new Blob(['第1场 日 内景\\n林默走进工作室。']), '冒烟剧本.txt');
    form.append('kind', 'script');
    const uploadResponse = await fetch(`${base}/api/projects/${projectId}/files`, {
      method: 'POST',
      body: form,
      headers: { 'x-forwarded-for': '203.0.113.10' }
    });
    if (!uploadResponse.ok) throw new Error(`上传失败：${uploadResponse.status}`);
    const uploaded = await uploadResponse.json();

    const oversizedForm = new FormData();
    oversizedForm.append('files', new Blob([new Uint8Array(15 * 1024 * 1024 + 1)]), 'oversized.txt');
    oversizedForm.append('kind', 'document');
    const oversizedResponse = await fetch(`${base}/api/projects/${projectId}/files`, {
      method: 'POST',
      body: oversizedForm,
      headers: { 'x-forwarded-for': '203.0.113.10' }
    });
    const oversizedPayload = await oversizedResponse.json();

    const created = await jsonRequest(`${base}/api/projects/${projectId}/records`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'asset',
        subtype: 'prop',
        name: '测试道具',
        data: { description: '冒烟测试记录' }
      })
    });

    const approved = await jsonRequest(`${base}/api/records/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' })
    });
    const assetImageForm = new FormData();
    const pngBytes = Uint8Array.from([
      137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,
      0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137
    ]);
    assetImageForm.append('image', new Blob([pngBytes], { type:'image/png' }), '测试资产图.png');
    const assetImageUploadResponse = await fetch(`${base}/api/assets/${created.id}/image`, {
      method:'POST',
      body:assetImageForm,
      headers:{'x-forwarded-for':'203.0.113.10'}
    });
    const assetWithImage = await assetImageUploadResponse.json();
    const assetImageResponse = await fetch(`${base}/api/assets/${created.id}/image`);
    const downloadedAssetImage = new Uint8Array(await assetImageResponse.arrayBuffer());
    const assetDownloadResponse = await fetch(`${base}/api/assets/${created.id}/image?download=1`);

    const manualScene = await jsonRequest(`${base}/api/projects/${projectId}/records`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'scene',
        subtype: 'script_scene',
        name: '测试场次',
        data: { sceneNo: 'T1', primaryLine: 'male', secondaryLines: [] }
      })
    });
    const manualGroup = await jsonRequest(`${base}/api/projects/${projectId}/records`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'shot_group',
        subtype: 'D-1',
        name: 'T1-1 测试分镜',
        data: { code: 'T1-1', sceneId: manualScene.id, primaryLine: 'male', lineRefs: ['male'] }
      })
    });
    await jsonRequest(`${base}/api/records/${manualGroup.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          colorCard: [
            { name: '冷青', hex: '#6EC6CC' },
            { name: '警示琥珀', hex: '#E49A45' }
          ]
        }
      })
    });
    const colorCardResponse = await fetch(`${base}/api/records/${manualGroup.id}/color-card.svg`);
    const colorCardSvg = await colorCardResponse.text();
    const comment = await jsonRequest(`${base}/api/projects/${projectId}/records`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'comment',
        subtype: 'shot_feedback',
        name: '时间码反馈',
        status: 'review',
        data: {
          sceneId: manualScene.id,
          shotGroupId: manualGroup.id,
          timecode: '00:06',
          role: '导演',
          text: '动作转折提前。',
          resolved: false
        }
      })
    });
    const resolvedComment = await jsonRequest(`${base}/api/records/${comment.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved', data: { resolved: true } })
    });
    const updatedManualScene = await jsonRequest(`${base}/api/records/${manualScene.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'review',
        data: { primaryLine: 'female', secondaryLines: ['romance'] }
      })
    });
    const linkedBootstrap = await jsonRequest(`${base}/api/workflow/bootstrap?projectId=${projectId}`);
    const inheritedGroup = linkedBootstrap.shotGroups.find(item => item.id === manualGroup.id);
    const jobStartedAt = Date.now();
    const jobResponse = await fetch(`${base}/api/projects/${projectId}/ai/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'prompt',
        targets: [manualGroup.id],
        scope: {
          shotGroupId: manualGroup.id,
          fields: ['prompt'],
          targetModel: 'general',
          mode: 't2v'
        }
      })
    });
    const queuedJob = await jobResponse.json();
    const jobSubmissionMs = Date.now() - jobStartedAt;
    const maintenanceStartResponse = await fetch(`${base}/api/deployment/maintenance`, {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-admin-password':'test-admin' },
      body:JSON.stringify({ active:true, message:'测试维护模式' })
    });
    const maintenanceState = await maintenanceStartResponse.json();
    const blockedDuringMaintenance = await fetch(`${base}/api/projects`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ name:'维护期间不应创建' })
    });
    const blockedPayload = await blockedDuringMaintenance.json();
    await fetch(`${base}/api/deployment/maintenance`, {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-admin-password':'test-admin' },
      body:JSON.stringify({ active:false })
    });

    if (
      uploaded.files?.length !== 1
      || uploaded.files?.[0]?.name !== '冒烟剧本.txt'
      || uploaded.files?.[0]?.subtype !== 'script'
      || !colorCardResponse.ok
      || !colorCardResponse.headers.get('content-disposition')?.includes('attachment')
      || !colorCardSvg.includes('<svg')
      || !colorCardSvg.includes('#6EC6CC')
      || !colorCardSvg.includes('1个15秒分镜共用')
      || approved.status !== 'approved'
      || !assetImageUploadResponse.ok
      || assetWithImage.data?.hasImage !== true
      || assetImageResponse.headers.get('content-type') !== 'image/png'
      || downloadedAssetImage.length !== pngBytes.length
      || !assetDownloadResponse.headers.get('content-disposition')?.includes('attachment')
      || inheritedGroup?.data?.primaryLine !== 'female'
      || !inheritedGroup?.data?.lineRefs?.includes('romance')
      || inheritedGroup?.data?.shots?.length !== 1
      || inheritedGroup?.data?.shots?.[0]?.duration !== 15
      || updatedManualScene.data?.primaryLineSource !== 'manual'
      || resolvedComment.data?.timecode !== '00:06'
      || resolvedComment.data?.resolved !== true
      || oversizedResponse.status !== 413
      || !oversizedPayload.error?.includes('15MB')
      || stderr.includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR')
      || jobResponse.status !== 202
      || queuedJob.job?.status !== 'running'
      || queuedJob.job?.data?.scope?.aiProvider !== 'kimi'
      || jobSubmissionMs > 1500
      || !maintenanceStartResponse.ok
      || maintenanceState.active !== true
      || blockedDuringMaintenance.status !== 503
      || blockedPayload.code !== 'DEPLOYMENT_MAINTENANCE'
    ) {
      throw new Error('核心工作流断言失败');
    }

    console.log(JSON.stringify({
      ok: true,
      project: bootstrap.project.name,
      seedRecords: [
        bootstrap.files,
        bootstrap.analyses,
        bootstrap.assets,
        bootstrap.scenes,
        bootstrap.shotGroups,
        bootstrap.jobs
      ].flat().length,
      upload: uploaded.files[0].name,
      manualRecordStatus: approved.status,
      sceneLinePropagation: inheritedGroup.data.lineRefs,
      assetImageRoundTrip: downloadedAssetImage.length,
      timecodedFeedback: resolvedComment.data.timecode,
      oversizedUploadStatus: oversizedResponse.status,
      proxyValidationClean: true,
      backgroundJobStatus: jobResponse.status,
      backgroundJobSubmissionMs: jobSubmissionMs,
      aiProvider: bootstrap.ai.provider,
      aiModel: bootstrap.ai.model,
      deploymentMaintenanceProtected: true
    }));
  } finally {
    child.kill();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
