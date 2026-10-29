import {Plugin,PluginSettingTab,Setting,Modal,Notice,MarkdownView} from 'obsidian';
import {DEFAULT_SETTINGS,normalizeSettings,planInsertion,UUID,validateEndpoint} from './core.mjs';
import {requestGateway} from './transport.mjs';
import {VoiceSession,MAX_SECONDS} from './session.mjs';

const OPTIONS_SECRET='dictation-bridge-options';
const errors={
 MIC_DENIED:'Allow microphone access for Obsidian in system settings.',NO_RECORDER:'Microphone recording is unavailable.',RECORDING_ERROR:'Recording failed. Check the microphone.',INVALID_AUDIO:'Recording is empty or too large.',TOO_LONG:'Recording exceeded the size limit and was cancelled.',
 INVALID_ENDPOINT:'Enter the full HTTPS transcription endpoint, without credentials, query or fragment.',INVALID_TOKEN:'Add a device token in settings.',INVALID_ID:'Check the instance UUID in settings.',INVALID_KEYWORDS:'Use up to 50 terms, one per line, up to 100 characters each; no < or >.',INVALID_SETTINGS:'Check transcription settings and language codes.',
 AUTH_ERROR:'Gateway access denied. Check the connection.',FORBIDDEN:'Gateway rejected this device token.',RATE_LIMIT:'Gateway rate limit reached.',DAILY_LIMIT:'Gateway daily request limit reached.',DAILY_AUDIO_LIMIT:'Gateway daily audio limit reached.',BUSY:'Gateway is already processing a recording. Retry later.',PROVIDER_UNAVAILABLE:'The gateway operator must configure the OpenAI API key.',
 SERVER_ERROR:'Gateway unavailable. Recording remains in memory.',HTTP_ERROR:'Gateway rejected the request. Recording remains in memory.',NETWORK_ERROR:'No response received. Recording remains in memory.',TIMEOUT:'Response timed out. Retry checks the same request without repeating the provider submission.',RESPONSE_LIMIT:'Gateway response exceeded the size limit. Recording remains in memory.',
 REQUEST_UNKNOWN:'The previous submission may have been billed. This request cannot be sent again.',RESULT_EXPIRED:'The gateway no longer has this result. Resubmission is blocked.',REQUEST_CONFLICT:'Request data changed. Cancel and begin a new recording.',PROVIDER_UNCERTAIN:'Provider outcome is unknown. Resubmission is blocked to prevent duplicate billing.',RESPONSE_MISMATCH:'Response belongs to another recording or device. Insertion blocked.',INVALID_TRANSCRIPT:'No usable transcript returned.',INVALID_MIME:'Recording format is unsupported.',INVALID_AUDIO_DURATION:'Unable to verify audio duration. Maximum: five minutes.',AUDIO_TOO_LONG:'Gateway rejected audio longer than five minutes.'
};
const message=code=>errors[code]||'Dictation did not complete. Check the connection and settings.';
const codeError=code=>Object.assign(new Error(code),{code});

