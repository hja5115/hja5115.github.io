import { safeAssetPath, safeExternalUrl, escapeHtml, normalizeDocument } from './content.js';

let documentData;
let canonicalData;
let deployment;
let previewAssets = new Map();
let galleryObservers = [];
let revealObserver;
let projectObserver;
let viewerState = null;
let lastFocus;
let editorOpening = false;
let closeTimer;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = selector => document.querySelector(selector);
const h = escapeHtml;
const asset = value => previewAssets.get(value) || safeAssetPath(value);

async function boot() {
  try {
    const [dataResponse, configResponse] = await Promise.all([fetch('data/portfolio.json', { cache: 'no-cache' }), fetch('data/deployment.json', { cache: 'no-cache' })]);
    if (!dataResponse.ok) throw new Error('프로젝트 파일을 불러오지 못했습니다.');
    canonicalData = normalizeDocument(await dataResponse.json());
    deployment = configResponse.ok ? await configResponse.json() : {};
    render(canonicalData);
    bindViewer();
    bindNavigation();
    bindEditor();
  } catch (error) {
    $('#project-list').innerHTML = `<p class="error-state">${h(error.message)} 잠시 후 새로고침해 주세요.</p>`;
  }
}

export function render(input) {
  documentData = normalizeDocument(input);
  const { site, projects } = documentData;
  document.title = `${site.englishName || site.name} · Game UI/UX & Unity`;
  document.querySelectorAll('.brand-name').forEach(node => node.textContent = site.englishName || site.name);
  $('.header-discipline').textContent = site.role;
  const roleLabel = $('.hero-copy .eyebrow');
  const statusDot = document.createElement('span'); statusDot.className = 'live-dot';
  roleLabel.replaceChildren(statusDot, document.createTextNode(site.role));
  $('#hero-title').replaceChildren(...headlineNodes(site.headline));
  $('#hero-intro').textContent = site.intro;
  const heroImage = asset(site.heroImage || projects[0]?.cover || projects[0]?.images[0]?.src);
  if (heroImage) { $('#hero-image').src = heroImage; $('#hero-image').alt = `${projects[0]?.title || ''} 게임 인터페이스`; }
  $('#hero-project-name').textContent = projects.find(p => p.images.some(i => i.src === site.heroImage))?.title || projects[0]?.title || 'SELECTED WORK';
  $('.nav-count').textContent = String(projects.length).padStart(2,'0');
  galleryObservers.forEach(observer => observer.disconnect());
  galleryObservers = [];
  $('#project-list').innerHTML = projects.map(projectMarkup).join('');
  $('#project-rail').innerHTML = projects.map((p,i) => `<a href="#${h(p.id)}" aria-label="${h(p.title)}로 이동"><span class="rail-line"></span>${String(i+1).padStart(2,'0')}</a>`).join('');
  renderContact(site);
  bindGalleries();
  observeSections();
}

function headlineNodes(text) {
  const words = String(text || '플레이의 흐름을 설계합니다.').split(/\n|(?=설계합니다\.)/).filter(Boolean);
  const first = document.createTextNode(words[0].trim());
  const second = document.createElement('span');
  second.textContent = words.slice(1).join(' ').trim();
  if (!second.textContent) return [first];
  return [first, document.createElement('br'), second];
}

