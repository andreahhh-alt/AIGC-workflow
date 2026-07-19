const assert = require('assert');

process.env.AI_PROVIDER = 'kimi';
process.env.AI_MODEL = 'kimi-k3';
process.env.MOONSHOT_API_KEY = 'test-moonshot-key';
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

const { provider, apiKey, model, aiBaseUrl, callAI } = require('../server');

(async () => {
  assert.equal(provider(), 'kimi');
  assert.equal(apiKey(), 'test-moonshot-key');
  assert.equal(model(), 'kimi-k3');
  assert.equal(aiBaseUrl(), 'https://api.moonshot.cn/v1');

  const result = await callAI('系统指令', '用户请求');
  assert.equal(result, '{"ok":true}');
  assert.equal(captured.url, 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(captured.options.headers.authorization, 'Bearer test-moonshot-key');
  assert.equal(captured.body.model, 'kimi-k3');
  assert.deepEqual(captured.body.messages, [
    { role: 'system', content: '系统指令' },
    { role: 'user', content: '用户请求' }
  ]);

  console.log(JSON.stringify({
    ok: true,
    provider: provider(),
    model: model(),
    endpoint: captured.url
  }));
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
