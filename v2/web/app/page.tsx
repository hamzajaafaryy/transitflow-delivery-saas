'use client';

import dynamic from 'next/dynamic';
import { Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Bell, Boxes, CircleCheck, CircleHelp, Clock3, Code2, LayoutDashboard,
  LogOut, Menu, Package, PackageCheck, Radar, RotateCcw, Settings2, ShieldCheck, Truck, Wallet, Warehouse, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, can, display, emptyReferences, fmt, href, moroccoZone, when, type References,type Row,type User } from './lib';
import { Busy, Empty, Field, Notice, Panel, Status, submit, useAction, useResource, value } from './components/ui';

const Orders=dynamic(()=>import('./components/orders').then(module=>module.Orders),{loading:Busy});
const Dispatch=dynamic(()=>import('./components/dispatch').then(module=>module.Dispatch),{loading:Busy});
const AgencyReturns=dynamic(()=>import('./components/returns').then(module=>module.AgencyReturns),{loading:Busy});
const MerchantReturns=dynamic(()=>import('./components/returns').then(module=>module.MerchantReturns),{loading:Busy});
const Finance=dynamic(()=>import('./components/finance').then(module=>module.Finance),{loading:Busy});
const Claims=dynamic(()=>import('./components/claims').then(module=>module.Claims),{loading:Busy});
const Stock=dynamic(()=>import('./components/operations').then(module=>module.Stock),{loading:Busy});
const Pickups=dynamic(()=>import('./components/operations').then(module=>module.Pickups),{loading:Busy});
const Settings=dynamic(()=>import('./components/operations').then(module=>module.Settings),{loading:Busy});
const Developer=dynamic(()=>import('./components/operations').then(module=>module.Developer),{loading:Busy});

const items=[
  {key:'dashboard',name:'Vue d’ensemble',icon:LayoutDashboard,group:'Pilotage',permission:''},
  {key:'orders',name:'Commandes',icon:Package,group:'Exploitation',permission:'orders.read'},
  {key:'stock',name:'Stock',icon:Boxes,group:'Exploitation',permission:'stock.read'},
  {key:'pickups',name:'Ramassages',icon:Truck,group:'Exploitation',permission:'pickups'},
  {key:'dispatch',name:'Bons d’envoi',icon:ArrowUpRight,group:'Exploitation',permission:'dispatch.manage'},
  {key:'agency-returns',name:'Retours agence',icon:RotateCcw,group:'Retours & finance',permission:'returns.read'},
  {key:'merchant-returns',name:'Retours marchands',icon:ArrowDownLeft,group:'Retours & finance',permission:'merchant_returns.read'},
  {key:'finance',name:'Finance',icon:Wallet,group:'Retours & finance',permission:'finance'},
  {key:'claims',name:'Réclamations',icon:CircleHelp,group:'Pilotage',permission:'claims'},
  {key:'settings',name:'Paramètres',icon:Settings2,group:'Administration',permission:'settings'},
  {key:'developer',name:'Intégrations',icon:Code2,group:'Administration',permission:'developer'},
] as const;
type View=typeof items[number]['key'];
const groups=['Pilotage','Exploitation','Retours & finance','Administration'];
const entry:Record<View,string>={
  dashboard:'Suivez les opérations de livraison, du ramassage au règlement.',
  orders:'Recherchez un colis, contrôlez son statut et préparez vos tickets.',
  stock:'Suivez les lots, les réservations et les quantités par marchand.',
  pickups:'Planifiez la collecte et la réception des demandes.',
  dispatch:'Préparez les expéditions par ville et contrôlez leur réception.',
  'agency-returns':'Suivez les retours physiques et les écarts par agence.',
  'merchant-returns':'Préparez la remise des colis et suivez la confirmation du marchand.',
  finance:'Consultez le COD, les relevés et les remises.',
  claims:'Retrouvez les conversations et les dossiers à traiter.',
  settings:'Configurez le réseau, les tarifs, les modèles et les accès.',
  developer:'Supervisez les connexions et les événements partenaires.',
};

function visible(user:User,permission:string) {
  if (!permission) return true;
  if (permission==='developer') return user.role==='DEVELOPER';
  if (permission==='pickups') return ['pickups.manage','pickups.create','pickups.collect'].some(p=>can(user,p));
  if (permission==='finance') return ['agency_payments.read','merchant_finance.read'].some(p=>can(user,p));
  if (permission==='claims') return ['claims.manage','claims.read'].some(p=>can(user,p));
  if (permission==='settings') return ['settings.manage','users.manage'].some(p=>can(user,p));
  return can(user,permission);
}