export default class DictationBridge extends Plugin {
  async onload(){
    this.disposed=false;this.modals=new Set();this.options={...DEFAULT_SETTINGS,endpoint:'',instanceId:'',token:''};this.loadOptions();
    this.session=new VoiceSession({mediaDevices:navigator.mediaDevices,Recorder:globalThis.MediaRecorder,request:args=>requestGateway(args),isValid:t=>this.validSession(t),deliver:(text,t)=>this.insertCaptured(text,t),getConnection:()=>this.connection(),settings:()=>this.options,onAutoStop:()=>this.stop(),onChange:()=>this.render(),onError:code=>new Notice(message(code),7000)});
    this.addSettingTab(new VoiceSettings(this.app,this));
    this.addCommand({id:'toggle',name:'Start / stop dictation',callback:()=>void this.toggle()});
    this.addCommand({id:'cancel',name:'Cancel dictation',callback:()=>this.cancel()});
    this.addCommand({id:'result',name:'Show pending transcript',callback:()=>this.showRecovery()});
    this.addCommand({id:'settings',name:'Configure dictation',callback:()=>this.openSettings()});
    this.ribbon=this.addRibbonIcon('mic','Dictation Bridge: dictate',()=>void this.toggle());
    this.status=this.addStatusBarItem();this.status.addClass('dictation-bridge-status');this.status.addEventListener('click',()=>void this.toggle());
    this.panel=document.body.createDiv({cls:'dictation-bridge-panel'});this.panel.setAttribute('role','status');
    this.label=this.panel.createSpan();this.meter=this.panel.createEl('meter');this.meter.min=0;this.meter.max=1;this.meter.setAttribute('aria-label','Microphone level');
    this.primary=this.panel.createEl('button');this.primary.addEventListener('click',()=>void this.primaryAction());
    this.cancelButton=this.panel.createEl('button',{text:'Cancel'});this.cancelButton.addEventListener('click',()=>this.cancel());
    this.registerEvent(this.app.workspace.on('cipherfold:will-lock',()=>this.cancelPrivacy()));
    this.registerEvent(this.app.workspace.on('active-leaf-change',()=>this.render()));
    this.registerDomEvent(document,'visibilitychange',()=>{if(document.hidden)this.cancelPrivacy();});
    this.registerInterval(setInterval(()=>{
      if(this.session.state!=='idle'&&!this.validSession(this.session.target)){this.cancelPrivacy();return;}
      this.updateMeter();this.render();
    },200));
    this.render();
  }
  cipherfold(){return this.app.plugins.plugins['cipherfold'];}
  unlocked(){const p=this.cipherfold();return !p||p.voiceLifecycleVersion===1&&p.ready&&p.store?.isUnlocked&&p.acceptWrites&&!p.lockPromise&&!p.disposed;}
  validSession(target){return !this.disposed&&!document.hidden&&!!target&&this.unlocked()&&this.cipherfold()===target.cipherfold&&(!target.cipherfold||target.cipherfold.epoch===target.epoch);}
  loadOptions(){
    try{const stored=this.app.secretStorage?.peekSecret(OPTIONS_SECRET);if(stored){const value=JSON.parse(stored);this.options={...normalizeSettings(value),instanceId:UUID.test(value.instanceId||'')?value.instanceId:'',endpoint:typeof value.endpoint==='string'?value.endpoint:'',token:typeof value.token==='string'?value.token:''};}}catch{}
  }
  storageReady(){return !!this.app.secretStorage&&this.app.secretStorage.isEncryptionAvailable()===true;}
  saveOptions(value){
    if(!UUID.test(value.instanceId||''))throw codeError('INVALID_ID');
    const token=value.token??this.options.token;
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(token||''))throw codeError('INVALID_TOKEN');
    const next={...normalizeSettings(value),instanceId:value.instanceId,endpoint:validateEndpoint(value.endpoint),token};
    if(!this.storageReady())throw Error('Secure storage unavailable');
    // Keep endpoint, device identity and token in one encrypted atomic slot.
    this.app.secretStorage.setSecret(OPTIONS_SECRET,JSON.stringify(next));this.options=next;
  }
  deviceToken(){return this.options.token||'';}
  connection(){return {token:this.deviceToken(),instanceId:this.options.instanceId,endpoint:validateEndpoint(this.options.endpoint)};}
  captureTarget(){
    const view=this.app.workspace.getActiveViewOfType(MarkdownView);
    if(!view?.file||!view.editor||view.getMode?.()!=='source')throw Error('Open a Markdown note in editing mode.');
    const original=view.editor.getValue(),from=view.editor.posToOffset(view.editor.getCursor('from')),to=view.editor.posToOffset(view.editor.getCursor('to'));
    return {view,file:view.file,path:view.file.path,editor:view.editor,original,from,to,cipherfold:this.cipherfold(),epoch:this.cipherfold()?.epoch};
  }
  insertCaptured(text,target){
    if(!this.validSession(target))return false;
    const {view,file,editor}=target;
    if(view.file!==file||file.path!==target.path||view.editor!==editor||this.app.vault.getAbstractFileByPath(target.path)!==file||this.app.workspace.getActiveViewOfType(MarkdownView)!==view||view.getMode?.()!=='source')return false;
    const plan=planInsertion({original:target.original,current:editor.getValue(),from:target.from,to:target.to,text});
    if(!this.validSession(target))return false;
    // One native editor transaction. Cipherfold's ordinary save path encrypts it.
    editor.transaction({changes:[{from:editor.offsetToPos(plan.from),to:editor.offsetToPos(plan.to),text:plan.text}]});
    new Notice('Transcript inserted. Use Undo to revert.');return true;
  }
  async toggle(){
    const s=this.session;
    if(s.state==='recording'||s.state==='requesting'){this.stop();return;}
    if(s.state==='recovery'){this.showRecovery();return;}
    if(s.state==='error'){this.render();new Notice('Recording remains in memory. Choose Retry or Cancel.');return;}
    if(s.state!=='idle')return;
    const cipherfold=this.cipherfold();
    if(cipherfold&&cipherfold.voiceLifecycleVersion!==1){new Notice('This Cipherfold version does not support safe dictation.');return;}
    if(!this.unlocked()){new Notice('Unlock Cipherfold first.');return;}
    this.loadOptions();
    if(!this.deviceToken()||!UUID.test(this.options.instanceId||'')||!this.options.endpoint){this.openSettings();new Notice('Configure your gateway connection first.');return;}
    try{const target=this.captureTarget();this.peak=0;this.meterSamples=0;await s.start(target);}catch(e){new Notice(e.message||'Open a note for dictation.');}
  }
  stop(){
    if(this.session.state==='recording'&&this.meterSamples>5&&this.peak<0.001){this.cancel();new Notice('No microphone signal detected. Recording was not sent.');return;}
    this.session.stop();
  }
  cancel(){this.session.cancel();this.closeMeter();for(const modal of [...this.modals])modal.close();}
  cancelPrivacy(){const active=this.session?.state!=='idle';this.cancel();if(active&&!this.disposed)new Notice('Dictation cancelled when hidden or locked. Previously inserted text remains in the note.');}
  primaryAction(){if(this.session.state==='error')return this.session.retry();if(this.session.state==='recovery')return this.showRecovery();this.stop();}
  showRecovery(){if(this.session.state!=='recovery'||!this.validSession(this.session.target))return;if([...this.modals].some(m=>m instanceof RecoveryModal))return;new RecoveryModal(this).open();}
  openSettings(){this.app.setting.open();this.app.setting.openTabById(this.manifest.id);}
  openMeter(){
    if(this.audioContext||!this.session.stream)return;
    try{const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;if(!Audio)return;this.audioContext=new Audio();this.source=this.audioContext.createMediaStreamSource(this.session.stream);this.analyser=this.audioContext.createAnalyser();this.analyser.fftSize=256;this.source.connect(this.analyser);this.wave=new Float32Array(256);void this.audioContext.resume().catch(()=>{});}catch{this.closeMeter();}
  }
  updateMeter(){
    if(this.session.state!=='recording'){this.closeMeter();return;}
    this.openMeter();if(!this.analyser||this.audioContext?.state!=='running')return;
    this.analyser.getFloatTimeDomainData(this.wave);const rms=Math.sqrt(this.wave.reduce((sum,x)=>sum+x*x,0)/this.wave.length);this.peak=Math.max(this.peak,rms);this.meterSamples++;if(this.meter)this.meter.value=Math.min(1,rms*8);
  }
  closeMeter(){try{this.source?.disconnect();void this.audioContext?.close().catch(()=>{});}catch{}this.source=null;this.analyser=null;this.audioContext=null;this.wave=null;if(this.meter)this.meter.value=0;}
  render(){
    if(!this.panel)return;
    const s=this.session,state=s.state,seconds=state==='recording'?Math.min(MAX_SECONDS,Math.floor((Date.now()-s.startedAt)/1000)):0;
    const labels={idle:'Dictation Bridge',requesting:'Requesting microphone…',recording:`Recording ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`,stopping:'Finishing recording…',transcribing:'Gateway → OpenAI → text…',error:'No response · audio in memory',recovery:'Transcript ready · choose insertion location'};
    this.label.textContent=labels[state];this.status?.setText(state==='idle'?'🎙 Dictation Bridge':labels[state]);
    this.panel.hidden=state==='idle';this.panel.dataset.state=state;this.meter.hidden=state!=='recording';
    this.primary.textContent=state==='error'?'Retry':state==='recovery'?'Show transcript':'Done';this.primary.disabled=['stopping','transcribing'].includes(state)||(state==='error'&&!s.canRetry());
    this.cancelButton.textContent=state==='recovery'?'Discard result':'Cancel';
  }
  onunload(){this.disposed=true;this.cancel();this.panel?.remove();this.options=null;}
}

