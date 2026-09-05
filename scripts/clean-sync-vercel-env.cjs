const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Read environment variables dynamically from .env.local or process.env
const envLocalPath = path.resolve(__dirname, '../.env.local');
const localEnv = {};

if (fs.existsSync(envLocalPath)) {
  const content = fs.readFileSync(envLocalPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      localEnv[k] = v;
    }
  }
}

const keysToSync = [
  'NEXT_PUBLIC_AGORA_APP_ID',
  'NEXT_AGORA_APP_CERTIFICATE',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SLACK_WEBHOOK_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_DOMAIN',
  'JIRA_PROJECT_KEY',
  'PAGERDUTY_API_KEY',
  'PAGERDUTY_SERVICE_ID',
  'PAGERDUTY_FROM_EMAIL',
  'INCIDENT_RESET_SECRET',
];

const envs = keysToSync
  .map(key => [key, localEnv[key] || process.env[key]])
  .filter(([, val]) => Boolean(val));

async function sync() {
  if (envs.length === 0) {
    console.log('No matching environment variables found in .env.local or process.env to sync.');
    return;
  }

  for (const [key, val] of envs) {
    console.log(`Updating ${key}...`);
    await new Promise(resolve => {
      const rm = spawn('npx', ['vercel', 'env', 'rm', key, 'production', '--yes'], { shell: true, stdio: 'ignore' });
      rm.on('close', resolve);
    });
    await new Promise(resolve => {
      const add = spawn('npx', ['vercel', 'env', 'add', key, 'production'], { shell: true, stdio: ['pipe', 'ignore', 'inherit'] });
      add.stdin.write(val);
      add.stdin.end();
      add.on('close', resolve);
    });
    console.log(`✓ ${key} updated cleanly`);
  }
  console.log('All available environment variables updated cleanly without newlines!');
}

sync();
