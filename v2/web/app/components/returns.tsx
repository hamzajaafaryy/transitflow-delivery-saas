'use client';

import { ArrowLeft, ClipboardCheck, LockKeyhole, MessageCircle, Plus, ScanBarcode, Send, Upload } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, attachment, can, dateBoundary, display, fmt, href, normalizeCodes, short, when,
  type PageRows,type References,type Row,type User } from '../lib';
import { Scanner } from './scanner';
import { Busy, Download, Field, FilterGroup, Info, Modal, Notice, Options, Pagination, Panel, RefOptions, Refresh, Status, Table,
  submit, useAction, useResource, value } from './ui';

interface ReturnDetails {
  bon:Row;lines:Row[];canEdit:boolean;
  counts:{ received:number;expected:number;missing:number;anomalies:number;invalid:number;reconciled:number;manual:number };
}
const parcelCode=(row:Row)=><strong className="tracking">{fmt(row.tracking_code)}</strong>;

export function AgencyReturns({user,refs,initialId}:{user:User;refs:References;initialId?:string}) {
  const [filters,setFilters]=useState({agencyId:'',status:'',search:'',from:'',to:''});
  const [page,setPage]=useState(1);
  const [record,setRecord]=useState(initialId??'');
  const [create,setCreate]=useState<'import'|'manual'|''>('');
  const [scan,setScan]=useState(false);
  const [damaged,setDamaged]=useState(false);
  const [note,setNote]=useState('');
  const [photo,setPhoto]=useState<File>();
  const [original,setOriginal]=useState('');
  const rows=useResource<PageRows>(href('/return-bons',{...filters,from:dateBoundary(filters.from),to:dateBoundary(filters.to),page}));
  const data=useResource<ReturnDetails>(record?'/return-bons/'+record:null);
  const action=useAction(()=>{rows.reload();data.reload();});
  const bon=data.data?.bon;
  const canScan=can(user,'returns.scan');
  const canManage=can(user,'returns.manage')&&(!user.agencyId||bon?.creator_kind==='AGENCY');
  const counts=data.data?.counts;
  function show(id:string) {setRecord(id);setScan(false);setDamaged(false);setPhoto(undefined);setNote('');}
  function set(name:keyof typeof filters,value:string) {setFilters(previous=>({...previous,[name]:value}));setPage(1);}
  const change=(status:string)=>void action.run(()=>api('/return-bons/'+record+'/state',{action:status,confirmed:true,receivedCount:counts?.received}));

  return <>
    {!record?<Panel title="Bons Retour Agence" description="Import Excel, réception physique et écarts."
      actions={<><Refresh reload={rows.reload}/>{can(user,'returns.manage')&&<>
        <button className="button secondary" onClick={()=>{setOriginal('');setCreate('manual');}}><Plus size={16}/>Nouveau bon</button>
        <button className="button primary" onClick={()=>{setOriginal('');setCreate('import');}}><Upload size={17}/>Importer Excel</button></>}</>}>
      <FilterGroup active={Object.entries(filters).filter(([name,value])=>name!=='search'&&value).length}
        search={<Field title="Code ou numéro de bon"><input value={filters.search} onChange={e=>set('search',e.target.value)}/></Field>}>
        {!user.agencyId&&<Field title="Agence"><select value={filters.agencyId} onChange={e=>set('agencyId',e.target.value)}><RefOptions rows={refs.agencies} empty="Toutes les agences"/></select></Field>}
        <Field title="Statut"><select value={filters.status} onChange={e=>set('status',e.target.value)}><Options values={['BROUILLON','ENVOYE','RECU']} empty="Tous"/></select></Field>
        <Field title="Du"><input type="date" value={filters.from} onChange={e=>set('from',e.target.value)}/></Field>
        <Field title="Avant le"><input type="date" value={filters.to} onChange={e=>set('to',e.target.value)}/></Field>
      </FilterGroup>
      <Notice error={rows.error||action.error} message={action.message}/>
      {rows.loading?<Busy/>:<Table rows={rows.data?.rows??[]} open={show} columns={[
        {title:'Bon',cell:r=><strong className="tracking">RET-{short(r.id)}</strong>},{title:'Agence',cell:r=>fmt(r.agency)},
        {title:'État',cell:r=><Status value={r.status}/>},{title:'Attendus',cell:r=>fmt(r.expected)},
        {title:'Reçus',cell:r=>fmt(r.received)},{title:'Date',cell:r=>when(r.created_at)},
      ]}/>}
      <Pagination page={page} total={rows.data?.total??0} onPage={setPage}/>
    </Panel>:<Panel title={'Bon RET-'+short(record)} description={fmt(bon?.agency)}
      actions={<><button className="button secondary" onClick={()=>show('')}><ArrowLeft size={16}/>Liste</button><Refresh reload={data.reload}/>
        {bon?.status==='RECU'&&<Download path={'/return-bons/'+record+'/pdf'}>Télécharger PDF A4</Download>}</>}>
      <Notice error={data.error||action.error} message={action.message}/>
      {data.loading?<Busy/>:bon&&counts&&<>
        <div className="action-strip"><Status value={bon.status}/>
          {bon.first_received_at!=null&&<span className="tag"><LockKeyhole size={14}/>Liste verrouillée</span>}
          {canManage&&bon.status==='BROUILLON'&&<button className="button secondary" onClick={()=>change('SEND')}>Envoyer</button>}
          {canManage&&bon.status==='ENVOYE'&&<button className="button secondary" onClick={()=>change('REOPEN')}>Rouvrir</button>}
          {canScan&&bon.status!=='RECU'&&<button className="button primary scan-entry" aria-expanded={scan} onClick={()=>setScan(!scan)}><ScanBarcode size={19}/>
            {scan?'Fermer le scan':'Recevoir des colis'}</button>}
          {canScan&&bon.status==='ENVOYE'&&<button className="button secondary" disabled={Boolean(counts.missing)||(!counts.received&&!counts.reconciled)} onClick={()=>{
            if (window.confirm('Clôturer définitivement ce bon ? '+counts.received+' reçus, '+counts.reconciled+' rapprochés, '+counts.missing+' manquants.')) change('CLOSE');
          }}><ClipboardCheck size={16}/>Clôturer reçu</button>}
          {data.data?.canEdit&&<button className="button danger" onClick={()=>{if (window.confirm('Supprimer définitivement ce bon sans réception ?')) {
            void action.run(async()=>{await api('/return-bons/'+record,{confirmed:true},'DELETE');show('');});
          }}}>Supprimer</button>}
        </div>
        <div className="summary-grid return-counts">
          {[['Attendus',counts.expected],['Reçus',counts.received],['Manquants',counts.missing],['Sans état valide',counts.invalid],['Anomalies',counts.anomalies],['Rapprochés',counts.reconciled]].map(([title,count])=>
            <div key={title}><small>{title}</small><strong>{count}</strong></div>)}
        </div>
        {scan&&bon.status!=='RECU'&&<Scanner key={record} title="Réception au warehouse" references={refs} receipt
          extra={<div className="damage-options"><label className="check"><input type="checkbox" checked={damaged} onChange={e=>setDamaged(e.target.checked)}/> Colis endommagé</label>
            {damaged&&<div className="form-grid"><Field title="Note"><input value={note} onChange={e=>setNote(e.target.value)} maxLength={400}/></Field>
              <Field title="Photo (facultative)"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>setPhoto(e.target.files?.[0])}/></Field></div>}</div>}
          scan={async (input,signal)=>{
            const result=await api<{outcome:string}>('/return-bons/'+record+'/receive',{...input,damaged,note:damaged&&note.trim()?note.trim():undefined,
              photo:damaged?await attachment(photo):undefined},'POST',signal);
            data.reload();return result;
          }}/>}
        {data.data?.canEdit&&<form className="filters" onSubmit={event=>submit(event,form=>void action.run(async()=>{
          await api('/return-bons/'+record+'/lines',{add:normalizeCodes(value(form,'codes'))});event.currentTarget?.reset();
        }))}><Field title="Ajouter des codes"><textarea name="codes" rows={2} required/></Field><button className="button secondary" disabled={action.busy}>Ajouter au bon</button></form>}
        <Table rows={data.data?.lines??[]} empty="Ce bon ne contient aucun code." columns={[
          {title:'Code suivi',cell:parcelCode},{title:'Statut commande',cell:r=>r.order_status?<Status value={r.order_status}/>:'—'},
          {title:'État du retour',cell:r=>r.received_at?'Reçu'+(r.input_method==='MANUAL'?' · saisie manuelle':''):r.superseded_at?'Rapproché dans RET-'+short(r.superseded_by):
            r.anomaly_reason?display(r.anomaly_reason):!r.status_valid?'Commande sans état valide':'Attendu'},
          {title:'Date de réception',cell:r=>when(r.received_at)},
          {title:'État du colis',cell:r=><>{r.damaged?'ENDOMMAGÉ':'—'}{r.damage_photo_id!=null&&<a className="text-button" href={'/api/v2/return-photos/'+fmt(r.damage_photo_id)}> Photo</a>}</>},
          {title:'Actions',cell:r=>data.data?.canEdit?<button className="text-button" onClick={()=>{
            if (window.confirm('Retirer '+fmt(r.tracking_code)+' du bon ?')) void action.run(()=>api('/return-bons/'+record+'/lines',{remove:[r.tracking_code],confirmed:true}));
          }}>Retirer</button>:!r.status_valid&&r.order_id!=null?<a href={'/?view=orders&record='+fmt(r.order_id)} target="_blank" rel="noreferrer">Voir commande ↗</a>:'—'},
        ]}/>
      </>}
    </Panel>}
    {create&&<Modal title={create==='import'?'Importer un Bon Retour Agence':'Nouveau Bon Retour Agence'} onClose={()=>setCreate('')}>
      <form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(async()=>{
        const agencyId=user.agencyId||value(form,'agency');
        try {
          let result:ReturnDetails;
          if (create==='import') {
            const upload=new FormData();upload.append('file',form.get('file') as File);
            result=await api('/agencies/'+agencyId+'/return-import',upload);
          } else result=await api('/return-bons',{agencyId,codes:normalizeCodes(value(form,'codes'))});
          setCreate('');show(result.bon.id);
        } catch(error) {
          if (error instanceof ApiError && error.code==='DUPLICATE_IMPORT') setOriginal(fmt(error.details?.bonId));
          throw error;
        }
      },'Bon enregistré.'))}>
        {!user.agencyId&&<Field title="Agence"><select name="agency" required><RefOptions rows={refs.agencies}/></select></Field>}
        {create==='import'?<><Field title="Fichier Excel .xlsx"><input type="file" name="file" required accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/></Field>
          <Info>L’import crée le bon immédiatement. La détention des colis est enregistrée à la réception.</Info></>:
          <Field title="Codes de suivi"><textarea name="codes" rows={4} placeholder="Un code par ligne"/></Field>}
        <Notice error={action.error}/>
        {original&&<button className="button secondary" type="button" onClick={()=>{setCreate('');show(original);}}>Ouvrir le bon existant</button>}
        <button className="button primary wide" disabled={action.busy}>{create==='import'?'Importer et créer':'Créer le bon'}</button>
      </form>
    </Modal>}
  </>;
}

