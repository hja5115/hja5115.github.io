/** Browser bridge to the loopback-only server. No GitHub credential enters the browser. */
export class LocalGitHubStore {
  #fetch;
  #nonce = '';
  #connected = false;
  #sha = null;
  #config;
  #epoch = 0;

  constructor(config = {}, { fetchImpl = globalThis.fetch } = {}) {
    this.#config = Object.freeze({ ...config });
    this.#fetch = fetchImpl;
  }

  get sha() { return this.#sha; }
  get connected() { return this.#connected; }

  async #request(path, { method = 'GET', body, nonce = this.#nonce } = {}) {
    const epoch = this.#epoch;
    let response;
    try {
      response = await this.#fetch(`/__owner/${path}`, {
        method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: {
          ...(nonce ? { 'X-Portfolio-CSRF': nonce } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (epoch !== this.#epoch) throw Object.assign(new Error('로컬 GitHub 연결이 해제되었습니다.'), { code: 'NOT_CONNECTED' });
      throw Object.assign(new Error('로컬 편집 서버에 연결하지 못했습니다. 이 PC의 미리 보기 서버가 실행 중인지 확인해 주세요.'), { code: 'LOCAL_NETWORK_ERROR' });
    }
    let result;
    try { result = await response.json(); }
    catch { throw Object.assign(new Error('로컬 편집 서버 응답을 읽지 못했습니다. 서버를 다시 실행해 주세요.'), { code: 'INVALID_RESPONSE' }); }
    if (epoch !== this.#epoch) throw Object.assign(new Error('로컬 GitHub 연결이 해제되었습니다.'), { code: 'NOT_CONNECTED' });
    if (!response.ok) throw Object.assign(new Error(result.message || '로컬 GitHub 작업을 완료하지 못했습니다.'), { code: result.error || 'LOCAL_ERROR', status: response.status });
    return result;
  }

  async authenticate() {
    this.#epoch += 1;
    this.#nonce = '';
    this.#connected = false;
    this.#sha = null;
    const session = await this.#request('session');
    if (typeof session.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(session.nonce)) {
      throw Object.assign(new Error('로컬 편집 세션을 확인하지 못했습니다.'), { code: 'INVALID_SESSION' });
    }
    this.#nonce = session.nonce;
    const account = await this.#request('authenticate', { method: 'POST', body: {} });
    if (typeof account.login !== 'string' || account.login.toLowerCase() !== String(this.#config.owner || '').toLowerCase() ||
        account.repo !== this.#config.repo) {
      await this.disconnect();
      throw Object.assign(new Error('로컬 GitHub 계정 또는 저장소가 이 사이트 설정과 다릅니다.'), { code: 'WRONG_OWNER' });
    }
    this.#connected = true;
    return account;
  }

  #assertConnected() {
    if (!this.#connected) throw Object.assign(new Error('로컬 PC GitHub 계정을 먼저 연결해 주세요.'), { code: 'NOT_CONNECTED' });
  }

  async load() {
    this.#assertConnected();
    const loaded = await this.#request('content');
    this.#sha = loaded.sha;
    return loaded;
  }

  async save(document, uploads = [], { expectedSha = this.#sha } = {}) {
    this.#assertConnected();
    const saved = await this.#request('save', { method: 'POST', body: { document, uploads, expectedSha } });
    this.#sha = saved.sha;
    return saved;
  }

  async disconnect() {
    this.#epoch += 1;
    this.#connected = false;
    this.#sha = null;
    const hadNonce = this.#nonce;
    this.#nonce = '';
    if (hadNonce) await this.#request('disconnect', { method: 'POST', body: {}, nonce: hadNonce });
  }
}
