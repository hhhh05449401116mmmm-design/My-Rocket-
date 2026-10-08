'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function controller(){
 const timers=new Map();let id=0,now=1000,removed=false;
 const context=vm.createContext({performance:{now:()=>now},Promise,Number,String,document:{getElementById:()=>null,querySelector:()=>({removeAttribute:()=>{removed=true}}),body:{classList:{add(){},remove(){}}}},setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id},clearTimeout:n=>timers.delete(n),keepHomeBannerVideosPlaying(){},syncTelegramBackButton(){}});
 vm.runInContext(html.slice(html.indexOf('var rocketStartupState ='),html.indexOf('        var rocketBootstrapPromise =')),context);
 return{context,timers,advance:n=>{now+=n},isRemoved:()=>removed};
}
test('Startup starts once and has an eight-second watchdog independent of network completion',()=>{
 const{context,timers}=controller();context.beginRocketStartup();const first=context.rocketStartupState.finishPromise;context.beginRocketStartup();assert.equal(context.rocketStartupState.finishPromise,first);assert.equal(timers.size,1);assert.equal([...timers.values()][0].ms,8000);
});
test('Startup does not reveal until both actual bootstrap and poster readiness complete',()=>{
 const c=controller();c.context.beginRocketStartup();c.advance(1000);c.context.markRocketBootstrapReady(true);assert.equal(c.context.rocketStartupState.finished,false);
 c.context.rocketStartupState.mediaReady=true;c.context.maybeFinishRocketStartup();assert.equal(c.context.rocketStartupState.finished,true);assert.equal(c.isRemoved(),true);
});
test('Startup watchdog reveals fallback UI without declaring authentication successful',()=>{
 const c=controller();c.context.beginRocketStartup();c.advance(8000);[...c.timers.values()][0].fn();assert.equal(c.context.rocketStartupState.finished,true);assert.equal(c.context.rocketStartupState.timedOut,true);assert.equal(c.context.rocketStartupState.authenticated,false);
});
test('Startup early completion uses a short gentle minimum, not a fixed long fake countdown',()=>{
 const c=controller();c.context.beginRocketStartup();c.context.rocketStartupState.mediaReady=true;c.context.markRocketBootstrapReady(true);assert.equal(c.context.rocketStartupState.finished,false);assert.ok([...c.timers.values()].some(t=>t.ms===650));c.advance(650);const t=[...c.timers.values()].find(t=>t.ms===650);t.fn();assert.equal(c.context.rocketStartupState.finished,true);
});
test('Image readiness cleans both listeners when image loads or fails',async()=>{
 const c=controller(),listeners=new Map(),img={complete:false,naturalWidth:0,addEventListener:(e,f)=>listeners.set(e,f),removeEventListener:e=>listeners.delete(e)};
 const p=c.context.waitForStartupImage(img);assert.equal(listeners.size,2);listeners.get('error')();assert.equal(await p,false);assert.equal(listeners.size,0);
});
test('Splash uses only Crazy Rocket identity, and first-screen buttons have same-video webp posters',()=>{
 const splash=html.slice(html.indexOf('<section id="rocket-startup"'),html.indexOf('<noscript>'));
 assert.match(splash,/Crazy Rocket/);assert.match(splash,/\/icon-180.png/);assert.doesNotMatch(splash,/Chance|ScreenRecording/);
 for(const name of ['ADJtCAFOdpAFHHbg','WddYFBEPUHJZYMlo','IlLXxhvJRWznUUZY']){
  assert.match(html,new RegExp('startup-posters/'+name+'\\.webp'));assert.ok(fs.statSync(path.join(root,'assets/startup-posters',name+'.webp')).size>5000);
 }
 assert.match(html,/class="banner-fallback-name"/);
});
test('Video decoder failures do not erase fallback and loot media stays hidden until playing',()=>{
 assert.match(html,/video\.loot-video\.loot-video-ready/);assert.match(html,/video.addEventListener\('playing', \(\) => video.classList.add\('loot-video-ready'\)\)/);
 const stop=html.slice(html.indexOf('function stopHomeBannerCanvas('),html.indexOf('function startHomeBannerCanvas('));assert.doesNotMatch(stop,/clearRect/);
 assert.match(html,/class="loot-startup-poster"/);assert.match(html,/videoPoster/);
});
test('Auxiliary scripts no longer block initial paint and signed Telegram authentication remains required',()=>{
 assert.match(html,/<script defer src="https:\/\/unpkg.com\/@tonconnect/);assert.match(html,/<script defer src="https:\/\/cdnjs/);
 assert.match(html,/if \(!initData\)/);assert.match(html,/body: JSON.stringify\(\{ initData \}\)/);
 assert.match(html,/const authenticated = await authenticateUser\(\)/);assert.match(html,/markRocketBootstrapReady\(false\)/);
});

test('Loot videos are bound synchronously immediately after rendering and recover already-playing media',()=>{
 const render=html.slice(html.indexOf('function renderLootBoxes()'),html.indexOf('let selectedLootBox'));
 assert.match(render,/grid.appendChild\(div\)/);assert.match(render,/initLootBoxVideos\(\)/);
 assert.match(html,/if \(!video.paused && video.readyState >= 2\) video.classList.add\('loot-video-ready'\)/);
});