function projectMarkup(project, index) {
  const accent = /^#[\da-f]{6}$/i.test(project.accent) ? project.accent : '#b0e2c3';
  const video = safeExternalUrl(project.videoUrl);
  const sheet = asset(project.fullSheet);
  const leadIndex = Math.max(0, project.images.findIndex(image => image.src === project.cover));
  return `<article class="project" id="${h(project.id)}" style="--project-accent:${accent}">
    <div class="project-heading reveal"><span class="project-number">${String(index+1).padStart(2,'0')}</span><div><div class="project-title-line"><h3>${h(project.title)}</h3>${project.genre ? `<span class="genre-label">${h(project.genre)}</span>` : ''}</div><p class="project-summary">${h(project.summary)}</p><div class="project-tags">${[...new Set([...project.tags,...project.tools])].map(tag => `<span>${h(tag)}</span>`).join('')}</div></div><div class="gallery-controls"><span class="gallery-counter" data-counter="${h(project.id)}">01 / ${String(project.images.length).padStart(2,'0')}</span><button class="icon-button" data-gallery-prev="${h(project.id)}" aria-label="${h(project.title)} 이전 이미지">←</button><button class="icon-button" data-gallery-next="${h(project.id)}" aria-label="${h(project.title)} 다음 이미지">→</button></div></div>
    <div class="gallery reveal" data-gallery="${h(project.id)}" role="region" aria-label="${h(project.title)} 이미지 갤러리. 대표 이미지와 두 줄의 추가 이미지, 좌우 방향키로 이동" tabindex="0">${project.images[leadIndex] ? shotMarkup(project, project.images[leadIndex], leadIndex, true) : ''}${project.images.map((image,i) => ({image,index:i})).filter(entry => entry.index !== leadIndex).map(entry => shotMarkup(project,entry.image,entry.index)).join('')}</div>
    <section class="project-process" aria-label="${h(project.title)} UX 설계 과정"><div class="process-intro reveal"><div><p class="eyebrow">BEHIND THE INTERFACE / UX</p><h4>화면을 설계한 관점</h4></div>${sheet ? `<a class="quiet-link" href="${h(sheet)}" target="_blank" rel="noopener noreferrer">전체 시트 보기 ↗</a>` : ''}</div><div class="process-grid">${project.process.map(step => `<article class="process-card reveal"><span class="process-step">${h(step.label)}</span><h5>${h(step.title)}</h5><p>${h(step.body)}</p>${asset(step.image) ? `<img src="${h(asset(step.image))}" alt="${h(step.title)} 설계 자료" loading="lazy">` : ''}</article>`).join('')}</div>${video ? `<a class="project-video" href="${h(video)}" target="_blank" rel="noopener noreferrer"><span aria-hidden="true">▶</span> Unity / 인터랙션 작동 영상 <span aria-hidden="true">↗</span></a>` : ''}</section>
  </article>`;
}

function shotMarkup(project,image,index,lead=false){return `<figure class="shot-card${lead?' lead-shot':''}" style="margin:0"><button class="shot-open" data-project="${h(project.id)}" data-image="${index}" aria-label="${h(image.title)} 이미지와 설명 확대 보기"><span class="shot-frame"><img src="${h(asset(image.src))}" alt="${h(image.alt || image.title)}" loading="lazy" decoding="async"${image.width?` width="${Number(image.width)}" height="${Number(image.height)}"`:''}></span><span class="shot-enlarge"><span class="enlarge-label">이미지 & 설명 보기</span><span aria-hidden="true">↗</span></span></button><figcaption class="shot-caption">${h(image.title)}<span>${lead?'MAIN SCREEN':h(image.kind||'UI')} / ${String(index+1).padStart(2,'0')}</span></figcaption></figure>`;}

function renderContact(site) {
  const contact = safeExternalUrl(site.contactUrl);
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(site.email || '') ? site.email : '';
  $('#contact-actions').innerHTML = `${email ? `<a href="mailto:${h(email)}">${h(email)}</a>` : ''}${email && contact ? '<span class="contact-separator" aria-hidden="true">•</span>' : ''}${contact ? `<a href="${h(contact)}" target="_blank" rel="noopener noreferrer">카카오톡</a>` : ''}`;
  $('#copyright-year').textContent = new Date().getFullYear();
}

