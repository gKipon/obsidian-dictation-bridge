// Use the Web Fetch redirect policy, rather than Obsidian's native requestUrl
// (which always follows redirects). Tokens must never follow a redirect.
export async function requestGateway(options,fetchImpl=globalThis.fetch){
 const response=await fetchImpl(options.url,{method:'POST',headers:{...options.headers,'Content-Type':options.contentType},body:options.body,signal:options.signal,redirect:'error',credentials:'omit',cache:'no-store'});
 let json=null;
 try{json=await response.json();}catch{}
 return {status:response.status,json};
}
