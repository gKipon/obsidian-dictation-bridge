import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceSession} from '../src/session.mjs';
const instanceId='22222222-2222-4222-8222-222222222222';
const response=(arg,text)=>{const p=JSON.parse(arg.body);return {status:200,json:{text,request_id:p.request_id,instance_id:p.instance_id}};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(extra={}){
 let stopped=0,valid=true;const sent=[],inserted=[],errors=[];
 const stream={getTracks:()=>[{stop:()=>stopped++}]};
 class Recorder{
  static isTypeSupported(m){return m==='audio/webm;codecs=opus';}
  constructor(){this.mimeType='audio/webm;codecs=opus';this.state='inactive';}
  start(){this.state='recording';}
  stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['synthetic audio'])});this.onstop?.();}
 }
 const session=new VoiceSession({mediaDevices:{getUserMedia:async()=>stream},Recorder,request:async arg=>{sent.push({url:arg.url,body:arg.body});return response(arg,'Я не согласовал 42 рубля.');},isValid:()=>valid,deliver:text=>{inserted.push(text);return true;},getConnection:()=>({endpoint:'https://voice.example.invalid/v1/transcribe',token:'synthetic-token-not-a-secret-1234567',instanceId}),settings:()=>({}),onError:code=>errors.push(code),...extra});
 return {session,stream,sent,inserted,errors,stopped:()=>stopped,setValid:v=>valid=v};
}
test('record, stop, transcribe, insert once; microphone and audio are released',async()=>{
 const f=fixture();await f.session.start({});assert.equal(f.session.state,'recording');f.session.stop();await tick();await tick();
 assert.equal(f.sent.length,1);assert.equal(f.inserted.length,1);assert(f.stopped()>0);assert.equal(f.session.state,'idle');assert.equal(f.session.bytes,null);assert.equal(f.session.target,null);
 assert(!f.sent[0].body.includes('note body'));
});
test('cancel while permission pending stops late microphone without starting recording',async()=>{
 const permission=deferred(),f=fixture({mediaDevices:{getUserMedia:()=>permission.promise}});const pending=f.session.start({});f.session.cancel();permission.resolve(f.stream);await pending;
 assert.equal(f.session.state,'idle');assert.equal(f.stopped(),1);assert.equal(f.sent.length,0);
});
test('lock during network wait clears buffers and ignores late transcription',async()=>{
 const response=deferred(),f=fixture({request:()=>response.promise});await f.session.start({});f.session.stop();await tick();assert.equal(f.session.state,'transcribing');
 f.setValid(false);f.session.cancel();await tick();assert.equal(f.session.bytes,null);assert.equal(f.session.text,'');assert.equal(f.session.target,null);
 response.resolve({status:200,json:{text:'late'}});await tick();assert.equal(f.inserted.length,0);assert.equal(f.session.state,'idle');
});
test('changed editor retains transcript for explicit insertion without retaining audio',async()=>{
 const f=fixture({deliver:()=>false});await f.session.start({});f.session.stop();await tick();await tick();assert.equal(f.session.state,'recovery');assert.equal(f.session.text,'Я не согласовал 42 рубля.');assert.equal(f.session.bytes,null);f.session.cancel();assert.equal(f.session.text,'');
});
test('failed request is not automatically retried and can be manually retried once',async()=>{
 let calls=0;const f=fixture({request:async arg=>++calls===1?{status:429,json:{error:'PRIVATE_BODY'}}:response(arg,'готово')});await f.session.start({});f.session.stop();await tick();await tick();
 assert.equal(calls,1);assert.equal(f.session.state,'error');assert.deepEqual(f.errors,['RATE_LIMIT']);assert(f.session.bytes);await f.session.retry();assert.equal(calls,2);assert.equal(f.session.state,'idle');
});
test('timeout and overlapping late response cannot affect a fresh request',async()=>{
 const old=deferred();let calls=0;const f=fixture({request:arg=>++calls===1?old.promise:Promise.resolve(response(arg,'new')),timeoutMs:8});await f.session.start({});f.session.stop();await new Promise(r=>setTimeout(r,20));assert.equal(f.session.state,'error');assert.deepEqual(f.errors,['TIMEOUT']);await f.session.retry();assert.deepEqual(f.inserted,['new']);old.resolve({status:200,json:{text:'old'}});await tick();assert.deepEqual(f.inserted,['new']);
});
test('loss of validity before permission is granted never uploads',async()=>{
 const d=deferred(),f=fixture({mediaDevices:{getUserMedia:()=>d.promise}});const p=f.session.start({});f.setValid(false);d.resolve(f.stream);await p;assert.equal(f.session.state,'idle');assert.equal(f.sent.length,0);
});
test('permission denial and unavailable recorder have bounded safe errors',async()=>{
 const f=fixture({mediaDevices:{getUserMedia:async()=>{throw Object.assign(Error('PRIVATE'),{name:'NotAllowedError'});}}});await f.session.start({});assert.deepEqual(f.errors,['MIC_DENIED']);assert.equal(f.session.state,'idle');
 const g=fixture({Recorder:null});await g.session.start({});assert.deepEqual(g.errors,['NO_RECORDER']);
});

