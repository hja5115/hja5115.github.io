const canvas=document.getElementById('particle-field');
const context=canvas?.getContext('2d');
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
const fine=matchMedia('(pointer:fine)');
const ring=document.querySelector('.cursor-ring');
const dot=document.querySelector('.cursor-dot');
// Keep the red light inside the hovered image instead of behind the whole page.
document.querySelector('.pointer-aura')?.remove();
let hoveredShot=null;
let width=innerWidth,height=innerHeight,points=[],frame,lastTime=0;
const pointer={x:-1000,y:-1000,ringX:-1000,ringY:-1000,active:false};
function size(){width=innerWidth;height=innerHeight;const density=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*density);canvas.height=Math.round(height*density);canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;context.setTransform(density,0,0,density,0,0);points=Array.from({length:Math.min(85,Math.max(30,Math.round(width*height/24000)))},()=>({x:Math.random()*width,y:Math.random()*height,vx:(Math.random()-.5)*.15,vy:-.08-Math.random()*.2,r:.7+Math.random()*2.3,phase:Math.random()*Math.PI*2,red:Math.random()>.48}));}
function draw(time){context.clearRect(0,0,width,height);const elapsed=Math.min(35,time-lastTime||16)/16;lastTime=time;for(const point of points){if(!reduce.matches){point.x+=point.vx*elapsed;point.y+=point.vy*elapsed;if(point.y< -15)point.y=height+15;if(point.x< -15)point.x=width+15;if(point.x>width+15)point.x=-15;}const distance=Math.hypot(point.x-pointer.x,point.y-pointer.y);const alpha=.24+Math.sin(time*.0006+point.phase)*.13;let x=point.x,y=point.y;if(pointer.active&&distance<155&&!reduce.matches){const push=(155-distance)*.13;x+=(point.x-pointer.x)/(distance||1)*push;y+=(point.y-pointer.y)/(distance||1)*push;}context.shadowBlur=point.red?12:6;context.shadowColor=point.red?'#d14646':'#c9d6de';context.fillStyle=point.red?`rgba(218,66,66,${alpha})`:`rgba(222,231,239,${alpha*.7})`;context.beginPath();context.arc(x,y,point.r,0,Math.PI*2);context.fill();}context.shadowBlur=0;if(pointer.active&&fine.matches&&!reduce.matches){pointer.ringX+=(pointer.x-pointer.ringX)*.15;pointer.ringY+=(pointer.y-pointer.ringY)*.15;if(ring)ring.style.transform=`translate3d(${pointer.ringX}px,${pointer.ringY}px,0)`;if(dot)dot.style.transform=`translate3d(${pointer.x}px,${pointer.y}px,0)`;}if(!reduce.matches&&!document.hidden)frame=requestAnimationFrame(draw);}
function clearShot(){hoveredShot?.classList.remove('is-pointer-hovered');hoveredShot=null;}
function updateShot(event){
  const shot=fine.matches&&!reduce.matches ? event.target.closest?.('.shot-open') : null;
  if(shot!==hoveredShot){clearShot();hoveredShot=shot;}
  if(!shot)return;
  const rect=shot.getBoundingClientRect();
  shot.style.setProperty('--hover-x',`${event.clientX-rect.left}px`);
  shot.style.setProperty('--hover-y',`${event.clientY-rect.top}px`);
  shot.classList.add('is-pointer-hovered');
}
function leave(){pointer.active=false;document.body.classList.remove('pointer-present');ring?.classList.remove('is-hovering','is-pressed');clearShot();}
function restart(){cancelAnimationFrame(frame);clearShot();size();lastTime=0;document.body.classList.toggle('cursor-effects',fine.matches&&!reduce.matches);draw(performance.now());}
if(context){
  addEventListener('resize',restart,{passive:true});
  addEventListener('pointermove',event=>{if(event.pointerType==='touch'){leave();return;}pointer.x=event.clientX;pointer.y=event.clientY;if(!pointer.active){pointer.ringX=pointer.x;pointer.ringY=pointer.y;}pointer.active=true;document.body.classList.add('pointer-present');const hover=event.target.closest?.('a,button,input,textarea,select');ring?.classList.toggle('is-hovering',Boolean(hover));updateShot(event);},{passive:true});
  document.addEventListener('pointerleave',leave);
  addEventListener('blur',leave);
  addEventListener('pointerdown',()=>ring?.classList.add('is-pressed'),{passive:true});
  addEventListener('pointerup',()=>ring?.classList.remove('is-pressed'),{passive:true});
  document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(frame);if(document.hidden)leave();else restart();});
  reduce.addEventListener('change',restart);fine.addEventListener('change',restart);
  new MutationObserver(()=>{const host=document.querySelector('dialog[open]')||document.body;if(ring&&dot&&ring.parentElement!==host){host.append(ring,dot);}}).observe(document.body,{attributes:true,subtree:true,attributeFilter:['open']});
  restart();
}
