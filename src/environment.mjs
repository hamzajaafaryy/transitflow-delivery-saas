// Read deployment identity from trusted process configuration, never request headers.
function codespaceBaseUrl(env){
 const name=env.CODESPACE_NAME,domain=env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,port=Number(env.PORT||3000);
 if(env.CODESPACES==='true'&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name||'')&&/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(domain||'')&&Number.isInteger(port)&&port>=1&&port<=65535)return `https://${name}-${port}.${domain}`;
 return null;
}
export function publicBaseUrl(env=process.env){
 const configured=String(env.PUBLIC_BASE_URL||'').trim();
 let url;
 if(configured){
  try{url=new URL(configured);}catch{throw Error('PUBLIC_BASE_URL doit être une URL HTTP(S) valide');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('PUBLIC_BASE_URL doit être une URL HTTP(S) sans identifiants');
 }
 const local=!url||['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 const forwarded=codespaceBaseUrl(env);
 if(local&&forwarded)return forwarded;
 return url?.origin||'http://localhost:3000';
}

// Codespaces can rewrite the standard Origin to localhost. Compatibility is
// scoped to this exact codespace and port, with an independent custom header.
// A browser cannot send this custom header cross-origin without a successful
// CORS preflight; this server grants no cross-origin CORS access.
export function allowedBrowserOrigin(headers,expected,env=process.env){
 const actual=headers.origin,target=new URL(expected).origin;
 if(!actual||actual===target)return true;
 if(codespaceBaseUrl(env)!==target||headers['x-transitflow-origin']!==target)return false;
 const site=headers['sec-fetch-site'];
 if(site&&site!=='same-origin')return false;
 const port=Number(env.PORT||3000);
 return ['http','https'].some(protocol=>['localhost','127.0.0.1','[::1]'].some(host=>actual===`${protocol}://${host}:${port}`));
}
