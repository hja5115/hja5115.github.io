import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubStore,
  validatePortfolioDocument,
  validateUploadPath,
  validateUploads,
  encodeUtf8Base64,
  decodeUtf8Base64,
} from '../js/github-store.js';

const config = { owner: 'hja5115', repo: 'portfolio', branch: 'main', dataPath: 'data/portfolio.json' };
const token = 'github_pat_TEST_ONLY_NEVER_A_REAL_CREDENTIAL';
const repoPath = '/repos/hja5115/portfolio';
const oldBlob = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const baseTree = 'c'.repeat(40);
const imageBlob = 'd'.repeat(40);
const dataBlob = 'e'.repeat(40);
const newTree = 'f'.repeat(40);
const newCommit = '1'.repeat(40);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP3sAAAAASUVORK5CYII=';

function documentFixture() {
  return {
    schemaVersion: 1,
    site: {
      name: '테스트 디자이너', englishName: 'Test Designer', role: 'GAME UI/UX DESIGNER',
      headline: '게임의 선택을 선명하게', intro: '한글과 🎮도 UTF-8로 보존합니다.',
      email: '', github: '', heroImage: 'assets/chronos/cover.jpg',
      contactUrl: '', contactLabel: '카카오톡으로 이야기하기',
    },
    projects: [{
      id: 'chronos', title: 'CHRONOS', genre: 'RPG', summary: '테스트 요약', role: 'UI/UX',
      tools: ['Figma', 'Unity'], tags: ['UI', 'UX'], accent: '#7F9FFF',
      cover: 'assets/chronos/cover.jpg', videoUrl: '',
      images: [{ id: 'screen1', src: 'assets/chronos/screen1.jpg', alt: '로비', title: '로비', description: '', kind: 'UI' }],
      process: [{ id: 'step1', label: '01 / UX', title: '정보 구조', body: '', image: '' }],
    }],
  };
}

function fileResponse(document = documentFixture(), sha = oldBlob) {
  return { type: 'file', encoding: 'base64', size: 1000, sha, content: encodeUtf8Base64(JSON.stringify(document)) };
}

function step(method, path, response, inspect, status = 200) {
  return { method, path, response, inspect, status };
}

function authSteps(login = 'hja5115', push = true) {
  return [
    step('GET', '/user', { login }),
    step('GET', repoPath, { permissions: { push } }),
  ];
}

function loadStep(document = documentFixture(), sha = oldBlob) {
  return step('GET', `${repoPath}/contents/data/portfolio.json?ref=main`, fileResponse(document, sha));
}

function saveSteps({ document = documentFixture(), sha = oldBlob, upload = false, failAt = '', failStatus = 500 } = {}) {
  const steps = [
    step('GET', `${repoPath}/git/ref/heads/main`, { object: { sha: headSha } }),
    step('GET', `${repoPath}/contents/data/portfolio.json?ref=${headSha}`, fileResponse(document, sha)),
    step('GET', `${repoPath}/git/commits/${headSha}`, { tree: { sha: baseTree } }),
  ];
  if (upload) steps.push(step('POST', `${repoPath}/git/blobs`, { sha: imageBlob }, (body) => {
    assert.equal(body.encoding, 'base64');
    assert.equal(body.content, png);
  }));
  steps.push(
    step('POST', `${repoPath}/git/blobs`, { sha: dataBlob }, (body) => {
      assert.equal(body.encoding, 'base64');
      assert.deepEqual(JSON.parse(decodeUtf8Base64(body.content)), document);
    }),
    step('POST', `${repoPath}/git/trees`, { sha: newTree }, (body) => {
      assert.equal(body.base_tree, baseTree);
      assert.deepEqual(body.tree, [
        ...(upload ? [{ path: 'assets/uploads/new.png', mode: '100644', type: 'blob', sha: imageBlob }] : []),
        { path: 'data/portfolio.json', mode: '100644', type: 'blob', sha: dataBlob },
      ]);
    }),
    step('POST', `${repoPath}/git/commits`, { sha: newCommit }, (body) => {
      assert.equal(body.tree, newTree);
      assert.deepEqual(body.parents, [headSha]);
    }),
    step('PATCH', `${repoPath}/git/refs/heads/main`, { object: { sha: newCommit } }, (body) => {
      assert.deepEqual(body, { sha: newCommit, force: false });
    }),
  );
  if (failAt) {
    const index = steps.findIndex((item) => `${item.method} ${item.path}`.endsWith(failAt));
    assert.notEqual(index, -1);
    steps[index] = { ...steps[index], status: failStatus, response: { message: `Do not expose ${token}` } };
    return steps.slice(0, index + 1);
  }
  return steps;
}

