import assert from 'node:assert/strict';
import test from 'node:test';
import {createBrowserProviderHarness,providerRequestLeaksPrivateHeaders} from '../tools/standalone-browser-provider-harness.mjs';
const origin='http://127.0.0.1:12345';
const url='https://api.github.com/repos/fixture/standalone/commits?per_page=1&page=1';
function fixture(t,fail){
 const calls=[],failure=Promise.withResolvers(),cdp={listeners:new Set(),async send(method,params,sessionId){calls.push({method,params,sessionId});if(method==='Fetch.failRequest'&&fail)throw new Error('CDP command failed',{cause:fail});return {};}};
 const harness=createBrowserProviderHarness(cdp,origin,failure.resolve);t.after(()=>harness.close());
 const emit=message=>{for(const listener of cdp.listeners)listener(message);};
 const attach=async id=>{emit({method:'Target.attachedToTarget',sessionId:'page',params:{sessionId:id,targetInfo:{type:'worker',targetId:id}}});await harness.waitFor(event=>event.kind==='worker'&&event.sessionId===id);};
 const network=id=>emit({method:'Network.requestWillBeSent',sessionId:id,params:{requestId:'network-old',request:{url,method:'GET',headers:{}}}});
 const detach=id=>emit({method:'Target.detachedFromTarget',params:{sessionId:id}});
 const paused=()=>emit({method:'Fetch.requestPaused',sessionId:'page',params:{requestId:'interception-old',networkId:'network-old',request:{url,method:'GET',headers:{}}}});
 return {harness,calls,failure,attach,network,detach,paused,emit};
}

test('late parent-channel Fetch notification retains its detached network owner rather than using a replacement worker',async t=>{
 const state=fixture(t,{code:-32602,message:'Invalid InterceptionId.'});
 await state.attach('old');state.network('old');state.detach('old');await state.attach('replacement');state.paused();
 await state.harness.waitFor(event=>event.kind==='late-cancelled-request');
 assert.equal(state.harness.requests.at(-1).sessionId,'old');
 assert.deepEqual(state.calls.find(call=>call.method==='Fetch.failRequest'),{method:'Fetch.failRequest',params:{requestId:'interception-old',errorReason:'Aborted'},sessionId:'page'});
 assert.ok(state.harness.events.some(event=>event.kind==='interception-cancelled'&&event.sessionId==='old'));
 assert.equal(state.calls.some(call=>call.method==='Fetch.fulfillRequest'),false);
});

test('detached-owner cancellation does not suppress a different CDP failure',async t=>{
 const state=fixture(t,{code:-32000,message:'A different failure'});
 await state.attach('old');state.network('old');state.detach('old');state.paused();
 const error=await state.failure.promise;assert.equal(error.cause.message,'A different failure');
 assert.equal(state.harness.events.some(event=>event.kind==='interception-cancelled'),false);
});

test('complete Network metadata permits an empty explicit no-referrer value but no credentials or populated referrer',()=>{
 assert.equal(providerRequestLeaksPrivateHeaders({Referer:'',Accept:'application/json'}),false);
 for(const headers of [{Referer:origin},{referrer:origin},{Authorization:''},{Cookie:''},{authorization:'token'},{cookie:'value'}])assert.equal(providerRequestLeaksPrivateHeaders(headers),true);
});

test('records un-intercepted same-origin requests including potential unauthorized uploads',async t=>{
 const state=fixture(t);const hidden=origin+'/unobserved?source=PRIVATE_SYNTHETIC_UNCOMMITTED_A';
 state.emit({method:'Network.requestWillBeSent',sessionId:'page',params:{requestId:'unobserved',request:{url:hidden,method:'POST',headers:{'X-Synthetic':'source'}}}});
 assert.deepEqual(state.harness.requests,[{url:hidden,method:'POST',worker:false,sessionId:'page',headers:{'X-Synthetic':'source'}}]);
});

test('an unattributed provider request still fails the worker-only network boundary',async t=>{
 const state=fixture(t);state.paused();
 assert.match((await state.failure.promise).message,/non-worker provider request/u);
 assert.equal(state.harness.events.some(event=>event.kind==='interception-cancelled'),false);
});
