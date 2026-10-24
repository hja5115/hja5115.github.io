const API_ORIGIN = 'https://api.github.com';
const DATA_PATH = 'data/portfolio.json';
const MAX_DOCUMENT_BYTES = 900 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/i;
const IMAGE_PATH_PATTERN = /^assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i;
const UPLOAD_PATH_PATTERN = /^assets\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|gif|webp)$/i;

export class GitHubStoreError extends Error {
  constructor(message, code = 'GITHUB_ERROR', status = 0) {
    super(message);
    this.name = 'GitHubStoreError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) {
  throw new GitHubStoreError(message, 'INVALID_DATA');
}

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(`${label}: 올바른 객체가 필요합니다.`);
  }
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    invalid(`${label}: 지원하지 않는 필드가 있습니다.`);
  }
}

function string(value, label, max = 12000) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    invalid(`${label}: ${max}자 이하의 텍스트가 필요합니다.`);
  }
}

function list(value, label, max) {
  if (!Array.isArray(value) || value.length > max) invalid(`${label}: 최대 ${max}개까지 가능합니다.`);
}

function identifier(value, label, seen) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value) || seen.has(value)) {
    invalid(`${label}: 중복되지 않는 영문·숫자 ID가 필요합니다.`);
  }
  seen.add(value);
}

export function validateImagePath(path, { allowEmpty = true } = {}) {
  if (allowEmpty && path === '') return path;
  if (typeof path !== 'string' || path.length > 240 || !IMAGE_PATH_PATTERN.test(path)) {
    invalid('이미지는 assets/ 안의 PNG, JPG, GIF, WebP 상대 경로만 사용할 수 있습니다.');
  }
  return path;
}

export function validateUploadPath(path) {
  if (typeof path !== 'string' || path.length > 240 || !UPLOAD_PATH_PATTERN.test(path)) {
    invalid('업로드 경로는 assets/uploads/파일명.png 형식이어야 합니다. 코드나 다른 폴더에는 저장할 수 없습니다.');
  }
  return path;
}

function webLink(value, label, githubOnly = false) {
  string(value, label, 2048);
  if (!value) return;
  let parsed;
  try { parsed = new URL(value); } catch { invalid(`${label}: 올바른 웹 주소가 필요합니다.`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      /[\r\n\t]/.test(value) || (githubOnly && parsed.hostname.toLowerCase() !== 'github.com')) {
    invalid(`${label}: ${githubOnly ? 'GitHub의 ' : ''}http 또는 https 주소만 사용할 수 있습니다.`);
  }
}

/** Validate the public data schema, without mutating the caller's document. */
export function validatePortfolioDocument(document) {
  object(document, ['schemaVersion', 'site', 'projects'], '포트폴리오');
  if (document.schemaVersion !== 1) invalid('지원하는 포트폴리오 schemaVersion은 1입니다.');
  const site = document.site;
  object(site, ['name', 'englishName', 'role', 'headline', 'intro', 'email', 'github', 'heroImage', 'contactUrl', 'contactLabel'], '사이트');
  for (const key of ['name', 'role', 'headline', 'intro']) string(site[key], `사이트 ${key}`);
  for (const key of ['englishName', 'contactLabel']) {
    if (Object.hasOwn(site, key)) string(site[key], `사이트 ${key}`, 200);
  }
  string(site.email, '이메일', 254);
  if (site.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(site.email)) invalid('이메일 주소를 확인해 주세요.');
  webLink(site.github, 'GitHub 주소', true);
  if (Object.hasOwn(site, 'contactUrl')) {
    webLink(site.contactUrl, '오픈채팅 주소');
    if (site.contactUrl) {
      const contact = new URL(site.contactUrl);
      if (contact.protocol !== 'https:' || contact.hostname !== 'open.kakao.com' || !/^\/o\/[A-Za-z0-9]+\/?$/.test(contact.pathname)) {
        invalid('문의 링크는 https://open.kakao.com/o/ 형식의 카카오 오픈채팅 주소만 사용할 수 있습니다.');
      }
    }
  }
  validateImagePath(site.heroImage);
  list(document.projects, '프로젝트', 20);
  const projectIds = new Set();
  for (const project of document.projects) {
    object(project, ['id', 'title', 'genre', 'summary', 'role', 'tools', 'tags', 'accent', 'cover', 'fullSheet', 'images', 'process', 'videoUrl'], '프로젝트');
    identifier(project.id, '프로젝트 ID', projectIds);
    for (const key of ['title', 'genre', 'summary', 'role']) string(project[key], `프로젝트 ${key}`);
    for (const key of ['tools', 'tags']) {
      list(project[key], key, 40);
      for (const item of project[key]) string(item, key, 120);
    }
    if (typeof project.accent !== 'string' || !/^#[A-Fa-f0-9]{6}$/.test(project.accent)) {
      invalid('프로젝트 색상은 #7F9FFF와 같은 6자리 색상이어야 합니다.');
    }
    validateImagePath(project.cover);
    if (Object.hasOwn(project, 'fullSheet')) validateImagePath(project.fullSheet);
    webLink(project.videoUrl, '영상 주소');
    list(project.images, '프로젝트 이미지', 80);
    const imageIds = new Set();
    for (const entry of project.images) {
      object(entry, ['id', 'src', 'alt', 'title', 'description', 'kind', 'width', 'height'], '이미지');
      identifier(entry.id, '이미지 ID', imageIds);
      validateImagePath(entry.src);
      for (const key of ['alt', 'title', 'description']) string(entry[key], `이미지 ${key}`);
      for (const key of ['width', 'height']) {
        if (Object.hasOwn(entry, key) && (!Number.isInteger(entry[key]) || entry[key] < 1 || entry[key] > 100000)) {
          invalid('이미지 크기는 1에서 100000 사이의 정수여야 합니다.');
        }
      }
      if (!['UI', 'UX', 'Unity'].includes(entry.kind)) invalid('이미지 종류는 UI, UX, Unity 중 하나여야 합니다.');
    }
    list(project.process, '과정', 40);
    const processIds = new Set();
    for (const entry of project.process) {
      object(entry, ['id', 'label', 'title', 'body', 'image'], '과정');
      identifier(entry.id, '과정 ID', processIds);
      for (const key of ['label', 'title', 'body']) string(entry[key], `과정 ${key}`, 20000);
      validateImagePath(entry.image);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(document)).length > MAX_DOCUMENT_BYTES) {
    invalid('포트폴리오 설명 데이터가 너무 큽니다. 900KB 이하로 줄여 주세요.');
  }
  return document;
}

function base64Bytes(value) {
  if (typeof value !== 'string') invalid('올바른 Base64 데이터가 필요합니다.');
  const normalized = value.replace(/[\r\n]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    invalid('Base64 데이터가 올바르지 않습니다. data: 접두어는 사용할 수 없습니다.');
  }
  try {
    return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
  } catch { invalid('Base64 데이터를 읽을 수 없습니다.'); }
}

export function decodeUtf8Base64(value) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(base64Bytes(value)); }
  catch (error) {
    if (error instanceof GitHubStoreError) throw error;
    invalid('포트폴리오 파일의 UTF-8 인코딩이 올바르지 않습니다.');
  }
}

