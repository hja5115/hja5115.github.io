import { GitHubStore } from './github-store.js';

const IMAGE_KINDS = ['UI', 'UX', 'Unity'];
const MAX_PROJECTS = 20;
const MAX_IMAGES = 80;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const identifier = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
const listText = value => Array.isArray(value) ? value.join(', ') : String(value || '');
const parseList = value => [...new Set(value.split(/[,\n]/).map(item => item.trim()).filter(Boolean))];

function field(label, value, { scope = 'project', key, type = 'text', multiline = false, hint = '', index, maxLength = 5000 } = {}) {
  const attrs = `data-scope="${scope}" data-field="${key}"${index === undefined ? '' : ` data-index="${index}"`} maxlength="${maxLength}"`;
  const input = multiline
    ? `<textarea ${attrs} rows="${key === 'intro' || key === 'body' ? 4 : 3}">${escapeHtml(value)}</textarea>`
    : `<input ${attrs} type="${type}" value="${escapeHtml(value)}" autocomplete="off">`;
  return `<label class="ed-field"><span class="ed-label">${escapeHtml(label)}</span>${input}${hint ? `<span class="ed-hint">${escapeHtml(hint)}</span>` : ''}</label>`;
}

function textError(error) {
  const message = String(error?.message || '작업을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  // Never display upstream URLs or credentials if a transport implementation includes them.
  return message.replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[인증 정보 숨김]').replace(/Bearer\s+\S+/gi, 'Bearer [숨김]');
}

function drawImage(canvas, image, width, height) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('이 브라우저에서 이미지 변환을 사용할 수 없습니다.');
  context.drawImage(image, 0, 0, width, height);
}

function canvasBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('이미지를 변환하지 못했습니다. 다른 이미지로 시도해 주세요.')), 'image/webp', quality));
}

async function readImage(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function uploadBytes(bytes, extension) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return { path: `assets/uploads/${identifier('image')}.${extension}`, base64: btoa(binary) };
}

