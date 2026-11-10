import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {name:'TransitFlow V2 · Opérations',short_name:'TransitFlow',start_url:'/',scope:'/',display:'standalone',
    background_color:'#f3f7f8',theme_color:'#102434',lang:'fr',
    icons:[{src:'/icon-192.png',sizes:'192x192',type:'image/png'},{src:'/icon-512.png',sizes:'512x512',type:'image/png'}]};
}
