const assert = require('assert');

process.env.AI_PROVIDER = 'kimi';
process.env.AI_MODEL = 'kimi-k3';
process.env.MOONSHOT_API_KEY = '  "Bearer test-moonshot-key"  ';
process.env.KIMI_BASE_URL = 'https://api.moonshot.cn/v1/';

let captured;
global.fetch = async (url, options) => {
  captured = { url, options, body: JSON.parse(options.body) };
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] });
    }
  };
};

const {
  provider,
  apiKey,
  model,
  aiBaseUrl,
  callAI,
  WORKFLOW_SCHEMA_MIGRATIONS
} = require('../server');

(async () => {
  assert.equal(provider(), 'kimi');
  assert.equal(apiKey(), 'test-moonshot-key');
  assert.equal(model(), 'kimi-k3');
  assert.equal(aiBaseUrl(), 'https://api.moonshot.cn/v1');
  assert(
    WORKFLOW_SCHEMA_MIGRATIONS.some(sql => /sort_order TYPE bigint/i.test(sql)),
    'Postgres sort_order 必须迁移为 bigint，才能保存毫秒时间戳'
  );

  const result = await callAI('系统指令', '用户请求');
  assert.equal(result, '{"ok":true}');
  assert.equal(captured.url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(captured.options.headers.authorization, 'Bearer test-moonshot-key');
  assert.equal(captured.body.model, 'kimi-k3');
  assert.equal(captured.body.reasoning_effort, 'max');
  assert.equal(captured.body.max_completion_tokens, 6000);
  assert.equal(captured.body.max_tokens, undefined);
  assert.deepEqual(captured.body.messages, [
    { role: 'system', content: '系统指令' },
    { role: 'user', content: '用户请求' }
  ]);

  console.log(JSON.stringify({
    ok: true,
    provider: provider(),
    model: model(),
    endpoint: captured.url,
    postgresSortOrder: 'bigint'
  }));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