function bindGalleries() {
  document.querySelectorAll('.gallery').forEach(gallery => {
    const id = gallery.dataset.gallery;
    const prev = document.querySelector(`[data-gallery-prev="${CSS.escape(id)}"]`);
    const next = document.querySelector(`[data-gallery-next="${CSS.escape(id)}"]`);
    const count = document.querySelector(`[data-counter="${CSS.escape(id)}"]`);
    const columnStops = () => {
      const left = gallery.getBoundingClientRect().left;
      return [...new Set([...gallery.children].map(card => Math.round(card.getBoundingClientRect().left - left + gallery.scrollLeft)))].sort((a,b) => a-b);
    };
    const move = direction => {
      const stops = columnStops(), position = gallery.scrollLeft, maximum = gallery.scrollWidth-gallery.clientWidth;
      const target = direction > 0 ? stops.find(stop => stop > position + 3) ?? maximum : stops.findLast(stop => stop < position - 3) ?? 0;
      gallery.scrollTo({left:Math.max(0,Math.min(maximum,target)),behavior:reduceMotion?'instant':'smooth'});
    };
    prev.onclick = () => move(-1);
    next.onclick = () => move(1);
    gallery.addEventListener('keydown', event => { if (event.target !== gallery) return; if(event.key === 'ArrowRight' || event.key === 'ArrowLeft'){event.preventDefault();move(event.key === 'ArrowRight'?1:-1);} });
    const update = () => { const maximum = gallery.scrollWidth-gallery.clientWidth;prev.disabled=gallery.scrollLeft<3;next.disabled=maximum<3 || gallery.scrollLeft>=maximum-3;const left=gallery.getBoundingClientRect().left;const current=Math.max(0,[...gallery.children].findIndex(card => card.getBoundingClientRect().right > left+8))+1;count.textContent=`${String(current).padStart(2,'0')} / ${String(gallery.children.length).padStart(2,'0')}`; };
    gallery.addEventListener('scroll', update,{passive:true});
    const observer = new ResizeObserver(update);observer.observe(gallery);galleryObservers.push(observer);update();
    gallery.querySelectorAll('.shot-open').forEach(button => button.addEventListener('click', () => openViewer(id,Number(button.dataset.image),button)));
  });
}

function observeSections() {
  revealObserver?.disconnect();projectObserver?.disconnect();
  if (!reduceMotion) {
    document.body.classList.add('motion-ready');
    revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-visible');revealObserver.unobserve(entry.target);}}),{threshold:.07,rootMargin:'0px 0px -20px 0px'});
    document.querySelectorAll('.reveal').forEach(node=>revealObserver.observe(node));
  }
  projectObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(!entry.isIntersecting)return;document.querySelectorAll('.project-rail a').forEach(a=>{const active=a.hash===`#${entry.target.id}`;a.classList.toggle('active',active);if(active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});}),{rootMargin:'-15% 0px -65% 0px',threshold:0});
  document.querySelectorAll('.project').forEach(node=>projectObserver.observe(node));
}

function bindNavigation() {
  const menu=$('.mobile-menu'),navigation=$('#main-navigation');
  menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));menu.setAttribute('aria-label',open?'메뉴 닫기':'메뉴 열기');navigation.classList.toggle('open',open);});
  navigation.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','메뉴 열기');navigation.classList.remove('open');}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&navigation.classList.contains('open')){menu.click();menu.focus();}});
}

function openViewer(projectId,index,source) {
  const project=documentData.projects.find(p=>p.id===projectId);
  if(!project?.images[index])return;
  viewerState={project,index};lastFocus=source || document.activeElement;
  const dialog=$('#image-viewer');clearTimeout(closeTimer);dialog.classList.remove('closing');
  fillViewer();dialog.showModal();document.body.classList.add('modal-open');dialog.scrollTop=0;
  $('#viewer-close').focus({preventScroll:true});
  const target=$('#viewer-image');
  if(!reduceMotion && source?.querySelector('img')){
    const from=source.querySelector('img').getBoundingClientRect();
    requestAnimationFrame(()=>{const to=target.getBoundingClientRect();if(to.width&&from.width){const scale=Math.min(1.4,Math.max(.45,from.width/to.width));target.animate([{transform:`translate(${from.x+from.width/2-to.x-to.width/2}px,${from.y+from.height/2-to.y-to.height/2}px) scale(${scale})`,opacity:.55},{transform:'translate(0,0) scale(1)',opacity:1}],{duration:620,easing:'cubic-bezier(.2,.75,.25,1)'});}});
  }
}