export function encodeUtf8Base64(value) {
  string(value, '인코딩할 텍스트', Number.MAX_SAFE_INTEGER);
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

function hasImageSignature(bytes, extension) {
  const starts = (sequence) => sequence.every((value, index) => bytes[index] === value);
  if (extension === 'png') return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (['jpg', 'jpeg'].includes(extension)) return starts([255, 216, 255]);
  if (extension === 'gif') return starts([71, 73, 70, 56]) && [55, 57].includes(bytes[4]) && bytes[5] === 97;
  return bytes.length >= 12 && starts([82, 73, 70, 70]) &&
    [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
}

export function validateUploads(uploads) {
  list(uploads, '한 번에 업로드할 이미지', 20);
  let total = 0;
  const paths = new Set();
  return uploads.map((upload) => {
    object(upload, ['path', 'base64'], '업로드');
    validateUploadPath(upload.path);
    if (paths.has(upload.path)) invalid('동일한 업로드 경로가 중복되었습니다.');
    paths.add(upload.path);
    if (typeof upload.base64 !== 'string' || upload.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024) {
      invalid('이미지 한 장은 10MB 이하여야 합니다.');
    }
    const bytes = base64Bytes(upload.base64);
    total += bytes.length;
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || total > MAX_UPLOAD_BYTES) {
      invalid('이미지는 한 장 10MB, 한 번의 저장에 합계 30MB 이하여야 합니다.');
    }
    if (!hasImageSignature(bytes, upload.path.split('.').pop().toLowerCase())) {
      invalid('이미지 파일의 형식과 확장자가 일치하지 않습니다. PNG, JPG, GIF, WebP 파일을 선택해 주세요.');
    }
    return { path: upload.path, base64: upload.base64.replace(/[\r\n]/g, '') };
  });
}

function checkedSha(value) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new GitHubStoreError('GitHub 응답의 파일 또는 커밋 식별자가 올바르지 않습니다.', 'INVALID_RESPONSE');
  }
  return value;
}

function conflict() {
  return new GitHubStoreError('다른 곳에서 포트폴리오가 변경되었습니다. 현재 편집 내용을 복사해 두고 최신 내용을 다시 불러온 후 저장해 주세요.', 'CONFLICT', 409);
}

