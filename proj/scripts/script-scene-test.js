const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const { normalizeSceneData, linkAnalysisData, parseScriptSceneBlocks } = require('../server');

const input = process.argv[2] || path.resolve(__dirname, '..', '..', '..', '最新剧本.docx');

const scenePatterns = [
  /^场\s*(\d+(?:[-.]\d+)?)\s*[：:·.\s-]*(.*)$/u,
  /^(?:第\s*)?(\d+(?:[-.]\d+)?)\s*场(?:次)?\s*[：:·.\s-]*(.+)$/u,
  /^(\d+(?:[-.]\d+)?)\s*[.．、]\s*((?:内|外|内外)景.+)$/u,
  /^(\d+(?:[-.]\d+)?)\s+((?:内|外|内外)景.+)$/u
];

function detectSceneHeadings(text) {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const headings = [];
  for (const [index, line] of lines.entries()) {
    for (const pattern of scenePatterns) {
      const match = line.match(pattern);
      if (!match) continue;
      headings.push({
        sceneNo: match[1],
        heading: match[2].trim(),
        lineNumber: index + 1,
        sourceLine: line
      });
      break;
    }
  }
  return { lines, headings };
}

(async () => {
  if (!fs.existsSync(input)) throw new Error(`找不到剧本：${input}`);
  const { value } = await mammoth.extractRawText({ path: input });
  const { lines, headings } = detectSceneHeadings(value);
  const serverParsedScenes = parseScriptSceneBlocks(value, path.basename(input));
  if (!value.trim()) throw new Error('剧本文本提取为空');
  if (!headings.length) {
    console.error(JSON.stringify({ sampleLines: lines.slice(0, 120) }, null, 2));
    throw new Error('未识别到场次标题，请检查场次格式');
  }

  const uniqueSceneNos = new Set(headings.map(item => item.sceneNo));
  if (serverParsedScenes.length !== headings.length) {
    throw new Error(`服务端场次解析数量不一致：测试=${headings.length}，服务端=${serverParsedScenes.length}`);
  }
  const counts = headings.reduce((map, item) => map.set(item.sceneNo, (map.get(item.sceneNo) || 0) + 1), new Map());
  const occurrences = new Map();
  const linkedHeadings = headings.map(item => {
    const occurrence = (occurrences.get(item.sceneNo) || 0) + 1;
    occurrences.set(item.sceneNo, occurrence);
    const conflict = counts.get(item.sceneNo) > 1;
    return {
      ...item,
      sceneRef: `${item.sceneNo}#${occurrence}`,
      displaySceneNo: conflict ? `${item.sceneNo}${String.fromCharCode(64 + occurrence)}` : item.sceneNo,
      numberingConflict: conflict
    };
  });
  const conflicts = linkedHeadings.filter(item => item.numberingConflict);
  const mockProject = { data: { scriptVersion: 'latest-test' } };
  const normalizedScenes = linkedHeadings.map((item, index) => {
    const normalized = normalizeSceneData('script-test', {
      sceneNo: item.sceneNo,
      sceneIndex: index + 1,
      heading: item.heading,
      primaryLine: index % 3 === 0 ? 'female' : 'male',
      secondaryLines: index % 5 === 0 ? ['romance'] : [],
      events: [{ label: `场${item.displaySceneNo}测试事件`, type: 'action' }]
    }, mockProject, {
      occurrence: Number(item.sceneRef.split('#')[1]),
      duplicateSceneNo: item.numberingConflict,
      sceneIndex: index + 1
    });
    return { id: normalized.sceneId, data: normalized };
  });
  if (new Set(normalizedScenes.map(scene => scene.id)).size !== normalizedScenes.length) {
    throw new Error('稳定场次ID发生冲突');
  }

  const explicitConflict = conflicts[0];
  const graph = linkAnalysisData({
    nodes: [
      { id: 'first', label: '首场', sceneRefs: [{ sceneNo: linkedHeadings[0].sceneNo, sceneRef: linkedHeadings[0].sceneRef }] },
      { id: 'conflict-explicit', label: '重复号精确链接', sceneRefs: [{ sceneNo: explicitConflict.sceneNo, sceneRef: explicitConflict.sceneRef }] },
      { id: 'conflict-ambiguous', label: '重复号模糊链接', sceneRefs: [{ sceneNo: explicitConflict.sceneNo }] }
    ]
  }, normalizedScenes);
  const explicitLinked = graph.nodes[1].sceneRefs[0];
  const ambiguousLink = graph.nodes[2].sceneRefs[0];
  if (!explicitLinked.sceneId || !ambiguousLink.ambiguous) {
    throw new Error('知识图谱场次链接断言失败');
  }

  console.log(JSON.stringify({
    ok: true,
    file: path.basename(input),
    characters: value.length,
    nonEmptyLines: lines.length,
    scenes: linkedHeadings.length,
    uniqueSceneNumbers: uniqueSceneNos.size,
    numberingConflictGroups: [...counts.values()].filter(count => count > 1).length,
    stableSceneIds: normalizedScenes.length,
    serverParsedScenes: serverParsedScenes.length,
    graphLinking: {
      linkedSceneCount: graph.linkedSceneCount,
      explicitDuplicateResolved: !!explicitLinked.sceneId,
      ambiguousDuplicateBlocked: ambiguousLink.ambiguous
    },
    conflicts,
    firstScene: linkedHeadings[0],
    lastScene: linkedHeadings.at(-1),
    sample: linkedHeadings.slice(0, 8)
  }, null, 2));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
