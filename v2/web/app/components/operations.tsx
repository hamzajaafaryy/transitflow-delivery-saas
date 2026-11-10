'use client';

import { Plus, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { api, can, display, fmt, href, money, packagingKinds, short, when, type PageRows,type References,type Row,type User } from '../lib';
import { Busy, Field, Info, Modal, Notice, Options, Pagination, Panel, RefOptions, Status, Table, cents, integer, submit, useAction, useResource, value } from './ui';

export function Stock({user,refs}:{user:User;refs:References}) {
  const [merchant,setMerchant]=useState(user.merchantId??'');
  const [form,setForm]=useState<'product'|'replenish'|'adjust'|''>('');
  const [record,setRecord]=useState('');
  const stock=useResource<{rows:Row[]}>(href('/stock',{merchantId:merchant}));
  const lots=useResource<{rows:Row[]}>(form==='adjust'&&record?'/stock/products/'+record+'/lots':null);
  const action=useAction(()=>stock.reload());
  const manage=can(user,'stock.manage');
  return <Panel title="Stock par marchand" description="Quantités physiques, réservées, disponibles et mises en quarantaine."
    actions={manage&&<button className="button primary" onClick={()=>setForm('product')}><Plus size={16}/>Nouveau produit</button>}>
    {!user.merchantId&&<div className="filters"><Field title="Marchand"><select value={merchant} onChange={e=>setMerchant(e.target.value)}><RefOptions rows={refs.merchants} empty="Tous les marchands"/></select></Field></div>}
    <Notice error={stock.error||action.error} message={action.message}/>
    {stock.loading?<Busy/>:<Table rows={stock.data?.rows??[]} columns={[
      {title:'SKU',cell:r=><strong className="tracking">{fmt(r.sku)}</strong>},{title:'Produit',cell:r=>fmt(r.name)},{title:'Marchand',cell:r=>fmt(r.merchant)},
      {title:'Physique',cell:r=>fmt(r.physical)},{title:'Réservé',cell:r=>fmt(r.reserved)},{title:'Disponible',cell:r=><strong>{fmt(r.available)}</strong>},
      {title:'Quarantaine',cell:r=>fmt(r.quarantined)},{title:'Actions',cell:r=>manage?<div className="actions">
        <button className="text-button" onClick={()=>{setRecord(r.id);setForm('replenish');}}>Réceptionner</button>
        <button className="text-button" onClick={()=>{setRecord(r.id);setForm('adjust');}}>Ajuster</button></div>:'—'},
    ]}/>}
    {form&&<Modal title={form==='product'?'Créer un produit':form==='replenish'?'Réception de stock':'Ajuster un lot'} onClose={()=>setForm('')}>
      <form className="form-grid" onSubmit={event=>submit(event,data=>void action.run(async()=>{
        if (form==='product') await api('/stock/products',{merchantId:value(data,'merchant'),sku:value(data,'sku'),name:value(data,'name')});
        else if (form==='replenish') await api('/stock/products/'+record+'/replenish',{quantity:integer(data,'quantity'),reason:value(data,'reason')||undefined});
        else await api('/stock/lots/'+value(data,'lot')+'/adjust',{quantity:integer(data,'quantity'),reason:value(data,'reason')});
        setForm('');
      }))}>
        {form==='product'?<><Field title="Marchand"><select name="merchant" required defaultValue={merchant}><RefOptions rows={refs.merchants}/></select></Field>
          <Field title="SKU"><input name="sku" required maxLength={80}/></Field><Field title="Nom"><input name="name" required maxLength={150}/></Field></>:<>
          {form==='adjust'&&<Field title="Lot"><select name="lot" required><option value="">Choisir…</option>{lots.data?.rows.map(row=>
            <option key={row.id} value={row.id}>{when(row.created_at)} · {fmt(row.physical)} physiques · {short(row.id)}</option>)}</select></Field>}
          <Field title={form==='adjust'?'Quantité physique constatée':'Quantité reçue'}><input type="number" name="quantity" required min={form==='adjust'?0:1}/></Field>
          <Field title="Motif"><input name="reason" required={form==='adjust'} maxLength={250}/></Field></>}
        <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Enregistrer</button>
      </form>
    </Modal>}
  </Panel>;
}

export function Pickups({user,refs}:{user:User;refs:References}) {
  const [page,setPage]=useState(1),[newPickup,setNewPickup]=useState(false),[record,setRecord]=useState<Row>();
  const data=useResource<PageRows>(href('/pickups',{page}));
  const collectors=useResource<{rows:Row[]}>(can(user,'pickups.manage')?'/pickups/collectors':null);
  const action=useAction(()=>data.reload());
  const current=data.data?.rows.find(row=>row.id===record?.id)??record;
  const manage=can(user,'pickups.manage'),before=['EN_ATTENTE','AFFECTE','REPORTE'].includes(fmt(current?.status));
  const change=(name:string,data:Record<string,unknown>={})=>void action.run(()=>api('/pickups/'+current?.id+'/state',{action:name,...data}));
  return <Panel title="Demandes de ramassage" description="Affectation par zone et clôture après arrivée à l’entrepôt."
    actions={can(user,'pickups.create')&&<button className="button primary" onClick={()=>setNewPickup(true)}><Plus size={16}/>Demander un ramassage</button>}>
    <Notice error={data.error||action.error} message={action.message}/>
    <Table rows={data.data?.rows??[]} open={id=>setRecord(data.data?.rows.find(row=>row.id===id))} columns={[
      {title:'Demande',cell:r=><strong className="tracking">RAM-{short(r.id)}</strong>},{title:'Marchand',cell:r=>fmt(r.merchant)},
      {title:'Zone',cell:r=>fmt(r.zone)},{title:'Statut',cell:r=><Status value={r.status}/>},{title:'Ramasseur',cell:r=>fmt(r.assignee)||'—'},
      {title:'Planifié',cell:r=>when(r.scheduled_at)},
    ]}/>
    <Pagination page={page} total={data.data?.total??0} onPage={setPage}/>
    {newPickup&&<Modal title="Demander un ramassage" onClose={()=>setNewPickup(false)}><form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(async()=>{
      await api('/pickups',{merchantId:user.merchantId||value(form,'merchant'),zone:value(form,'zone'),address:value(form,'address')});setNewPickup(false);
    }))}>{!user.merchantId&&<Field title="Marchand"><select name="merchant" required><RefOptions rows={refs.merchants}/></select></Field>}
      <Field title="Zone"><input name="zone" required maxLength={80}/></Field><Field title="Adresse"><input name="address" required maxLength={250}/></Field>
      <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Enregistrer</button></form></Modal>}
    {current&&<Modal title={'Ramassage RAM-'+short(current.id)} onClose={()=>setRecord(undefined)}>
      <div className="action-strip"><Status value={current.status}/><span>{fmt(current.address)}</span></div>
      {manage&&before&&<form className="form-grid" onSubmit={event=>submit(event,data=>change('ASSIGN',{assigneeId:value(data,'collector')}))}>
        <Field title="Ramasseur disponible"><select name="collector" required><option value="">Choisir…</option>{collectors.data?.rows.filter(row=>row.zone===current.zone)
          .map(row=><option key={row.id} value={row.id}>{fmt(row.display_name)}</option>)}</select></Field>
        <button className="button primary" disabled={action.busy}>Affecter</button></form>}
      {manage&&before&&<form className="form-grid" onSubmit={event=>submit(event,data=>change('POSTPONE',{scheduledAt:new Date(value(data,'time')).toISOString()}))}>
        <Field title="Nouveau rendez-vous"><input type="datetime-local" name="time" required/></Field><button className="button secondary">Reporter</button></form>}
      <div className="actions">
        {can(user,'pickups.collect')&&current.status==='AFFECTE'&&current.assignee_id===user.id&&<button className="button primary" onClick={()=>change('PICK')}>Marquer collecté</button>}
        {manage&&current.status==='PICKED'&&<button className="button primary" onClick={()=>change('CLOSE')}>Clore à l’entrepôt</button>}
        {before&&(manage||user.merchantId)&&<button className="button danger" onClick={()=>{if(window.confirm('Annuler ce ramassage ?')) change('CANCEL');}}>Annuler</button>}
      </div><Notice error={action.error} message={action.message}/>
    </Modal>}
  </Panel>;
}