/** A narrowly scoped GitHub Pages data editor. Credentials never leave instance memory. */
export class GitHubStore {
  #token = '';
  #authenticated = false;
  #sha = null;
  #epoch = 0;
  #controllers = new Set();
  #busy = false;
  #fetch;
  #config;

  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    const { owner, repo, branch = 'main', dataPath = DATA_PATH } = config || {};
    if (typeof owner !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
        typeof repo !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || ['.', '..'].includes(repo) ||
        branch !== 'main' || dataPath !== DATA_PATH || typeof fetchImpl !== 'function') {
      throw new GitHubStoreError('GitHub 저장소 설정을 확인해 주세요. main의 data/portfolio.json만 편집할 수 있습니다.', 'INVALID_CONFIG');
    }
    this.#config = Object.freeze({ owner, repo, branch, dataPath });
    // Native browser fetch must receive the Window/global receiver, not this store.
    this.#fetch = fetchImpl.bind(globalThis);
  }

  get sha() { return this.#sha; }
  get connected() { return this.#authenticated; }
  get config() { return this.#config; }
  get #repoPath() { return `/repos/${encodeURIComponent(this.#config.owner)}/${encodeURIComponent(this.#config.repo)}`; }

  disconnect() {
    this.#epoch += 1;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.#token = '';
    this.#authenticated = false;
    this.#sha = null;
    this.#busy = false;
  }

  #assertConnected() {
    if (!this.#authenticated || !this.#token) {
      throw new GitHubStoreError('소유자 GitHub 계정을 먼저 연결해 주세요.', 'NOT_CONNECTED');
    }
  }

  async #request(path, { method = 'GET', body, refUpdate = false } = {}) {
    if (!this.#token) throw new GitHubStoreError('GitHub 연결이 해제되었습니다.', 'NOT_CONNECTED');
    const epoch = this.#epoch;
    const controller = new AbortController();
    this.#controllers.add(controller);
    let response;
    try {
      response = await this.#fetch(`${API_ORIGIN}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'X-GitHub-Api-Version': '2026-03-10',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (epoch !== this.#epoch) throw new GitHubStoreError('GitHub 연결이 해제되어 작업을 중단했습니다.', 'NOT_CONNECTED');
      if (!response.ok) {
        // Do not copy server messages: an error response may contain sensitive request details.
        if (response.status === 401) {
          this.disconnect();
          throw new GitHubStoreError('GitHub 토큰이 유효하지 않거나 만료되었습니다. 소유자 토큰으로 다시 연결해 주세요.', 'UNAUTHORIZED', 401);
        }
        if (response.status === 403) {
          throw new GitHubStoreError('GitHub가 요청을 거부했습니다. 토큰의 해당 저장소 Contents 읽기·쓰기 권한, 조직 승인 또는 API 사용 한도를 확인해 주세요.', 'FORBIDDEN', 403);
        }
        if (response.status === 409 || (refUpdate && response.status === 422)) throw conflict();
        if (response.status === 404) throw new GitHubStoreError('저장소 또는 포트폴리오 파일을 찾을 수 없습니다. 저장소 선택과 토큰 접근 권한을 확인해 주세요.', 'NOT_FOUND', 404);
        throw new GitHubStoreError(`GitHub 요청에 실패했습니다 (HTTP ${response.status}). 다시 시도해 주세요.`, 'GITHUB_ERROR', response.status);
      }
      const result = await response.json();
      if (epoch !== this.#epoch) throw new GitHubStoreError('GitHub 연결이 해제되어 작업을 중단했습니다.', 'NOT_CONNECTED');
      return result;
    } catch (error) {
      if (error instanceof GitHubStoreError) throw error;
      if (epoch !== this.#epoch) throw new GitHubStoreError('GitHub 연결이 해제되어 작업을 중단했습니다.', 'NOT_CONNECTED');
      throw new GitHubStoreError('GitHub에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.', 'NETWORK_ERROR');
    } finally {
      this.#controllers.delete(controller);
    }
  }

  async authenticate(token) {
    this.disconnect();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_]{1,256}$/.test(token.trim())) {
      throw new GitHubStoreError('올바른 GitHub 개인 액세스 토큰을 입력해 주세요.', 'INVALID_TOKEN');
    }
    this.#token = token.trim();
    const epoch = this.#epoch;
    try {
      const user = await this.#request('/user');
      if (typeof user.login !== 'string' || user.login.toLowerCase() !== this.#config.owner.toLowerCase()) {
        throw new GitHubStoreError('이 사이트 소유자의 GitHub 계정만 편집할 수 있습니다. 다른 계정의 토큰은 사용할 수 없습니다.', 'WRONG_OWNER');
      }
      const repo = await this.#request(this.#repoPath);
      if (repo.permissions?.push !== true) {
        throw new GitHubStoreError('이 토큰에는 저장소 쓰기 권한이 없습니다. 소유자 계정과 저장소 Contents 읽기·쓰기 권한을 확인해 주세요.', 'READ_ONLY');
      }
      if (epoch !== this.#epoch) throw new GitHubStoreError('GitHub 연결이 해제되었습니다.', 'NOT_CONNECTED');
      this.#authenticated = true;
      return { login: user.login, ...this.#config };
    } catch (error) {
      if (epoch === this.#epoch) this.disconnect();
      throw error;
    }
  }

  async #exclusive(action) {
    this.#assertConnected();
    if (this.#busy) throw new GitHubStoreError('불러오기 또는 저장이 진행 중입니다. 완료된 후 다시 시도해 주세요.', 'BUSY');
    this.#busy = true;
    const epoch = this.#epoch;
    try { return await action(); }
    finally { if (epoch === this.#epoch) this.#busy = false; }
  }

  async #readDocument(ref) {
    const entry = await this.#request(`${this.#repoPath}/contents/${DATA_PATH}?ref=${encodeURIComponent(ref)}`);
    if (entry.type !== 'file' || entry.encoding !== 'base64' || typeof entry.content !== 'string' || entry.size > MAX_DOCUMENT_BYTES) {
      throw new GitHubStoreError('포트폴리오 JSON 파일을 읽을 수 없습니다. 파일 형식과 크기를 확인해 주세요.', 'INVALID_RESPONSE');
    }
    let document;
    try { document = JSON.parse(decodeUtf8Base64(entry.content)); }
    catch (error) {
      if (error instanceof GitHubStoreError) throw error;
      throw new GitHubStoreError('포트폴리오 JSON 문법이 올바르지 않습니다.', 'INVALID_DATA');
    }
    validatePortfolioDocument(document);
    return { document, sha: checkedSha(entry.sha) };
  }

  async load() {
    return this.#exclusive(async () => {
      const loaded = await this.#readDocument(this.#config.branch);
      this.#sha = loaded.sha;
      return loaded;
    });
  }

  async save(document, uploads = [], { expectedSha = this.#sha } = {}) {
    return this.#exclusive(async () => {
      if (!this.#sha) throw new GitHubStoreError('저장하기 전에 최신 포트폴리오를 먼저 불러와 주세요.', 'LOAD_REQUIRED');
      if (expectedSha !== this.#sha) throw conflict();
      validatePortfolioDocument(document);
      const safeUploads = validateUploads(uploads);
      // Snapshot before awaiting: later UI edits cannot change the pending commit.
      const serialized = `${JSON.stringify(document, null, 2)}\n`;
      if (new TextEncoder().encode(serialized).length > MAX_DOCUMENT_BYTES) invalid('포트폴리오 데이터는 900KB 이하여야 합니다.');
      const savedDocument = JSON.parse(serialized);
      const reference = await this.#request(`${this.#repoPath}/git/ref/heads/main`);
      const headSha = checkedSha(reference.object?.sha);
      const current = await this.#readDocument(headSha);
      if (current.sha !== expectedSha) throw conflict();
      const head = await this.#request(`${this.#repoPath}/git/commits/${headSha}`);
      const baseTree = checkedSha(head.tree?.sha);
      const entries = [];
      for (const upload of safeUploads) {
        const blob = await this.#request(`${this.#repoPath}/git/blobs`, {
          method: 'POST', body: { content: upload.base64, encoding: 'base64' },
        });
        entries.push({ path: upload.path, mode: '100644', type: 'blob', sha: checkedSha(blob.sha) });
      }
      const dataBlob = await this.#request(`${this.#repoPath}/git/blobs`, {
        method: 'POST', body: { content: encodeUtf8Base64(serialized), encoding: 'base64' },
      });
      const documentSha = checkedSha(dataBlob.sha);
      entries.push({ path: DATA_PATH, mode: '100644', type: 'blob', sha: documentSha });
      const tree = await this.#request(`${this.#repoPath}/git/trees`, {
        method: 'POST', body: { base_tree: baseTree, tree: entries },
      });
      const commit = await this.#request(`${this.#repoPath}/git/commits`, {
        method: 'POST', body: { message: 'Update portfolio content and images', tree: checkedSha(tree.sha), parents: [headSha] },
      });
      const commitSha = checkedSha(commit.sha);
      await this.#request(`${this.#repoPath}/git/refs/heads/main`, {
        method: 'PATCH', body: { sha: commitSha, force: false }, refUpdate: true,
      });
      this.#sha = documentSha;
      return { document: savedDocument, sha: documentSha, commitSha };
    });
  }
}
