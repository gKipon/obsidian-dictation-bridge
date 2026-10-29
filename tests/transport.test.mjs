import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {requestGateway} from '../src/transport.mjs';
test('fetch rejects redirect, omits cookies and passes abort signal',async()=>{
 const controller=new AbortController();let seen;
 const result=await requestGateway({url:'https://example.invalid',headers:{Authorization:'Bearer synthetic'},contentType:'application/json',body:'{}',signal:controller.signal},async(url,options)=>{seen=options;return {status:403,json:async()=>({error:'FORBIDDEN'})};});
 assert.equal(seen.redirect,'error');assert.equal(seen.credentials,'omit');assert.equal(seen.signal,controller.signal);assert.equal(result.status,403);
});
test('actual HTTP redirect is rejected before contacting redirect target',async()=>{
 let targetHits=0;const server=http.createServer((req,res)=>{if(req.url==='/target'){targetHits++;res.end('{}');}else{res.writeHead(302,{Location:'/target'});res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await assert.rejects(requestGateway({url:`http://127.0.0.1:${server.address().port}/source`,headers:{Authorization:'Bearer synthetic'},contentType:'application/json',body:'{}'}));assert.equal(targetHits,0);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
