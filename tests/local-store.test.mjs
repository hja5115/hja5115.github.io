import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createLocalEditorHandler, createGhApiFetch } from '../scripts/local-store.mjs';
import { LocalGitHubStore } from '../js/local-store.js';
import { encodeUtf8Base64 } from '../js/github-store.js';

const port = 4174;
const config = { owner: 'hja5115', repo: 'hja5115.github.io', branch: 'main', dataPath: 'data/portfolio.json' };
const repo = '/repos/hja5115/hja5115.github.io';
const sha = 'a'.repeat(40);
const head = 'b'.repeat(40);
const tree = 'c'.repeat(40);
const newBlob = 'd'.repeat(40);
const newTree = 'e'.repeat(40);
const commit = 'f'.repeat(40);
const doc = {
  schemaVersion: 1,
  site: { name: '테스트', role: 'UI', headline: '제목', intro: '설명', email: '', github: '', heroImage: '' },
  projects: [],
};
const file = { type: 'file', encoding: 'base64', content: encodeUtf8Base64(JSON.stringify(doc)), sha, size: 500 };

function ghMock(routes = []) {
  const calls = [];
  const runGh = async (executable, args, options) => {
    const route = routes[calls.length];
    calls.push({ executable, args, options });
    assert.ok(route, `Unexpected gh call: ${args.join(' ')}`);
    assert.equal(executable, 'mock-gh');
    assert.deepEqual(args.slice(0, 3), ['api', '--hostname', 'github.com']);
    assert.equal(args[args.indexOf('--method') + 1], route.method || 'GET');
    assert.equal(args.at(-1), route.path);
    assert.equal(args.some(value => /Authorization|Bearer|local_desktop_session|github_pat_/.test(value)), false);
    if (route.inspect) route.inspect(options, args);
    if (route.throw) throw new Error('raw-stderr github_pat_SUPER_SECRET');
    return { code: route.code || 0, stdout: JSON.stringify(route.data || {}), stderr: route.stderr || '' };
  };
  return { runGh, calls, done: () => assert.equal(calls.length, routes.length) };
}

function authRoutes(login = 'hja5115', push = true) {
  return [{ path: '/user', data: { login } }, { path: repo, data: { permissions: { push } } }];
}

function mount(mock = ghMock()) {
  const handler = createLocalEditorHandler({ config, root: 'M:/private/local-path', port, ghExecutable: 'mock-gh', runGh: mock.runGh });
  const request = async (path, { method = 'GET', body, nonce, headers = {}, remoteAddress = '127.0.0.1' } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    req.headers = {
      host: `localhost:${port}`, 'sec-fetch-site': 'same-origin',
      ...(method === 'POST' ? { origin: `http://localhost:${port}`, 'content-type': 'application/json' } : {}),
      ...(nonce ? { 'x-portfolio-csrf': nonce } : {}), ...headers,
    };
    req.socket = { remoteAddress };
    let status, responseHeaders, text;
    const res = {
      writeHead(code, nextHeaders) { status = code; responseHeaders = nextHeaders; },
      end(value) { text = value; },
    };
    const handled = await handler(req, res, new URL(path, `http://localhost:${port}`));
    return { handled, status, headers: responseHeaders, text, data: text ? JSON.parse(text) : undefined };
  };
  return { request, mock };
}

async function session(request) {
  const response = await request('/__owner/session');
  assert.equal(response.status, 200);
  assert.match(response.data.nonce, /^[a-f0-9]{64}$/);
  return response.data.nonce;
}

