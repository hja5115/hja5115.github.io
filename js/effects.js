const canvas=document.getElementById('particle-field');
const context=canvas?.getContext('2d');
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
const fine=matchMedia('(pointer:fine)');
let hoveredShot=null;
let width=innerWidth,height=innerHeight,points=[],frame,lastTime=0;
const pointer={x:-1000,y:-1000,active:false};
function size(){width=innerWidth;height=innerHeight;const density=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*density);canvas.height=Math.round(height*density);canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;context.setTransform(density,0,0,density,0,0);points=Array.from({length:Math.min(85,Math.max(30,Math.round(width*height/24000)))},()=>({x:Math.random()*width,y:Math.random()*height,vx:(Math.random()-.5)*.15,vy:-.08-Math.random()*.2,r:.7+Math.random()*2.3,phase:Math.random()*Math.PI*2,red:Math.random()>.48}));}
function draw(time){context.clearRect(0,0,width,height);const elapsed=Math.min(35,time-lastTime||16)/16;lastTime=time;for(const point of points){if(!reduce.matches){point.x+=point.vx*elapsed;point.y+=point.vy*elapsed;if(point.y< -15)point.y=height+15;if(point.x< -15)point.x=width+15;if(point.x>width+15)point.x=-15;}const distance=Math.hypot(point.x-pointer.x,point.y-pointer.y);const alpha=.24+Math.sin(time*.0006+point.phase)*.13;let x=point.x,y=point.y;if(pointer.active&&distance<155&&!reduce.matches){const push=(155-distance)*.13;x+=(point.x-pointer.x)/(distance||1)*push;y+=(point.y-pointer.y)/(distance||1)*push;}context.shadowBlur=point.red?12:6;context.shadowColor=point.red?'#d14646':'#c9d6de';context.fillStyle=point.red?`rgba(218,66,66,${alpha})`:`rgba(222,231,239,${alpha*.7})`;context.beginPath();context.arc(x,y,point.r,0,Math.PI*2);context.fill();}context.shadowBlur=0;if(!reduce.matches&&!document.hidden)frame=requestAnimationFrame(draw);}
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
function leave(){pointer.active=false;clearShot();}
function restart(){cancelAnimationFrame(frame);clearShot();size();lastTime=0;draw(performance.now());}
if(context){
  addEventListener('resize',restart,{passive:true});
  addEventListener('pointermove',event=>{if(event.pointerType==='touch'){leave();return;}pointer.x=event.clientX;pointer.y=event.clientY;pointer.active=true;updateShot(event);},{passive:true});
  document.addEventListener('pointerleave',leave);
  addEventListener('blur',leave);
  document.addEventListener('visibilitychange',()=>{cancelAnimationFrame(frame);if(document.hidden)leave();else restart();});
  reduce.addEventListener('change',restart);fine.addEventListener('change',restart);
  restart();
}
