export const DEFAULT_SETTINGS = Object.freeze({ languages: [], keywords: '', voiceCommands: false });

const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const LIMIT = 5 * 1024 * 1024;

export function normalizeSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_SETTINGS');
  const result = { ...DEFAULT_SETTINGS };
  for (const key of ['voiceCommands']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('INVALID_SETTINGS');
    if (input[key] !== undefined) result[key] = input[key];
  }
  if (input.languages !== undefined) {
    if (!Array.isArray(input.languages) || input.languages.length > 8 || input.languages.some(l => typeof l !== 'string' || !/^[a-z]{2,3}$/.test(l))) fail('INVALID_SETTINGS');
    result.languages = [...new Set(input.languages)];
  }
  if (input.keywords !== undefined) {
    if (typeof input.keywords !== 'string') fail('INVALID_KEYWORDS');
    // Lines are term separators; commas remain part of a literal term.
    const terms = input.keywords.split(/\r?\n/).filter((term) => term.length > 0);
    if (terms.length > 50 || terms.some((term) => !term.trim() || term.length > 100 || /[<>\r\n]/.test(term))) fail('INVALID_KEYWORDS');
    result.keywords = terms.join('\n');
  }
  return result;
}

export function validateEndpoint(value) {
  let url; try { url = new URL(value); } catch { fail('INVALID_ENDPOINT'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !url.hostname) fail('INVALID_ENDPOINT');
  return url.href;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function buildTranscriptionRequest({ bytes, mime, token, instanceId, requestId, settings, endpoint } = {}) {
  const normalized = normalizeSettings(settings);
  const url = validateEndpoint(endpoint);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > LIMIT) fail('INVALID_AUDIO');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) fail('INVALID_TOKEN');
  if (!UUID.test(instanceId||'') || !UUID.test(requestId||'')) fail('INVALID_ID');
  if (typeof mime !== 'string' || !/^audio\/(webm|mp4|wav|x-wav)(;\s*codecs\s*=\s*"?[a-zA-Z0-9.,_-]+"?\s*)?$/.test(mime)) fail('INVALID_MIME');
  let binary='';
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const body=JSON.stringify({request_id:requestId,instance_id:instanceId,audio_base64:btoa(binary),mime,languages:normalized.languages,keywords:normalized.keywords.split('\n').filter(Boolean)});
  return {url,method:'POST',headers:{Authorization:`Bearer ${token}`},contentType:'application/json',body,throw:false};
}

const safeCodes=new Set(['FORBIDDEN','PROVIDER_UNAVAILABLE','BUSY','DAILY_LIMIT','REQUEST_CONFLICT','RESULT_EXPIRED','REQUEST_UNKNOWN','PROVIDER_UNCERTAIN','INVALID_AUDIO','INVALID_MIME','AUDIO_TOO_LONG','DAILY_AUDIO_LIMIT','INVALID_AUDIO_DURATION']);
export function parseTranscript(response, {requestId,instanceId}={}) {
  if (!response || !Number.isInteger(response.status)) fail('INVALID_RESPONSE');
  if(response.status<200||response.status>=300){
    const code=response.json?.error;
    if(safeCodes.has(code))fail(code);
    fail(response.status===401||response.status===403?'AUTH_ERROR':response.status===429?'RATE_LIMIT':response.status>=500?'SERVER_ERROR':'HTTP_ERROR');
  }
  if(!UUID.test(requestId||'')||!UUID.test(instanceId||'')||response.json?.request_id!==requestId||response.json?.instance_id!==instanceId)fail('RESPONSE_MISMATCH');
  const text=response.json?.text;
  if(typeof text!=='string'||!text.trim()||text.length>100000)fail('INVALID_TRANSCRIPT');
  return text;
}

export function formatTranscript(text, settings) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) fail('INVALID_TRANSCRIPT');
  if (!normalizeSettings(settings).voiceCommands) return text;
  return text.replace(/(^|\n)[ \t]*(new paragraph|new line|new item|новый абзац|новая строка|новый пункт)[ \t]*(?:\r?\n|$)/giu, (_match, prefix, command) => {
    switch (command.toLocaleLowerCase('ru')) {
      case 'new paragraph': case 'новый абзац': return prefix + '\n';
      case 'new line': case 'новая строка': return prefix;
      default: return prefix + '- ';
    }
  });
}

export function planInsertion({ original, current, from, to, text } = {}) {
  if (typeof original !== 'string' || typeof current !== 'string') fail('INVALID_TARGET');
  if (original !== current) fail('TARGET_CHANGED');
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > original.length) fail('INVALID_RANGE');
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) fail('INVALID_TRANSCRIPT');
  // Preserve transcription verbatim, adding a separating space only between adjacent words.
  const word = (c) => c && /[\p{L}\p{N}]/u.test(c);
  const before = original[from - 1], after = original[to];
  const prefix = word(before) && word(text[0]) ? ' ' : '';
  const suffix = word(text[text.length - 1]) && word(after) ? ' ' : '';
  return { from, to, text: prefix + text + suffix };
}
