const assert = require('assert');
const { normalizeSceneData, linkAnalysisData } = require('../server');

const project = { data: { scriptVersion: 'test-v1' } };
const scene21AData = normalizeSceneData('test-project', {
  sceneNo: '21',
  heading: '客厅',
  primaryLine: 'female',
  secondaryLines: ['romance'],
  events: [{ label: '女主作出选择', type: 'choice' }]
}, project, { occurrence: 1, duplicateSceneNo: true, sceneIndex: 21 });
const scene21BData = normalizeSceneData('test-project', {
  sceneNo: '21',
  heading: '隧道',
  primaryLine: 'male',
  events: [{ label: '男主进入隧道', type: 'action' }]
}, project, { occurrence: 2, duplicateSceneNo: true, sceneIndex: 22 });

assert.notStrictEqual(scene21AData.sceneId, scene21BData.sceneId);
assert.strictEqual(scene21AData.displaySceneNo, '21A');
assert.strictEqual(scene21BData.displaySceneNo, '21B');

const linked = linkAnalysisData({
  nodes: [
    { id: 'node-a', label: '女主选择', sceneRefs: [{ sceneNo: '21', sceneRef: '21#1' }] },
    { id: 'node-b', label: '模糊节点', sceneRefs: [{ sceneNo: '21' }] }
  ]
}, [
  { id: scene21AData.sceneId, data: scene21AData },
  { id: scene21BData.sceneId, data: scene21BData }
]);

assert.strictEqual(linked.nodes[0].sceneRefs[0].sceneId, scene21AData.sceneId);
assert.strictEqual(linked.nodes[1].sceneRefs[0].ambiguous, true);
assert.strictEqual(linked.nodes[1].sceneRefs[0].candidateSceneIds.length, 2);

console.log(JSON.stringify({
  ok: true,
  stableIds: 2,
  explicitLinkResolved: true,
  ambiguousLinkBlocked: true
}));
