'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
function controller(withGift=false,reduced=false){
 const timers=new Map(),animations=[];let id=0,now=1000,removed=false;
 const node=()=>({style:{transform:''},setAttribute(){},animate(frames,timing){const a={frames,timing,cancelled:false,cancel(){this.cancelled=true}};animations.push(a);return a;}});
 const nodes=withGift?{'rocket-startup-progress':node(),'rocket-startup-gift-reveal':node(),'rocket-startup-gift-color':node()}:{};
 const context=vm.createContext({performance:{now:()=>now},Promise,Number,String,document:{getElementById:id=>nodes[id]||null,querySelector:()=>({removeAttribute:()=>{removed=true}}),body:{classList:{add(){},remove(){}}}},window:{matchMedia:()=>({matches:reduced})},getComputedStyle:()=>({transform:'matrix(1,0,0,1,0,90)'}),setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id},clearTimeout:n=>timers.delete(n),keepHomeBannerVideosPlaying(){},syncTelegramBackButton(){}});
 vm.runInContext(html.slice(html.indexOf('var rocketStartupState ='),html.indexOf('        var rocketBootstrapPromise =')),context);
 return{context,timers,nodes,animations,advance:n=>{now+=n},isRemoved:()=>removed};
}
test('Startup starts once and watchdog remains eight seconds independent of network',()=>{
 const c=controller();c.context.beginRocketStartup();const first=c.context.rocketStartupState.finishPromise;c.context.beginRocketStartup();assert.equal(c.context.rocketStartupState.finishPromise,first);assert.equal(c.timers.size,1);assert.equal([...c.timers.values()][0].ms,8000);
});
test('Bootstrap signal and poster readiness unlock UI; server authentication is not inferred from visual color',()=>{
 const c=controller();c.context.beginRocketStartup();c.advance(1000);c.context.markRocketBootstrapReady(true);assert.equal(c.context.rocketStartupState.finished,false);
 c.context.rocketStartupState.mediaReady=true;c.context.maybeFinishRocketStartup();assert.equal(c.context.rocketStartupState.finished,true);assert.equal(c.isRemoved(),true);
});
test('Watchdog never declares authentication successful',()=>{
 const c=controller();c.context.beginRocketStartup();c.advance(8000);[...c.timers.values()][0].fn();assert.equal(c.context.rocketStartupState.finished,true);assert.equal(c.context.rocketStartupState.timedOut,true);assert.equal(c.context.rocketStartupState.authenticated,false);
});
test('Fast readiness allows a one-second continuous initial fill, not a fixed long fake countdown',()=>{
 const c=controller();c.context.beginRocketStartup();c.context.rocketStartupState.mediaReady=true;c.context.markRocketBootstrapReady(true);assert.equal(c.context.rocketStartupState.finished,false);const t=[...c.timers.values()].find(t=>t.ms===1000);assert.ok(t);c.advance(1000);t.fn();assert.equal(c.context.rocketStartupState.finished,true);
});
test('Image readiness cleans load and error listeners',async()=>{
 const c=controller(),listeners=new Map(),img={complete:false,naturalWidth:0,addEventListener:(e,f)=>listeners.set(e,f),removeEventListener:e=>listeners.delete(e)};
 const p=c.context.waitForStartupImage(img);assert.equal(listeners.size,2);listeners.get('error')();assert.equal(await p,false);assert.equal(listeners.size,0);
});
test('Only Crazy Rocket, transparent pink-purple rocket and original Pink Latex appear',()=>{
 const splash=html.slice(html.indexOf('<section id="rocket-startup"'),html.indexOf('<noscript>'));
 assert.match(splash,/Crazy Rocket/);assert.match(splash,/crazy-rocket-pink-purple.webp/);assert.match(splash,/plush-pepe-pink-latex.png/);
 assert.doesNotMatch(splash,/rocket-startup-status|جاهز للانطلاق|Chance|ScreenRecording/);
 assert.ok(fs.statSync(path.join(root,'assets/startup/crazy-rocket-pink-purple.webp')).size<100000);
});
test('Same-video posters stay present and native banners keep their exact hit area and silent files',()=>{
 for(const name of ['ADJtCAFOdpAFHHbg','WddYFBEPUHJZYMlo','IlLXxhvJRWznUUZY']){
  assert.match(html,new RegExp('startup-posters/'+name+'\\.webp'));assert.ok(fs.statSync(path.join(root,'assets/startup-posters',name+'.webp')).size>5000);
 }
 assert.match(html,/aspect-ratio: 1228 \/ 314/);assert.match(html,/class="banner-fallback-name"/);
 assert.doesNotMatch(html,/-10000px|class="banner-art banner-canvas"|requestVideoFrameCallback|function drawHomeBannerFrame/);
 assert.match(html,/poster="\/assets\/startup-posters\/ADJtCAFOdpAFHHbg.webp" muted loop playsinline/);
});
test('Pepe filling uses continuous paired compositor transforms, capped short of full until actual readiness',()=>{
 const c=controller(true);c.context.beginRocketStartup();c.context.startRocketGiftFill();assert.equal(c.animations.length,2);
 assert.equal(c.animations[0].frames[0].transform,'translateY(100%)');assert.equal(c.animations[0].frames[1].transform,'translateY(8%)');
 assert.equal(c.animations[1].frames[0].transform,'translateY(-100%)');assert.equal(c.animations[1].frames[1].transform,'translateY(-8%)');
 assert.equal(c.animations[0].timing.duration,7600);assert.equal(c.context.rocketStartupState.finished,false);
 assert.doesNotMatch(html,/clip-path:inset\(calc\(\(1 - var\(--startup-completed/);
 c.context.startRocketGiftFill();assert.equal(c.animations.length,2);
});
test('Finish continues from presentation position to full color before opening; duplicate ready events cannot skip it',()=>{
 const c=controller(true);c.context.beginRocketStartup();c.context.startRocketGiftFill();c.advance(1100);c.context.rocketStartupState.mediaReady=true;c.context.markRocketBootstrapReady(true);
 assert.equal(c.context.rocketStartupState.completing,true);assert.equal(c.context.rocketStartupState.finished,false);assert.equal(c.isRemoved(),false);
 assert.ok(c.animations[0].cancelled&&c.animations[1].cancelled);assert.equal(c.animations[2].frames[0].transform,'matrix(1,0,0,1,0,90)');assert.equal(c.animations[2].frames[1].transform,'translateY(0)');
 c.context.maybeFinishRocketStartup();assert.equal(c.context.rocketStartupState.finished,false);const t=[...c.timers.values()].find(t=>t.ms===650);assert.ok(t);c.advance(650);t.fn();assert.equal(c.context.rocketStartupState.finished,true);
});
test('Reduced motion completes without unnecessary animation or long waits',()=>{
 const c=controller(true,true);c.context.beginRocketStartup();c.context.startRocketGiftFill();c.advance(1200);c.context.rocketStartupState.mediaReady=true;c.context.markRocketBootstrapReady(true);assert.equal(c.animations.length,0);assert.equal(c.context.rocketStartupState.finished,true);
});
test('Off-screen loot sources are deferred; no autoplay/pause recovery loop for every box',()=>{
 assert.match(html,/<video class="loot-video" data-src=/);assert.match(html,/preload="none"/);assert.match(html,/initLootBoxVideos\(\)/);
 assert.doesNotMatch(html,/window\.setTimeout\(function\(\)\s*\{\s*if \(video.paused\) play\(\)/);
});
test('Auxiliary scripts do not block first paint and signed Telegram authentication stays required',()=>{
 assert.match(html,/<script defer src="\/assets\/home-media.js"/);assert.match(html,/<script defer src="https:\/\/unpkg.com\/@tonconnect/);
 assert.match(html,/if \(!initData\)/);assert.match(html,/body: JSON.stringify\(\{ initData \}\)/);assert.match(html,/const authenticated = await authenticateUser\(\)/);assert.match(html,/markRocketBootstrapReady\(false\)/);
});

test('Failed signed-auth bootstrap reveals only unauthenticated fallback UI, never success',()=>{
 const c=controller();c.context.beginRocketStartup();c.advance(1200);c.context.rocketStartupState.mediaReady=true;c.context.markRocketBootstrapReady(false);
 assert.equal(c.context.rocketStartupState.authenticated,false);assert.equal(c.context.rocketStartupState.finished,true);
 const boot=html.slice(html.indexOf('async function runRocketBootstrap()'),html.indexOf("document.addEventListener('visibilitychange'",html.indexOf('async function runRocketBootstrap()')));
 assert.match(boot,/if \(!authenticated\) \{[\s\S]*?setServerStatus\(false\)[\s\S]*?return;/);
});
