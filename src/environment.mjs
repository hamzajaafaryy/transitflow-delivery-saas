// Read deployment identity from trusted process configuration, never request headers.
export function publicBaseUrl(env=process.env){
 const configured=String(env.PUBLIC_BASE_URL||'').trim();
 let url;
 if(configured){
  try{url=new URL(configured);}catch{throw Error('PUBLIC_BASE_URL doit être une URL HTTP(S) valide');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('PUBLIC_BASE_URL doit être une URL HTTP(S) sans identifiants');
 }
 const local=!url||['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 const name=env.CODESPACE_NAME,domain=env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,port=Number(env.PORT||3000);
 if(local&&env.CODESPACES==='true'&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name||'')&&/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(domain||'')&&Number.isInteger(port)&&port>=1&&port<=65535){
  return `https://${name}-${port}.${domain}`;
 }
 return url?.origin||'http://localhost:3000';
}