function mockFetch(steps) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const current = steps[calls.length];
    const request = { method: options.method, path: `${parsed.pathname}${parsed.search}`, options };
    calls.push(request);
    assert.ok(current, `Unexpected request: ${request.method} ${request.path}`);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(request.method, current.method);
    assert.equal(request.path, current.path);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    current.inspect?.(options.body === undefined ? undefined : JSON.parse(options.body));
    if (current.throwNetwork) throw new Error(`sensitive network details: ${token}`);
    return {
      ok: current.status >= 200 && current.status < 300,
      status: current.status,
      json: async () => current.response,
    };
  };
  return { fetchImpl, calls, done: () => assert.equal(calls.length, steps.length) };
}

test('owner identity is case insensitive and credentials stay in instance memory', async () => {
  const mock = mockFetch(authSteps('HJA5115'));
  const store = new GitHubStore(config, mock);
  const result = await store.authenticate(` ${token} `);
  assert.equal(result.login, 'HJA5115');
  assert.equal(store.connected, true);
  assert.equal(JSON.stringify(store).includes(token), false);
  assert.equal(Object.values(store).includes(token), false);
  mock.done();
  store.disconnect();
  assert.equal(store.connected, false);
  assert.equal(store.sha, null);
  await assert.rejects(() => store.load(), { code: 'NOT_CONNECTED' });
  mock.done();
});

test('fetch receives the global browser receiver rather than the GitHubStore instance', async () => {
  const mock = mockFetch(authSteps());
  const store = new GitHubStore(config, { fetchImpl: function (url, options) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return mock.fetchImpl(url, options);
  } });
  await store.authenticate(token);
  assert.equal(store.connected, true);
  mock.done();
});

test('a different GitHub account is refused before the repository is requested', async () => {
  const mock = mockFetch([step('GET', '/user', { login: 'someone-else' })]);
  const store = new GitHubStore(config, mock);
  await assert.rejects(() => store.authenticate(token), { code: 'WRONG_OWNER' });
  assert.equal(store.connected, false);
  await assert.rejects(() => store.save(documentFixture()), { code: 'NOT_CONNECTED' });
  mock.done();
});

test('read-only repository permissions cannot authorize editing', async () => {
  const mock = mockFetch(authSteps('hja5115', false));
  const store = new GitHubStore(config, mock);
  await assert.rejects(() => store.authenticate(token), { code: 'READ_ONLY' });
  assert.equal(store.connected, false);
  mock.done();
});

test('a malicious config cannot redirect the credential or write code paths', () => {
  for (const change of [
    { owner: 'https://attacker.test' }, { repo: '../other' }, { repo: '..' },
    { branch: 'elsewhere' }, { dataPath: 'js/app.js' }, { dataPath: '../index.html' },
  ]) assert.throws(() => new GitHubStore({ ...config, ...change }), { code: 'INVALID_CONFIG' });
  const source = { ...config };
  const store = new GitHubStore(source);
  source.owner = 'someone-else';
  assert.equal(store.config.owner, 'hja5115');
  assert.ok(Object.isFrozen(store.config));
});