interface MerchantDetails { bon:Row;rows:Row[];whatsapp?:string }
interface Queue extends PageRows { merchants:(Row&{name:string;pending:number})[] }

export function MerchantReturns({user,refs,initialId}:{user:User;refs:References;initialId?:string}) {
  const [record,setRecord]=useState(initialId??'');
  const [merchant,setMerchant]=useState('');
  const [create,setCreate]=useState(false);
  const [selected,setSelected]=useState<string[]>([]);
  const [filter,setFilter]=useState({search:'',from:'',to:''});
  const [page,setPage]=useState(1);
  const [verify,setVerify]=useState(false);
  const canManage=can(user,'merchant_returns.manage');
  const rows=useResource<PageRows>(href('/merchant-returns',{merchantId:merchant,page:record?1:page}));
  const detail=useResource<MerchantDetails>(record?'/merchant-returns/'+record:null);
  const bon=detail.data?.bon;
  const filters={...filter,from:dateBoundary(filter.from),to:dateBoundary(filter.to)};
  const queue=useResource<Queue>(canManage?href('/merchant-returns/queue',{...filters,merchantId:fmt(bon?.merchant_id)||merchant,page}):null);
  const action=useAction(()=>{rows.reload();detail.reload();queue.reload();});
  function open(id:string) {setRecord(id);setSelected([]);setPage(1);setVerify(false);setFilter({search:'',from:'',to:''});}
  const state=(name:string,reason?:string)=>void action.run(()=>api('/merchant-returns/'+record+'/state',{action:name,confirmed:true,reason}));
  const pending=bon?.status==='EN_ATTENTE_CONFIRMATION';
  return <>
    {!record?<Panel title="Retours marchands" description="Préparation, expédition et confirmation de chaque bon."
      actions={canManage&&<button className="button primary" onClick={()=>setCreate(true)}><Plus size={16}/>Nouveau bon</button>}>
      {canManage&&<div className="filters"><Field title="Marchand"><select value={merchant} onChange={e=>{setMerchant(e.target.value);setPage(1);}}><RefOptions rows={refs.merchants} empty="Tous les marchands"/></select></Field></div>}
      <Notice error={rows.error||action.error} message={action.message}/>
      {rows.loading?<Busy/>:<Table rows={rows.data?.rows??[]} open={open} columns={[
        {title:'Bon',cell:r=><strong className="tracking">RC-{short(r.id)}</strong>},{title:'Marchand',cell:r=>fmt(r.merchant)},
        {title:'Statut',cell:r=><Status value={r.status}/>},{title:'Colis',cell:r=>fmt(r.parcels)},{title:'Créé le',cell:r=>when(r.created_at)},
      ]}/>}
      <Pagination page={page} total={rows.data?.total??0} onPage={setPage}/>
    </Panel>:<Panel title={'Bon RC-'+short(record)} description={fmt(bon?.merchant)}
      actions={<><button className="button secondary" onClick={()=>open('')}><ArrowLeft size={16}/>Liste</button>
        <Download path={'/merchant-returns/'+record+'/pdf'}>PDF · 2 exemplaires</Download></>}>
      <Notice error={detail.error||action.error} message={action.message}/>
      {detail.loading?<Busy/>:bon&&<>
        <div className="action-strip"><Status value={bon.status}/><span className="tag">Révision {fmt(bon.revision)}</span>
          {canManage&&bon.status==='EN_PREPARATION'&&<>
            <button className="button primary" onClick={()=>state('SEND')}><Send size={16}/>Expédier vers client</button>
            <button className="button secondary" onClick={()=>setVerify(!verify)}>{verify?'Fermer le scan':'Contrôle facultatif'}</button></>}
          {canManage&&bon.status==='EXPEDIE_VERS_CLIENT'&&<>
            <button className="button secondary" onClick={()=>state('REOPEN')}>Rouvrir</button>
            <button className="button primary" onClick={()=>{if (window.confirm('Confirmer la remise physique au marchand ?')) state('RECEIVE');}}>Reçu par client</button></>}
          {user.role==='ADMIN'&&pending&&<button className="button secondary" onClick={()=>{
            const reason=window.prompt('Motif obligatoire de la correction');if(reason?.trim()) state('EXCEPTIONAL_REOPEN',reason.trim());
          }}>Corriger la remise</button>}
          {user.merchantId&&pending&&<button className="button primary" onClick={()=>{
            if (window.confirm('Confirmer la réception de ce bon ?')) state('CONFIRM');
          }}><ClipboardCheck size={16}/>Confirmer ce bon</button>}
          {detail.data?.whatsapp&&<a className="button secondary" href={detail.data.whatsapp} target="_blank" rel="noreferrer"><MessageCircle size={16}/>WhatsApp manuel</a>}
        </div>
        {verify&&bon.status==='EN_PREPARATION'&&<Scanner key={record} title="Vérification facultative" scan={async (input,signal)=>{
          const result=await api<{outcome:string}>('/merchant-returns/'+record+'/verify',input,'POST',signal);detail.reload();return result;
        }}/>}
        <Table rows={detail.data?.rows??[]} columns={[
          {title:'Code suivi',cell:parcelCode},{title:'Retour agence',cell:r=>when(r.received_at)},
          {title:'Étiquettes',cell:r=>[r.is_exchange?'ÉCHANGE':'',r.damaged?'ENDOMMAGÉ':''].filter(Boolean).join(' · ')||'—'},
          {title:'Contrôle',cell:r=>r.verified_at?'Vérifié':'Facultatif'},
          {title:'Action',cell:r=><>{r.damage_photo_id!=null&&<a href={'/api/v2/return-photos/'+fmt(r.damage_photo_id)}>Photo</a>}
            {canManage&&bon.status==='EN_PREPARATION'&&<button className="text-button" onClick={()=>{if (window.confirm('Retirer ce colis ?'))
              void action.run(()=>api('/merchant-returns/'+record+'/remove',{ids:[r.id],confirmed:true}));}}>Retirer</button>}</>},
        ]}/>
      </>}
    </Panel>}
    {canManage&&(!bon||bon.status==='EN_PREPARATION')&&<Panel title="Colis à remettre" description="Basé sur la date de réception physique au warehouse.">
      {!record&&<div className="chip-list">{queue.data?.merchants.map(row=><button className={'button '+(merchant===row.id?'primary':'secondary')} key={row.id}
        onClick={()=>{setMerchant(row.id);setPage(1);}}>{row.name} · {row.pending}</button>)}</div>}
      <div className="filters">
        <Field title="Code ou téléphone"><input value={filter.search} onChange={e=>{setFilter({...filter,search:e.target.value});setPage(1);setSelected([]);}}/></Field>
        <Field title="Du"><input type="date" value={filter.from} onChange={e=>{setFilter({...filter,from:e.target.value});setPage(1);setSelected([]);}}/></Field>
        <Field title="Avant le"><input type="date" value={filter.to} onChange={e=>{setFilter({...filter,to:e.target.value});setPage(1);setSelected([]);}}/></Field>
        {bon&&<><button className="button secondary" disabled={!selected.length||action.busy} onClick={()=>void action.run(async()=>{
          await api('/merchant-returns/'+record+'/add',{ids:selected,from:filters.from||undefined,to:filters.to||undefined,search:filters.search||undefined});setSelected([]);
        })}>Ajouter · {selected.length}</button>
          <button className="button primary" disabled={!queue.data?.total||action.busy} onClick={()=>void action.run(()=>api('/merchant-returns/'+record+'/add',
            {all:true,from:filters.from||undefined,to:filters.to||undefined,search:filters.search||undefined}),'Tous les résultats filtrés ont été traités.')}>Tout ajouter</button></>}
      </div>
      <Notice error={queue.error}/>
      <Table rows={(queue.data?.rows??[]).map(row=>({...row,id:fmt(row.order_id)}))} columns={[
        {title:'Code suivi',cell:parcelCode},{title:'Téléphone',cell:r=>fmt(r.phone)},{title:'Reçu le',cell:r=>when(r.received_at)},
        {title:'Observation',cell:r=>r.damaged?'Endommagé':r.is_exchange?'Échange':'—'},
      ]} selected={selected} toggle={bon?id=>setSelected(previous=>previous.includes(id)?previous.filter(k=>k!==id):[...previous,id]):undefined}/>
      <Pagination page={page} total={queue.data?.total??0} onPage={setPage}/>
    </Panel>}
    {create&&<Modal title="Nouveau bon marchand" onClose={()=>setCreate(false)}><form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(async()=>{
      const result=await api<Row>('/merchant-returns',{merchantId:value(form,'merchant')});setCreate(false);open(result.id);
    }))}><Field title="Marchand"><select name="merchant" defaultValue={merchant} required><RefOptions rows={refs.merchants}/></select></Field>
      <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Créer le bon</button></form></Modal>}
  </>;
}
