const assert = require('assert');
const { normalizeSceneData, linkAnalysisData, mergeSceneLineMembership, normalizeGroupShots } = require('../server');

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
const scene14Data = normalizeSceneData('test-project', {
  sceneNo: '第14场',
  heading: '冬派苏醒',
  primaryLine: 'female'
}, project, { occurrence: 1, duplicateSceneNo: false, sceneIndex: 14 });

assert.notStrictEqual(scene21AData.sceneId, scene21BData.sceneId);
assert.strictEqual(scene21AData.displaySceneNo, '21A');
assert.strictEqual(scene21BData.displaySceneNo, '21B');
assert.strictEqual(scene14Data.sceneNo, '14');

const linked = linkAnalysisData({
  nodes: [
    { id: 'node-a', label: '女主选择', sceneRefs: [{ sceneNo: '21', sceneRef: '21#1' }] },
    { id: 'node-b', label: '模糊节点', sceneRefs: [{ sceneNo: '21' }] },
    { id: 'node-c', label: '冬派苏醒', sourceRefs: ['最新剧本.docx/场14'] }
  ]
}, [
  { id: scene21AData.sceneId, data: scene21AData },
  { id: scene21BData.sceneId, data: scene21BData },
  { id: scene14Data.sceneId, data: scene14Data }
]);

assert.strictEqual(linked.nodes[0].sceneRefs[0].sceneId, scene21AData.sceneId);
assert.strictEqual(linked.nodes[1].sceneRefs[0].ambiguous, true);
assert.strictEqual(linked.nodes[1].sceneRefs[0].candidateSceneIds.length, 2);
assert.strictEqual(linked.nodes[2].sceneRefs[0].sceneId, scene14Data.sceneId);

const femaleFromGraph = mergeSceneLineMembership({
  primaryLine: 'other',
  secondaryLines: []
}, ['female']);
assert.strictEqual(femaleFromGraph.primaryLine, 'female');
assert.deepStrictEqual(femaleFromGraph.analysisLineMemberships, ['female']);

const ensembleFromGraphs = mergeSceneLineMembership({
  primaryLine: 'other',
  secondaryLines: []
}, ['male', 'female']);
assert.strictEqual(ensembleFromGraphs.primaryLine, 'ensemble');
assert(ensembleFromGraphs.secondaryLines.includes('male'));
assert(ensembleFromGraphs.secondaryLines.includes('female'));

const manualChoicePreserved = mergeSceneLineMembership({
  primaryLine: 'male',
  primaryLineSource: 'manual',
  secondaryLines: []
}, ['female']);
assert.strictEqual(manualChoicePreserved.primaryLine, 'male');
assert(manualChoicePreserved.secondaryLines.includes('female'));

const migratedGroupShots = normalizeGroupShots({
  code:'14-G1',
  title:'旧版分镜',
  duration:15,
  beats:[{time:'0-4s',action:'建立空间'}]
});
assert.strictEqual(migratedGroupShots.length, 1);
assert.strictEqual(migratedGroupShots[0].code, '14-G1-S1');
assert.strictEqual(migratedGroupShots[0].duration, 15);

const multiShotGroup = normalizeGroupShots({
  code:'14-G2',
  shots:[
    {code:'14-G2-S1',duration:9,title:'建立'},
    {code:'14-G2-S2',duration:22,title:'反应'}
  ]
});
assert.strictEqual(multiShotGroup.length, 2);
assert(multiShotGroup.every(shot => shot.duration === 15));

console.log(JSON.stringify({
  ok: true,
  stableIds: 2,
  explicitLinkResolved: true,
  ambiguousLinkBlocked: true,
  chineseSceneReferenceResolved: true,
  graphLineMembershipSynced: true,
  manualLineChoicePreserved: true,
  shotGroupHierarchyNormalized: true
}));
