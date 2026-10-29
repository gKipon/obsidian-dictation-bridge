import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS,normalizeSettings,buildTranscriptionRequest,parseTranscript,formatTranscript,planInsertion,validateEndpoint} from '../src/core.mjs';
const err=(fn,code)=>assert.throws(fn,e=>e.code===code&&e.message===code);
const ids={requestId:'11111111-1111-4111-8111-111111111111',instanceId:'22222222-2222-4222-8222-222222222222'};
const req=(extra={})=>buildTranscriptionRequest({bytes:new Uint8Array([0,255,13,10]),mime:'audio/webm;codecs=opus',endpoint:'https://voice.example.invalid/v1/transcribe',token:'synthetic-token-not-a-secret-1234567',...ids,...extra});
const reply=(text='не 42')=>({status:200,json:{request_id:ids.requestId,instance_id:ids.instanceId,text}});
test('gateway request sends only audio, explicit terms and routing IDs',()=>{
 const r=req({settings:{languages:['en'],keywords:'Example\nИван, Петров'}}),p=JSON.parse(r.body);
 assert.equal(r.url,'https://voice.example.invalid/v1/transcribe');assert.equal(r.throw,false);assert.match(r.headers.Authorization,/^Bearer /);
 assert.deepEqual(Object.keys(p).sort(),['audio_base64','instance_id','keywords','languages','mime','request_id']);
 assert.deepEqual([...Buffer.from(p.audio_base64,'base64')],[0,255,13,10]);assert.deepEqual(p.keywords,['Example','Иван, Петров']);
 assert(!r.body.includes('synthetic-token'));assert(!r.body.includes('openai'));
});
test('invalid credentials, routing, input size and settings fail before upload',()=>{
 assert.deepEqual(normalizeSettings(),DEFAULT_SETTINGS);
 for(const keywords of ['<термин>','a\rb','x'.repeat(101),Array(52).fill('x').join('\n')])err(()=>normalizeSettings({keywords}),'INVALID_KEYWORDS');
 err(()=>normalizeSettings({languages:'en'}),'INVALID_SETTINGS');
 for(const bytes of [new Uint8Array(),new Uint8Array(5*1024*1024+1)])err(()=>req({bytes}),'INVALID_AUDIO');
 err(()=>req({mime:'text/plain'}),'INVALID_MIME');err(()=>req({endpoint:'https://voice.example.invalid/v1/transcribe',token:'token\nheader'}),'INVALID_TOKEN');err(()=>req({instanceId:'no'}),'INVALID_ID');
});
test('response routing must match this instance and recording',()=>{
 assert.equal(parseTranscript(reply(),ids),'не 42');
 for(const field of ['request_id','instance_id']){const r=reply();r.json[field]='33333333-3333-4333-8333-333333333333';err(()=>parseTranscript(r,ids),'RESPONSE_MISMATCH');}
 for(const text of ['', ' '.repeat(3),'x'.repeat(100001)])err(()=>parseTranscript(reply(text),ids),'INVALID_TRANSCRIPT');
 for(const [status,code] of [[401,'AUTH_ERROR'],[429,'RATE_LIMIT'],[500,'SERVER_ERROR'],[400,'HTTP_ERROR']])err(()=>parseTranscript({status,json:{error:'PRIVATE'}},ids),code);
 err(()=>parseTranscript({status:409,json:{error:'REQUEST_UNKNOWN'}},ids),'REQUEST_UNKNOWN');
});
test('literal text and complete line commands',()=>{
 const literal='Не 42. Точка зрения.\nновый абзац\nне новый пункт';assert.equal(formatTranscript(literal),literal);
 assert.equal(formatTranscript(literal,{voiceCommands:true}),'Не 42. Точка зрения.\n\nне новый пункт');
 assert.equal(formatTranscript('один\nновый пункт\nдва',{voiceCommands:true}),'один\n- два');
});
test('insertion respects captured selection and detects changed document',()=>{
 assert.deepEqual(planInsertion({original:'доСЛОВОпосле',current:'доСЛОВОпосле',from:2,to:7,text:'текст'}),{from:2,to:7,text:' текст '});
 err(()=>planInsertion({original:'a',current:'b',from:0,to:0,text:'x'}),'TARGET_CHANGED');
 err(()=>planInsertion({original:'a',current:'a',from:2,to:2,text:'x'}),'INVALID_RANGE');
});

test('endpoint has no implicit service and rejects credential/query/redirect destinations',()=>{
 for(const endpoint of [undefined,'http://example.com/x','https://user:pass@example.com/x','https://example.com/x?a=1','https://example.com/x#secret'])err(()=>req({endpoint}),'INVALID_ENDPOINT');
 assert.equal(req({endpoint:'https://owned.example.invalid/v1/transcribe'}).url,'https://owned.example.invalid/v1/transcribe');
 assert.equal(formatTranscript('one\nnew paragraph\ntwo',{voiceCommands:true}),'one\n\ntwo');
});
