import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import test from 'node:test';
import {launchInstalledChrome,closeInstalledChrome} from '../tools/chrome-cdp.mjs';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
class Child extends EventEmitter {
 constructor(){super();this.stderr=new EventEmitter();this.exitCode=null;this.signalCode=null;this.kills=0;}
 kill(){this.kills++;queueMicrotask(()=>{this.signalCode='SIGTERM';this.emit('exit',null,'SIGTERM');this.emit('close',null,'SIGTERM');});return true;}
 exit(code=0,signal=null){this.exitCode=code;this.signalCode=signal;this.emit('exit',code,signal);}
 close(code=this.exitCode,signal=this.signalCode){this.emit('close',code,signal);}
}
async function launched(profile){const child=new Child();const chrome=await launchInstalledChrome({executable:'/installed/google-chrome'},profile,{spawnImpl(){queueMicrotask(()=>child.stderr.emit('data','DevTools listening on ws://127.0.0.1:12345/devtools/browser/owned\n'));return child;}});return {child,chrome};}

test('a Browser.close acknowledgement and even process exit do not permit profile removal before full close',async()=>{
 const temporary=await mkdtemp(path.join(os.tmpdir(),'code-city-chrome-shutdown-'));try{
 const profile=path.join(temporary,'profile');await mkdir(profile);const{child,chrome}=await launched(profile);let settled=false,cdpClosed=false;
 const stopping=closeInstalledChrome(chrome,{async send(method){assert.equal(method,'Browser.close');return{};},close(){cdpClosed=true;}}).then(()=>{settled=true;});
 await flush();assert.equal(child.kills,0);assert.equal(cdpClosed,true);assert.equal(settled,false);
 child.exit();await flush();assert.equal(settled,false,'exit alone must not release the profile');
 await writeFile(path.join(profile,'late-preferences'),'flushed');assert.equal(await readFile(path.join(profile,'late-preferences'),'utf8'),'flushed');
 child.close();await stopping;assert.equal(settled,true);assert.equal(child.kills,0);
 await rm(profile,{recursive:true});
 }finally{await rm(temporary,{recursive:true,force:true});}
});
test('the launch-time close barrier also handles Chrome that finished before cleanup starts',async()=>{
 const{child,chrome}=await launched(path.join(os.tmpdir(),'already-closed-chrome'));child.exit();child.close();let disconnected=false;
 await closeInstalledChrome(chrome,{async send(){throw Error('CDP already closed');},close(){disconnected=true;}});
 assert.equal(child.kills,0);assert.equal(disconnected,true);
});
test('failed protocol shutdown terminates only its owned child and rejects unsafe profile cleanup',async()=>{
 const{child,chrome}=await launched(path.join(os.tmpdir(),'owned-failed-chrome'));let disconnected=false;
 await assert.rejects(closeInstalledChrome(chrome,{async send(){throw Error('CDP failed');},close(){disconnected=true;}}),/did not shut down cleanly.*retain its temporary profile/u);
 assert.equal(child.kills,1);assert.equal(disconnected,true);
});
test('an accepted close followed by a nonzero exit is not silently treated as successful cleanup',async()=>{
 const{child,chrome}=await launched(path.join(os.tmpdir(),'nonzero-chrome'));
 const stopping=closeInstalledChrome(chrome,{async send(){return{};},close(){}});await flush();child.exit(1);child.close();
 await assert.rejects(stopping,/code=1.*retain its temporary profile/u);assert.equal(child.kills,0);
});