class RecoveryModal extends Modal {
  constructor(plugin){super(plugin.app);this.plugin=plugin;plugin.modals.add(this);}
  onOpen(){
    this.contentEl.addClass('dictation-bridge-modal');this.contentEl.createEl('h2',{text:'Transcript'});
    this.contentEl.createEl('p',{text:'The original note or insertion point changed. Open the desired note, position the cursor and insert the transcript. It is kept only until cancellation, hiding or locking the app.'});
    this.textarea=this.contentEl.createEl('textarea',{attr:{'aria-label':'Recognized text',spellcheck:'false'}});this.textarea.value=this.plugin.session.text;
    this.contentEl.createEl('button',{text:'Insert into current note',cls:'mod-cta'}).addEventListener('click',()=>{
      try{const target=this.plugin.captureTarget();if(!this.plugin.insertCaptured(this.textarea.value,target))throw Error();this.plugin.session.cancel();this.close();}catch{new Notice('Open the intended note in editing mode and retry insertion.');}
    });
    this.contentEl.createEl('button',{text:'Back to notes'}).addEventListener('click',()=>{this.plugin.session.text=this.textarea.value;this.close();});
  }
  onClose(){if(this.textarea&&this.plugin.session.state==='recovery')this.plugin.session.text=this.textarea.value;if(this.textarea)this.textarea.value='';this.contentEl.empty();this.plugin.modals.delete(this);}
}