function Brand({dark=false}:{dark?:boolean}) {
  return <div className={'brand '+(dark?'dark':'')}><img src="/mark.svg" alt="" width={39} height={39}/>
    <div><strong>Transit<span>Flow</span></strong><small>PLATEFORME LOGISTIQUE</small></div></div>;
}

function Login({onLogin}:{onLogin:(user:User)=>void}) {
  const [mfa,setMfa]=useState(false);
  const action=useAction();
  return <main className="login-layout">
    <section className="login-story">
      <Brand dark/>
      <div className="login-story-body">
        <span className="eyebrow"><span className="pulse"/> OPÉRATIONS · MAROC</span>
        <h1>Du premier scan<br/>au règlement.</h1>
        <p>Un espace de travail pour suivre chaque étape, de la collecte jusqu’au retour ou à la livraison.</p>
        <div className="login-lane"><div><Truck size={21}/><strong>Collecte</strong></div>
          <i/><div><Warehouse size={21}/><strong>Entrepôt</strong></div><i/><div><PackageCheck size={21}/><strong>Livraison</strong></div></div>
      </div>
      <p className="login-story-foot"><ShieldCheck size={15}/> Accès réservé aux comptes autorisés</p>
    </section>
    <section className="login-form-pane">
      <div className="login-form-card">
        <div className="mobile-brand"><Brand/></div>
        <span className="label-tag">TRANSITFLOW V2</span><h2>Se connecter</h2><p>Accédez à votre espace avec vos identifiants.</p>
        <form onSubmit={event=>submit(event,data=>void action.run(async()=>{
          try {
            const result=await api<{user:User}>('/auth/login',{login:value(data,'login'),password:String(data.get('password')??''),totp:value(data,'totp')||undefined});
            onLogin(result.user);
          } catch(error) {
            if (error instanceof ApiError&&error.code==='MFA_REQUIRED') setMfa(true);
            throw error;
          }
        }))}>
          <Field title="Adresse de connexion"><input type="email" name="login" autoComplete="username" required placeholder="nom@entreprise.ma"/></Field>
          <Field title="Mot de passe"><input type="password" name="password" autoComplete="current-password" required placeholder="Votre mot de passe"/></Field>
          {mfa&&<Field title="Code à 6 chiffres"><input name="totp" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" maxLength={6} required autoFocus/></Field>}
          <Notice error={action.error}/><button className="button primary login-submit" disabled={action.busy}>{action.busy?'Connexion…':'Se connecter'}<ArrowRight size={18}/></button>
        </form>
      </div>
    </section>
  </main>;
}

function Dashboard({user,go}:{user:User;go:(view:View)=>void}) {
  const data=useResource<{counts:{status:string;count:number}[]}>(can(user,'orders.read')?'/overview':null);
  const counts=Object.fromEntries((data.data?.counts??[]).map(row=>[row.status,row.count]));
  const total=Object.values(counts).reduce((sum,n)=>sum+n,0);
  const options=user.agencyId?[
    {title:'Colis détenus',count:total,icon:Package,color:'teal'},
    {title:'Reçus par ville',count:counts.RECU_VILLE??0,icon:Warehouse,color:'blue'},
    {title:'Refusés / annulés',count:(counts.REFUSE??0)+(counts.ANNULE??0),icon:RotateCcw,color:'amber'},
    {title:'En distribution',count:counts.MISE_EN_DISTRIBUTION??0,icon:Truck,color:'purple'},
  ]:[
    {title:'Total commandes',count:total,icon:Package,color:'teal'},
    {title:'Attente de ramassage',count:counts.ATTENTE_RAMASSAGE??0,icon:Clock3,color:'amber'},
    {title:'En circulation',count:(counts.EXPEDIE??0)+(counts.RECU_VILLE??0)+(counts.MISE_EN_DISTRIBUTION??0),icon:Truck,color:'blue'},
    {title:'Livrés',count:counts.LIVRE??0,icon:CircleCheck,color:'teal'},
  ];
  return <>
    <section className="hero"><div className="hero-text">
      <span className="hero-tag"><Activity size={15}/> CENTRE DE CONTRÔLE</span>
      <h2>Bonjour, {user.displayName||'TransitFlow'}.</h2>
      <p>{user.agencyId?'Consultez le stock physique de votre agence et vos bons de retour.':
        user.merchantId?'Consultez vos commandes, votre stock et vos règlements.':
        'Gardez une vue sur vos colis, les arrivées en agence et les opérations à traiter.'}</p>
      {can(user,'orders.read')&&<button className="button hero-button" onClick={()=>go('orders')}>{user.agencyId?'Voir le stock colis':'Voir les commandes'}<ArrowRight size={17}/></button>}
    </div><div className="hero-art" aria-hidden="true"><div/><div/><div/><Radar size={86} strokeWidth={1.25}/><i/><i/><i/></div></section>
    <Notice error={data.error}/>
    {can(user,'orders.read')&&<div className="stats">{options.map(({title,count,icon:Icon,color})=>
      <article className="stat" key={title}><div className={'stat-icon '+color}><Icon size={21}/></div><span>{title}</span><strong>{data.loading?'—':count.toLocaleString('fr-MA')}</strong></article>)}</div>}
    <div className="dashboard-grid">
      {can(user,'orders.read')&&<Panel title="Répartition des colis" description="Dernier statut enregistré">
        {data.loading?<Busy/>:!data.data?.counts.length?<Empty text="Les premières commandes apparaîtront ici."/>:
          <div className="distribution">{data.data.counts.slice(0,8).map(row=><div className="distribution-row" key={row.status}>
            <Status value={row.status}/><div className="track"><div style={{width:Math.max(5,row.count/total*100)+'%'}}/></div><strong>{row.count}</strong>
          </div>)}</div>}
      </Panel>}
      <Panel title="Accès rapide" description="Vos modules de travail">
        <div className="quick-links">{items.filter(item=>!['dashboard','developer','settings'].includes(item.key)&&visible(user,item.permission)).slice(0,6)
          .map(item=><button key={item.key} onClick={()=>go(item.key)}><span className="quick-icon"><item.icon size={18}/></span>
            <strong>{user.agencyId&&item.key==='orders'?'Stock Colis':item.name}</strong><Chevron/></button>)}</div>
      </Panel>
    </div>
  </>;
}
function Chevron(){return <ArrowRight size={17} className="chevron"/>;}

function Workspace({user,onLogout}:{user:User;onLogout:()=>void}) {
  const [location,setLocation]=useState<{view:View;record?:string}>({view:'dashboard'});
  const [menu,setMenu]=useState(false),[bell,setBell]=useState(false);
  const refs=useResource<References>('/references');
  const alerts=useResource<{rows:Row[];unread:number}>('/notifications',15_000);
  const allowed=items.filter(item=>visible(user,item.permission));
  useEffect(()=>{
    function read(){
      const query=new URLSearchParams(window.location.search),requested=query.get('view');
      const match=items.find(item=>item.key===requested&&visible(user,item.permission));
      const record=query.get('record');
      if (match) setLocation({view:match.key,record:record&&/^[0-9a-f-]{36}$/.test(record)?record:undefined});
      else setLocation({view:'dashboard'});
    }
    read();window.addEventListener('popstate',read);
    return ()=>window.removeEventListener('popstate',read);
  },[user]);
  function go(view:View,record?:string){
    setLocation({view,record});setMenu(false);setBell(false);
    window.history.pushState({},'',view==='dashboard'?'/':href('/',{view,record}));
  }
  const item=allowed.find(item=>item.key===location.view)??allowed[0];
  const title=user.agencyId&&item.key==='orders'?'Stock Colis':item.name;
  const references=refs.data??emptyReferences;
  async function readAlert(row?:Row) {
    await api('/notifications/read',{id:row?.id}).catch(()=>undefined);alerts.reload();
    if (!row) return;
    const group=fmt(row.group_key),id=fmt(row.entity_id);
    if(group.startsWith('merchant-return:')) go('merchant-returns',id);
    else if(group.startsWith('claim-')) go('claims',id);
    else if(group.startsWith('partner-')&&user.role==='DEVELOPER') go('developer');
  }
  const screen={
    dashboard:()=> <Dashboard user={user} go={go}/>,
    orders:()=> <Orders user={user} refs={references} initialId={location.record}/>,
    stock:()=> <Stock user={user} refs={references}/>,
    pickups:()=> <Pickups user={user} refs={references}/>,
    dispatch:()=> <Dispatch refs={references}/>,
    'agency-returns':()=> <AgencyReturns user={user} refs={references} initialId={location.record}/>,
    'merchant-returns':()=> <MerchantReturns user={user} refs={references} initialId={location.record}/>,
    finance:()=> <Finance user={user} refs={references}/>,
    claims:()=> <Claims user={user} initialId={location.record}/>,
    settings:()=> <Settings user={user} refs={references} reload={refs.reload}/>,
    developer:()=> <Developer refs={references}/>,
  };
  return <div className="workspace">
    {menu&&<button className="mobile-overlay" aria-label="Fermer le menu" onClick={()=>setMenu(false)}/>}
    <aside className={'sidebar '+(menu?'mobile-open':'')}>
      <div className="sidebar-brand"><Brand dark/><button className="icon-button close-nav" onClick={()=>setMenu(false)} aria-label="Fermer le menu"><X size={20}/></button></div>
      <div className="scope-card"><span className="scope-icon"><Warehouse size={17}/></span><div><strong>{user.agencyId?'Agence partenaire':user.merchantId?'Espace marchand':'Exploitation'}</strong><small>Maroc · V2</small></div></div>
      <nav aria-label="Navigation principale">
        {groups.map(group=>{const children=allowed.filter(item=>item.group===group);return children.length?<div className="nav-group" key={group}>
          <h2>{group}</h2>{children.map(link=><button key={link.key} className={item.key===link.key?'selected':''} onClick={()=>go(link.key)}
            aria-current={item.key===link.key?'page':undefined}><link.icon size={18}/><span>{user.agencyId&&link.key==='orders'?'Stock Colis':link.name}</span></button>)}</div>:null;})}
      </nav>
      <div className="sidebar-bottom"><span className="connection-dot"/> Espace de travail sécurisé</div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="top-left"><button className="icon-button mobile-menu" aria-label="Ouvrir le menu" onClick={()=>setMenu(true)}><Menu size={22}/></button>
        <div className="breadcrumb"><span>Espace de travail</span><span className="slash">/</span><strong>{title}</strong></div>
      </div>
      <div className="top-actions">
        <div className="notification-anchor"><button className="icon-button bell" aria-label="Notifications" aria-expanded={bell} onClick={()=>setBell(!bell)}>
          <Bell size={21}/>{Boolean(alerts.data?.unread)&&<b>{alerts.data!.unread>99?'99+':alerts.data!.unread}</b>}</button>
          {bell&&<section className="notification-panel"><div className="panel-head"><h2>Notifications</h2><button className="text-button" onClick={()=>void readAlert()}>Tout marquer comme lu</button></div>
            {alerts.data?.rows.length?alerts.data.rows.map(row=><button className={'notification '+(!row.read_at?'unread':'')} onClick={()=>void readAlert(row)} key={row.id}>
              <span className="notice-dot"/><div><strong>{fmt(row.title)}</strong><small>{when(row.updated_at)}</small></div></button>):<Empty text="Aucune notification en cours."/>}
          </section>}
        </div>
        <div className="profile"><span className="avatar">{(user.displayName||'TF').slice(0,2).toUpperCase()}</span><div><strong>{user.displayName}</strong><small>{display(user.role)}</small></div></div>
        <button className="icon-button logout" onClick={onLogout} aria-label="Se déconnecter" title="Se déconnecter"><LogOut size={19}/></button>
      </div></header>
      <main className="content"><div className="page-heading"><div><span className="label-tag">TRANSITFLOW V2</span><h1>{title}</h1>
        <p>{user.agencyId&&item.key==='orders'?'Colis actuellement détenus par votre agence.':entry[item.key]}</p></div>
        <span className="date-chip"><Clock3 size={15}/>{new Intl.DateTimeFormat('fr-MA',{dateStyle:'long',timeZone:moroccoZone(new Date())}).format(new Date())}</span>
      </div><div className="page-body" key={item.key+location.record}>{screen[item.key]()}</div></main>
    </div>
  </div>;
}

export default function Home() {
  const [user,setUser]=useState<User|null|undefined>(undefined);
  useEffect(()=>{
    let live=true;
    api<{user:User}>('/auth/me').then(data=>{if(live)setUser(data.user);}).catch(()=>{if(live)setUser(null);});
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(()=>undefined);
    return ()=>{live=false;};
  },[]);
  if (user===undefined) return <div className="loading-screen"><Brand/><Busy/></div>;
  if (!user) return <Login onLogin={setUser}/>;
  return <Workspace user={user} onLogout={()=>void api('/auth/logout',{}).then(()=>setUser(null)).catch(()=>undefined)}/>;
}