test('load decodes Korean, emoji, and GitHub Base64 line breaks; tracks the file SHA', async () => {
  const response = fileResponse();
  response.content = response.content.replace(/(.{64})/g, '$1\n');
  const mock = mockFetch([...authSteps(), step('GET', `${repoPath}/contents/data/portfolio.json?ref=main`, response)]);
  const store = new GitHubStore(config, mock);
  await store.authenticate(token);
  const loaded = await store.load();
  assert.deepEqual(loaded.document, documentFixture());
  assert.equal(loaded.sha, oldBlob);
  assert.equal(store.sha, oldBlob);
  mock.done();
});

test('save requires load and rejects a stale explicit SHA before any write', async () => {
  const mock = mockFetch([...authSteps(), loadStep()]);
  const store = new GitHubStore(config, mock);
  await store.authenticate(token);
  await assert.rejects(() => store.save(documentFixture()), { code: 'LOAD_REQUIRED' });
  await store.load();
  await assert.rejects(() => store.save(documentFixture(), [], { expectedSha: newCommit }), { code: 'CONFLICT' });
  mock.done();
});

test('a newer published JSON revision rejects saving before any blob is created', async () => {
  const changedSha = '2'.repeat(40);
  const mock = mockFetch([
    ...authSteps(), loadStep(),
    step('GET', `${repoPath}/git/ref/heads/main`, { object: { sha: headSha } }),
    step('GET', `${repoPath}/contents/data/portfolio.json?ref=${headSha}`, fileResponse(documentFixture(), changedSha)),
  ]);
  const store = new GitHubStore(config, mock);
  await store.authenticate(token);
  await store.load();
  await assert.rejects(() => store.save(documentFixture()), { code: 'CONFLICT' });
  assert.ok(mock.calls.every((call) => call.method === 'GET'));
  assert.equal(store.sha, oldBlob);
  mock.done();
});

test('images and JSON publish together in one atomic commit with the current tree and parent', async () => {
  const document = documentFixture();
  document.projects[0].images[0].src = 'assets/uploads/new.png';
  const mock = mockFetch([...authSteps(), loadStep(), ...saveSteps({ document, upload: true })]);
  const store = new GitHubStore(config, mock);
  await store.authenticate(token);
  await store.load();
  const result = await store.save(document, [{ path: 'assets/uploads/new.png', base64: png }]);
  assert.deepEqual(result, { document, sha: dataBlob, commitSha: newCommit });
  assert.equal(store.sha, dataBlob);
  assert.equal(mock.calls.filter((call) => call.method === 'PATCH').length, 1);
  assert.equal(mock.calls.at(-1).path, `${repoPath}/git/refs/heads/main`);
  assert.ok(mock.calls.every((call) => call.method !== 'PUT'));
  mock.done();
});

test('Git tree failure leaves the published ref and baseline untouched', async () => {
  const mock = mockFetch([...authSteps(), loadStep(), ...saveSteps({ failAt: 'POST /repos/hja5115/portfolio/git/trees' })]);
  const store = new GitHubStore(config, mock);
  await store.authenticate(token);
  await store.load();
  await assert.rejects(() => store.save(documentFixture()), (error) => error.code === 'GITHUB_ERROR' && !error.message.includes(token));
  assert.equal(store.sha, oldBlob);
  assert.ok(mock.calls.every((call) => call.method !== 'PATCH'));
  mock.done();
});

test('a main branch race is refused with force:false and a clear conflict', async () => {
  const mock = mockFetch([...authSteps(), loadStep(), ...saveSteps({ failAt: 'PATCH /repos/hja5115/portfolio/git/refs/heads/main', failStatus: 422 })]);
  const store = new GitHubStore(config, mock);
  await store.authenticate(token);
  await store.load();
  await assert.rejects(() => store.save(documentFixture()), { code: 'CONFLICT' });
  assert.equal(store.sha, oldBlob);
  mock.done();
});

