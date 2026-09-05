import { readFileSync } from 'node:fs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

const width = argument('width');
const height = argument('height');
const origin = process.env.INKSTACK_ORIGIN ?? 'http://127.0.0.1:3210';
const password = process.env.INKSTACK_ADMIN_PASSWORD ?? readFileSync('.local/admin-password.txt', 'utf8').trim();
const login = await fetch(`${origin}/api/session`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ password })
});
if (!login.ok) throw new Error(`Login failed (${login.status})`);
const cookie = login.headers.getSetCookie()[0].split(';')[0];
const headers = { origin, cookie, 'content-type': 'application/json' };

try {
  const currentResponse = await fetch(`${origin}/api/dashboards/main`, { headers: { cookie } });
  if (!currentResponse.ok) throw new Error(`Dashboard read failed (${currentResponse.status})`);
  const current = await currentResponse.json();
  const dashboard = structuredClone(current.draft);
  dashboard.screen = { width, height };
  const save = await fetch(`${origin}/api/dashboards/main/draft`, {
    method: 'PUT', headers,
    body: JSON.stringify({ dashboard, baseRevision: current.draftRevision })
  });
  if (!save.ok) throw new Error(`Dashboard save failed (${save.status}): ${await save.text()}`);
  const saved = await save.json();
  const publish = await fetch(`${origin}/api/dashboards/main/publish`, {
    method: 'POST', headers,
    body: JSON.stringify({ draftRevision: saved.draftRevision })
  });
  if (!publish.ok) throw new Error(`Publish failed (${publish.status}): ${await publish.text()}`);
  let job = await publish.json();
  for (let attempt = 0; attempt < 100 && ['queued', 'running'].includes(job.status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const response = await fetch(`${origin}/api/jobs/${job.id}`, { headers: { cookie } });
    if (!response.ok) throw new Error(`Publish status failed (${response.status})`);
    job = await response.json();
  }
  if (job.status !== 'succeeded') throw new Error(`Publish ended with ${job.status}: ${job.error ?? 'unknown error'}`);
  console.log(JSON.stringify({ width, height, draftRevision: saved.draftRevision, publishedRevision: job.revision }));
} finally {
  await fetch(`${origin}/api/session`, { method: 'DELETE', headers: { origin, cookie } });
}