function fillViewer(){
  const {project,index}=viewerState,image=project.images[index];
  const node=$('#viewer-image');node.src=asset(image.src);node.alt=image.alt||image.title;
  $('#viewer-project').textContent=project.title;$('#viewer-count').textContent=`${String(index+1).padStart(2,'0')} / ${String(project.images.length).padStart(2,'0')}`;
  $('#viewer-title').textContent=image.title;$('#viewer-kind').textContent=`${image.kind || 'UI'} / INTERFACE DETAIL`;
  $('#viewer-description').textContent=image.description||project.summary;
  $('#viewer-metadata').innerHTML=`<dt>PROJECT</dt><dd>${h(project.title)}</dd>${project.genre?`<dt>GENRE</dt><dd>${h(project.genre)}</dd>`:''}${project.role?`<dt>ROLE</dt><dd>${h(project.role)}</dd>`:''}${project.tools.length?`<dt>TOOLS</dt><dd>${h(project.tools.join(' · '))}</dd>`:''}`;
  $('#viewer-prev').disabled=index===0;$('#viewer-next').disabled=index===project.images.length-1;
}

function changeViewer(delta){if(!viewerState)return;const next=viewerState.index+delta;if(next<0||next>=viewerState.project.images.length)return;viewerState.index=next;fillViewer();if(!reduceMotion)$('#viewer-image').animate([{opacity:.25,transform:`translateX(${delta*18}px)`},{opacity:1,transform:'translateX(0)'}],{duration:330,easing:'ease-out'});}
function closeViewer(){const dialog=$('#image-viewer');if(!dialog.open)return;dialog.classList.add('closing');closeTimer=setTimeout(()=>{dialog.close();dialog.classList.remove('closing');document.body.classList.remove('modal-open');lastFocus?.focus({preventScroll:true});viewerState=null;},reduceMotion?0:220);}
function bindViewer(){const dialog=$('#image-viewer');$('#viewer-close').onclick=closeViewer;$('#viewer-prev').onclick=()=>changeViewer(-1);$('#viewer-next').onclick=()=>changeViewer(1);dialog.addEventListener('cancel',event=>{event.preventDefault();closeViewer();});dialog.addEventListener('click',event=>{if(event.target===dialog)closeViewer();});dialog.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'){event.preventDefault();changeViewer(-1);}if(event.key==='ArrowRight'){event.preventDefault();changeViewer(1);}if(event.key==='Tab'){const nodes=[...dialog.querySelectorAll('button,a[href]')].filter(node=>!node.disabled);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}});}

function bindEditor(){
  document.addEventListener('keydown',async event=>{
    if(!(event.ctrlKey||event.metaKey)||!event.altKey||event.code!=='KeyE')return;
    event.preventDefault();if(editorOpening)return;editorOpening=true;
    if($('#image-viewer').open){$('#image-viewer').close();document.body.classList.remove('modal-open');}
    try{
      if(!document.querySelector('link[data-editor-style]')){const link=document.createElement('link');link.rel='stylesheet';link.href='editor.css';link.dataset.editorStyle='true';document.head.append(link);}
      const {openEditor}=await import('./editor.js');
      await openEditor({document:structuredClone(canonicalData),config:deployment,onPreview:(data,options={})=>{if(options.saved)canonicalData=normalizeDocument(data);previewAssets=new Map((options.uploads||[]).map(upload=>[upload.path,`data:image/webp;base64,${upload.base64}`]));render(data);},onClose:()=>{previewAssets.clear();render(canonicalData);editorOpening=false;}});
    }catch(error){editorOpening=false;showToast(`편집기를 열지 못했습니다. ${error.message}`);}
  });
}
function showToast(message){const node=$('#toast');node.textContent=message;node.classList.add('visible');setTimeout(()=>node.classList.remove('visible'),5000);}
boot();
