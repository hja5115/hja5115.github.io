import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { GitHubStore } from '../js/github-store.js';

const MAX_BODY_BYTES = 45 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const API_ORIGIN = 'https://api.github.com';

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function failure(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

/** Execute gh without a shell; gh reads its own OS-managed credentials. */
export function runLocalGh(executable, args, { input, signal } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_DEBUG: '', GH_PAGER: 'cat' };
    // Prefer this PC's gh login, never a token inherited from a remote runner.
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[name];
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, signal });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let exceeded = false;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) { exceeded = true; child.kill(); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', () => reject(failure('이 PC에서 GitHub CLI를 실행하지 못했습니다. gh 설치와 로그인을 확인해 주세요.', 'GH_UNAVAILABLE', 503)));
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      if (exceeded) { reject(failure('GitHub 응답이 허용 크기를 초과했습니다.', 'GH_RESPONSE_LIMIT', 502)); return; }
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(input || '');
  });
}

/** Adapt the existing store's fetch calls to gh api. Authorization is deliberately ignored. */
export function createGhApiFetch({ ghExecutable = 'gh', runGh = runLocalGh } = {}) {
  return async (input, options = {}) => {
    let url;
    try { url = new URL(input); } catch { throw failure('허용되지 않는 GitHub API 주소입니다.', 'INVALID_API_URL'); }
    const method = options.method || 'GET';
    if (url.origin !== API_ORIGIN || url.username || url.password || url.hash ||
        !['GET', 'POST', 'PATCH'].includes(method) || !/^(?:\/user$|\/repos\/)/.test(url.pathname)) {
      throw failure('허용되지 않는 GitHub API 요청입니다.', 'INVALID_API_URL');
    }
    const args = ['api', '--hostname', 'github.com', '--method', method,
      '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2026-03-10'];
    if (options.body !== undefined) args.push('--input', '-');
    args.push(`${url.pathname}${url.search}`);
    let result;
    try {
      result = await runGh(ghExecutable, args, { input: options.body, signal: options.signal });
    } catch {
      return new Response(JSON.stringify({ error: 'LOCAL_GH_UNAVAILABLE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    if (result.code !== 0) {
      const match = /\bHTTP\s+(\d{3})\b/.exec(result.stderr || '');
      const status = match ? Number(match[1]) : 503;
      return new Response(JSON.stringify({ error: 'GITHUB_API_FAILED' }), { status: status >= 400 && status <= 599 ? status : 503, headers: { 'Content-Type': 'application/json' } });
    }
    try {
      JSON.parse(result.stdout);
      return new Response(result.stdout, { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_GITHUB_RESPONSE' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
  };
}

function matchesNonce(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw failure('JSON 요청만 허용됩니다.', 'INVALID_CONTENT_TYPE', 415);
  }
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    req.resume();
    throw failure('요청이 너무 큽니다. 한 번에 45MB 이하로 저장해 주세요.', 'BODY_TOO_LARGE', 413);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) throw failure('요청이 너무 큽니다. 한 번에 45MB 이하로 저장해 주세요.', 'BODY_TOO_LARGE', 413);
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure('요청 JSON 형식을 확인해 주세요.', 'INVALID_JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw failure('요청 객체가 필요합니다.', 'INVALID_JSON');
  return data;
}

/** Mount only on a server bound to 127.0.0.1 / localhost. No CORS is enabled. */
export function createLocalEditorHandler({ config, root, port, ghExecutable = 'gh', runGh = runLocalGh }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid local server port is required.');
  // root belongs to the static server; it is never returned or passed to gh API arguments.
  void root;
  const csrf = randomBytes(32).toString('hex');
  const store = new GitHubStore(config, { fetchImpl: createGhApiFetch({ ghExecutable, runGh }) });
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/__owner/')) return false;
    const host = req.headers.host;
    const origin = req.headers.origin;
    const remoteAddress = req.socket?.remoteAddress;
    // All checks happen before the first subprocess; fetch metadata is browser controlled.
    if ((remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) ||
        !hosts.has(host) || req.headers['sec-fetch-site'] !== 'same-origin' ||
        (origin !== undefined && origin !== `http://${host}`) ||
        (req.method === 'POST' && (origin !== `http://${host}` || !matchesNonce(req.headers['x-portfolio-csrf'], csrf)))) {
      send(res, 403, { error: 'LOCAL_ORIGIN_REQUIRED', message: '이 PC의 같은 사이트에서만 편집할 수 있습니다. 로컬 포트폴리오 페이지를 새로 열어 주세요.' });
      return true;
    }
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === 'GET /__owner/session') {
        send(res, 200, { nonce: csrf });
      } else if (route === 'POST /__owner/authenticate') {
        const body = await readJson(req);
        if (Object.keys(body).length) throw failure('인증 정보는 브라우저에서 전송하지 않습니다.', 'INVALID_AUTH_REQUEST');
        send(res, 200, await store.authenticate('local_desktop_session'));
      } else if (route === 'GET /__owner/content') {
        send(res, 200, await store.load());
      } else if (route === 'POST /__owner/save') {
        const body = await readJson(req);
        if (Object.keys(body).some((key) => !['document', 'uploads', 'expectedSha'].includes(key))) {
          throw failure('지원하지 않는 저장 필드가 있습니다.', 'INVALID_SAVE_REQUEST');
        }
        if (typeof body.expectedSha !== 'string') throw failure('최신 파일 식별자가 필요합니다. 다시 연결해 주세요.', 'LOAD_REQUIRED', 409);
        send(res, 200, await store.save(body.document, body.uploads || [], { expectedSha: body.expectedSha }));
      } else if (route === 'POST /__owner/disconnect') {
        await readJson(req);
        store.disconnect();
        send(res, 200, { disconnected: true });
      } else {
        send(res, 404, { error: 'NOT_FOUND', message: '지원하지 않는 로컬 편집 요청입니다.' });
      }
    } catch (error) {
      const known = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code);
      const status = error.status >= 400 && error.status <= 599 ? error.status :
        ['NOT_CONNECTED', 'WRONG_OWNER', 'READ_ONLY'].includes(error.code) ? 403 :
          ['CONFLICT', 'LOAD_REQUIRED', 'BUSY'].includes(error.code) ? 409 : 400;
      const message = error.status === 503 ? '이 PC의 GitHub CLI 연결을 확인해 주세요. 터미널의 gh auth status에서 hja5115 로그인을 확인할 수 있습니다.' :
        known ? error.message : '로컬 GitHub 작업을 완료하지 못했습니다. 연결 상태를 확인해 주세요.';
      send(res, status, { error: known ? error.code : 'LOCAL_ERROR', message });
    }
    return true;
  };
}