test('401 clears the session; 403 gives permission guidance without server secrets', async () => {
  for (const status of [401, 403]) {
    const mock = mockFetch([step('GET', '/user', { message: token }, undefined, status)]);
    const store = new GitHubStore(config, mock);
    await assert.rejects(() => store.authenticate(token), (error) => {
      assert.equal(error.code, status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN');
      assert.equal(error.status, status);
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, status === 401 ? /토큰/ : /권한/);
      return true;
    });
    assert.equal(store.connected, false);
    mock.done();
  }
});

test('network exceptions never expose credential-bearing error text', async () => {
  const mock = mockFetch([{ ...step('GET', '/user'), throwNetwork: true }]);
  const store = new GitHubStore(config, mock);
  await assert.rejects(() => store.authenticate(token), (error) => error.code === 'NETWORK_ERROR' && !error.message.includes(token));
  mock.done();
});

test('schema validation rejects remote images, executable URLs, unknown fields and duplicate IDs', () => {
  const changes = [
    (document) => { document.site.heroImage = 'https://attacker.test/track.png'; },
    (document) => { document.projects[0].cover = 'data:image/png;base64,AAA'; },
    (document) => { document.projects[0].images[0].src = 'blob:https://example.test/id'; },
    (document) => { document.projects[0].images[0].src = 'assets/../js/app.js'; },
    (document) => { document.site.github = 'https://github.com.attacker.test/profile'; },
    (document) => { document.site.contactUrl = 'https://attacker.test/o/chat'; },
    (document) => { document.projects[0].videoUrl = 'javascript:alert(1)'; },
    (document) => { document.projects[0].videoUrl = 'https://user:password@video.example.test'; },
    (document) => { document.projects[0].images[0].kind = 'Script'; },
    (document) => { document.projects[0].images[0].width = -1; },
    (document) => { document.projects[0].images[0].height = '810'; },
    (document) => { document.projects[0].images[0].width = 1.5; },
    (document) => { document.projects[0].code = 'alert(1)'; },
    (document) => { document.projects.push(structuredClone(document.projects[0])); },
  ];
  for (const mutate of changes) {
    const document = documentFixture();
    mutate(document);
    assert.throws(() => validatePortfolioDocument(document), { code: 'INVALID_DATA' });
  }
  const valid = documentFixture();
  valid.site.contactUrl = 'https://open.kakao.com/o/Example123';
  valid.projects[0].videoUrl = 'https://www.youtube.com/watch?v=example';
  valid.projects[0].fullSheet = 'assets/chronos-full.webp';
  valid.projects[0].images[0].width = 1440;
  valid.projects[0].images[0].height = 810;
  assert.equal(validatePortfolioDocument(valid), valid);
});

test('upload validation blocks traversal, code, SVG and disguised non-image content', () => {
  for (const path of [
    '../index.html', 'js/app.js', 'assets/uploads/../../index.html',
    'assets/uploads/%2e%2e.png', 'assets/uploads/nested/file.png',
    'assets/uploads/file.svg', '/assets/uploads/file.png', 'assets/uploads/file.png?x=1',
  ]) assert.throws(() => validateUploadPath(path), { code: 'INVALID_DATA' });
  assert.throws(() => validateUploads([{ path: 'assets/uploads/safe.png', base64: btoa('<script>alert(1)</script>') }]), { code: 'INVALID_DATA' });
  assert.throws(() => validateUploads([{ path: 'assets/uploads/safe.jpg', base64: png }]), { code: 'INVALID_DATA' });
  assert.throws(() => validateUploads([{ path: 'assets/uploads/safe.png', base64: `data:image/png;base64,${png}` }]), { code: 'INVALID_DATA' });
  assert.throws(() => validateUploads([
    { path: 'assets/uploads/same.png', base64: png }, { path: 'assets/uploads/same.png', base64: png },
  ]), { code: 'INVALID_DATA' });
  assert.deepEqual(validateUploads([{ path: 'assets/uploads/safe.png', base64: png }]), [{ path: 'assets/uploads/safe.png', base64: png }]);
});

