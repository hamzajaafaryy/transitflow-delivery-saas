'use client';

import { ArrowLeft, PackagePlus, Plus, ScanBarcode, Send } from 'lucide-react';
import { useState } from 'react';
import { api, fmt, href, normalizeCodes, short, when, type PageRows,type References,type Row } from '../lib';
import { Scanner } from './scanner';
import { Busy, Download, Field, Modal, Notice, Pagination, Panel, RefOptions, Refresh, Status, Table, submit, useAction, useResource, value } from './ui';

interface DispatchDetails { bon:Row;items:Row[];candidates:Row[];total:number;page:number }

export function Dispatch({refs}:{refs:References}) {
  const [selected,setSelected]=useState<string[]>([]);
  const [search,setSearch]=useState('');
  const [page,setPage]=useState(1);
  const [record,setRecord]=useState('');
  const [agencyId,setAgencyId]=useState('');
  const [create,setCreate]=useState(false);
  const [scanMode,setScanMode]=useState<'add'|'arrival'|'distribution'|''>('');
  const data=useResource<PageRows>(href('/dispatch',{page:record?1:page}),15_000);
  const detail=useResource<DispatchDetails>(record?href('/dispatch/'+record,{page,search}):null,15_000);
  const action=useAction(()=>{data.reload();detail.reload();});
  const bon=detail.data?.bon;
  const agency=refs.agencies.find(x=>x.id===agencyId);
  function selectRecord(id:string) {setRecord(id);setPage(1);setSearch('');setSelected([]);setScanMode('');}
  const canEdit=bon?.status==='EN_PREPARATION'&&!bon.first_received_at;
  const state=(name:string,ids?:string[])=>void action.run(()=>api('/dispatch/'+record+'/state',{action:name,ids,confirmed:true}));
  async function add(all:boolean) {
    await action.run(async()=>{
      const result=await api<{added:number;rejected:string[]}>('/dispatch/'+record+'/add',{all:all?true:undefined,ids:all?undefined:selected,search:search||undefined});
      setSelected([]);
      if (result.rejected.length) throw new Error(result.added+' ajoutés · '+result.rejected.length+' déjà affectés ou inéligibles.');
    },'Sélection ajoutée.');
    detail.reload();
  }

  return <>
    {!record?<Panel title="Bons d’envoi" description="Préparation par ville et agence · Actualisation toutes les 15 secondes"
      actions={<><Refresh reload={data.reload}/><button className="button primary" onClick={()=>setCreate(true)}><Plus size={17}/>Nouveau bon</button></>}>
      <Notice error={data.error||action.error} message={action.message}/>
      {data.loading?<Busy/>:<Table rows={data.data?.rows??[]} open={selectRecord} columns={[
        {title:'Bon',cell:r=><span className="tracking">ENV-{short(r.id)}</span>},{title:'Ville',cell:r=><span className="capitalize">{fmt(r.city)}</span>},
        {title:'Agence',cell:r=>fmt(r.agency)},{title:'État',cell:r=><Status value={r.status}/>},
        {title:'Colis',cell:r=>fmt(r.count)},{title:'Créé le',cell:r=>when(r.created_at)},
      ]}/>}
      <Pagination page={page} total={data.data?.total??0} onPage={setPage}/>
    </Panel>:<Panel title={'Bon ENV-'+short(record)} description={bon?fmt(bon.city)+' · '+(refs.agencies.find(row=>row.id===bon.agency_id)?.name??'Agence'):''}
      actions={<><button className="button secondary" onClick={()=>selectRecord('')}><ArrowLeft size={16}/>Liste</button><Refresh reload={detail.reload}/>
        <Download path={'/dispatch/'+record+'/export'}>Excel agence</Download></>}>
      <Notice error={detail.error||action.error} message={action.message}/>
      {detail.loading?<Busy/>:bon&&<>
        <div className="action-strip"><Status value={bon.status}/>{canEdit&&<button className="button primary" onClick={()=>state('SEND')}><Send size={16}/>Envoyer</button>}
          {bon.status==='ENVOYE'&&!bon.first_received_at&&<button className="button secondary" onClick={()=>state('REOPEN')}>Rouvrir</button>}
          {!bon.first_received_at&&<button className="button danger" onClick={()=>{if(window.confirm('Supprimer ce bon et remettre ses colis à Ramassé ?')){
            void action.run(async()=>{await api('/dispatch/'+record+'/state',{action:'DELETE',confirmed:true});selectRecord('');});
          }}}>Supprimer</button>}
          {canEdit&&<button className="button primary scan-entry" aria-expanded={scanMode==='add'} onClick={()=>setScanMode(scanMode==='add'?'':'add')}><ScanBarcode size={19}/>
            {scanMode==='add'?'Fermer le scan':'Scanner pour ajouter'}</button>}
        </div>
    {record&&scanMode==='add'&&<Scanner key={record} title="Ajout au bon d’envoi" references={refs} scan={async (input,signal)=>{
      const result=await api<{outcome:string}>('/dispatch/'+record+'/scan',input,'POST',signal);detail.reload();return result;
    }}/>}
        <Table rows={detail.data?.items??[]} empty="Aucun colis dans le bon." columns={[
          {title:'Code suivi',cell:r=><span className="tracking">{fmt(r.tracking_code)}</span>},{title:'Marchand',cell:r=>fmt(r.merchant)},
          {title:'Statut',cell:r=><Status value={r.status}/>},{title:'Réception',cell:r=>when(r.received_at)},
          {title:'Action',cell:r=>canEdit?<button className="text-button" onClick={()=>state('REMOVE',[r.id])}>Retirer</button>:'—'},
        ]}/>
        {canEdit&&<><div className="filters">
          <Field title="Colis ramassés · Code suivi / téléphone"><input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);setSelected([]);}}/></Field>
          <button className="button secondary" disabled={!selected.length||action.busy} onClick={()=>void add(false)}>Ajouter la sélection · {selected.length}</button>
          <button className="button primary" disabled={!detail.data?.total||action.busy} onClick={()=>void add(true)}><PackagePlus size={16}/>Tout ajouter</button>
        </div>
        <Table rows={detail.data?.candidates??[]} columns={[{title:'Code suivi',cell:r=>fmt(r.tracking_code)},{title:'Téléphone',cell:r=>fmt(r.phone)},
          {title:'Marchand',cell:r=>fmt(r.merchant)}]} selected={selected} toggle={id=>setSelected(previous=>previous.includes(id)?previous.filter(k=>k!==id):[...previous,id])}/>
        <Pagination page={page} total={detail.data?.total??0} onPage={setPage}/></>}
      </>}
    </Panel>}
    <Panel title="Réception et distribution" description="Scans physiques ou validation manuelle groupée.">
      <div className="filters"><Field title="Agence"><select value={agencyId} onChange={e=>{setAgencyId(e.target.value);setScanMode('');}}><RefOptions rows={refs.agencies}/></select></Field>
        <button className="button secondary" disabled={!agencyId} onClick={()=>setScanMode('arrival')}>Reçu par ville</button>
        <button className="button secondary" disabled={!agencyId} onClick={()=>setScanMode('distribution')}>Mise en distribution</button>
      </div>
      {agencyId&&(scanMode==='arrival'||scanMode==='distribution')&&<>
        <Scanner key={agencyId+scanMode} title={scanMode==='arrival'?'Reçu par ville':'Mise en distribution'} references={refs} receipt
          scan={(input,signal)=>api('/dispatch/agencies/'+agencyId+'/'+scanMode,input,'POST',signal)}/>
        <form className="filters" onSubmit={event=>submit(event,form=>{if(window.confirm('Valider ces colis sans scan physique ?')) void action.run(async()=>{
          const result=await api<{results:{outcome:string}[]}>('/dispatch/agencies/'+agencyId+'/'+scanMode,{codes:normalizeCodes(value(form,'codes')),confirmed:true});
          const errors=result.results.filter(row=>row.outcome!=='RECEIVED');
          if(errors.length) throw new Error(errors.length+' codes non traités. Vérifiez les colis dans la liste.');
        },'Validation groupée enregistrée.');})}><Field title="Codes à traiter en lot"><textarea name="codes" required rows={2}/></Field>
          <button className="button secondary" disabled={action.busy}>Valider en lot</button></form>
      </>}
    </Panel>
    {create&&<Modal title="Nouveau bon d’envoi" onClose={()=>setCreate(false)}><form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(async()=>{
      const id=value(form,'agency'),city=value(form,'city');
      const result=await api<{id:string}>('/dispatch',{agencyId:id,city});setCreate(false);selectRecord(result.id);
    }))}><Field title="Ville"><select name="city" defaultValue={agency?.city??''} required><option value="">Choisir…</option>{refs.cities.map(city=><option key={city}>{city}</option>)}</select></Field>
      <Field title="Agence"><select name="agency" defaultValue={agencyId} required><RefOptions rows={refs.agencies}/></select></Field>
      <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Créer le bon</button></form></Modal>}
  </>;
}
