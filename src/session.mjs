import {buildTranscriptionRequest,parseTranscript,formatTranscript} from './core.mjs';

export const MAX_AUDIO_BYTES=5*1024*1024;
export const MAX_SECONDS=295;
export class VoiceSession {
  constructor({mediaDevices,Recorder,request,isValid,deliver,onChange=()=>{},onError=()=>{},getConnection,settings,onAutoStop,now=()=>Date.now(),timeoutMs=90000,maxSeconds=MAX_SECONDS}){
    Object.assign(this,{mediaDevices,Recorder,request,isValid,deliver,onChange,onError,getConnection,settings,onAutoStop,now,timeoutMs,maxSeconds});
    this.state='idle';this.generation=0;this.chunks=[];this.bytes=null;this.text='';this.level=0;
  }
  changed(){this.onChange(this);}
  live(g){return this.generation===g&&this.state!=='idle'&&this.isValid(this.target);}
  async start(target){
    if(this.state!=='idle')return;
    this.target=target;this.requestId=crypto.randomUUID();this.requestSettings=structuredClone(this.settings());this.connection={...this.getConnection()};this.state='requesting';this.changed();const g=++this.generation;
    try{
      if(!this.mediaDevices?.getUserMedia||!this.Recorder)throw Object.assign(Error(),{code:'NO_RECORDER'});
      const stream=await this.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(!this.live(g)){stream.getTracks().forEach(t=>t.stop());if(this.generation===g)this.cancel();return;}
      this.stream=stream;
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(m=>this.Recorder.isTypeSupported?.(m));
      this.recorder=new this.Recorder(stream,mime?{mimeType:mime,audioBitsPerSecond:64000}:{});
      this.mime=this.recorder.mimeType||mime||'';this.chunks=[];this.audioSize=0;this.startedAt=this.now();
      this.recorder.ondataavailable=e=>{
        if(!this.live(g)||!e.data?.size)return;
        this.audioSize+=e.data.size;
        if(this.audioSize>MAX_AUDIO_BYTES){this.cancel();this.onError('TOO_LONG');return;}
        this.chunks.push(e.data);
      };
      this.recorder.onerror=()=>{if(this.generation===g){this.cancel();this.onError('RECORDING_ERROR');}};
      this.recorder.onstop=()=>{if(this.generation===g)void this.finish(g);};
      this.recorder.start(1000);this.state='recording';this.changed();
      this.deadline=setTimeout(()=>this.onAutoStop?this.onAutoStop():this.stop(),this.maxSeconds*1000);
    }catch(e){if(this.generation===g){this.cancel();this.onError(e.name==='NotAllowedError'?'MIC_DENIED':e.code||'RECORDING_ERROR');}}
  }
  stop(){
    if(this.state==='requesting'){this.cancel();return;}
    if(this.state!=='recording')return;
    this.state='stopping';this.changed();clearTimeout(this.deadline);
    try{this.recorder.stop();}catch{this.cancel();this.onError('RECORDING_ERROR');}
    this.stopTracks();
  }
  stopTracks(){this.stream?.getTracks().forEach(t=>{try{t.stop();}catch{}});this.stream=null;}
  async finish(g){
    this.stopTracks();clearTimeout(this.deadline);
    if(!this.live(g)){if(this.generation===g)this.cancel();return;}
    try{
      const blob=new Blob(this.chunks,{type:this.mime});this.chunks=[];
      this.bytes=new Uint8Array(await blob.arrayBuffer());
      if(!this.live(g)){if(this.generation===g)this.cancel();return;}
      await this.transcribe(g);
    }catch(e){if(this.live(g)){this.state='error';this.changed();this.onError(e.code||'INVALID_AUDIO');}}
  }
  async transcribe(g=this.generation){
    if(!this.live(g))return;
    this.state='transcribing';this.changed();
    let body=null,requestOptions=null,deadline=null,cancelWait=null,controller=null;
    try{
      requestOptions=buildTranscriptionRequest({bytes:this.bytes,mime:this.mime,...this.connection,requestId:this.requestId,settings:this.requestSettings});body=requestOptions.body;controller=new AbortController();this.controller=controller;requestOptions.signal=controller.signal;
      const cancelled=new Promise((_,reject)=>{cancelWait=()=>reject(Object.assign(Error(),{code:'CANCELLED'}));this.cancelWait=cancelWait;});
      const result=await Promise.race([this.request(requestOptions),cancelled,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Object.assign(Error(),{code:'TIMEOUT'})),this.timeoutMs);})]);
      if(!this.live(g))return;
      this.text=formatTranscript(parseTranscript(result,{...this.connection,requestId:this.requestId}),this.requestSettings);
      this.bytes?.fill(0);this.bytes=null;
      let inserted=false;
      try{inserted=this.deliver(this.text,this.target)===true;}catch{}
      if(!this.live(g))return;
      if(inserted)this.cancel();else{this.state='recovery';this.changed();}
    }catch(e){if(this.live(g)){this.lastError=e.code||'NETWORK_ERROR';this.state='error';this.changed();this.onError(this.lastError);}}
    finally{
      clearTimeout(deadline);if(this.cancelWait===cancelWait)this.cancelWait=null;
      // Aborting the client does not recall audio already received by gateway.
      // Generation guards and the server ledger prevent late insertion/replay.
      controller?.abort();if(this.controller===controller)this.controller=null;
      body=null;
      if(requestOptions)requestOptions.body=null;
      if(requestOptions)requestOptions.headers={};
    }
  }
  retry(){if(this.state==='error'&&this.bytes&&this.isValid(this.target))return this.transcribe();}
  cancel(){
    ++this.generation;this.controller?.abort();this.controller=null;clearTimeout(this.deadline);this.cancelWait?.();this.cancelWait=null;
    const recorder=this.recorder;this.recorder=null;
    if(recorder){recorder.onstop=null;recorder.ondataavailable=null;recorder.onerror=null;try{if(recorder.state!=='inactive')recorder.stop();}catch{}}
    this.stopTracks();this.chunks=[];this.bytes?.fill(0);this.bytes=null;this.text='';this.target=null;this.connection=null;this.requestSettings=null;this.requestId=null;this.lastError=null;this.state='idle';this.changed();
  }
}
