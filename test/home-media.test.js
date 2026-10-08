'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../assets/home-media.js'),'utf8');
function setup(){
 const timers=new Map(),frames=[],handlers={},videos=[];let id=0,starting=false,hubHidden=false,modalOpen=false;
 const hub={classList:{contains:()=>hubHidden}},modal={classList:{contains:()=>modalOpen}};
 const document={hidden:false,body:{classList:{contains:()=>starting}},getElementById:id=>id==='game-hub'?hub:id==='loot-box-modal'?modal:null,querySelectorAll:()=>videos,createElement:()=>{const attrs={};const img={hidden:false,setAttribute:(n,v)=>attrs[n]=v,removeAttribute:n=>delete attrs[n],getAttribute:n=>attrs[n],addEventListener(){}};Object.defineProperty(img,'src',{get:()=>attrs.src,set:v=>attrs.src=v});return img;},addEventListener:(type,fn)=>handlers[type]=fn};
 const window={innerWidth:390,innerHeight:844,addEventListener:(type,fn)=>handlers[type]=fn,requestAnimationFrame:fn=>frames.push(fn),IntersectionObserver:class{observe(){}unobserve(){}},MutationObserver:class{observe(){}}};
 const ctx=vm.createContext({window,document,Promise,Map,setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id},clearTimeout:n=>timers.delete(n)});vm.runInContext(source,ctx);
 function add(top=100,deferred=true){
  const attrs={},events={},classes=new Set(),images=[];let plays=0,pauses=0;
  const v={parentElement:{appendChild:img=>images.push(img)},dataset:deferred?{src:'/assets/example.mp4'}:{},paused:true,readyState:2,isConnected:true,top,style:{},classList:{add:n=>classes.add(n),remove:n=>classes.delete(n)},getBoundingClientRect:()=>({width:300,height:70,left:0,right:300,top:v.top,bottom:v.top+70}),getAttribute:n=>attrs[n],setAttribute:(n,s)=>attrs[n]=s,removeAttribute:n=>delete attrs[n],addEventListener:(e,f)=>events[e]=f,pause(){pauses++;this.paused=true},play(){plays++;this.paused=false;return Promise.resolve()}};
  Object.defineProperty(v,'src',{get:()=>attrs.src,set:s=>attrs.src=s});videos.push(v);return{v,events,attrs,classes,images,get plays(){return plays},get pauses(){return pauses}};
 }
 return{window,document,add,videos,timers,frames,handlers,setStarting:n=>starting=n,setHubHidden:n=>hubHidden=n,setModalOpen:n=>modalOpen=n,flushFrames:()=>{while(frames.length)frames.shift()()}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('Videos never play or assign off-screen loot source during splash or background',async()=>{
 const c=setup(),a=c.add(100),b=c.add(1000);c.setStarting(true);c.window.RocketHomeMedia.sync();assert.equal(a.plays,0);assert.equal(b.attrs.src,undefined);
 c.setStarting(false);c.window.RocketHomeMedia.sync();await tick();assert.equal(a.plays,1);assert.equal(a.attrs.src,'/assets/example.mp4');assert.equal(b.plays,0);assert.equal(b.attrs.src,undefined);
 c.document.hidden=true;c.window.RocketHomeMedia.sync();assert.equal(a.v.paused,true);assert.equal(c.timers.size,0);
});
test('Scroll and back navigation only activate current visible media without seeking',async()=>{
 const c=setup(),a=c.add(100),b=c.add(950);c.window.RocketHomeMedia.sync();await tick();assert.equal(a.plays,1);
 a.v.top=-100;b.v.top=200;c.window.RocketHomeMedia.sync();await tick();assert.equal(a.v.paused,true);assert.equal(b.plays,1);
 c.setHubHidden(true);c.window.RocketHomeMedia.sync();assert.equal(b.v.paused,true);
 c.setHubHidden(false);c.window.RocketHomeMedia.sync();await tick();assert.equal(b.v.paused,false);assert.equal(b.v.currentTime,undefined);
 c.setModalOpen(true);c.window.RocketHomeMedia.sync();assert.equal(b.v.paused,true);
});
test('NotAllowedError is not spammed; real gesture can retry while preserving poster',async()=>{
 const c=setup(),a=c.add();let attempts=0;a.v.play=()=>{attempts++;return Promise.reject(Object.assign(new Error('policy'),{name:'NotAllowedError'}))};
 c.window.RocketHomeMedia.sync();await tick();c.window.RocketHomeMedia.sync();await tick();assert.equal(attempts,1);assert.equal(c.timers.size,0);assert.equal(a.v.dataset.mediaPolicyBlocked,'1');assert.equal(a.classes.has('home-media-failed'),false);
 c.window.RocketHomeMedia.sync(true);await tick();assert.equal(attempts,2);
});
test('One pending play request per video, no duplicate listeners or render loops',async()=>{
 const c=setup(),a=c.add();let resolves,attempts=0;a.v.play=()=>{attempts++;return new Promise(resolve=>resolves=resolve)};
 c.window.RocketHomeMedia.sync();c.window.RocketHomeMedia.sync();a.events.canplay();c.flushFrames();assert.equal(attempts,1);c.setStarting(true);c.window.RocketHomeMedia.sync();resolves();await tick();assert.equal(a.v.paused,true);
 assert.doesNotMatch(source,/requestVideoFrameCallback|drawImage|currentTime\s*=|setInterval/);
});
test('Media errors preserve visible poster and stop; no repeated playback loop',async()=>{
 const c=setup(),a=c.add();c.window.RocketHomeMedia.sync();await tick();a.events.error();c.window.RocketHomeMedia.sync();assert.equal(a.v.paused,true);assert.ok(a.classes.has('home-media-failed'));assert.equal(c.timers.size,0);assert.equal(a.plays,1);
});

test('Animated same-video fallback is loaded only on policy refusal and removed outside home',async()=>{
 const c=setup(),a=c.add();a.v.dataset.motionFallback='/assets/startup-motion/example.webp';a.v.play=()=>Promise.reject(Object.assign(new Error('policy'),{name:'NotAllowedError'}));
 c.setStarting(true);c.window.RocketHomeMedia.sync();assert.equal(a.images.length,0);
 c.setStarting(false);c.window.RocketHomeMedia.sync();await tick();assert.equal(a.images.length,1);assert.equal(a.images[0].src,'/assets/startup-motion/example.webp');assert.equal(a.images[0].hidden,false);
 c.setHubHidden(true);c.window.RocketHomeMedia.sync();assert.equal(a.images[0].src,undefined);assert.equal(a.images[0].hidden,true);
 c.setHubHidden(false);c.window.RocketHomeMedia.sync();assert.equal(a.images.length,1);assert.equal(a.images[0].src,'/assets/startup-motion/example.webp');
});

test('Non-policy rejection exhausts real attempt budget even across repeated lifecycle syncs',async()=>{
 const c=setup(),a=c.add();let attempts=0;a.v.play=()=>{attempts++;return Promise.reject(Object.assign(new Error('abort'),{name:'AbortError'}))};
 for(let i=0;i<20;i++){c.window.RocketHomeMedia.sync();await tick();}
 assert.equal(attempts,3);assert.equal(c.timers.size,0);
 c.window.RocketHomeMedia.sync(true);await tick();assert.equal(attempts,4);
});
