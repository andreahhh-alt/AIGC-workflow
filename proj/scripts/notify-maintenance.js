const baseUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.MAINTENANCE_URL || '').replace(/\/+$/, '');
const token = process.env.MAINTENANCE_TOKEN || process.env.ADMIN_PASSWORD || '';
const targetCommit = process.env.RENDER_GIT_COMMIT || '';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

(async () => {
  if (!baseUrl || !token || !targetCommit) {
    console.log('Maintenance notice skipped outside a Render deployment.');
    return;
  }
  try {
    let status = await request('/api/deployment/maintenance', {
      method:'POST',
      headers:{ 'content-type':'application/json', 'x-maintenance-token':token },
      body:JSON.stringify({
        active:true,
        targetCommit,
        message:'网站正在更新到新版本。为保护正在生成的内容，更新期间暂时停止操作。'
      })
    });
    console.log(`Maintenance mode enabled; ${status.runningJobs || 0} AI job(s) still running.`);

    const deadline = Date.now() + 8 * 60 * 1000;
    while (status.runningJobs > 0 && Date.now() < deadline) {
      await wait(10000);
      status = await request('/api/deployment/status');
      console.log(`Waiting for ${status.runningJobs || 0} AI job(s) before deployment.`);
    }
    if (status.runningJobs > 0) {
      console.log('Maintenance wait reached 8 minutes; deployment will continue with recovery safeguards.');
    }
  } catch (error) {
    // The first deployment of this feature reaches an older instance without
    // the maintenance endpoint. Future deployments use it automatically.
    console.log(`Maintenance notice unavailable: ${error.message}`);
  }
})();