test('nonce is stable within a server instance, random per instance, with no CORS or path disclosure', async () => {
  const one = mount(), two = mount();
  const first = await one.request('/__owner/session');
  const next = await one.request('/__owner/session');
  const another = await two.request('/__owner/session');
  assert.equal(first.data.nonce, next.data.nonce);
  assert.notEqual(first.data.nonce, another.data.nonce);
  assert.equal(first.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(first.headers['Cache-Control'], 'no-store');
  assert.equal(first.text.includes('private'), false);
  assert.equal(one.mock.calls.length, 0);
  assert.equal((await one.request('/index.html')).handled, false);
});

test('DNS rebinding, wrong ports, cross-site fetches and non-loopback peers fail before gh', async () => {
  const { request, mock } = mount();
  for (const options of [
    { headers: { host: 'attacker.test:4174' } },
    { headers: { host: 'localhost:4175' } },
    { headers: { host: 'localhost:4174.attacker.test' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'sec-fetch-site': 'same-site' } },
    { headers: { 'sec-fetch-site': undefined } },
    { headers: { origin: 'https://attacker.test' } },
    { remoteAddress: '192.168.1.7' },
  ]) assert.equal((await request('/__owner/session', options)).status, 403);
  assert.equal(mock.calls.length, 0);
});

test('POST requires same-origin Origin, browser fetch metadata, JSON and a matching CSRF nonce', async () => {
  const { request, mock } = mount();
  const nonce = await session(request);
  for (const options of [
    {}, { nonce: 'wrong' }, { nonce, headers: { origin: undefined } },
    { nonce, headers: { origin: 'null' } }, { nonce, headers: { origin: 'http://attacker.test' } },
    { nonce, headers: { 'sec-fetch-site': 'cross-site' } },
  ]) assert.equal((await request('/__owner/authenticate', { method: 'POST', body: {}, ...options })).status, 403);
  assert.equal((await request('/__owner/authenticate', { method: 'POST', nonce, body: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(mock.calls.length, 0);
});

test('oversized body, malformed JSON and token-bearing auth requests fail without gh', async () => {
  const { request, mock } = mount();
  const nonce = await session(request);
  assert.equal((await request('/__owner/authenticate', { method: 'POST', nonce, body: {}, headers: { 'content-length': String(46 * 1024 * 1024) } })).status, 413);
  assert.equal((await request('/__owner/authenticate', { method: 'POST', nonce, body: '{invalid' })).status, 400);
  const response = await request('/__owner/authenticate', { method: 'POST', nonce, body: { token: 'github_pat_SHOULD_NOT_BE_SENT' } });
  assert.equal(response.status, 400);
  assert.equal(response.text.includes('github_pat_'), false);
  assert.equal(mock.calls.length, 0);
});

test('local gh identity and push permissions are checked, then content loads through the shared store', async () => {
  const mock = ghMock([...authRoutes(), { path: `${repo}/contents/data/portfolio.json?ref=main`, data: file }]);
  const { request } = mount(mock);
  const nonce = await session(request);
  const auth = await request('/__owner/authenticate', { method: 'POST', nonce, body: {} });
  assert.equal(auth.status, 200);
  assert.equal(auth.data.login, 'hja5115');
  assert.equal(auth.text.includes('token'), false);
  const loaded = await request('/__owner/content');
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.data, { document: doc, sha });
  mock.done();
});

test('a different PC gh account or read-only repository is denied', async () => {
  for (const routes of [[{ path: '/user', data: { login: 'someone-else' } }], authRoutes('hja5115', false)]) {
    const mock = ghMock(routes);
    const { request } = mount(mock);
    const nonce = await session(request);
    const auth = await request('/__owner/authenticate', { method: 'POST', nonce, body: {} });
    assert.equal(auth.status, 403);
    assert.ok(['WRONG_OWNER', 'READ_ONLY'].includes(auth.data.error));
    assert.equal((await request('/__owner/content')).status, 403);
    mock.done();
  }
});

test('local save reuses schema validation and publishes only one non-forced atomic Git commit', async () => {
  const mock = ghMock([
    ...authRoutes(), { path: `${repo}/contents/data/portfolio.json?ref=main`, data: file },
    { path: `${repo}/git/ref/heads/main`, data: { object: { sha: head } } },
    { path: `${repo}/contents/data/portfolio.json?ref=${head}`, data: file },
    { path: `${repo}/git/commits/${head}`, data: { tree: { sha: tree } } },
    { method: 'POST', path: `${repo}/git/blobs`, data: { sha: newBlob }, inspect: (options, args) => {
      assert.ok(args.includes('--input'));
      assert.equal(JSON.parse(options.input).encoding, 'base64');
    } },
    { method: 'POST', path: `${repo}/git/trees`, data: { sha: newTree }, inspect: options => {
      const body = JSON.parse(options.input);
      assert.equal(body.base_tree, tree);
      assert.deepEqual(body.tree.map(entry => entry.path), ['data/portfolio.json']);
    } },
    { method: 'POST', path: `${repo}/git/commits`, data: { sha: commit }, inspect: options => assert.deepEqual(JSON.parse(options.input).parents, [head]) },
    { method: 'PATCH', path: `${repo}/git/refs/heads/main`, data: { object: { sha: commit } }, inspect: options => assert.deepEqual(JSON.parse(options.input), { sha: commit, force: false }) },
  ]);
  const { request } = mount(mock);
  const nonce = await session(request);
  await request('/__owner/authenticate', { method: 'POST', nonce, body: {} });
  await request('/__owner/content');
  const response = await request('/__owner/save', { method: 'POST', nonce, body: { document: doc, uploads: [], expectedSha: sha } });
  assert.equal(response.status, 200);
  assert.equal(response.data.commitSha, commit);
  assert.equal(response.text.includes('local_desktop_session'), false);
  mock.done();
});

test('saving a code path or stale revision is refused before any gh write', async () => {
  const mock = ghMock([...authRoutes(), { path: `${repo}/contents/data/portfolio.json?ref=main`, data: file }]);
  const { request } = mount(mock);
  const nonce = await session(request);
  await request('/__owner/authenticate', { method: 'POST', nonce, body: {} });
  await request('/__owner/content');
  const badUpload = await request('/__owner/save', { method: 'POST', nonce, body: { document: doc, uploads: [{ path: 'js/app.js', base64: 'AAAA' }], expectedSha: sha } });
  assert.equal(badUpload.status, 400);
  const stale = await request('/__owner/save', { method: 'POST', nonce, body: { document: doc, uploads: [], expectedSha: '0'.repeat(40) } });
  assert.equal(stale.status, 409);
  mock.done();
});

test('gh transport accepts only GitHub API URLs, ignores Authorization, and never exposes raw stderr', async () => {
  const mock = ghMock([{ path: '/user', data: { login: 'hja5115' } }, { path: '/user', code: 1, stderr: 'raw secret github_pat_SECRET (HTTP 403)' }]);
  const fetchImpl = createGhApiFetch({ ghExecutable: 'mock-gh', runGh: mock.runGh });
  for (const url of ['https://attacker.test/user', 'https://api.github.com.attacker.test/user', 'http://api.github.com/user', 'https://user:secret@api.github.com/user', 'https://api.github.com/username']) {
    await assert.rejects(() => fetchImpl(url), { code: 'INVALID_API_URL' });
  }
  const good = await fetchImpl('https://api.github.com/user', { headers: { Authorization: 'Bearer github_pat_MUST_NOT_FORWARD' } });
  assert.equal((await good.json()).login, 'hja5115');
  const failed = await fetchImpl('https://api.github.com/user');
  assert.equal(failed.status, 403);
  assert.equal((await failed.text()).includes('SECRET'), false);
  mock.done();
});

test('browser bridge sends no token and includes nonce for auth/save/disconnect', async () => {
  const nonce = '1'.repeat(64);
  const responses = [
    { nonce }, { login: 'hja5115', ...config }, { document: doc, sha },
    { document: doc, sha: newBlob, commitSha: commit }, { disconnected: true },
  ];
  const paths = ['session', 'authenticate', 'content', 'save', 'disconnect'];
  const calls = [];
  const store = new LocalGitHubStore(config, { fetchImpl: async (path, options) => {
    const index = calls.length;
    calls.push({ path, options });
    assert.equal(path, `/__owner/${paths[index]}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
    if (options.method === 'POST') assert.equal(options.headers['X-Portfolio-CSRF'], nonce);
    assert.equal(JSON.stringify(options).includes('token'), false);
    return { ok: true, status: 200, json: async () => responses[index] };
  } });
  await store.authenticate();
  assert.equal(store.connected, true);
  const loaded = await store.load();
  assert.equal(loaded.sha, sha);
  const saved = await store.save(doc, [], { expectedSha: loaded.sha });
  assert.equal(saved.sha, newBlob);
  assert.equal(JSON.parse(calls[3].options.body).expectedSha, sha);
  await store.disconnect();
  assert.equal(store.connected, false);
  assert.equal(store.sha, null);
  assert.equal(calls.length, 5);
  await assert.rejects(() => store.load(), { code: 'NOT_CONNECTED' });
});

test('closing a browser bridge during authentication cannot revive its session', async () => {
  let release;
  const store = new LocalGitHubStore(config, { fetchImpl: () => new Promise(resolve => { release = resolve; }) });
  const pending = store.authenticate();
  const assertion = assert.rejects(() => pending, { code: 'NOT_CONNECTED' });
  await store.disconnect();
  release({ ok: true, json: async () => ({ nonce: '1'.repeat(64) }) });
  await assertion;
  assert.equal(store.connected, false);
  assert.equal(store.sha, null);
});
