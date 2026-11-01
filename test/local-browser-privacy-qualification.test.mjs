import assert from 'node:assert/strict';
import test from 'node:test';
import {assertLocalRequests} from '../tools/standalone-local-browser-scenarios.mjs';
const origin='http://127.0.0.1:12345';
const request=(path,method='GET',headers={})=>({url:origin+path,method,headers});
test('local privacy gate rejects same-origin nonasset routes and metadata queries',()=>{
 assert.throws(()=>assertLocalRequests([request('/unobserved')],origin),/Unapproved local/u);
 assert.throws(()=>assertLocalRequests([request('/unobserved?source=PRIVATE_SYNTHETIC_UNCOMMITTED_A','POST')],origin),/query/u);
 assert.throws(()=>assertLocalRequests([request('/browser.js','GET',{'X-Source':'PRIVATE_SYNTHETIC_UNCOMMITTED_A'})],origin),/repository data/u);
});
test('local privacy gate grants exactly one POST only in the explicit Save interval',()=>{
 const upload=request('/api/investigations','POST');
 assert.throws(()=>assertLocalRequests([upload],origin),/authorization/u);
 assert.doesNotThrow(()=>assertLocalRequests([upload],origin,{expectedPosts:1}));
 assert.throws(()=>assertLocalRequests([upload,upload],origin,{expectedPosts:1}),/authorization/u);
 assert.throws(()=>assertLocalRequests([request('/elsewhere','POST')],origin,{expectedPosts:1}),/upload route/u);
});
test('local reopen gate checks parser absence across source inspection, not just initial publication',()=>{
 const id='A'.repeat(43),options={savedId:id,forbidParser:true};
 assert.doesNotThrow(()=>assertLocalRequests([request('/saved/'+id),request('/analysis-worker.js'),request('/api/investigations/'+id+'/record'),request('/api/investigations/'+id)],origin,options));
 assert.throws(()=>assertLocalRequests([request('/api/investigations/'+id),request('/parser/tree-sitter-javascript.wasm')],origin,options),/analysis parser/u);
 assert.throws(()=>assertLocalRequests([request('/api/investigations/'+id+'/record'),request('/parser/web-tree-sitter.js')],origin,options),/analysis parser/u);
});