test('invalid document and upload paths fail before any GitHub mutation or save reads', async () => {
  const mock = mockFetch([...authSteps(), loadStep()]);
  const store = new GitHubStore(config, mock);
  await store.authenticate(token);
  await store.load();
  const invalid = documentFixture();
  invalid.projects[0].images[0].src = 'https://elsewhere.test/image.png';
  await assert.rejects(() => store.save(invalid), { code: 'INVALID_DATA' });
  await assert.rejects(() => store.save(documentFixture(), [{ path: 'index.html', base64: png }]), { code: 'INVALID_DATA' });
  assert.ok(mock.calls.every((call) => call.method === 'GET'));
  mock.done();
});

test('UTF-8 helpers reject malformed Base64 and invalid UTF-8', () => {
  const source = '홍정아 / 설명과 버튼 🎮';
  assert.equal(decodeUtf8Base64(encodeUtf8Base64(source)), source);
  assert.throws(() => decodeUtf8Base64('not valid !'), { code: 'INVALID_DATA' });
  assert.throws(() => decodeUtf8Base64('/w=='), { code: 'INVALID_DATA' });
});

test('disconnect invalidates a pending authentication response before further requests', async () => {
  let release;
  let calls = 0;
  const store = new GitHubStore(config, { fetchImpl: () => {
    calls += 1;
    return new Promise((resolve) => { release = resolve; });
  } });
  const pending = store.authenticate(token);
  const assertion = assert.rejects(() => pending, { code: 'NOT_CONNECTED' });
  store.disconnect();
  release({ ok: true, status: 200, json: async () => ({ login: 'hja5115' }) });
  await assertion;
  assert.equal(calls, 1);
  assert.equal(store.connected, false);
});

test('overlapping load and save requests are refused, and disconnect cancels the pending load', async () => {
  const auth = mockFetch(authSteps());
  let release;
  const store = new GitHubStore(config, { fetchImpl: (url, options) => {
    if (!url.includes('/contents/')) return auth.fetchImpl(url, options);
    return new Promise((resolve) => { release = resolve; });
  } });
  await store.authenticate(token);
  const pending = store.load();
  const assertion = assert.rejects(() => pending, { code: 'NOT_CONNECTED' });
  await assert.rejects(() => store.save(documentFixture()), { code: 'BUSY' });
  store.disconnect();
  release({ ok: true, status: 200, json: async () => fileResponse() });
  await assertion;
  assert.equal(store.sha, null);
  auth.done();
});

test('the saved document is a snapshot even if the caller changes its object during a request', async () => {
  const original = documentFixture();
  const snapshot = structuredClone(original);
  const mock = mockFetch([...authSteps(), loadStep(), ...saveSteps({ document: snapshot })]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = new GitHubStore(config, { fetchImpl: async (url, options) => {
    if (url.endsWith('/git/ref/heads/main')) await gate;
    return mock.fetchImpl(url, options);
  } });
  await store.authenticate(token);
  await store.load();
  const pending = store.save(original);
  original.site.headline = 'Changed while saving';
  original.projects[0].title = 'Changed too';
  release();
  const result = await pending;
  assert.deepEqual(result.document, snapshot);
  mock.done();
});

test('Contents write permission failure stops before publication and keeps the current baseline', async () => {
  const mock = mockFetch([...authSteps(), loadStep(), ...saveSteps({ failAt: 'POST /repos/hja5115/portfolio/git/blobs', failStatus: 403 })]);
  const store = new GitHubStore(config, mock);
  await store.authenticate(token);
  await store.load();
  await assert.rejects(() => store.save(documentFixture()), (error) => error.code === 'FORBIDDEN' && /Contents/.test(error.message));
  assert.equal(store.sha, oldBlob);
  assert.ok(mock.calls.every((call) => call.method !== 'PATCH'));
  mock.done();
});