test('retry preserves immutable request ID, language, terms and connection',async()=>{
 const bodies=[];let settings={keywords:'Example'},conn={endpoint:'https://voice.example.invalid/v1/transcribe',token:'synthetic-token-not-a-secret-1234567',instanceId};
 const f=fixture({settings:()=>settings,getConnection:()=>conn,request:async arg=>{bodies.push(arg.body);return {status:429,json:{error:'RATE_LIMIT'}};}});
 await f.session.start({});f.session.stop();await tick();await tick();settings={keywords:'other'};conn={...conn,instanceId:crypto.randomUUID()};
 await f.session.retry();assert.equal(bodies[0],bodies[1]);assert.equal(f.inserted.length,0);f.session.cancel();
});

test('invalid connection releases target and settings before requesting microphone',async()=>{
 const f=fixture({getConnection:()=>{throw Object.assign(Error('private detail'),{code:'INVALID_ENDPOINT'});}});
 await f.session.start({original:'synthetic note'});
 assert.equal(f.session.state,'idle');assert.equal(f.session.target,null);assert.equal(f.session.requestSettings,null);
 assert.equal(f.session.connection,null);assert.equal(f.sent.length,0);assert.deepEqual(f.errors,['INVALID_ENDPOINT']);
});
test('uncertain and terminal results cannot be retried through the state machine',async()=>{
 for(const error of ['REQUEST_UNKNOWN','RESULT_EXPIRED','REQUEST_CONFLICT','PROVIDER_UNCERTAIN']){
  let calls=0;const f=fixture({request:async()=>{calls++;return {status:409,json:{error}};}});
  await f.session.start({});f.session.stop();await tick();await tick();
  assert.equal(f.session.state,'error');assert.equal(f.session.canRetry(),false);
  await f.session.retry();assert.equal(calls,1);f.session.cancel();
 }
});
test('late Blob conversion cannot replace fresh-session audio after cancellation',async t=>{
 const old=deferred(),original=Blob.prototype.arrayBuffer;let reads=0;
 t.mock.method(Blob.prototype,'arrayBuffer',function(){return ++reads===1?old.promise:original.call(this);});
 const f=fixture({request:async()=>({status:429,json:{error:'RATE_LIMIT'}})});
 await f.session.start({});f.session.stop();f.session.cancel();
 await f.session.start({});f.session.stop();await tick();await tick();
 const current=f.session.bytes;assert(current);assert.equal(f.session.state,'error');
 const stale=new Uint8Array([1,2,3]);old.resolve(stale.buffer);await tick();
 assert.equal(f.session.bytes,current);assert.deepEqual([...stale],[0,0,0]);assert.equal(f.session.state,'error');
 f.session.cancel();
});