export function Settings({user,refs,reload}:{user:User;refs:References;reload:()=>void}) {
  const [modal,setModal]=useState<'agency'|'merchant'|'account'|'rates'|'template'|'holiday'|''>('');
  const [target,setTarget]=useState<Row>();
  const [role,setRole]=useState('EMPLOYEE');
  const accounts=useResource<{rows:Row[];permissions:string[]}>(can(user,'users.manage')?'/settings/users':null);
  const action=useAction(()=>{accounts.reload();reload();});
  const config=can(user,'settings.manage');
  return <>
    {config&&<Panel title="Agences et marchands" description="Plusieurs agences peuvent desservir la même ville."
      actions={<><button className="button secondary" onClick={()=>setModal('template')}>Modèles Excel</button>
        <button className="button secondary" onClick={()=>setModal('rates')}>Tarifs marchands</button>
        <button className="button secondary" onClick={()=>setModal('holiday')}>Jours fériés SLA</button>
        <button className="button secondary" onClick={()=>setModal('agency')}><Plus size={16}/>Agence</button>
        <button className="button primary" onClick={()=>setModal('merchant')}><Plus size={16}/>Marchand</button></>}>
      <div className="summary-grid"><div><small>Agences actives</small><strong>{refs.agencies.length}</strong></div>
        <div><small>Marchands actifs</small><strong>{refs.merchants.length}</strong></div></div>
      <Notice error={action.error} message={action.message}/>
    </Panel>}
    {can(user,'users.manage')&&<Panel title="Comptes et autorisations" description="Accès par module, présence et sessions révocables."
      actions={<button className="button primary" onClick={()=>{setRole('EMPLOYEE');setModal('account');}}><Plus size={16}/>Créer un compte</button>}>
      <Notice error={accounts.error||action.error} message={action.message}/>
      <Table rows={accounts.data?.rows??[]} columns={[{title:'Compte',cell:r=>fmt(r.display_name)},{title:'Rôle',cell:r=>display(r.role)},
        {title:'Connexion',cell:r=>fmt(r.login)},{title:'Présence',cell:r=>display(r.presence)},{title:'2FA',cell:r=>r.mfa_enabled?'Activée':'—'},
        {title:'Actions',cell:r=>!['ADMIN','DEVELOPER'].includes(fmt(r.role))?<button className="text-button" onClick={()=>setTarget(r)}><Settings2 size={15}/>Gérer</button>:'—'}]}/>
    </Panel>}
    {target&&<Modal title={'Accès · '+fmt(target.display_name)} onClose={()=>setTarget(undefined)}><form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(async()=>{
      const external=['MERCHANT','PARTNER_AGENCY'].includes(fmt(target.role));
      await api('/settings/users/'+target.id,{presence:value(form,'presence'),active:form.has('active'),grants:external?undefined:form.getAll('grant')},'PUT');setTarget(undefined);
    }))}>
      <Field title="Présence"><select name="presence" defaultValue={fmt(target.presence)}><Options values={['PRESENTE','TT','ABSENTE']}/></select></Field>
      <label className="check"><input name="active" type="checkbox" defaultChecked={Boolean(target.active)}/>Compte actif</label>
      {!['MERCHANT','PARTNER_AGENCY'].includes(fmt(target.role))&&<div className="grant-grid wide">{accounts.data?.permissions.map(p=><label className="check" key={p}><input type="checkbox" name="grant" value={p}
        defaultChecked={Array.isArray(target.permissions)&&target.permissions.includes(p)}/>{p}</label>)}</div>}
      <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Appliquer</button></form></Modal>}
    {modal&&<Modal title={{agency:'Nouvelle agence',merchant:'Nouveau marchand',account:'Nouveau compte',rates:'Tarifs marchands',template:'Modèles Excel',holiday:'Jour férié SLA'}[modal]} onClose={()=>setModal('')}>
      <form className="form-grid" onSubmit={event=>submit(event,data=>void action.run(async()=>{
        if(modal==='agency') await api('/settings/agencies',{name:value(data,'name'),city:value(data,'city'),returnHeader:value(data,'header')||undefined});
        if(modal==='merchant') await api('/settings/merchants',{name:value(data,'name'),phone:value(data,'phone')||undefined,refusedFee:cents(data,'refused')});
        if(modal==='account') await api('/settings/users',{name:value(data,'name'),login:value(data,'login'),password:value(data,'password'),role,
          zone:value(data,'zone')||undefined,agencyId:value(data,'agency')||undefined,merchantId:value(data,'merchant')||undefined,
          grants:data.getAll('grant'),totpSeed:value(data,'totp')||undefined});
        if(modal==='rates') await api('/settings/merchants/'+value(data,'merchant')+'/rates',{
          delivery:value(data,'city')?[{city:value(data,'city'),centimes:cents(data,'fee')}]:[],
          packaging:value(data,'kind')?[{kind:value(data,'kind'),centimes:cents(data,'packaging')}]:[],
          refusedFee:value(data,'refused')?cents(data,'refused'):undefined,
        },'PUT');
        if(modal==='template') await api('/settings/agencies/'+value(data,'agency')+'/templates',{
          returnHeader:value(data,'header'),dispatchHeaders:value(data,'columns').split('\n').map(line=>line.trim()).filter(Boolean),
        },'PUT');
        if(modal==='holiday') await api('/settings/holidays',{day:value(data,'day'),label:value(data,'name')},'PUT');
        setModal('');
      }))}>
        {['agency','merchant','account','holiday'].includes(modal)&&<Field title="Nom"><input name="name" required maxLength={120}/></Field>}
        {modal==='agency'&&<><Field title="Ville"><input name="city" required maxLength={80}/></Field><Field title="Colonne suivi retour"><input name="header" placeholder="CODE SUIVI"/></Field></>}
        {modal==='merchant'&&<><Field title="Téléphone"><input name="phone" type="tel"/></Field><Field title="Frais de refus (MAD)"><input name="refused" type="number" min="0" step=".01" defaultValue="0"/></Field></>}
        {modal==='holiday'&&<Field title="Date locale"><input type="date" name="day" required/></Field>}
        {modal==='account'&&<>
          <Field title="Adresse de connexion"><input type="email" name="login" required/></Field>
          <Field title="Mot de passe initial"><input type="password" name="password" required minLength={14} autoComplete="new-password"/></Field>
          <Field title="Rôle"><select value={role} onChange={e=>setRole(e.target.value)}><Options values={user.role==='RESPONSABLE'?['EMPLOYEE']:['EMPLOYEE','RESPONSABLE','PARTNER_AGENCY','MERCHANT']}/></select></Field>
          {role==='PARTNER_AGENCY'&&<Field title="Agence"><select name="agency" required><RefOptions rows={refs.agencies}/></select></Field>}
          {role==='MERCHANT'&&<Field title="Marchand"><select name="merchant" required><RefOptions rows={refs.merchants}/></select></Field>}
          {['EMPLOYEE','RESPONSABLE'].includes(role)&&<><Field title="Zone de ramassage"><input name="zone"/></Field><Field title="Clé TOTP (facultative)" hint="Obligatoire pour l’approbation financière."><input type="password" name="totp" autoComplete="off"/></Field>
            <div className="grant-grid wide">{accounts.data?.permissions.filter(p=>user.role!=='RESPONSABLE'||user.permissions.includes(p)).map(p=>
              <label className="check" key={p}><input type="checkbox" name="grant" value={p}/>{p}</label>)}</div></>}
        </>}
        {modal==='rates'&&<><Field title="Marchand"><select name="merchant" required><RefOptions rows={refs.merchants}/></select></Field>
          <Field title="Ville"><input name="city"/></Field><Field title="Livraison (MAD)"><input name="fee" type="number" min="0" step=".01"/></Field>
          <Field title="Emballage"><select name="kind"><Options values={packagingKinds} empty="Aucun"/></select></Field>
          <Field title="Frais emballage (MAD)"><input name="packaging" type="number" min="0" step=".01"/></Field>
          <Field title="Frais de refus (MAD)"><input name="refused" type="number" min="0" step=".01"/></Field></>}
        {modal==='template'&&<><Field title="Agence"><select name="agency" required><RefOptions rows={refs.agencies}/></select></Field>
          <Field title="Colonne retour"><input name="header" required defaultValue="CODE SUIVI"/></Field>
          <Field title="11 colonnes d’envoi, dans l’ordre"><textarea name="columns" rows={8} required defaultValue={'CODE SUIVI\nDESTINATAIRE\nTELEPHONE\nADRESSE\nPRIX\nVILLE\nCOMMENTAIRE\nMARCHANDISE\nQTY\nPEUT OUVRIR\nCOLIS REMPLACER'}/></Field></>}
        <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Enregistrer</button>
      </form>
    </Modal>}
  </>;
}

