import {readBoundedText} from './http-body.mjs';
// Use the Web Fetch redirect policy, rather than Obsidian's native requestUrl
// (which always follows redirects). Tokens must never follow a redirect.
export async function requestGateway(options,fetchImpl=globalThis.fetch){
 const response=await fetchImpl(options.url,{method:'POST',headers:{...options.headers,'Content-Type':options.contentType},body:options.body,signal:options.signal,redirect:'error',credentials:'omit',cache:'no-store'});
 let json=null;
 const text=await readBoundedText(response,1024*1024);
 try{json=JSON.parse(text);}catch{}
 return {status:response.status,json};
}