export async function prepareUpload(file) {
  if (!/^image\/(png|jpe?g|webp|avif|gif)$/.test(file.type)) throw new Error('PNG, JPG, WebP, AVIF, GIF 이미지 파일을 선택해 주세요.');
  if (file.type === 'image/gif') {
    if (file.size > MAX_IMAGE_BYTES) throw new Error('GIF는 애니메이션을 유지할 수 있도록 2MB 이하 원본을 선택해 주세요.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))) throw new Error('올바른 GIF 파일을 선택해 주세요.');
    return uploadBytes(bytes, 'gif');
  }
  if (file.size > 24 * 1024 * 1024) throw new Error('이미지 원본은 24MB 이하로 선택해 주세요.');
  const image = await readImage(file);
  try {
    if (!image.width || !image.height) throw new Error('이미지 크기를 확인하지 못했습니다.');
    const ratio = Math.min(1, 2000 / Math.max(image.width, image.height));
    let width = Math.max(1, Math.round(image.width * ratio));
    let height = Math.max(1, Math.round(image.height * ratio));
    let blob = file.type === 'image/webp' && file.size <= MAX_IMAGE_BYTES && ratio === 1 ? file : null;
    if (!blob) {
      const canvas = document.createElement('canvas');
      for (let step = 0; step < 4 && !blob; step += 1) {
        drawImage(canvas, image, width, height);
        for (const quality of [0.9, 0.8, 0.68, 0.54, 0.42]) {
          const candidate = await canvasBlob(canvas, quality);
          if (candidate.type !== 'image/webp') throw new Error('이 브라우저는 WebP 변환을 지원하지 않습니다. WebP 파일로 다시 선택해 주세요.');
          if (candidate.size <= MAX_IMAGE_BYTES) {
            blob = candidate;
            break;
          }
        }
        width = Math.max(1, Math.round(width * 0.8));
        height = Math.max(1, Math.round(height * 0.8));
      }
      canvas.width = 0;
      canvas.height = 0;
    }
    if (!blob) throw new Error('2MB 이하로 변환하지 못했습니다. 더 작은 이미지를 선택해 주세요.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return uploadBytes(bytes, 'webp');
  } finally {
    image.close?.();
  }
}

/** Local edits use this PC's GitHub login; hosted edits keep a token in memory only. */
export async function openEditor({ document: initialDocument, config = {}, onPreview = () => {}, onClose = () => {} }) {
  const useLocalAccount = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);
  const previousFocus = document.activeElement;
  const previousOverflow = document.body.style.overflow;
  let portfolio = clone(initialDocument);
  let baseline = JSON.stringify(portfolio);
  let selectedId = portfolio.projects?.[0]?.id || '';
  let mode = 'project';
  let store = null;
  let loadedSha = null;
  let account = null;
  let busy = false;
  let closed = false;
  let previewed = false;
  let minimized = false;
  const uploads = new Map();
  const root = document.createElement('div');
  root.className = 'owner-editor';
  root.innerHTML = `<section class="ed-dialog" role="dialog" aria-modal="true" aria-labelledby="ed-title" tabindex="-1">
    <header class="ed-header"><div><p class="ed-eyebrow">OWNER WORKSPACE</p><h2 id="ed-title">포트폴리오 편집</h2></div><button class="ed-icon-button" type="button" data-action="close" aria-label="편집기 닫기">×</button></header>
    <div class="ed-status" role="status" aria-live="polite"></div><div class="ed-body"></div><footer class="ed-footer"></footer>
  </section><div class="ed-preview-bar" hidden><div><strong>저장 전 미리 보기</strong><span>이 화면은 아직 공개 사이트에 반영되지 않았습니다.</span></div><button class="ed-button ed-button--primary" type="button" data-action="resume">편집기로 돌아가기</button></div>`;
  document.body.appendChild(root);
  document.body.style.overflow = 'hidden';
  const dialog = root.querySelector('.ed-dialog');
  const body = root.querySelector('.ed-body');
  const footer = root.querySelector('.ed-footer');
  const status = root.querySelector('.ed-status');

  const currentProject = () => portfolio.projects?.find(project => project.id === selectedId);
  const isDirty = () => JSON.stringify(portfolio) !== baseline;
  const queuedUploads = () => [...uploads.values()].map(upload => ({ ...upload }));

  function announce(message, level = 'info', commitSha = '') {
    status.className = `ed-status ed-status--${level}`;
    status.textContent = message;
    if (commitSha && /^[a-f0-9]{7,64}$/i.test(commitSha)) {
      const link = document.createElement('a');
      link.href = `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/commit/${commitSha}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'GitHub 저장 내역 보기 ↗';
      status.append(' ', link);
    }
  }

  function setBusy(value) {
    busy = value;
    root.classList.toggle('ed-is-busy', value);
    body.inert = value;
    footer.inert = value;
    root.setAttribute('aria-busy', String(value));
    root.querySelector('[data-action="close"]').disabled = value;
  }

  function previewSrc(src) {
    if (uploads.has(src)) return `data:${src.toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/webp'};base64,${uploads.get(src).base64}`;
    return /^assets\/[A-Za-z0-9_./-]+$/.test(src || '') && !src.split('/').includes('..') ? src : '';
  }

  function markDirty() {
    const indicator = root.querySelector('.ed-dirty');
    if (indicator) indicator.textContent = isDirty() ? '저장하지 않은 변경 사항' : '모든 변경 사항이 저장됨';
  }

  function galleryChoices(project, selected, emptyLabel = '선택 안 함') {
    return `<option value="">${emptyLabel}</option>${(project.images || []).map((image, index) => `<option value="${escapeHtml(image.src)}"${image.src === selected ? ' selected' : ''}>${index + 1}. ${escapeHtml(image.title || image.alt || '이미지')}</option>`).join('')}`;
  }

  function imageCard(image, index) {
    const src = previewSrc(image.src);
    return `<article class="ed-image-card">
      <div class="ed-image-preview">${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(image.alt || image.title || '업로드 이미지')}" loading="lazy">` : '<span>이미지를 확인할 수 없습니다</span>'}<span class="ed-image-order">${String(index + 1).padStart(2, '0')}</span></div>
      <div class="ed-image-content"><div class="ed-card-toolbar"><span class="ed-card-label">갤러리 이미지</span><div><button type="button" class="ed-icon-button" data-action="image-up" data-index="${index}" aria-label="이미지 위로 이동"${index === 0 ? ' disabled' : ''}>↑</button><button type="button" class="ed-icon-button" data-action="image-down" data-index="${index}" aria-label="이미지 아래로 이동"${index === currentProject().images.length - 1 ? ' disabled' : ''}>↓</button><button type="button" class="ed-text-button ed-danger" data-action="image-remove" data-index="${index}">삭제</button></div></div>
      ${field('이미지 제목', image.title, { scope: 'image', key: 'title', index })}
      <label class="ed-field"><span class="ed-label">이미지 종류</span><select data-scope="image" data-field="kind" data-index="${index}">${IMAGE_KINDS.map(kind => `<option${kind === image.kind ? ' selected' : ''}>${kind}</option>`).join('')}</select></label>
      ${field('짧은 설명', image.description, { scope: 'image', key: 'description', index, multiline: true })}
      ${field('대체 텍스트', image.alt, { scope: 'image', key: 'alt', index, hint: '화면을 보지 못해도 내용을 이해할 수 있도록 적어 주세요.' })}
      <p class="ed-filepath">${escapeHtml(image.src)}</p></div></article>`;
  }

  function processCard(step, index, project) {
    return `<article class="ed-process-card"><div class="ed-card-toolbar"><span class="ed-card-label">${String(index + 1).padStart(2, '0')} / 제작 과정</span><div><button type="button" class="ed-icon-button" data-action="process-up" data-index="${index}" aria-label="과정 위로 이동"${index === 0 ? ' disabled' : ''}>↑</button><button type="button" class="ed-icon-button" data-action="process-down" data-index="${index}" aria-label="과정 아래로 이동"${index === project.process.length - 1 ? ' disabled' : ''}>↓</button><button type="button" class="ed-text-button ed-danger" data-action="process-remove" data-index="${index}">삭제</button></div></div>
      <div class="ed-two-columns">${field('단계 이름', step.label, { scope: 'process', key: 'label', index, hint: '예: 01 · 문제 발견' })}${field('제목', step.title, { scope: 'process', key: 'title', index })}</div>
      ${field('내용', step.body, { scope: 'process', key: 'body', index, multiline: true })}
      <label class="ed-field"><span class="ed-label">함께 보여줄 이미지</span><select data-scope="process" data-field="image" data-index="${index}">${galleryChoices(project, step.image)}</select></label></article>`;
  }

  function materialCard(project, key, title) {
    const path = project[key] || '';
    const src = previewSrc(path);
    const isInGallery = project.images.some(image => image.src === path);
    return `<article class="ed-process-card"><div class="ed-section-heading"><h4>${title}</h4><button class="ed-text-button ed-danger" type="button" data-action="material-remove" data-field="${key}"${path ? '' : ' disabled'}>자료 삭제</button></div>
      <div class="ed-image-preview">${src ? `<img src="${escapeHtml(src)}" alt="${title}" loading="lazy">` : '<span>자료 등록 전</span>'}</div>
      <label class="ed-field"><span class="ed-label">갤러리에서 선택</span><select data-scope="project" data-field="${key}">${path && !isInGallery ? `<option value="${escapeHtml(path)}" selected>직접 올린 자료</option>` : ''}${galleryChoices(project, path)}</select></label>
      <label class="ed-button ed-button--secondary ed-upload-label">${path ? '새 파일로 교체' : '자료 파일 추가'}<input type="file" data-upload="${key}" accept="image/png,image/jpeg,image/webp,image/avif,image/gif"></label>
      <p class="ed-filepath">${escapeHtml(path)}</p></article>`;
  }

  function renderSite() {
    const site = portfolio.site || (portfolio.site = {});
    return `<section class="ed-section"><div class="ed-section-heading"><div><p class="ed-eyebrow">PROFILE</p><h3>사이트 소개</h3></div></div><div class="ed-two-columns">
      ${field('이름', site.name, { scope: 'site', key: 'name', maxLength: 150 })}
      ${field('직무', site.role, { scope: 'site', key: 'role', maxLength: 200 })}</div>
      ${field('영문 이름', site.englishName || '', { scope: 'site', key: 'englishName', maxLength: 200 })}
      ${field('첫 화면 제목', site.headline, { scope: 'site', key: 'headline', maxLength: 500 })}
      ${field('소개', site.intro, { scope: 'site', key: 'intro', multiline: true })}
      ${field('이메일', site.email, { scope: 'site', key: 'email', type: 'email', maxLength: 254 })}
      <div class="ed-two-columns">${field('카카오 오픈채팅 주소', site.contactUrl || '', { scope: 'site', key: 'contactUrl', type: 'url', hint: 'https://open.kakao.com/o/ 로 시작하는 주소' })}${field('문의 버튼 문구', site.contactLabel || '', { scope: 'site', key: 'contactLabel', maxLength: 200, hint: '예: 카카오톡으로 이야기하기' })}</div>
      ${field('GitHub 주소 (선택)', site.github, { scope: 'site', key: 'github', type: 'url', hint: 'https://github.com/사용자명 · 비워 두어도 됩니다.' })}
      <label class="ed-field"><span class="ed-label">첫 화면 대표 이미지</span><select data-scope="site" data-field="heroImage"><option value="">선택 안 함</option>${(portfolio.projects || []).map(project => `<optgroup label="${escapeHtml(project.title)}">${(project.images || []).map(image => `<option value="${escapeHtml(image.src)}"${image.src === site.heroImage ? ' selected' : ''}>${escapeHtml(image.title || image.alt || '이미지')}</option>`).join('')}</optgroup>`).join('')}</select><span class="ed-hint">프로젝트 갤러리에 추가한 이미지에서 선택합니다.</span></label></section>`;
  }

  function renderProject() {
    const project = currentProject();
    if (!project) return '<div class="ed-empty"><span class="ed-empty-icon">＋</span><h3>첫 프로젝트를 추가해 주세요</h3><p>프로젝트의 화면과 제작 과정을 함께 정리할 수 있습니다.</p><button class="ed-button ed-button--primary" type="button" data-action="project-add">프로젝트 추가</button></div>';
    project.images ||= [];
    project.process ||= [];
    return `<section class="ed-section"><div class="ed-section-heading"><div><p class="ed-eyebrow">PROJECT DETAILS</p><h3>프로젝트 정보</h3></div><button type="button" class="ed-text-button ed-danger" data-action="project-delete">프로젝트 삭제</button></div>
      <div class="ed-two-columns">${field('프로젝트 제목', project.title, { key: 'title', maxLength: 200 })}${field('장르', project.genre, { key: 'genre', maxLength: 200 })}</div>
      ${field('한 문장 소개', project.summary, { key: 'summary', multiline: true })}
      ${field('담당 역할', project.role, { key: 'role', hint: '직접 작업한 범위를 구체적으로 적어 주세요.' })}
      <div class="ed-two-columns">${field('사용 도구', listText(project.tools), { key: 'tools', hint: '쉼표로 구분 · 예: Photoshop, Figma, Unity' })}${field('태그', listText(project.tags), { key: 'tags', hint: '쉼표로 구분 · 예: HUD, 인벤토리, UI 애니메이션' })}</div>
      <div class="ed-two-columns">${field('강조 색상', project.accent || '#69d9e7', { key: 'accent', type: 'color' })}<label class="ed-field"><span class="ed-label">대표 이미지</span><select data-scope="project" data-field="cover">${galleryChoices(project, project.cover, '첫 번째 이미지 사용')}</select></label></div>
      ${field('작동 영상 주소', project.videoUrl, { key: 'videoUrl', type: 'url', hint: 'YouTube / Vimeo 등 https:// 영상 링크. 비워 두어도 됩니다.' })}</section>
      <section class="ed-section"><div class="ed-section-heading"><div><p class="ed-eyebrow">PROJECT OVERVIEW</p><h3>요약과 제작 자료</h3></div></div>
      ${field('프로젝트 설계 요약', project.overview || '', { key: 'overview', multiline: true, maxLength: 20000, hint: '갤러리 아래에 표시할 설계 의도를 두세 문장으로 정리해 주세요. 개별 화면 설명은 이미지 확대 보기에 남습니다.' })}
      <p class="ed-section-description">왼쪽은 엔진 적용 화면 또는 GIF, 오른쪽은 리소스 자료입니다. 일반 이미지는 긴 변 2,000px, 2MB 이하 WebP로 정리하고 GIF는 2MB 이하 원본의 애니메이션을 유지합니다.</p>
      <div class="ed-two-columns">${materialCard(project, 'engineImage', '엔진 적용 자료')}${materialCard(project, 'resourceImage', '리소스 자료')}</div></section>
      <section class="ed-section"><div class="ed-section-heading"><div><p class="ed-eyebrow">SCREEN GALLERY</p><h3>화면 이미지 <span class="ed-count">${project.images.length}</span></h3></div><label class="ed-button ed-button--secondary ed-upload-label">이미지 추가<input type="file" data-upload="gallery" accept="image/png,image/jpeg,image/webp,image/avif,image/gif" multiple></label></div>
      <p class="ed-section-description">갤러리 최대 80장 · 한 번에 20장까지 저장 · 일반 이미지는 긴 변 2,000px, 2MB 이하 WebP로 정리합니다. GIF는 2MB 이하 원본으로 애니메이션을 유지합니다. 업로드는 GitHub 저장을 누를 때 진행됩니다.</p>
      <div class="ed-images-grid">${project.images.map(imageCard).join('') || '<p class="ed-empty-line">완성 화면, UX 흐름, 엔진 적용 화면을 추가해 주세요.</p>'}</div></section>
      <details class="ed-section"><summary class="ed-label">보관한 설계 메모</summary><p class="ed-section-description">기존 단계별 설명과 이미지는 이곳에 보관됩니다. 공개 화면에는 위에서 작성한 프로젝트 설계 요약을 표시합니다.</p><button class="ed-button ed-button--secondary" type="button" data-action="process-add"${project.process.length >= 40 ? ' disabled' : ''}>메모 추가</button><div class="ed-process-list">${project.process.map((step, index) => processCard(step, index, project)).join('') || '<p class="ed-empty-line">보관한 설계 메모가 없습니다.</p>'}</div></details>`;
  }

  function renderWorkspace() {
    body.innerHTML = `<div class="ed-workspace"><aside class="ed-sidebar"><div class="ed-account"><span class="ed-account-dot"></span><div><strong>${escapeHtml(account.login)}</strong><span>${escapeHtml(config.owner)}/${escapeHtml(config.repo)}</span></div></div>
      <button class="ed-nav-item${mode === 'site' ? ' is-active' : ''}" type="button" data-action="mode-site"><span>◈</span>사이트 소개</button>
      <div class="ed-sidebar-heading"><span>프로젝트</span><button class="ed-icon-button" type="button" data-action="project-add" aria-label="프로젝트 추가"${portfolio.projects.length >= MAX_PROJECTS ? ' disabled' : ''}>＋</button></div>
      <nav class="ed-project-nav" aria-label="편집할 프로젝트">${portfolio.projects.map((project, index) => `<button class="ed-nav-item${mode === 'project' && project.id === selectedId ? ' is-active' : ''}" type="button" data-action="project-select" data-id="${escapeHtml(project.id)}"><span>${String(index + 1).padStart(2, '0')}</span><span class="ed-project-name">${escapeHtml(project.title || '새 프로젝트')}</span></button>`).join('')}</nav>
      <p class="ed-sidebar-note">${useLocalAccount ? '이 PC의 GitHub 로그인으로 연결되어 있습니다. 인증 정보는 브라우저에 전달되지 않습니다.' : '인증 정보는 현재 편집기에만 유지되며 닫으면 해제됩니다.'}</p></aside><main class="ed-content">${mode === 'site' ? renderSite() : renderProject()}</main></div>`;
    footer.innerHTML = '<div class="ed-save-state"><span class="ed-dirty"></span><span class="ed-hint">저장하면 GitHub에 반영됩니다.</span></div><div class="ed-footer-actions"><button class="ed-button ed-button--ghost" type="button" data-action="backup">JSON 백업</button><button class="ed-button ed-button--secondary" type="button" data-action="preview">미리 보기</button><button class="ed-button ed-button--primary" type="button" data-action="save">GitHub에 저장</button></div>';
    markDirty();
  }

  function renderAuthentication() {
    const configured = Boolean(config.owner && config.repo);
    body.innerHTML = `<div class="ed-auth"><div class="ed-auth-mark" aria-hidden="true">⌁</div><p class="ed-eyebrow">PRIVATE EDITOR</p><h3>소유자 인증</h3><p class="ed-auth-description">GitHub 저장소의 소유자만 내용을 수정할 수 있습니다. 인증 후 저장소의 최신 내용을 불러옵니다.</p>
      ${configured ? `<div class="ed-repo-label"><span>연결할 저장소</span><strong>${escapeHtml(config.owner)}/${escapeHtml(config.repo)}</strong><small>${escapeHtml(config.branch || 'main')} · ${escapeHtml(config.dataPath || 'data/portfolio.json')}</small></div><form class="ed-auth-form">${useLocalAccount ? '<div class="ed-local-connection"><span class="ed-local-connection-mark" aria-hidden="true">⌘</span><p>이 PC의 GitHub 로그인으로 연결합니다. 인증 정보는 브라우저에 전달되지 않습니다.</p></div><button class="ed-button ed-button--primary" type="submit">로컬 PC GitHub 계정으로 연결</button>' : '<label class="ed-field"><span class="ed-label">GitHub Personal Access Token</span><input type="password" name="github-token" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="현재 편집기에만 사용합니다"></label><p class="ed-hint">이 저장소의 Contents 읽기·쓰기 권한이 있는 토큰을 사용해 주세요. 토큰은 사이트 내용이나 백업에 포함되지 않습니다.</p><button class="ed-button ed-button--primary" type="submit">인증하고 최신 내용 불러오기</button>'}</form>` : '<div class="ed-setup-message"><strong>저장소 연결 설정이 필요합니다.</strong><p>사이트 설정의 GitHub 소유자(owner)와 저장소(repo)를 지정하면 이 편집기에서 인증할 수 있습니다. 현재 공개 포트폴리오는 그대로 열람할 수 있습니다.</p></div>'}</div>`;
    footer.innerHTML = '<p class="ed-hint">공개 페이지에는 이 편집기를 안내하는 메뉴가 표시되지 않습니다.</p><button class="ed-button ed-button--secondary" type="button" data-action="close">닫기</button>';
  }

  function close({ force = false } = {}) {
    if (closed || busy) return false;
    if (!force && isDirty() && !window.confirm('저장하지 않은 변경 사항이 있습니다. 편집기를 닫을까요?')) return false;
    closed = true;
    void disconnectSafely(store);
    store = null;
    uploads.clear();
    root.remove();
    document.body.style.overflow = previousOverflow;
    document.removeEventListener('keydown', keydown, true);
    window.removeEventListener('beforeunload', beforeUnload);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    onClose({ previewed });
    return true;
  }

  async function disconnectSafely(connection) {
    try { await connection?.disconnect(); } catch { /* Closing must remain possible if the local bridge is unavailable. */ }
  }

  function resume() {
    minimized = false;
    root.classList.remove('ed-is-minimized');
    dialog.hidden = false;
    root.querySelector('.ed-preview-bar').hidden = true;
    document.body.style.overflow = 'hidden';
    root.querySelector('[data-action="preview"]')?.focus({ preventScroll: true });
  }

  function pruneUploads() {
    const paths = new Set();
    if (portfolio.site?.heroImage) paths.add(portfolio.site.heroImage);
    for (const project of portfolio.projects) {
      if (project.cover) paths.add(project.cover);
      if (project.engineImage) paths.add(project.engineImage);
      if (project.resourceImage) paths.add(project.resourceImage);
      for (const image of project.images || []) paths.add(image.src);
      for (const step of project.process || []) if (step.image) paths.add(step.image);
    }
    for (const path of uploads.keys()) if (!paths.has(path)) uploads.delete(path);
  }

  function changeField(target) {
    if (!account || busy) return;
    const { scope, field: key, index } = target.dataset;
    const allowed = {
      site: ['name', 'englishName', 'role', 'headline', 'intro', 'email', 'github', 'heroImage', 'contactUrl', 'contactLabel'],
      project: ['title', 'genre', 'summary', 'overview', 'engineImage', 'resourceImage', 'role', 'tools', 'tags', 'accent', 'videoUrl', 'cover'],
      image: ['title', 'description', 'kind', 'alt'],
      process: ['label', 'title', 'body', 'image'],
    };
    if (!allowed[scope]?.includes(key)) return;
    const project = currentProject();
    const item = scope === 'site' ? portfolio.site : scope === 'image' ? project?.images[Number(index)] : scope === 'process' ? project?.process[Number(index)] : project;
    if (!item) return;
    item[key] = key === 'tools' || key === 'tags' ? parseList(target.value) : target.value;
    if (scope === 'project' && ['engineImage', 'resourceImage'].includes(key)) {
      pruneUploads();
      renderWorkspace();
      return;
    }
    if (key === 'title' && scope === 'project') {
      const name = [...root.querySelectorAll('[data-action="project-select"]')].find(button => button.dataset.id === selectedId)?.querySelector('.ed-project-name');
      if (name) name.textContent = target.value || '새 프로젝트';
    }
    markDirty();
  }

  async function addImages(files) {
    const project = currentProject();
    if (!project || !files.length) return;
    pruneUploads();
    if (project.images.length + files.length > MAX_IMAGES) return announce('프로젝트마다 이미지를 최대 80장까지 추가할 수 있습니다.', 'error');
    if (uploads.size + files.length > 20) return announce('이미지는 한 번 저장할 때 20장까지 올릴 수 있습니다. 준비한 이미지를 먼저 저장한 뒤 추가해 주세요.', 'error');
    setBusy(true);
    let added = 0;
    try {
      for (const file of files) {
        announce(`이미지 정리 중 · ${added + 1}/${files.length}`);
        const upload = await prepareUpload(file);
        const combinedSize = [...uploads.values(), upload].reduce((sum, item) => sum + Math.floor(item.base64.length * 3 / 4), 0);
        if (combinedSize > 30 * 1024 * 1024) throw new Error('한 번에 저장할 이미지 합계가 30MB를 넘었습니다. 준비한 이미지를 먼저 저장해 주세요.');
        const title = file.name.replace(/\.[^.]+$/, '');
        uploads.set(upload.path, upload);
        project.images.push({ id: identifier('screen'), src: upload.path, title, description: '', kind: 'UI', alt: title });
        if (!project.cover) project.cover = upload.path;
        added += 1;
      }
      announce(`${added}장의 이미지를 준비했습니다. GitHub에 저장하면 사이트에 반영됩니다.`, 'success');
    } catch (error) {
      announce(`${added ? `${added}장은 준비되었습니다. ` : ''}${textError(error)}`, 'error');
    } finally {
      setBusy(false);
      renderWorkspace();
    }
  }

  async function addMaterial(file, key) {
    const project = currentProject();
    if (!project || !file || !['engineImage', 'resourceImage'].includes(key)) return;
    pruneUploads();
    if (uploads.size >= 20) return announce('이미지는 한 번 저장할 때 20장까지 올릴 수 있습니다. 준비한 이미지를 먼저 저장해 주세요.', 'error');
    setBusy(true);
    try {
      announce('자료 이미지를 준비하고 있습니다.');
      const upload = await prepareUpload(file);
      const combinedSize = [...uploads.values(), upload].reduce((sum, item) => sum + Math.floor(item.base64.length * 3 / 4), 0);
      if (combinedSize > 30 * 1024 * 1024) throw new Error('한 번에 저장할 이미지 합계가 30MB를 넘었습니다. 준비한 이미지를 먼저 저장해 주세요.');
      uploads.set(upload.path, upload);
      project[key] = upload.path;
      pruneUploads();
      announce('자료를 준비했습니다. 미리 보기로 확인한 뒤 GitHub에 저장해 주세요.', 'success');
    } catch (error) {
      announce(textError(error), 'error');
    } finally {
      setBusy(false);
      renderWorkspace();
    }
  }

  async function authenticate(event) {
    event.preventDefault();
    if (busy || !config.owner || !config.repo) return;
    const input = event.target.elements?.namedItem('github-token');
    let token = useLocalAccount ? '' : (input?.value || '').trim();
    if (input) input.value = '';
    if (!useLocalAccount && !token) return;
    setBusy(true);
    announce(useLocalAccount ? '이 PC의 GitHub 계정을 확인하고 저장소의 최신 내용을 불러오는 중입니다.' : '소유자를 확인하고 저장소의 최신 내용을 불러오는 중입니다.');
    let candidate;
    try {
      let verifiedAccount;
      if (useLocalAccount) {
        const { LocalGitHubStore } = await import('./local-store.js');
        candidate = new LocalGitHubStore(config);
        verifiedAccount = await candidate.authenticate();
      } else {
        candidate = new GitHubStore(config);
        verifiedAccount = await candidate.authenticate(token);
      }
      token = '';
      const latest = await candidate.load();
      if (!latest?.document || !Array.isArray(latest.document.projects)) throw new Error('저장소의 포트폴리오 내용을 읽지 못했습니다.');
      store = candidate;
      account = verifiedAccount;
      portfolio = clone(latest.document);
      baseline = JSON.stringify(portfolio);
      loadedSha = latest.sha;
      selectedId = portfolio.projects[0]?.id || '';
      uploads.clear();
      renderWorkspace();
      announce('최신 내용을 불러왔습니다. 변경한 뒤 미리 보기로 확인해 보세요.', 'success');
    } catch (error) {
      await disconnectSafely(candidate);
      announce(textError(error), 'error');
    } finally {
      token = '';
      setBusy(false);
    }
  }

  async function save() {
    if (!store || busy) return;
    if (!isDirty()) return announce('저장할 변경 사항이 없습니다.');
    setBusy(true);
    announce('GitHub에 저장하는 중입니다. 완료될 때까지 편집기를 열어 두세요.');
    try {
      pruneUploads();
      const result = await store.save(clone(portfolio), queuedUploads(), { expectedSha: loadedSha });
      portfolio = clone(result.document);
      baseline = JSON.stringify(portfolio);
      loadedSha = result.sha;
      uploads.clear();
      previewed = false;
      onPreview(clone(portfolio), { saved: true, uploads: [] });
      renderWorkspace();
      announce('GitHub에 저장했습니다. 공개 사이트 반영에는 잠시 시간이 걸릴 수 있습니다.', 'success', result.commitSha);
    } catch (error) {
      announce(textError(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function backup() {
    const blob = new Blob([JSON.stringify(portfolio, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'portfolio-backup.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce(uploads.size ? 'JSON 백업을 만들었습니다. 아직 저장하지 않은 새 이미지 파일은 백업에 포함되지 않습니다.' : 'JSON 백업을 만들었습니다. GitHub 저장 상태에는 변화가 없습니다.');
  }

  async function action(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled || busy) return;
    const actionName = button.dataset.action;
    if (actionName === 'close') return close();
    if (actionName === 'resume') return resume();
    if (!account) return;
    const project = currentProject();
    const index = Number(button.dataset.index);
    if (actionName === 'save') return save();
    if (actionName === 'backup') return backup();
    if (actionName === 'preview') {
      pruneUploads();
      onPreview(clone(portfolio), { uploads: queuedUploads() });
      previewed = true;
      minimized = true;
      root.classList.add('ed-is-minimized');
      dialog.hidden = true;
      root.querySelector('.ed-preview-bar').hidden = false;
      document.body.style.overflow = previousOverflow;
      root.querySelector('[data-action="resume"]').focus({ preventScroll: true });
      return;
    }
    if (actionName === 'mode-site') mode = 'site';
    if (actionName === 'project-select') {
      selectedId = button.dataset.id;
      mode = 'project';
    }
    if (actionName === 'project-add') {
      if (portfolio.projects.length >= MAX_PROJECTS) return announce('프로젝트를 최대 20개까지 추가할 수 있습니다.', 'error');
      const item = { id: identifier('project'), title: '새 프로젝트', genre: '', summary: '', overview: '', engineImage: '', resourceImage: '', role: '', tools: [], tags: [], accent: '#69d9e7', cover: '', videoUrl: '', images: [], process: [] };
      portfolio.projects.push(item);
      selectedId = item.id;
      mode = 'project';
    }
    if (actionName === 'project-delete' && project) {
      if (!window.confirm(`“${project.title}” 프로젝트를 삭제할까요? GitHub에 저장하기 전까지 공개 사이트에는 반영되지 않습니다.`)) return;
      portfolio.projects = portfolio.projects.filter(item => item.id !== project.id);
      selectedId = portfolio.projects[0]?.id || '';
      pruneUploads();
    }
    if (actionName === 'image-remove' && project?.images[index]) {
      const image = project.images[index];
      if (!window.confirm(`“${image.title || '이미지'}”를 갤러리에서 삭제할까요?`)) return;
      project.images.splice(index, 1);
      if (project.cover === image.src) project.cover = project.images[0]?.src || '';
      if (portfolio.site?.heroImage === image.src) portfolio.site.heroImage = '';
      for (const step of project.process || []) if (step.image === image.src) step.image = '';
      pruneUploads();
    }
    if (actionName === 'image-up' || actionName === 'image-down') {
      const target = index + (actionName === 'image-up' ? -1 : 1);
      if (project?.images[index] && project.images[target]) [project.images[index], project.images[target]] = [project.images[target], project.images[index]];
    }
    if (actionName === 'material-remove' && project && ['engineImage', 'resourceImage'].includes(button.dataset.field)) {
      project[button.dataset.field] = '';
      pruneUploads();
    }
    if (actionName === 'process-add' && project && project.process.length < 40) project.process.push({ id: identifier('step'), label: '', title: '', body: '', image: '' });
    if (actionName === 'process-remove' && project?.process[index]) project.process.splice(index, 1);
    if (actionName === 'process-up' || actionName === 'process-down') {
      const target = index + (actionName === 'process-up' ? -1 : 1);
      if (project?.process[index] && project.process[target]) [project.process[index], project.process[target]] = [project.process[target], project.process[index]];
    }
    renderWorkspace();
  }

  function keydown(event) {
    if (closed) return;
    if (minimized) {
      if (document.querySelector('#image-viewer[open]')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        resume();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
    if (event.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')].filter(element => element.getClientRects().length && !element.closest('[inert]'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first) {
      event.preventDefault();
      dialog.focus();
    } else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  function beforeUnload(event) {
    if (!isDirty() && !busy) return;
    event.preventDefault();
    event.returnValue = '';
  }

  root.addEventListener('click', action);
  root.addEventListener('submit', event => { if (event.target.matches('.ed-auth-form')) authenticate(event); });
  root.addEventListener('input', event => { if (event.target.matches('[data-scope]')) changeField(event.target); });
  root.addEventListener('change', event => {
    if (event.target.matches('[data-scope]')) changeField(event.target);
    if (event.target.matches('[data-upload="gallery"]')) {
      const files = [...event.target.files];
      event.target.value = '';
      addImages(files);
    }
    if (event.target.matches('[data-upload="engineImage"], [data-upload="resourceImage"]')) {
      const file = event.target.files[0];
      const key = event.target.dataset.upload;
      event.target.value = '';
      addMaterial(file, key);
    }
  });
  document.addEventListener('keydown', keydown, true);
  window.addEventListener('beforeunload', beforeUnload);
  renderAuthentication();
  requestAnimationFrame(() => (root.querySelector('input[type="password"]') || root.querySelector('.ed-auth-form button[type="submit"]') || root.querySelector('[data-action="close"]')).focus());
  return { close, getDocument: () => clone(portfolio) };
}
