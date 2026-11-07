import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exerciseLocalBrowser, reopenLocalBrowser } from './standalone-local-browser-scenarios.mjs';
import { exerciseAutomaticExclusions, reopenAutomaticExclusions } from './standalone-automatic-exclusion-scenarios.mjs';
import { FIXTURE_REVISION } from './standalone-browser-provider-harness.mjs';

/** Contextual details are bounded overlays, not the former half-height sheet. */
export async function assertContextualDetailsReachable(p) {
  const proof = await p.evaluate(`(()=>{
    const panel=document.querySelector('[data-selection-details]'),last=panel.querySelector('dl > div:last-child'),close=panel.querySelector('[data-close-details]');
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const reachable=e=>{const r=e.getBoundingClientRect(),v=panel.getBoundingClientRect();return e.checkVisibility()&&r.width>0&&r.height>0&&r.left>=v.left&&r.right<=v.right&&r.top>=v.top&&r.bottom<=v.bottom&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));};
    last.scrollIntoView({block:'nearest'});
    const lastReachable=reachable(last),scrollTop=panel.scrollTop;
    close.scrollIntoView({block:'nearest'});
    return {panel:rect(panel),toolbar:rect(document.querySelector('[data-city-tools]')),viewport:{width:innerWidth,height:innerHeight},visible:panel.checkVisibility(),horizontalOverflow:document.documentElement.scrollWidth>innerWidth||panel.scrollWidth>panel.clientWidth,lastReachable,closeReachable:reachable(close),scrollTop};
  })()`);
  assert.ok(proof.visible&&!proof.horizontalOverflow&&proof.panel.left>=0&&proof.panel.right<=proof.viewport.width&&proof.panel.top>=proof.toolbar.bottom&&proof.panel.bottom<=proof.viewport.height&&proof.lastReachable&&proof.closeReachable,'contextual details must be bounded, below tools, scrollable and uncovered: '+JSON.stringify(proof));
  return proof;
}

