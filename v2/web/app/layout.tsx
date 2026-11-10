import type { Metadata, Viewport } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title:'TransitFlow V2 · Espace opérations',
  description:'Plateforme de livraison, stock, retours et finances.',
  applicationName:'TransitFlow V2',
  robots:{index:false,follow:false},
  manifest:'/manifest.webmanifest',
  icons:{icon:'/mark.svg',apple:'/icon-192.png'},
  appleWebApp:{capable:true,statusBarStyle:'black-translucent',title:'TransitFlow'},
};
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#102434'};

export default function RootLayout({ children }: Readonly<{children:React.ReactNode}>) {
  return <html lang="fr"><body>{children}</body></html>;
}