export function Developer({refs}:{refs:References}) {
  const [agency,setAgency]=useState('');
  const data=useResource<{rows:Row[]}>('/developer/partners');
  const details=useResource<{rows:Row[];mappings:Row[]}>(agency?'/developer/partners/'+agency+'/events':null);
  const audit=useResource<{rows:Row[]}>('/developer/audit');
  const action=useAction(()=>{data.reload();details.reload();audit.reload();});
  return <>
    <Panel title="Connexions partenaires" description="Clés chiffrées, statuts non mappés et réexécution auditée.">
      <Notice error={data.error||action.error} message={action.message}/>
      <Table rows={data.data?.rows??[]} open={setAgency} columns={[
        {title:'Agence',cell:r=>fmt(r.name)},{title:'Ville',cell:r=>fmt(r.city)},{title:'Connexion',cell:r=>r.connected?'Configurée':'À configurer'},
        {title:'Dernier événement',cell:r=>when(r.last_seen_at)},{title:'Non mappés',cell:r=>fmt(r.unmapped)},{title:'Alerte',cell:r=>when(r.last_error_at)},
      ]}/>
    </Panel>
    {agency&&<Panel title={refs.agencies.find(row=>row.id===agency)?.name??'Agence partenaire'} description="Paramétrage du webhook signé et reprise chronologique.">
      <Info>La clé est enregistrée chiffrée. Un événement inconnu reste disponible dans la liste des statuts non mappés.</Info>
      <div className="padded split-forms">
        <form onSubmit={event=>{const form=event.currentTarget;submit(event,data=>void action.run(async()=>{
          await api('/developer/partners/'+agency+'/secret',{secret:value(data,'secret')},'PUT');form.reset();
        }));}}><Field title="Nouvelle clé partenaire"><input name="secret" type="password" minLength={32} maxLength={256} autoComplete="new-password" required/></Field>
          <button className="button secondary" disabled={action.busy}>Enregistrer la clé</button></form>
        <form onSubmit={event=>submit(event,form=>void action.run(()=>api('/developer/partners/'+agency+'/mapping',{
          externalStatus:value(form,'external'),status:value(form,'internal'),reason:value(form,'reason'),
        },'PUT'),'Mapping appliqué et historique recalculé.'))}>
          <Field title="Statut externe"><input name="external" required/></Field><Field title="Statut TransitFlow"><select name="internal">
            <Options values={['RECU_VILLE','MISE_EN_DISTRIBUTION','LIVRE','REFUSE','ANNULE','PAS_DE_REPONSE','DEUXIEME_APPEL','TROISIEME_APPEL','REPORTE']}/></select></Field>
          <Field title="Motif"><input name="reason" required/></Field><button className="button primary" disabled={action.busy}>Mapper et rejouer</button></form>
      </div>
      <div className="action-strip"><button className="button secondary" onClick={()=>{const reason=window.prompt('Motif de resynchronisation');
        if(reason?.trim()) void action.run(()=>api('/developer/partners/'+agency+'/resync',{reason:reason.trim()}));}}>Resynchroniser</button></div>
      <Table rows={details.data?.rows??[]} empty="Aucun événement non mappé." columns={[{title:'Statuts non mappés',cell:r=>fmt(r.external_status)},{title:'Date',cell:r=>when(r.occurred_at)}]}/>
      <Table rows={(details.data?.mappings??[]).map(r=>({...r,id:fmt(r.external_status)}))} empty="Aucune correspondance." columns={[
        {title:'Statut externe',cell:r=>fmt(r.external_status)},{title:'Statut TransitFlow',cell:r=><Status value={r.internal_status}/>},
      ]}/>
    </Panel>}
    <Panel title="Journal technique" description="Actions récentes et références techniques.">
      <Table rows={audit.data?.rows??[]} columns={[{title:'Action',cell:r=>fmt(r.action)},{title:'Entité',cell:r=>fmt(r.entity_type)},
        {title:'Référence',cell:r=>short(r.entity_id)},{title:'Date',cell:r=>when(r.created_at)}]}/>
    </Panel>
  </>;
}