/** Bounded presentation acceptance using the packaged app and the existing synthetic provider. */
export async function exerciseWorkspace({page,cdp,harness,origin,request,checked,evidenceDirectory,restart,expectEmpty=true}) {
  assert.ok(evidenceDirectory, 'Workspace evidence needs an explicit output directory');
  await mkdir(evidenceDirectory,{recursive:true});
  const p=await page(); const proofs=[],headerProof=[];
  await cdp.send('Page.bringToFront',{},p.sessionId);
  const settled=()=>p.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  const shot=async (name,target=p)=>{await target.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');const clip=await target.evaluate('({x:0,y:0,width:innerWidth,height:innerHeight,scale:1})');const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip},target.sessionId);await writeFile(path.join(evidenceDirectory,name+'.png'),Buffer.from(data,'base64'));};
  // Compare the unobscured city pixels, not just canvas dimensions or uniforms.
  const cityPixels=async()=>{
    const clip=await p.evaluate(`(()=>{const r=document.querySelector('[data-city] canvas').getBoundingClientRect(),y=Math.ceil(Math.max(r.top+160,r.top+r.height*.4));return {x:Math.ceil(r.left)+1,y,width:Math.floor(r.width)-2,height:Math.floor(r.bottom)-y-1,scale:1};})()`);
    const {data}=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip},p.sessionId);
    return createHash('sha256').update(Buffer.from(data,'base64')).digest('hex');
  };
  const geometry=()=>p.evaluate(`(()=>{const c=document.querySelector('[data-city] canvas'),r=c.getBoundingClientRect();return {rect:[r.x,r.y,r.width,r.height],buffer:[c.width,c.height],matrix:window.__render.matrices.at(-1),uploads:window.__render.uploads};})()`);
  const fits=async()=>{assert.equal(await p.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight`),true,'workspace overflows viewport');};
  const sourceMeasurement=(target=p)=>target.evaluate(`(()=>{
    const bounds=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {rect:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},clientHeight:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop,overflowX:s.overflowX,overflowY:s.overflowY};};
    const read=selector=>bounds(document.querySelector(selector));
    return {viewport:{width:innerWidth,height:innerHeight},helpOpen:document.querySelector('[data-owned-contributions] details').open,
      dialog:read('[data-unit-source]'),body:read('[data-source-body]'),sourceSection:read('[data-source-body]>section:first-child'),code:read('[data-source-code]'),contributionRegion:read('[data-owned-contributions]'),list:read('[data-contribution-rows]'),
      focus:(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),identify=e=>e?{tag:e.tagName,id:e.id,data:{...e.dataset}}:null,ancestors=[];for(let a=e;a;a=a.parentElement)ancestors.push({element:identify(a),...bounds(a),scrollLeft:a.scrollLeft,clientWidth:a.clientWidth,scrollWidth:a.scrollWidth});return {element:identify(e),centerHit:identify(hit),containsCenterHit:e.contains(hit),ancestors};})(),
      controls:[...document.querySelectorAll('[data-source-title], [data-unit-details], [data-source-paging], [data-owned-contributions]>:not([data-contribution-rows]), [data-owned-contributions] button, [data-contribution-scope]')].map(e=>({tag:e.tagName,text:e.textContent,...bounds(e)}))};
  })()`);
  const recordSource=async(name,target=p)=>{const measurement=await sourceMeasurement(target);await writeFile(path.join(evidenceDirectory,name+'-proof.json'),JSON.stringify(measurement,null,2)+'\n');return measurement;};
  const pointer=async selector=>{const r=await p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);for(const type of ['mouseMoved','mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,...r,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})},p.sessionId);};
  const key=async(key,code,n,modifiers=0)=>{await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n,modifiers,...(key==='Enter'?{text:'\r'}:{})},p.sessionId);await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n,modifiers},p.sessionId);};
  const run=async(mode,predicate,exclusions='')=>{process.stdout.write('Workspace: '+mode+'\n');harness.setMode(mode);await p.submit(undefined,exclusions);return p.wait(predicate);};
  const openFind=async()=>{if(await p.evaluate(`document.querySelector('[data-workspace-navigation]').hidden`))await pointer('[data-navigation-toggle]');};
  const selectFile=async name=>{await openFind();await p.click('#workspace-files-tab');await p.evaluate(`[...document.querySelectorAll('[data-analyzed-rows] button')].find(b=>b.querySelector('bdi').textContent===${JSON.stringify(name)}).click();true`);};
  await p.evaluate(`(()=>{window.__inspectionCalls=[];const send=Worker.prototype.postMessage;Worker.prototype.postMessage=function(message,...rest){if(message.type==='INSPECT'){window.__inspectionCalls.push(message.query);if(window.__rejectUnits&&message.query.type==='units'){queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:{type:'INSPECTION_RESULT',sessionId:message.sessionId,generation:message.generation,requestId:message.requestId,ok:false}})));return;}}return send.call(this,message,...rest);};return true;})()`);
  await fits();await shot('desktop-empty');
  await p.click('[data-open-saved]');await p.evaluate(`new Promise(resolve=>{const check=()=>{if(document.querySelector('[data-saved-message]').textContent==='No saved investigations yet.'||document.querySelectorAll('[data-saved-projects] button').length){o.disconnect();resolve(true);}};const o=new MutationObserver(check);o.observe(document.querySelector('[data-saved-picker]'),{childList:true,subtree:true});check();})`);
  assert.equal(await p.evaluate(`document.querySelector('[data-saved-message]').textContent==='No saved investigations yet.'`),expectEmpty,'initial saved inventory state');await p.click('[data-close-saved]');
  await p.submit('invalid');await p.wait(s=>s.feedback==='Invalid input');assert.equal((await p.snapshot()).setup,true);
  await run('districts',s=>s.canvases===1&&s.analyzed===5);await settled();await fits();await shot('desktop-completed');
  const initial=await geometry();
  assert.equal((await p.snapshot()).sourceIdentity,'Commit: '+FIXTURE_REVISION);
  const headerState=()=>p.evaluate(`({name:document.querySelector('[data-repository]').textContent,title:document.querySelector('[data-repository]').title,removed:document.querySelectorAll('[data-origin-identity],[data-origin-label],[data-commit],[data-investigation] output').length,links:document.querySelectorAll('[data-investigation] a,[data-save-status] a').length,status:document.querySelector('[data-save-status]').textContent,time:document.querySelector('[data-save-status]').title,url:location.href})`);
  const headerWork=()=>p.evaluate(`({calls:window.__inspectionCalls.length,matrices:window.__render.matrices.length,frames:window.__render.frames.length,uploads:window.__render.uploads})`);
  const beforeTitle=await geometry(),titleWork=await headerWork(),titleNetwork=harness.requests.length,titleEvents=harness.events.length;
  for(const [width,height] of [[1365,900],[390,844]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800},p.sessionId);await settled();
    const before=await geometry(),work=await headerWork();
    const point=await p.evaluate(`(()=>{const r=document.querySelector('[data-repository]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point},p.sessionId);await settled();
    const state=await headerState();assert.equal(state.title,'Commit: '+FIXTURE_REVISION);assert.equal(state.removed,0);assert.equal(state.links,0);assert.equal(state.status,'');assert.equal(state.time,'');
    assert.deepEqual(await geometry(),before,'project native title hover changed canvas/camera');assert.deepEqual(await headerWork(),work,'project native title hover caused work');
    headerProof.push({width,height,hover:state});await shot('header-default-'+width);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false},p.sessionId);await settled();
  assert.deepEqual(await geometry(),beforeTitle);assert.equal((await headerWork()).calls,titleWork.calls);assert.equal(harness.requests.length,titleNetwork);assert.equal(harness.events.length,titleEvents,'title hover caused worker traffic');
  // Real hover, resolved browser colors, and WCAG luminance in each product theme.
  const hoverProof=[];
  const hubPalette={light:{page:'#efefef',surface:'#f5f5f5',raised:'#e7e7e7',navigation:'#f5f5f5',header:'#004696',accent:'#1976d2'},dark:{page:'#1a1a1a',surface:'#2d2d2d',raised:'#262626',navigation:'#212121',header:'#0b1a2d',accent:'#90caf9'}};
  const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
  const contrastRatio=colors=>{const a=luminance(colors.color),b=luminance(colors.background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
  const hoverColors=async selector=>{const point=await p.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point},p.sessionId);await settled();return p.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(e);return {hover:e.matches(':hover'),color:s.color,background:s.backgroundColor};})()`);};
  // Normal packaged gate and bounded workspace run share this native-input proof.
  const toolbarProof=[];
  for (const [width,height] of [[1365,900],[390,844],[700,390]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800},p.sessionId);await settled();
    for (const theme of ['light','dark']) {
      await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]},p.sessionId);
      await pointer('[data-city-reset]'); // Establish native overview before measuring hint-only work.
      await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1},p.sessionId);
      await p.evaluate(`document.activeElement.blur();true`);await settled();
      const before=await geometry(),network=harness.requests.length;
      const work=await p.evaluate(`({calls:window.__inspectionCalls.length,matrices:window.__render.matrices.length,frames:window.__render.frames.length})`);
      assert.equal(await p.evaluate(`document.querySelector('[data-inspect-highest]').textContent`),'Inspect code');
      assert.equal(await p.evaluate(`[...document.querySelectorAll('[data-toolbar-tooltip]')].every(e=>!e.checkVisibility())`),true,'hints visible by default');
      if(width!==700)await shot('toolbar-default-'+width+'-'+theme);
      const bitmap=await cityPixels();
      for (const [selector,label,modifiers] of [['[data-navigation-toggle]','Find a file',0],['[data-city-reset]','Reset view',8]]) {
        const control=await p.evaluate(`(()=>{const b=document.querySelector('${selector}'),r=b.getBoundingClientRect(),s=b.querySelector('svg');return {name:b.getAttribute('aria-label'),width:r.width,height:r.height,hit:b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),svg:s.namespaceURI,decorative:s.getAttribute('aria-hidden'),focusable:s.getAttribute('focusable')};})()`);
        assert.ok(control.width>=44&&control.height>=44&&control.hit,JSON.stringify(control));
        assert.equal(control.name,label);assert.equal(control.svg,'http://www.w3.org/2000/svg');assert.equal(control.decorative,'true');assert.equal(control.focusable,'false');
        const hint=()=>p.evaluate(`(()=>{const b=document.querySelector('${selector}'),e=b.querySelector('[data-toolbar-tooltip]'),r=e.getBoundingClientRect(),s=getComputedStyle(e),fg=s.color.match(/[\\d.]+/g).map(Number),bg=s.backgroundColor.match(/[\\d.]+/g).map(Number),alpha=fg[3]??1;return {visible:e.checkVisibility(),text:e.textContent,hover:b.matches(':hover'),focused:document.activeElement===b,focusVisible:b.matches(':focus-visible'),color:'rgb('+fg.slice(0,3).map((v,i)=>v*alpha+bg[i]*(1-alpha)).join(',')+')',background:s.backgroundColor,inside:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};})()`);
        await hoverColors(selector);let shown=await hint();
        assert.ok(shown.visible&&shown.hover&&shown.inside&&shown.hit&&contrastRatio(shown)>=4.5,'native hover hint: '+JSON.stringify(shown));assert.equal(shown.text,label);
        if(width!==700)await shot('toolbar-hover-'+(modifiers?'reset':'find')+'-'+width+'-'+theme);
        assert.equal(await cityPixels(),bitmap,'hover changed the visible city bitmap');
        // Moving onto the hint itself must keep it available; it takes no focus.
        const point=await p.evaluate(`(()=>{const r=document.querySelector('${selector} [data-toolbar-tooltip]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        const focused=await p.evaluate(`document.activeElement.tagName`);
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point},p.sessionId);assert.equal((await hint()).visible,true);assert.equal(await p.evaluate(`document.activeElement.tagName`),focused);
        await key('Escape','Escape',27);assert.equal((await hint()).visible,false,'Escape must dismiss a hovered hint even without button focus');
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1},p.sessionId);
        // Seed an adjacent control only; the target receives actual Tab/ShiftTab.
        await p.evaluate(`document.querySelector('${modifiers?'[data-legend-disclosure] summary':'[data-inspect-highest]'}').focus();true`);
        await key('Tab','Tab',9,modifiers);await settled();shown=await hint();
        assert.ok(shown.visible&&shown.focused&&shown.focusVisible&&shown.inside&&shown.hit&&contrastRatio(shown)>=4.5,'native focus hint: '+JSON.stringify(shown));
        if(width!==700)await shot('toolbar-focus-'+(modifiers?'reset':'find')+'-'+width+'-'+theme);
        assert.equal(await cityPixels(),bitmap,'keyboard focus changed the visible city bitmap');
        await key('Escape','Escape',27);assert.equal((await hint()).visible,false);assert.equal((await hint()).focused,true);
        await key('Tab','Tab',9);assert.equal((await hint()).visible,false,'blur must hide hint');
        toolbarProof.push({width,height,theme,control,focus:shown,bitmap});
      }
      await settled();assert.deepEqual(await geometry(),before,'hints changed canvas rect/bitmap/matrix/uploads');
      assert.deepEqual(await p.evaluate(`({calls:window.__inspectionCalls.length,matrices:window.__render.matrices.length,frames:window.__render.frames.length})`),work,'hints caused source work or GPU redraw');assert.equal(harness.requests.length,network,'hints caused network');
      const ax=await cdp.send('Accessibility.getFullAXTree',{},p.sessionId);
      for(const name of ['Reset view','Find a file','Inspect code'])assert.equal(ax.nodes.filter(n=>!n.ignored&&n.role?.value==='button'&&n.name?.value===name).length,1,'single native accessible button '+name);
    }
  }
  // Existing callbacks, now through native icon pointer/Enter/Space activation.
  const actionGeometry=await geometry(),actionNetwork=harness.requests.length;
  const callsBefore=await p.evaluate('window.__inspectionCalls.length');
  for(const activation of ['click','Enter',' ']) {
    await p.evaluate(`document.querySelector('[data-inspect-highest]').focus();true`);await key('Tab','Tab',9);
    if(activation==='click')await pointer('[data-navigation-toggle]');else await key(activation,activation===' '?'Space':'Enter',activation===' '?32:13);
    assert.equal(await p.evaluate(`!document.querySelector('[data-workspace-navigation]').hidden&&document.querySelector('[data-city]').inert&&document.activeElement===document.querySelector('[data-close-navigation]')&&document.querySelector('[data-navigation-toggle]').getAttribute('aria-expanded')==='true'`),true,'Find native '+activation);
    await key('Escape','Escape',27);
    assert.equal(await p.evaluate(`document.querySelector('[data-workspace-navigation]').hidden&&!document.querySelector('[data-city]').inert&&document.activeElement===document.querySelector('[data-navigation-toggle]')`),true);
    // Native wheel changes the camera; the same Reset callback restores overview.
    const point=await p.evaluate(`(()=>{const r=document.querySelector('[data-city] canvas').getBoundingClientRect();return {x:r.x+r.width*.8,y:r.y+r.height*.75};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-120},p.sessionId);await settled();assert.notDeepEqual((await geometry()).matrix,actionGeometry.matrix,'wheel must change camera before Reset');
    await p.evaluate(`document.querySelector('[data-navigation-toggle]').focus();true`);await key('Tab','Tab',9);
    if(activation==='click')await pointer('[data-city-reset]');else await key(activation,activation===' '?'Space':'Enter',activation===' '?32:13);
    await settled();assert.deepEqual(await geometry(),actionGeometry,'Reset native '+activation+' must restore overview without upload');
  }
  assert.equal(await p.evaluate('window.__inspectionCalls.length'),callsBefore);assert.equal(harness.requests.length,actionNetwork);
  // The compact controls and labels remain usable with enlarged typography.
  await p.evaluate(`(()=>{const sheet=[...document.styleSheets].find(s=>s.href&&new URL(s.href).pathname.endsWith('/browser.css')),index=sheet.cssRules.length;sheet.insertRule('[data-city-tools] button,[data-toolbar-tooltip]{font-size:22px !important;line-height:1.6 !important}',index);window.__toolbarStress={sheet,index};return true;})()`);
  for(const [width,height] of [[390,844],[700,390],[390,390]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true},p.sessionId);await settled();await fits();
    for(const selector of ['[data-navigation-toggle]','[data-city-reset]']) {
      await hoverColors(selector);
      assert.equal(await p.evaluate(`(()=>{const b=document.querySelector('${selector}'),e=b.querySelector('[data-toolbar-tooltip]'),r=e.getBoundingClientRect();return e.checkVisibility()&&getComputedStyle(e).fontSize==='22px'&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&b.contains(document.elementFromPoint(b.getBoundingClientRect().x+22,b.getBoundingClientRect().y+22));})()`),true,'22px toolbar hint clipped');
    }
    await shot('toolbar-typography-'+width+'x'+height);
  }
  await p.evaluate(`window.__toolbarStress.sheet.deleteRule(window.__toolbarStress.index);delete window.__toolbarStress;document.activeElement.blur();true`);
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1},p.sessionId);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false},p.sessionId);await settled();assert.deepEqual(await geometry(),initial);
  await writeFile(path.join(evidenceDirectory,'toolbar-icons-proof.json'),JSON.stringify(toolbarProof,null,2)+'\n');
  for (const theme of ['light','dark']) {
    await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]},p.sessionId);
    const point=await p.evaluate(`(()=>{const r=document.querySelector('[data-inspect-highest]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point},p.sessionId);await settled();
    const colors=await p.evaluate(`(()=>{const e=document.querySelector('[data-inspect-highest]'),s=getComputedStyle(e);return {hover:e.matches(':hover'),color:s.color,background:s.backgroundColor};})()`);
    const contrast=contrastRatio(colors);
    assert.ok(colors.hover&&contrast>=4.5,theme+' hovered primary contrast: '+JSON.stringify({...colors,contrast}));
    const palette=await p.evaluate(`(()=>{const s=getComputedStyle(document.documentElement);return Object.fromEntries(['page','surface','raised','navigation','header','accent'].map(k=>[k,s.getPropertyValue('--'+k).trim()]));})()`);
    assert.deepEqual(palette,hubPalette[theme],theme+' documented Hub palette');
    assert.equal(await p.evaluate(`getComputedStyle(document.querySelector('[data-city]')).backgroundColor`),'rgb(7, 17, 31)','shell theme must not change the visualization palette');
    await shot('primary-hover-'+theme);
    await p.click('[data-change-repository]');
    const controls=[];
    for(const selector of ['form button[type=submit]','[data-source-tabs] [aria-selected=true]']){const colors=await hoverColors(selector),contrast=contrastRatio(colors);assert.ok(colors.hover&&contrast>=4.5,theme+' hovered source control: '+JSON.stringify({selector,...colors,contrast}));controls.push({selector,...colors,contrast});}
    await shot('hub-setup-'+theme);await p.click('[data-change-repository]');
    const header=await hoverColors('[data-open-saved]'),headerContrast=contrastRatio(header);
    assert.ok(header.hover&&headerContrast>=4.5,theme+' header contrast: '+JSON.stringify({...header,headerContrast}));
    hoverProof.push({theme,...colors,contrast,palette,sourceControls:controls,header:{...header,contrast:headerContrast}});
  }
  await writeFile(path.join(evidenceDirectory,'primary-hover-proof.json'),JSON.stringify(hoverProof,null,2)+'\n');
  assert.equal(await p.evaluate(`document.querySelector('[data-workspace-navigation]').hidden&&document.querySelector('[data-selection-details]').hidden&&!document.querySelector('[data-analyzed-rows] button').checkVisibility()&&document.querySelector('[data-inspect-highest]').checkVisibility()&&window.__inspectionCalls.length===0`),true);
  assert.equal(await p.evaluate(`(()=>{const before=document.activeElement;document.querySelector('[data-analyzed-query]').focus();return document.activeElement===before;})()`),true,'default hidden inventory must be inert to focus');
  assert.equal(await p.evaluate(`(()=>{const c=document.querySelector('[data-city]').getBoundingClientRect();return c.width>innerWidth*.95&&c.height>innerHeight*.65;})()`),true);
  for(const [width,height] of [[390,844],[700,390],[390,390]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true},p.sessionId);await settled();await fits();
    assert.equal(await p.evaluate(`document.querySelector('[data-workspace-navigation]').hidden&&document.querySelector('[data-selection-details]').hidden&&document.querySelector('[data-inspect-highest]').checkVisibility()`),true);
    const before=await geometry();await pointer('[data-navigation-toggle]');await shot('lookup-'+width+'x'+height);await pointer('[data-close-navigation]');await pointer('[data-legend-disclosure] summary');await pointer('[data-legend-disclosure] summary');await settled();assert.deepEqual(await geometry(),before);proofs.push({viewport:{width,height},before,afterPanels:await geometry()});await shot('default-'+width+'x'+height);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false},p.sessionId);await settled();assert.deepEqual(await geometry(),initial);assert.equal(await p.evaluate('window.__inspectionCalls.length'),0,'panel toggles made inspection RPCs');
  const panelNetwork=harness.requests.length;
  await pointer('[data-navigation-toggle]');await shot('desktop-lookup');await p.evaluate(`document.querySelector('[data-analyzed-query]').value='not-the-winner';document.querySelector('[data-analyzed-query]').dispatchEvent(new Event('input'));true`);
  await key('Escape','Escape',27);await settled();assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-navigation-toggle]')&&document.querySelector('[data-workspace-navigation]').hidden&&window.__inspectionCalls.length===0`),true);
  await pointer('[data-legend-disclosure] summary');await pointer('[data-legend-disclosure] summary');await settled();assert.deepEqual(await geometry(),initial);assert.equal(harness.requests.length,panelNetwork);
  await pointer('[data-inspect-highest]');await p.wait(s=>s.sourceReady&&s.contributions===1);await shot('desktop-code');
  assert.equal(await p.evaluate(`document.querySelector('[data-canonical-path]').textContent==='src/edge/a.js'&&document.querySelector('[data-source-code]').textContent.includes('function choose(v) { return v ? 1 : 0; }')&&document.querySelector('[data-contribution-rows] button').getAttribute('aria-current')==='true'&&document.querySelector('[data-source-code] mark').textContent==='v ? 1 : 0'`),true);
  assert.deepEqual(await p.evaluate(`window.__inspectionCalls.map(q=>({type:q.type,path:q.path,...(q.type==='units'?{offset:q.offset}: {unit:q.unit})}))`),[{type:'units',path:'src/edge/a.js',offset:0},{type:'source',path:'src/edge/a.js',unit:1},{type:'contributions',path:'src/edge/a.js',unit:1}]);
  assert.equal(await p.evaluate(`(()=>{const d=document.querySelector('[data-unit-source]'),c=document.querySelector('[data-source-code]').getBoundingClientRect(),r=document.querySelector('[data-owned-contributions]').getBoundingClientRect();return d.scrollHeight===d.clientHeight&&c.right<=r.left;})()`),true);
  await key('Escape','Escape',27);await p.wait(s=>!s.sourceOpen);assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-inspect-highest]')`),true);
  await settled();assert.deepEqual(await geometry(),initial);await shot('desktop-file');
  // Mixed native keyboard/pointer input: a hovered Reset hint cannot steal the
  // selected lookup's first Escape. Observe the real capture/bubble path.
  const mixedBefore=await geometry(),mixedNetwork=harness.requests.length;
  const mixedCalls=await p.evaluate('window.__inspectionCalls.length');
  const mixedSelection=(await p.snapshot()).selectedFile;
  await p.evaluate(`(()=>{window.__mixedEscape=[];const record=phase=>event=>{if(event.key==='Escape')window.__mixedEscape.push({phase,target:event.target.dataset.closeNavigation!==undefined?'close':event.target.tagName,prevented:event.defaultPrevented,lookupHidden:document.querySelector('[data-workspace-navigation]').hidden});};window.__mixedCapture=record('capture');window.__mixedBubble=record('lookup-bubble');document.addEventListener('keydown',window.__mixedCapture,true);document.querySelector('[data-workspace-navigation]').addEventListener('keydown',window.__mixedBubble);document.querySelector('[data-inspect-highest]').focus();return true;})()`);
  await key('Tab','Tab',9);await key('Enter','Enter',13);
  assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-close-navigation]')`),true);
  await hoverColors('[data-city-reset]');await shot('mixed-lookup-hover-reset');
  assert.equal(await p.evaluate(`!document.querySelector('[data-city-reset] [data-toolbar-tooltip]').hidden&&document.activeElement===document.querySelector('[data-close-navigation]')`),true);
  await key('Escape','Escape',27);await settled();
  const mixedProof=await p.evaluate(`({events:window.__mixedEscape,closed:document.querySelector('[data-workspace-navigation]').hidden,hintHidden:document.querySelector('[data-city-reset] [data-toolbar-tooltip]').hidden,focusReturned:document.activeElement===document.querySelector('[data-navigation-toggle]'),detailsVisible:!document.querySelector('[data-selection-details]').hidden})`);
  assert.deepEqual(mixedProof.events,[{phase:'capture',target:'close',prevented:false,lookupHidden:false},{phase:'lookup-bubble',target:'close',prevented:true,lookupHidden:true}]);
  assert.ok(mixedProof.closed&&mixedProof.hintHidden&&mixedProof.focusReturned&&mixedProof.detailsVisible);
  assert.equal((await p.snapshot()).selectedFile,mixedSelection);
  assert.deepEqual(await geometry(),mixedBefore);assert.equal(harness.requests.length,mixedNetwork);assert.equal(await p.evaluate('window.__inspectionCalls.length'),mixedCalls);
  await shot('mixed-lookup-escape-closed');
  // Escape on the hint's own native keyboard-focused button only dismisses it.
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:1,y:1},p.sessionId);
  await p.evaluate(`document.querySelector('[data-navigation-toggle]').focus();true`);await key('Tab','Tab',9);
  assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-city-reset]')&&!document.querySelector('[data-city-reset] [data-toolbar-tooltip]').hidden`),true);
  await key('Escape','Escape',27);await settled();
  mixedProof.ownFocused=await p.evaluate(`({event:window.__mixedEscape.at(-1),hintHidden:document.querySelector('[data-city-reset] [data-toolbar-tooltip]').hidden,focusRetained:document.activeElement===document.querySelector('[data-city-reset]')})`);
  assert.deepEqual(mixedProof.ownFocused,{event:{phase:'capture',target:'BUTTON',prevented:true,lookupHidden:true},hintHidden:true,focusRetained:true});
  assert.equal((await p.snapshot()).selectedFile,mixedSelection);assert.deepEqual(await geometry(),mixedBefore);assert.equal(harness.requests.length,mixedNetwork);assert.equal(await p.evaluate('window.__inspectionCalls.length'),mixedCalls);
  await writeFile(path.join(evidenceDirectory,'mixed-escape-proof.json'),JSON.stringify(mixedProof,null,2)+'\n');
  await p.evaluate(`document.removeEventListener('keydown',window.__mixedCapture,true);document.querySelector('[data-workspace-navigation]').removeEventListener('keydown',window.__mixedBubble);true`);
  await openFind();await p.evaluate(`document.querySelector('[data-analyzed-query]').value='';document.querySelector('[data-analyzed-query]').dispatchEvent(new Event('input'));document.querySelector('#workspace-files-tab').focus();true`);await key('ArrowRight','ArrowRight',39);
  assert.equal((await p.snapshot()).district,null);
  assert.equal(await p.evaluate(`document.activeElement.id==='workspace-directories-tab'`),true);
  await pointer('[data-district-rows="directories"] button');await p.wait(s=>s.district!=='/');await shot('desktop-directory');await settled();assert.deepEqual(await geometry(),initial);
  await p.evaluate(`window.__directoryRow=document.querySelector('[data-district-rows="files"] button');window.__directoryRow.click();true`);await p.wait(s=>s.selectedFile!==null);
  assert.equal(await p.evaluate(`window.__directoryRow===document.querySelector('[data-district-rows="files"] button')`),true,'file selection destroyed directory location');
  await p.click('[data-close-details]');await p.wait(s=>s.selectedFile===null&&s.district===null);await settled();assert.deepEqual(await geometry(),initial);
  const requests=harness.requests.length;
  const setupProof=[];
  for(const [width,height] of [[1365,900],[390,844]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800},p.sessionId);await settled();
    const before=await geometry(),calls=await p.evaluate('window.__inspectionCalls.length');
    await p.click('[data-change-repository]');await settled();
    // Challenge setup with a native keyboard hint behind it as well as hover.
    await p.evaluate(`document.querySelector('[data-inspect-highest]').focus();true`);await key('Tab','Tab',9);
    assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-navigation-toggle]')&&!document.querySelector('[data-navigation-toggle] [data-toolbar-tooltip]').hidden`),true);
    const measure=()=>p.evaluate(`(()=>{const form=document.querySelector('form'),heading=form.querySelector('h2');const hit=e=>{const r=e.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {text:e.textContent,visible:e.checkVisibility(),hit:e.contains(h),hitTag:h?.tagName,hitTab:h?.closest('[data-source-tabs] [role=tab]')?.id??null,focused:document.activeElement===e};};return {heading:hit(heading),tabs:[...form.querySelectorAll('[data-source-tabs] [role=tab]')].map(hit)};})()`);
    let proof=await measure();assert.ok(proof.heading.visible&&proof.heading.hit&&proof.tabs.every(t=>t.visible&&t.hit&&t.hitTab),'setup covered: '+JSON.stringify(proof));
    await shot('setup-covered-hint-'+width);
    for(const selector of ['[data-source-local]','[data-source-github]']) {
      await hoverColors(selector);proof=await measure();assert.ok(proof.tabs.every(t=>t.hit&&t.hitTab),'hover hit intercepted: '+JSON.stringify(proof));
    }
    // Actual native Tab enters the selected source tab from the header.
    await p.evaluate(`document.querySelector('[data-save]').focus();true`);await key('Tab','Tab',9);await settled();
    proof=await measure();assert.ok(proof.tabs.some(t=>t.focused&&t.hit&&t.hitTab),'source tab focus covered: '+JSON.stringify(proof));
    setupProof.push({width,height,...proof});await shot(width===1365?'desktop-source-setup':'mobile-source-setup');
    assert.deepEqual(await geometry(),before);assert.equal(await p.evaluate('window.__inspectionCalls.length'),calls);
    await pointer('[data-change-repository]');await settled();assert.deepEqual(await geometry(),before);assert.equal(harness.requests.length,requests);
  }
  await writeFile(path.join(evidenceDirectory,'source-setup-layer-proof.json'),JSON.stringify(setupProof,null,2)+'\n');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false},p.sessionId);await settled();assert.deepEqual(await geometry(),initial);
  proofs.push({desktop:initial,afterSelectionAndPanels:await geometry()});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},p.sessionId);await settled();await fits();const mobile=await geometry();await shot('mobile-city');
  await pointer('[data-navigation-toggle]');assert.equal(await p.evaluate(`document.querySelector('[data-analyzed-query]').checkVisibility()||document.querySelector('[data-district-navigation]').checkVisibility()`),true);
  await p.click('#workspace-files-tab');await pointer('[data-analyzed-rows] button');await p.wait(s=>s.units>0);await settled();assert.deepEqual(await geometry(),mobile);await fits();await shot('mobile-file');
  proofs.push({mobileFileDetails:await assertContextualDetailsReachable(p)});
  for(const [width,height] of [[700,390],[390,390]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true},p.sessionId);await settled();
    const before=await geometry(),details=await assertContextualDetailsReachable(p);
    assert.ok(details.scrollTop>0,'short details must actually scroll to reach the last metric');
    await openFind();await pointer('[data-close-navigation]');await settled();assert.deepEqual(await geometry(),before);
    proofs.push({shortFileDetails:details});
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},p.sessionId);await settled();assert.deepEqual(await geometry(),mobile);
  const selectedFile=(await p.snapshot()).selectedFile;
  await openFind();await settled();await shot('mobile-selected-lookup');
  assert.equal(await p.evaluate(`document.querySelector('[data-selection-details]').hidden&&!document.querySelector('[data-close-details]').checkVisibility()`),true);
  assert.equal((await p.snapshot()).selectedFile,selectedFile,'lookup cleared selection');
  const lookupFocus=[];
  for (const modifiers of [0,8]) {
    await p.evaluate(`document.querySelector('[data-close-navigation]').focus();true`);
    let looped=false;
    for(let step=0;step<40;step++) {
      await key('Tab','Tab',9,modifiers);await settled();
      const focus=await p.evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect();return {tag:e.tagName,details:!!e.closest('[data-selection-details]'),visible:e.checkVisibility(),hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),close:e.matches('[data-close-navigation]')};})()`);
      assert.ok(!focus.details&&focus.visible&&focus.hit,'lookup focus hidden/covered: '+JSON.stringify({modifiers,step,...focus}));lookupFocus.push({modifiers,step,...focus});
      if(focus.close){looped=true;break;}
    }
    assert.ok(looped,'native lookup traversal did not complete a loop');
  }
  await pointer('[data-close-navigation]');await settled();
  assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-navigation-toggle]')&&!document.querySelector('[data-selection-details]').hidden`),true);
  assert.equal((await p.snapshot()).selectedFile,selectedFile);
  await openFind();await p.evaluate(`[...document.querySelectorAll('[data-analyzed-rows] button')].find(b=>b.querySelector('bdi').textContent===${JSON.stringify(selectedFile)}).focus();true`);await key('Enter','Enter',13);
  assert.equal(await p.evaluate(`document.querySelector('[data-workspace-navigation]').hidden&&document.activeElement===document.querySelector('[data-inspector]')&&!document.querySelector('[data-selection-details]').hidden`),true,'same-file reveal must restore visible details focus');
  await writeFile(path.join(evidenceDirectory,'mobile-selected-lookup-focus.json'),JSON.stringify(lookupFocus,null,2)+'\n');
  await pointer('[data-unit-rows] button');await p.wait(s=>s.sourceReady);await fits();await shot('mobile-code');await key('Escape','Escape',27);await p.wait(s=>!s.sourceOpen);
  await pointer('[data-close-details]');await settled();assert.deepEqual(await geometry(),mobile);
  await openFind();await p.click('[data-browse-directories]');await p.click('[data-district-navigation] button:first-child');await p.wait(s=>s.district==='/');await p.click('[data-close-navigation]');await settled();assert.deepEqual(await geometry(),mobile);proofs.push({mobileDistrictDetails:await assertContextualDetailsReachable(p)});await shot('mobile-directory');
  // The primary path is also a single keyboard activation on mobile.
  await p.evaluate(`document.querySelector('[data-inspect-highest]').focus();true`);await key('Enter','Enter',13);await p.wait(s=>s.sourceReady&&s.contributions===1);await shot('mobile-primary-code');
  assert.equal(await p.evaluate(`document.querySelector('[data-source-code]').textContent.includes('function choose(v)')`),true);
  await key('Escape','Escape',27);await p.wait(s=>!s.sourceOpen);assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-inspect-highest]')`),true);
  await p.click('[data-close-details]');
  await p.click('[data-change-repository]');await settled();assert.deepEqual(await geometry(),mobile);await p.click('[data-change-repository]');
  proofs.push({mobile,afterSelectionAndPanels:await geometry()});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false},p.sessionId);
  await run('unit-evidence',s=>s.canvases===1&&s.analyzed>0);await selectFile('dense.js');await p.wait(s=>s.units===1);await pointer('[data-unit-rows] button');await p.wait(s=>s.sourceReady&&s.contributions===32);
  assert.equal(await p.evaluate(`(()=>{const c=document.querySelector('[data-source-code]'),r=document.querySelector('[data-contribution-rows]'),d=document.querySelector('[data-unit-source]');r.scrollTop=r.scrollHeight;window.__rows=[...r.querySelectorAll('button')];window.__scroll=r.scrollTop;window.__range=document.querySelector('[data-source-range]').textContent;return r.scrollTop>0&&c.clientHeight>300&&d.scrollHeight===d.clientHeight;})()`),true);
  const networkBefore=harness.requests.length;
  await p.evaluate(`window.__rows.at(-1).focus({preventScroll:true});true`);await key('Enter','Enter',13);await p.wait(s=>s.sourceReady&&s.contributions===32);
  assert.equal(await p.evaluate(`(()=>{const r=document.querySelector('[data-contribution-rows]');return window.__rows.every((b,i)=>b===r.querySelectorAll('button')[i])&&r.scrollTop===window.__scroll&&document.activeElement===document.querySelector('[data-source-code]')&&document.querySelector('[data-source-range]').textContent===window.__range&&document.querySelector('[data-source-code]').scrollLeft>0;})()`),true);
  await shot('desktop-code-dense');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:700,height:390,deviceScaleFactor:1,mobile:true},p.sessionId);await settled();
  const landscape=[];
  // Native scrollTop is integer-quantized while font/layout rects are fractional;
  // allow one CSS pixel at scroll edges, still requiring an uncovered center hit.
  // A stacked scroll pane may exceed its outer viewport: require a useful visible
  // intersection for that pane, but the full bounds for individual controls/rows.
  const focusedReachable=()=>p.evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),dialog=document.querySelector('[data-unit-source]'),d=dialog.getBoundingClientRect();if(e.matches('[data-owned-contributions]')){let left=Math.max(r.left,d.left),right=Math.min(r.right,d.right),top=Math.max(r.top,d.top),bottom=Math.min(r.bottom,d.bottom);for(let p=e.parentElement;p&&p!==dialog;p=p.parentElement){const s=getComputedStyle(p),v=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,v.top);bottom=Math.min(bottom,v.bottom);}if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,v.left);right=Math.min(right,v.right);}}return right-left>=100&&bottom-top>=100&&e.contains(document.elementFromPoint((left+right)/2,(top+bottom)/2));}if(!(r.width>0&&r.height>0&&r.left>=d.left&&r.right<=d.right&&r.top>=d.top&&r.bottom<=d.bottom&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))))return false;for(let p=e.parentElement;p&&p!==dialog;p=p.parentElement){const s=getComputedStyle(p),v=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowY)&&(r.top<v.top-1||r.bottom>v.bottom+1))return false;if(/auto|scroll|hidden|clip/.test(s.overflowX)&&(r.left<v.left-1||r.right>v.right+1))return false;}return true;})()`);
  const assertFocusedReachable=async name=>{const reachable=await focusedReachable();if(!reachable){const proof=await recordSource(name+'-focus-failure');await shot(name+'-focus-failure');process.stdout.write(name+' focus diagnostics: '+JSON.stringify(proof)+'\n');}assert.equal(reachable,true,name);};
  const selectedSourceProof=()=>p.evaluate(`(()=>{const c=document.querySelector('[data-source-code]'),mark=c.querySelector('mark'),r=mark.getBoundingClientRect();let left=r.left,right=r.right,top=r.top,bottom=r.bottom;const ancestors=[];for(let e=mark.parentElement;e;e=e.parentElement){const s=getComputedStyle(e),v=e.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,v.top+e.clientTop);bottom=Math.min(bottom,v.top+e.clientTop+e.clientHeight);}if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,v.left+e.clientLeft);right=Math.min(right,v.left+e.clientLeft+e.clientWidth);}ancestors.push({tag:e.tagName,data:{...e.dataset},bounds:[v.left,v.top,v.right,v.bottom],scroll:[e.scrollLeft,e.scrollTop]});if(e.matches('[data-unit-source]'))break;}const hit=document.elementFromPoint((left+right)/2,(top+bottom)/2);return {text:mark.textContent,rect:[r.left,r.top,r.right,r.bottom],clipped:[left,top,right,bottom],fullyVisible:left<=r.left&&right>=r.right&&top<=r.top&&bottom>=r.bottom,hit:mark.contains(hit),ancestors};})()`);
  const shortCamera=await geometry();
  for(const open of [false,true]) {
    // Toggle help with a real pointer. Then exercise native Tab scrolling, not DOM click().
    if(await p.evaluate(`document.querySelector('[data-owned-contributions] details').open`)!==open)await pointer('[data-owned-contributions] summary');
    assert.equal(await p.evaluate(`document.querySelector('[data-owned-contributions] details').open`),open);
    await p.evaluate(`document.querySelector('[data-close-source]').focus();true`);
    const visited=[];
    for(let step=0;step<42;step++) {
      await key('Tab','Tab',9);await settled();
      const target=await p.evaluate(`(()=>{const e=document.activeElement;return e.matches('[data-close-source]')?'close':e.matches('[data-source-code]')?'code':e.matches('[data-owned-contributions]')?'pane':e.matches('[data-contribution-scope]')?'scope':e.matches('summary')?'help':e.closest('[data-contribution-paging]')?'paging':e.hasAttribute('data-contribution')?'row':null;})()`);
      if(target){assert.equal(await focusedReachable(),true,'keyboard target clipped with help '+open+': '+target);visited.push(target);}
      if(target==='close')break;
    }
    for(const target of ['code','pane','scope','help','paging','row','close'])assert.ok(visited.includes(target),'missing keyboard target '+target);
    assert.equal(visited.filter(v=>v==='row').length,32,'Tab must reach all 32 native list rows');
    // Native keyboard paging remains usable in both help states.
    await p.evaluate(`document.querySelector('[data-contribution-paging] button:last-child').focus();true`);assert.equal(await focusedReachable(),true);
    await key('Enter','Enter',13);await p.wait(s=>s.contributionStart===33&&s.contributions===32);
    await p.evaluate(`document.querySelector('[data-contribution-paging] button:first-child').focus();true`);assert.equal(await focusedReachable(),true);
    await key('Enter','Enter',13);await p.wait(s=>s.contributionStart===1&&s.contributions===32);
    await p.evaluate(`window.__landscapeRows=[...document.querySelectorAll('[data-contribution-rows] button')];window.__landscapeRange=document.querySelector('[data-source-range]').textContent;window.__landscapeRows.at(-1).focus();true`);
    assert.equal(await focusedReachable(),true);
    const scroll=await p.evaluate(`({pane:document.querySelector('[data-owned-contributions]').scrollTop,list:document.querySelector('[data-contribution-rows]').scrollTop})`);
    await key('Enter','Enter',13);await settled();
    const selection=await p.evaluate(`(()=>{const c=document.querySelector('[data-source-code]'),r=document.querySelector('[data-contribution-rows]'),m=c.querySelector('mark').getBoundingClientRect(),v=c.getBoundingClientRect();return {focused:document.activeElement===c,identical:window.__landscapeRows.every((b,i)=>b===r.querySelectorAll('button')[i]),selected:window.__landscapeRows.at(-1).getAttribute('aria-current')==='true'&&window.__landscapeRows.at(-1).dataset.contribution==='31'&&c.querySelector('mark').textContent==='x&&x'&&document.querySelector('[data-source-body] [role=status]').textContent.includes('starts at column 156, ends before column 160'),range:document.querySelector('[data-source-range]').textContent===window.__landscapeRange,mark:[m.left,m.top,m.right,m.bottom],viewport:[v.left,v.top,v.right,v.bottom],visible:m.left>=v.left&&m.left<v.right&&m.top>=v.top&&m.top<v.bottom};})()`);
    assert.ok(selection.focused&&selection.identical&&selection.selected&&selection.range&&selection.visible,'selection must retain native rows/range and focus visible exact source: '+JSON.stringify(selection));
    assert.deepEqual(await p.evaluate(`({pane:document.querySelector('[data-owned-contributions]').scrollTop,list:document.querySelector('[data-contribution-rows]').scrollTop})`),scroll,'selection must retain both contribution scroll positions');
    assert.equal(await focusedReachable(),true,'selected source must remain reachable');
    assert.deepEqual(await geometry(),shortCamera,'landscape inspection moved camera/buffers');
    assert.equal(harness.requests.length,networkBefore,'landscape inspection made provider requests');
    const measurement=await p.evaluate(`(()=>{const d=document.querySelector('[data-unit-source]'),c=document.querySelector('[data-source-code]'),r=document.querySelector('[data-contribution-rows]'),s=document.querySelector('[data-owned-contributions]');return {helpOpen:${open},dialogHeight:d.clientHeight,dialogScrollHeight:d.scrollHeight,codeHeight:c.clientHeight,listHeight:r.clientHeight,contributionHeight:s.clientHeight,contributionScrollHeight:s.scrollHeight};})()`);
    measurement.layout=await recordSource('landscape-source-help-'+(open?'open':'closed'));
    assert.ok(measurement.codeHeight>=140&&measurement.listHeight>=120&&measurement.dialogHeight===measurement.dialogScrollHeight,'short landscape panes must have useful height: '+JSON.stringify(measurement));
    landscape.push({...measurement,visited,scroll,camera:await geometry()});
    await shot('landscape-source-help-'+(open?'open':'closed')+'-list');
    // Also capture the disclosure content at the top of the scrollable region.
    await p.evaluate(`document.querySelector('[data-owned-contributions]').scrollTop=0;true`);
    await shot('landscape-source-help-'+(open?'open':'closed'));
    await p.evaluate(`document.querySelector('[data-close-source]').focus();true`);assert.equal(await focusedReachable(),true);
    await key('Enter','Enter',13);await p.wait(s=>!s.sourceOpen);
    assert.equal(await p.evaluate(`document.activeElement===document.querySelector('[data-unit-rows] button')`),true,'Close must restore unit focus');
    await settled();assert.deepEqual(await geometry(),shortCamera);
    await key('Enter','Enter',13);await p.wait(s=>s.sourceReady&&s.contributions===32);
    assert.deepEqual(await geometry(),shortCamera,'reopening source moved camera/buffers');
  }
  await writeFile(path.join(evidenceDirectory,'landscape-source-proof.json'),JSON.stringify(landscape,null,2)+'\n');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:390,deviceScaleFactor:1,mobile:true},p.sessionId);await settled();
  const narrowCamera=await geometry(),narrow=await recordSource('narrow-short-source');
  assert.equal(await p.evaluate(`(()=>{const b=document.querySelector('[data-source-body]'),c=document.querySelector('[data-source-code]'),r=document.querySelector('[data-contribution-rows]');return b.scrollHeight>b.clientHeight&&c.clientHeight>=140&&r.clientHeight>=120;})()`),true,'narrow short screens need bounded stacked scrolling: '+JSON.stringify(narrow));
  await p.evaluate(`document.querySelector('[data-contribution-rows] li:last-child button').focus();true`);assert.equal(await focusedReachable(),true);
  await key('Enter','Enter',13);await settled();
  await recordSource('narrow-short-after-selection');
  assert.equal(await p.evaluate(`document.querySelector('[data-source-body]').scrollTop===0&&document.activeElement===document.querySelector('[data-source-code]')`),true,'narrow stacked selection must return to source');
  await assertFocusedReachable('narrow-short-code-after-selection');
  const narrowSelected=await selectedSourceProof();assert.ok(narrowSelected.text==='x&&x'&&narrowSelected.fullyVisible&&narrowSelected.hit,'narrow short exact selected span must be exposed: '+JSON.stringify(narrowSelected));
  await fits();await shot('narrow-short-source');
  // Deterministic source-parent clipping using the same trusted CSSOM technique
  // as the all-controls stress below. Enlarged source guidance makes this section
  // overflow even with Windows fonts; retain a nonzero offset across selection.
  await p.evaluate(`(()=>{const sheet=[...document.styleSheets].find(s=>s.href&&new URL(s.href).origin===location.origin&&new URL(s.href).pathname.endsWith('/browser.css')),index=sheet.cssRules.length;sheet.insertRule('[data-source-body]>section:first-child>p{font-size:22px !important;line-height:1.6 !important}',index);window.__sourceParentStress={sheet,index};document.querySelector('[data-contribution-rows] li:last-child button').focus();return true;})()`);
  const retainedOffset=await p.evaluate(`(()=>{const section=document.querySelector('[data-source-body]>section:first-child'),rows=document.querySelector('[data-contribution-rows]');section.scrollTop=1;window.__narrowRows=[...rows.querySelectorAll('button')];const c=document.querySelector('[data-source-code]').getBoundingClientRect(),v=section.getBoundingClientRect();return {section:section.scrollTop,clipped:c.top<v.top||c.bottom>v.bottom,font:getComputedStyle(section.querySelector('p')).fontSize,pane:document.querySelector('[data-owned-contributions]').scrollTop,list:rows.scrollTop,calls:window.__inspectionCalls.length,range:document.querySelector('[data-source-range]').textContent};})()`);
  assert.ok(retainedOffset.section>0&&retainedOffset.clipped&&retainedOffset.font==='22px','controlled source section must actually scroll and clip code: '+JSON.stringify(retainedOffset));
  await recordSource('narrow-short-retained-source-offset-before');await shot('narrow-short-retained-source-offset-before');
  await key('Enter','Enter',13);await settled();
  await assertFocusedReachable('narrow-short-retained-source-offset-after');
  const retainedSelected=await selectedSourceProof();assert.ok(retainedSelected.text==='x&&x'&&retainedSelected.fullyVisible&&retainedSelected.hit,'retained source offset must reveal exact span: '+JSON.stringify(retainedSelected));
  assert.equal(await p.evaluate(`(()=>{const rows=document.querySelector('[data-contribution-rows]');return window.__narrowRows.every((b,i)=>b===rows.querySelectorAll('button')[i])&&rows.scrollTop===${retainedOffset.list}&&document.querySelector('[data-owned-contributions]').scrollTop===${retainedOffset.pane}&&window.__inspectionCalls.length===${retainedOffset.calls}&&document.querySelector('[data-source-range]').textContent===${JSON.stringify(retainedOffset.range)};})()`),true,'source-parent reveal must preserve contributions, source range and RPC count');
  assert.deepEqual(await geometry(),narrowCamera,'narrow source-parent reveal moved camera/buffers');
  await recordSource('narrow-short-retained-source-offset-after');await shot('narrow-short-retained-source-offset-after');
  await writeFile(path.join(evidenceDirectory,'narrow-short-selection-proof.json'),JSON.stringify({narrowSelected,retainedOffset,retainedSelected},null,2)+'\n');
  await p.evaluate(`window.__sourceParentStress.sheet.deleteRule(window.__sourceParentStress.index);delete window.__sourceParentStress;true`);
  await p.evaluate(`document.querySelector('[data-owned-contributions] details').open=false;true`);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},p.sessionId);await settled();await fits();await shot('mobile-code-dense');
  const portrait=await recordSource('portrait-source');
  assert.equal(await p.evaluate(`document.querySelector('[data-source-code]').clientHeight>=150&&document.querySelector('[data-contribution-rows]').clientHeight>=120`),true,'mobile code and contribution panes must both be useful: '+JSON.stringify(portrait));
  // Existing same-origin external sheet CSSOM is trusted under style-src 'self'.
  // No inline style node, CSP bypass, new product route, or product policy change.
  await p.evaluate(`(()=>{const sheet=[...document.styleSheets].find(s=>s.href&&new URL(s.href).origin===location.origin&&new URL(s.href).pathname.endsWith('/browser.css'));if(!sheet)throw Error('trusted product sheet missing');const index=sheet.cssRules.length;sheet.insertRule('[data-unit-source] button,[data-source-body] p,[data-source-body] label,[data-source-body] summary,[data-contribution-rows],[data-contribution-rows] button{font-size:22px !important;line-height:1.6 !important}',index);window.__typeStress={sheet,index};return true;})()`);
  const stressProof=[];
  for(const [width,height,name] of [[390,844,'portrait'],[700,390,'landscape'],[390,390,'narrow-short']]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:true},p.sessionId);
    for(const open of [false,true]) {
      await p.evaluate(`document.querySelector('[data-owned-contributions] details').open=${open};document.querySelector('[data-owned-contributions]').scrollTop=0;true`);await settled();
      const fonts=await p.evaluate(`['[data-close-source]','[data-source-body] p','[data-source-body] summary','[data-contribution-rows]','[data-contribution-rows] button'].map(s=>({selector:s,fontSize:getComputedStyle(document.querySelector(s)).fontSize}))`);
      for(const font of fonts)assert.equal(font.fontSize,'22px','typography stress did not apply: '+font.selector);
      const nameWithState=name+'-typography-help-'+(open?'open':'closed');
      const measurement=await recordSource(nameWithState);assert.ok(measurement.list.clientHeight>=120,'stress contribution list lost its 120px reading area');
      await shot(nameWithState);
      await p.evaluate(`document.querySelector('[data-contribution-rows] li:last-child button').focus();true`);assert.equal(await focusedReachable(),true,nameWithState+' clipped contribution focus');await shot(nameWithState+'-contributions');
      await p.evaluate(`document.querySelector('[data-close-source]').focus();true`);assert.equal(await focusedReachable(),true,nameWithState+' clipped Close');
      // Stress uses actual native traversal too, including nested-pane scrolling.
      const visited=[];
      for(let step=0;step<42;step++) {
        await key('Tab','Tab',9);await settled();
        const target=await p.evaluate(`(()=>{const e=document.activeElement;return e.matches('[data-close-source]')?'close':e.matches('[data-source-code]')?'code':e.matches('[data-owned-contributions]')?'pane':e.matches('[data-contribution-scope]')?'scope':e.matches('summary')?'help':e.closest('[data-contribution-paging]')?'paging':e.hasAttribute('data-contribution')?'row':null;})()`);
        if(target){
          await assertFocusedReachable(nameWithState+'-native-'+target);visited.push(target);
        }
        if(target==='close')break;
      }
      for(const target of ['code','pane','scope','help','paging','row','close'])assert.ok(visited.includes(target),nameWithState+' missing '+target);
      assert.equal(visited.filter(v=>v==='row').length,32,nameWithState+' must reach all rows');
      // Native activation after traversal must reveal the exact selected code,
      // not merely focus an offscreen PRE inside the independently scrolled pane.
      await p.evaluate(`document.querySelector('[data-contribution-rows] li:last-child button').focus();window.__stressRows=[...document.querySelectorAll('[data-contribution-rows] button')];true`);
      const beforeSelection=await p.evaluate(`({pane:document.querySelector('[data-owned-contributions]').scrollTop,list:document.querySelector('[data-contribution-rows]').scrollTop,calls:window.__inspectionCalls.length})`);
      await key('Enter','Enter',13);await settled();await assertFocusedReachable(nameWithState+'-selected-code');
      const selected=await selectedSourceProof();assert.ok(selected.text==='x&&x'&&selected.fullyVisible&&selected.hit,nameWithState+' selected exact span clipped: '+JSON.stringify(selected));
      assert.deepEqual(await p.evaluate(`({pane:document.querySelector('[data-owned-contributions]').scrollTop,list:document.querySelector('[data-contribution-rows]').scrollTop,calls:window.__inspectionCalls.length})`),beforeSelection,nameWithState+' selection changed contribution offsets or RPC count');
      assert.equal(await p.evaluate(`window.__stressRows.every((b,i)=>b===document.querySelectorAll('[data-contribution-rows] button')[i])&&document.activeElement===document.querySelector('[data-source-code]')`),true);
      await recordSource(nameWithState+'-selected-code');await shot(nameWithState+'-selected-code');
      stressProof.push({width,height,open,fonts,listHeight:measurement.list.clientHeight,visited,selected,beforeSelection});
    }
  }
  await writeFile(path.join(evidenceDirectory,'typography-stress-proof.json'),JSON.stringify(stressProof,null,2)+'\n');
  await p.evaluate(`window.__typeStress.sheet.deleteRule(window.__typeStress.index);delete window.__typeStress;true`);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false},p.sessionId);await p.closeSource();
  await selectFile('long.js');await p.wait(s=>s.units===2);await p.click('[data-unit-rows] button');await p.wait(s=>s.sourceReady&&s.contributionMessage.includes('0 of 27'));
  await p.evaluate(`const scope=document.querySelector('[data-contribution-scope]');scope.value='unit';scope.dispatchEvent(new Event('change'));true`);await p.wait(s=>s.contributions===27);
  await p.evaluate(`window.__whole=[...document.querySelectorAll('[data-contribution-rows] button')];window.__whole[9].click();true`);await p.wait(s=>s.sourceRange.startsWith('Shown source: 1101:2'));
  assert.equal(await p.evaluate(`window.__whole.every((b,i)=>b===document.querySelectorAll('[data-contribution-rows] button')[i])&&document.activeElement===document.querySelector('[data-source-code]')`),true);
  await p.click('[data-source-paging] button:first-child');await p.wait(s=>s.sourceRange.startsWith('Shown source: 660:'));
  assert.equal(await p.evaluate(`document.querySelectorAll('[data-contribution-rows] [aria-current=true]').length`),0);assert.equal(harness.requests.length,networkBefore);await p.closeSource();
  await run('unit-evidence',s=>s.canvases===1&&s.analyzed===1,'a.js\ndense.js\nlong.js\noverlap.js');
  await selectFile('b.js');await p.wait(s=>s.units===32);await pointer('[data-unit-paging] button:last-child');await p.wait(s=>s.units===9);
  const laterStart=await p.evaluate('window.__inspectionCalls.length'),laterGeometry=await geometry();
  await pointer('[data-inspect-highest]');await p.wait(s=>s.sourceReady&&s.contributions===0);
  assert.deepEqual(await p.evaluate(`window.__inspectionCalls.slice(${laterStart}).map(q=>({type:q.type,path:q.path,...(q.type==='units'?{offset:q.offset}:{unit:q.unit})}))`),[{type:'units',path:'b.js',offset:0},{type:'source',path:'b.js',unit:0},{type:'contributions',path:'b.js',unit:0}]);
  assert.equal(await p.evaluate(`document.querySelector('[data-source-code]').textContent.includes('const f0')&&document.querySelector('[data-source-code]').textContent.includes('const f39')&&document.querySelector('[data-unit-details]').textContent.startsWith('Top-level code')`),true,'later unit page changed the direct target');
  await p.closeSource();await settled();assert.deepEqual(await geometry(),laterGeometry);
  const start=harness.events.length;harness.setMode('parser-held');await p.submit();await checked(harness.waitFor(e=>harness.events.indexOf(e)>=start&&e.kind==='parser-held'));await shot('desktop-progress');await p.click('[data-status] button');await p.wait(s=>s.status==='Cancelled'&&s.setup&&s.canvases===0);
  await run('all-failed',s=>s.failed===2&&s.canvases===0);assert.equal((await p.snapshot()).failuresOpen,false);await shot('desktop-failure');await p.click('[data-failed] summary');assert.equal(await p.evaluate(`document.querySelector('[data-failed-rows]').checkVisibility()`),true);
  await run('success',s=>s.status.includes('No supported')||s.status.includes('No files'), 'a.js\nb.ts\nc.tsx\nd.cs\nempty.js');assert.equal((await p.snapshot()).canvases,0);assert.equal((await p.snapshot()).setup,true);
  await run('success',s=>s.canvases===1&&s.analyzed===1,'a.js\nb.ts\nc.tsx\nd.cs');
  assert.equal(await p.evaluate(`document.querySelector('[data-inspect-highest]').disabled&&document.querySelector('[data-primary-inspection-status]').textContent==='No executable units to inspect.'`),true);await shot('desktop-no-units');
  await run('success',s=>s.canvases===1&&s.analyzed===5);
  await p.evaluate(`window.__rejectUnits=true;document.querySelector('[data-inspect-highest]').focus();true`);await key('Enter','Enter',13);
  await p.evaluate(`new Promise(resolve=>{const e=document.querySelector('[data-primary-inspection-status]');const check=()=>{if(e.textContent.includes('unavailable')){o.disconnect();resolve(true);}};const o=new MutationObserver(check);o.observe(e,{childList:true});check();})`);
  assert.equal(await p.evaluate(`!document.querySelector('[data-save]').disabled&&document.querySelector('[data-city] canvas').checkVisibility()&&!document.querySelector('[data-unit-source]').open&&document.querySelector('[data-primary-inspection-status]').textContent==='Inspection unavailable. Click Inspect code to retry.'`),true);await shot('desktop-inspection-error');
  await p.evaluate(`window.__rejectUnits=false;true`);
  const failedCalls=await p.evaluate('window.__inspectionCalls.length');await settled();assert.equal(await p.evaluate('window.__inspectionCalls.length'),failedCalls,'inspection retried automatically');
  await p.click('[data-save]');
  await p.evaluate(`new Promise(resolve=>{const e=document.querySelector('[data-save]');const check=()=>{if(e.textContent==='Copy link'){o.disconnect();resolve(true);}};const o=new MutationObserver(check);o.observe(e,{childList:true});check();})`);
  await pointer('[data-inspect-highest]');await p.wait(s=>s.sourceReady&&s.contributions===1);await p.closeSource();
  const savedUrl=await p.evaluate('location.href');
  const savedId=new URL(savedUrl).pathname.split('/').at(-1);
  assert.match(savedId,/^[A-Za-z0-9_-]{43}$/u);
  const recordResponse=await checked(request(origin,'/api/investigations/'+savedId+'/record'));assert.equal(recordResponse.status,200);
  const savedRecord=JSON.parse(recordResponse.body.toString('utf8'));
  const savedHeader=await headerState();assert.equal(savedHeader.status,'Saved');assert.equal(savedHeader.time,'Saved '+savedRecord.savedAt);assert.equal(savedHeader.title,'Commit: '+savedRecord.revision);assert.equal(savedHeader.links,0);assert.equal(savedHeader.removed,0);
  const savedNetwork=harness.requests.length,savedWork=await headerWork();
  await p.click('[data-save-status]');assert.equal(await p.evaluate('location.href'),savedUrl,'plain Saved status navigated');
  // Observe the real Copy link handler without changing the desktop clipboard.
  const copied=await p.evaluate(`(async()=>{const clipboard=navigator.clipboard,own=Object.getOwnPropertyDescriptor(clipboard,'writeText');let copied;Object.defineProperty(clipboard,'writeText',{configurable:true,value:async value=>{copied=value;}});try{document.querySelector('[data-save]').click();await Promise.resolve();return copied;}finally{if(own)Object.defineProperty(clipboard,'writeText',own);else delete clipboard.writeText;}})()`);
  assert.equal(copied,savedUrl,'Copy link did not use canonical current location');assert.equal(harness.requests.length,savedNetwork);assert.deepEqual(await headerWork(),savedWork);
  for(const [width,height] of [[1365,900],[390,844]]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<800},p.sessionId);await settled();await fits();headerProof.push({width,height,saved:await headerState(),copied});await shot('header-saved-'+width);}
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1365,height:900,deviceScaleFactor:1,mobile:false},p.sessionId);await settled();
  const retainedStart=harness.requests.length;
  harness.setMode('no-provider');const retained=await page({url:savedUrl});await retained.wait(s=>s.saved&&s.canvases===1);
  assert.equal((await retained.snapshot()).sourceIdentity,'Commit: '+savedRecord.revision);
  assert.equal(await retained.evaluate(`document.querySelector('[data-save-status]').title`),'Saved '+savedRecord.savedAt);
  assert.equal(await retained.evaluate(`document.querySelector('[data-save-status] a')`),null);
  assert.equal(await retained.evaluate(`document.querySelector('[data-selection-details]').hidden&&!document.querySelector('[data-unit-source]')`),true);
  await retained.evaluate(`document.querySelector('[data-inspect-highest]').focus();true`);
  for(const type of ['keyDown','keyUp'])await cdp.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})},retained.sessionId);
  await retained.wait(s=>s.sourceReady&&s.contributions===1);assert.equal(await retained.evaluate(`document.querySelector('[data-source-code]').textContent.includes('function choose(v)')`),true);
  assert.deepEqual(harness.requests.slice(retainedStart).filter(r=>new URL(r.url).pathname.startsWith('/parser/')||!r.url.startsWith(origin)),[],'saved primary reacquired source or parser');
  await shot('desktop-saved-primary-code',retained);await retained.closeSource();
  await cdp.send('Target.closeTarget',{targetId:retained.targetId});
  const replacementStart=harness.events.length;harness.setMode('revision-held');await p.submit();
  await checked(harness.waitFor(e=>harness.events.indexOf(e)>=replacementStart&&e.kind==='revision-held'));
  const clearedHeader=await headerState();assert.equal(clearedHeader.title,'');assert.equal(clearedHeader.status,'');assert.equal(clearedHeader.time,'');assert.equal((await p.snapshot()).saved,false);assert.equal(await p.evaluate('location.pathname'),'/');
  await p.click('[data-status] button');await p.wait(s=>s.status==='Cancelled');assert.equal((await p.snapshot()).sourceIdentity,'');
  headerProof.push({replacement:clearedHeader});
  await run('success',s=>s.canvases===1&&s.analyzed===5);
  process.stdout.write('Workspace: local preservation checks\n');
  const local=await exerciseLocalBrowser({page,cdp,harness,origin,request,checked});
  const automatic=await exerciseAutomaticExclusions({page,cdp,harness,origin,request,checked});
  process.stdout.write('Workspace: saved picker screenshot\n');
  await p.click('[data-open-saved]');await settled();await shot('desktop-saved-loading');
  process.stdout.write('Workspace saved state: '+JSON.stringify(await p.evaluate(`({open:document.querySelector('[data-saved-picker]').open,message:document.querySelector('[data-saved-message]').textContent,rows:document.querySelectorAll('[data-saved-projects] button').length})`))+'\n');
  await p.evaluate(`new Promise((resolve,reject)=>{const check=()=>{const message=document.querySelector('[data-saved-message]').textContent;if(document.querySelectorAll('[data-saved-projects] button').length){o.disconnect();resolve(true);}else if(message!=='Loading saved investigations'){o.disconnect();reject(new Error(message));}};const o=new MutationObserver(check);o.observe(document.querySelector('[data-saved-picker]'),{childList:true,subtree:true});check();})`);await pointer('[data-saved-projects] summary');await shot('desktop-saved');
  assert.equal(await p.evaluate(`document.querySelectorAll('[data-saved-projects] details').length>=2&&[...document.querySelectorAll('[data-saved-projects] button')].every(b=>b.querySelector('small')&&b.title)`),true);
  const pickerTitle=`${savedRecord.repository} · ${savedRecord.ref} · ${savedRecord.revision} · ${savedRecord.savedAt}`;
  assert.equal(await p.evaluate(`[...document.querySelectorAll('[data-saved-projects] button')].filter(b=>b.title===${JSON.stringify(pickerTitle)}).length`),1,'saved picker lost full original metadata');
  const pickerStart=harness.requests.length;harness.setMode('no-provider');
  await p.evaluate(`[...document.querySelectorAll('[data-saved-projects] button')].find(b=>b.title===${JSON.stringify(pickerTitle)}).click();true`);
  await p.wait(s=>s.saved&&s.canvases===1);assert.equal(await p.evaluate('location.href'),savedUrl);assert.equal((await p.snapshot()).sourceIdentity,'Commit: '+savedRecord.revision);
  assert.equal((await headerState()).time,'Saved '+savedRecord.savedAt);
  assert.deepEqual(harness.requests.slice(pickerStart).filter(r=>new URL(r.url).pathname.startsWith('/parser/')||!r.url.startsWith(origin)),[],'picker reopen reacquired or parsed source');
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'light'},{name:'prefers-reduced-motion',value:'reduce'}]},p.sessionId);await fits();await shot('desktop-light');
  process.stdout.write('Workspace: restart and retained-source preservation checks\n');
  await restart();await reopenLocalBrowser({page,cdp,harness,checked,origin,saved:local});await reopenAutomaticExclusions({page,cdp,harness,checked,origin,request,saved:automatic});
  process.stdout.write('Workspace: long mobile source identity\n');
  harness.setMode('no-provider');
  const long=await page({localPicker:true});
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},long.sessionId);
  await long.evaluate(`(async()=>{const root=await navigator.storage.getDirectory();window.__localRoot=await root.getDirectoryHandle('synthetic-long-project-'+ 'name'.repeat(25),{create:true});let dir=window.__localRoot;for(let i=0;i<3;i++)dir=await dir.getDirectoryHandle('long-directory-'+String(i)+'-'.repeat(60),{create:true});const file=await dir.getFileHandle('long-file-name-'+ 'x'.repeat(80)+'.ts',{create:true});const w=await file.createWritable();await w.write('export function choose(x:number) { if(x) return 1; return 0; }');await w.close();return true;})()`);
  process.stdout.write('Workspace: long synthetic OPFS prepared\n');
  await long.click('[data-choose-folder]');await long.evaluate(`new Promise(resolve=>{const check=()=>{if(document.querySelector('[data-folder-status]').textContent==='Folder selected.'){o.disconnect();resolve(true);}};const o=new MutationObserver(check);o.observe(document.querySelector('[data-folder-status]'),{childList:true});check();})`);
  process.stdout.write('Workspace: long folder selected\n');
  await long.evaluate(`document.querySelector('form').requestSubmit();true`);
  const longResult=await long.wait(s=>s.canvases===1||(s.setup&&s.progress===null&&s.status!==''));
  assert.equal(longResult.canvases,1,JSON.stringify(longResult));
  process.stdout.write('Workspace: long city published\n');
  await long.click('[data-navigation-toggle]');await long.click('[data-analyzed-rows] button');
  await long.wait(s=>s.units>0);
  process.stdout.write('Workspace: long units ready\n');
  await long.click('[data-unit-rows] button');
  await long.wait(s=>s.sourceReady);
  process.stdout.write('Workspace: long source ready\n');
  assert.equal(await long.evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[data-unit-source]').scrollHeight===document.querySelector('[data-unit-source]').clientHeight&&document.querySelector('[data-source-code]').clientHeight>=150`),true,'long source identity must not displace the useful mobile code pane');
  process.stdout.write('Workspace: long layout fits\n');
  await shot('mobile-long-path',long);await long.closeSource();
  process.stdout.write('Workspace: long source closed\n');
  await writeFile(path.join(evidenceDirectory,'workspace-dom-proof.json'),JSON.stringify(proofs,null,2)+'\n');
  await writeFile(path.join(evidenceDirectory,'header-proof.json'),JSON.stringify(headerProof,null,2)+'\n');
}
