import assert from 'node:assert/strict';import test from 'node:test';
import{closeDialogAndWait}from'../tools/browser-dialog-barrier.mjs';
class Dialog extends EventTarget{open=true;}
test('browser dialog barrier waits for the queued close event after open becomes false',async()=>{
 const dialog=new Dialog();let cleared=false,settled=false;
 dialog.addEventListener('close',()=>{cleared=true;});
 const pending=closeDialogAndWait(dialog,()=>{dialog.open=false;}).then(()=>{settled=true;assert.equal(cleared,true);});
 await Promise.resolve();assert.equal(dialog.open,false);assert.equal(settled,false);
 dialog.dispatchEvent(new Event('close'));await pending;assert.equal(settled,true);
});
test('browser dialog barrier handles closed dialogs and propagates activation errors without retry',async()=>{
 const dialog=new Dialog();dialog.open=false;await closeDialogAndWait(dialog,()=>{throw Error('must not activate');});
 dialog.open=true;let calls=0;await assert.rejects(closeDialogAndWait(dialog,()=>{calls++;throw Error('activation failed');}),/activation failed/u);assert.equal(calls,1);
 await assert.rejects(closeDialogAndWait(null,()=>{}),/native dialog/u);
});