class VoiceSettings extends PluginSettingTab {
 constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
 display(){
  const p=this.plugin,c=this.containerEl;c.empty();c.addClass('dictation-bridge-settings');p.loadOptions();
  c.createEl('p',{text:'Audio and your explicit vocabulary are sent to your gateway, then to OpenAI. The note title, path and existing text are never uploaded. A gateway and a paid OpenAI API account are required. The API key stays on the gateway.'});
  c.createEl('p',{text:'Maximum recording: 4 minutes 55 seconds / 5 MiB. Audio and transcript stay in memory until completion or cancellation. Hiding Obsidian or locking Cipherfold cancels unfinished dictation. Cancellation cannot recall audio already sent.'});
  const draft={...p.options};let secretInput;
  new Setting(c).setName('HTTPS endpoint').setDesc('Full transcription URL on your own gateway. No default service is provided.').addText(t=>t.setPlaceholder('https://voice.example.com/dictation-bridge/v1/transcribe').setValue(draft.endpoint||'').onChange(v=>draft.endpoint=v.trim()));
  new Setting(c).setName('Instance UUID').setDesc('Generate a separate device identity on your gateway for each vault/device.').addText(t=>t.setValue(draft.instanceId||'').onChange(v=>draft.instanceId=v.trim()));
  new Setting(c).setName('Device token').setDesc('Gateway device token, not an OpenAI API key. Required when saving the connection. Stored using OS-encrypted Obsidian SecretStorage.').addText(t=>{secretInput=t.inputEl;secretInput.type='password';secretInput.autocomplete='off';});
  new Setting(c).addButton(b=>b.setButtonText('Save connection').setCta().onClick(()=>{
   const token=secretInput.value.trim();secretInput.value='';
   try{
    validateEndpoint(draft.endpoint);
    if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw codeError('INVALID_TOKEN');
    if(!UUID.test(draft.instanceId||''))throw codeError('INVALID_ID');
    normalizeSettings(draft);
    if(!p.storageReady())throw Error();
    p.saveOptions({...draft,token});
    new Notice('Connection saved on this device.');this.display();
   }catch(e){new Notice(errors[e.code]||'OS-encrypted secret storage is unavailable.');}
  }));
  const options={...p.options};
  new Setting(c).setName('Expected languages').setDesc('Optional comma-separated ISO language codes, e.g. en, ru. Leave empty for automatic detection; up to eight.').addText(t=>t.setValue(options.languages.join(', ')).onChange(v=>options.languages=v.trim()?v.split(',').map(x=>x.trim()):[]));
  new Setting(c).setName('Vocabulary').setDesc('Up to 50 terms, one per line. These terms are sent with the audio.').addTextArea(t=>t.setValue(options.keywords).onChange(v=>options.keywords=v));
  new Setting(c).setName('Whole-line formatting commands').setDesc('Convert standalone “new paragraph”, “new line” and “new item” (also Russian equivalents) to Markdown. Off by default.').addToggle(t=>t.setValue(options.voiceCommands).onChange(v=>options.voiceCommands=v));
  new Setting(c).addButton(b=>b.setButtonText('Save transcription settings').onClick(()=>{try{p.saveOptions(options);new Notice('Settings saved.');}catch(e){new Notice(errors[e.code]||'Save a connection first.');}}));
  c.createEl('p',{text:'Start from the microphone icon or command palette. Assign a shortcut in Obsidian Hotkeys. Retry reuses the same request ID; uncertain requests are never submitted to OpenAI twice.'});
 }
 hide(){this.containerEl.querySelectorAll('input[type="password"]').forEach(e=>e.value='');}
}
