'use client';

import { Boxes, Plus, Printer, ScanBarcode } from 'lucide-react';
import { useState } from 'react';
import { api, can, dateBoundary, fmt, href, money, orderStatuses, packagingKinds, when,
  type PageRows,type References,type Row,type User } from '../lib';
import { Busy, Download, Field, FilterGroup, Modal, Notice, Options, Pagination, Panel, RefOptions, Status, Table, cents,
  integer, submit, useAction, useResource, value } from './ui';
import { Scanner } from './scanner';

const tracking=(row:Row)=><span className="tracking">{fmt(row.tracking_code)}</span>;
const dateFields=(name:string,value:string,set:(value:string)=>void)=><Field title={name}><input type="date" value={value} onChange={event=>set(event.target.value)}/></Field>;

export function Orders({user,refs,initialId}:{user:User;refs:References;initialId?:string}) {
  const [filter,setFilter]=useState({search:'',city:'',status:'',merchantId:'',agencyId:'',from:'',to:''});
  const [page,setPage]=useState(1);
  const [selected,setSelected]=useState<string[]>([]);
  const [open,setOpen]=useState(initialId??'');
  const [create,setCreate]=useState(false);
  const [collect,setCollect]=useState(false);
  const [pack,setPack]=useState(false);
  const [batch,setBatch]=useState('');
  const filters={...filter,from:dateBoundary(filter.from),to:dateBoundary(filter.to)};
  const orders=useResource<PageRows>(href('/orders',{...filters,page}));
  const current=useResource<{order:Row;history:Row[]}>(open?'/orders/'+open:null);
  const action=useAction(()=>{orders.reload();current.reload();});
  const agency=Boolean(user.agencyId);
  const [source,setSource]=useState('EXTERNAL');
  const [stockMerchant,setStockMerchant]=useState(user.merchantId??'');
  const [itemCount,setItemCount]=useState(1);
  const stock=useResource<{rows:Row[]}>(create&&source==='STOCK'&&(stockMerchant||user.merchantId)?
    href('/stock',{merchantId:stockMerchant||user.merchantId}):null);

  function set(name:keyof typeof filter,value:string) {
    setFilter(previous=>({...previous,[name]:value}));setPage(1);setSelected([]);
  }

  const columns=agency?[
    {title:'Code suivi',cell:tracking},{title:'Statut',cell:(row:Row)=><Status value={row.status}/>},
    {title:'Dernier scan',cell:(row:Row)=>fmt(row.current_holder_type)==='AGENCY'?'Reçu en agence':'—'},
    {title:'Date',cell:(row:Row)=>when(row.holder_updated_at)},{title:'Agence',cell:(row:Row)=>fmt(row.agency)},
  ]:[
    {title:'Code suivi',cell:tracking},{title:'Destinataire',cell:(row:Row)=>fmt(row.recipient)},
    {title:'Téléphone',cell:(row:Row)=>fmt(row.phone)},{title:'Ville',cell:(row:Row)=><span className="capitalize">{fmt(row.city)}</span>},
    {title:'Statut',cell:(row:Row)=><Status value={row.status}/>},{title:'Marchand',cell:(row:Row)=>fmt(row.merchant)},
    {title:'Prix',cell:(row:Row)=><strong>{money(row.cod_centimes)}</strong>},{title:'Agence',cell:(row:Row)=>fmt(row.agency)||'—'},
  ];

  return <>
    <Panel title={agency?'Stock Colis':'Commandes'} description={agency?'Colis physiquement détenus par votre agence.':'Suivi opérationnel par date réelle de changement de statut.'}
      actions={<>{(agency||can(user,'orders.export'))&&<Download path={href(agency?'/agency-stock/export':'/orders/export',filters)}>Exporter Excel</Download>}
        {can(user,'orders.create')&&<button className="button primary" onClick={()=>setCreate(true)}><Plus size={17}/>Nouvelle commande</button>}</>}>
      <FilterGroup active={Object.entries(filter).filter(([name,value])=>name!=='search'&&value).length}
        search={<Field title="Recherche"><input placeholder={agency?'Code suivi':'Code suivi ou téléphone'} value={filter.search}
          onChange={event=>set('search',event.target.value)}/></Field>}>
        <Field title="Statut"><select value={filter.status} onChange={event=>set('status',event.target.value)}><Options values={orderStatuses} empty="Tous les statuts"/></select></Field>
        {!agency&&<Field title="Ville"><select value={filter.city} onChange={event=>set('city',event.target.value)}><Options values={refs.cities} empty="Toutes les villes"/></select></Field>}
        {!user.merchantId&&!agency&&<Field title="Marchand"><select value={filter.merchantId} onChange={event=>set('merchantId',event.target.value)}><RefOptions rows={refs.merchants} empty="Tous les marchands"/></select></Field>}
        {!user.merchantId&&!agency&&<Field title="Agence"><select value={filter.agencyId} onChange={event=>set('agencyId',event.target.value)}><RefOptions rows={refs.agencies} empty="Toutes les agences"/></select></Field>}
        {dateFields('Du',filter.from,v=>set('from',v))}{dateFields('Avant le',filter.to,v=>set('to',v))}
      </FilterGroup>
      {!agency&&<div className="action-strip">
        <button className="button secondary" disabled={!selected.length||action.busy} onClick={()=>void action.run(async()=>{
          const result=await api<{id:string}>('/tickets',{ids:selected});setBatch(result.id);
        },'Lot de tickets préparé.')}><Printer size={16}/>Tickets 100 × 100 {selected.length?('· '+selected.length):''}</button>
        {batch&&<Download path={'/tickets/'+batch+'/pdf'}>Télécharger / réimprimer</Download>}
        {can(user,'dispatch.manage')&&<>
          <button className="button primary scan-entry" aria-expanded={collect} onClick={()=>setCollect(!collect)}><ScanBarcode size={19}/>
            {collect?'Fermer le scan':'Scanner le ramassage'}</button>
          {batch&&<button className="button secondary" onClick={()=>{if(window.confirm('Confirmer le ramassage en lot sous votre responsabilité ?'))
            void action.run(()=>api('/tickets/'+batch+'/collect',{confirmed:true}),'Ramassage en lot traité.');}}>Ramasser le lot imprimé</button>}
        </>}
        {can(user,'stock.manage')&&<button className="button secondary" disabled={!selected.length} onClick={()=>setPack(true)}><Boxes size={16}/>Emballage</button>}
      </div>}
    {collect&&<Scanner title="Ramassage · arrivée entrepôt" references={refs} scan={async (input,signal)=>{
      const result=await api<{outcome:string}>('/orders/collect',input,'POST',signal);orders.reload();return result;
    }}/>}
      <Notice error={orders.error||action.error} message={action.message}/>
      {orders.loading?<Busy/>:<Table rows={orders.data?.rows??[]} columns={columns} open={setOpen}
        selected={selected} toggle={agency?undefined:id=>setSelected(previous=>previous.includes(id)?previous.filter(key=>key!==id):[...previous,id])}/>}
      <Pagination page={page} total={orders.data?.total??0} onPage={setPage}/>
    </Panel>
    {create&&<Modal title="Nouvelle commande" onClose={()=>{setCreate(false);setSource('EXTERNAL');setItemCount(1);}}>
      <form className="form-grid" onSubmit={event=>submit(event,data=>void action.run(async()=>{
        const items=source==='STOCK'?Array.from({length:itemCount},(_,index)=>({
          productId:value(data,'product-'+index),quantity:integer(data,'quantity-'+index),
        })):[];
        await api('/orders',{merchantId:user.merchantId||value(data,'merchant')||undefined,source,recipient:value(data,'recipient'),
          phone:value(data,'phone'),address:value(data,'address'),city:value(data,'city'),codCentimes:cents(data,'cod'),
          merchandise:value(data,'merchandise'),quantity:integer(data,'qty')||1,comment:value(data,'comment'),items,
          canOpen:data.has('canOpen'),isExchange:data.has('exchange')});
        setCreate(false);setItemCount(1);
      },'Commande créée.'))}>
        {!user.merchantId&&<Field title="Marchand"><select name="merchant" value={stockMerchant} required onChange={e=>setStockMerchant(e.target.value)}><RefOptions rows={refs.merchants}/></select></Field>}
        <Field title="Type de commande"><select value={source} onChange={e=>setSource(e.target.value)}><Options values={['EXTERNAL','STOCK']}/></select></Field>
        <Field title="Destinataire"><input name="recipient" required maxLength={100}/></Field>
        <Field title="Téléphone"><input type="tel" name="phone" required maxLength={24}/></Field>
        <Field title="Ville"><input name="city" list="cities" required maxLength={80}/><datalist id="cities">{refs.cities.map(city=><option key={city}>{city}</option>)}</datalist></Field>
        <Field title="Montant COD (MAD)"><input type="number" name="cod" step=".01" min="0" defaultValue="0" required/></Field>
        <Field title="Adresse"><input name="address" required maxLength={250}/></Field>
        <Field title="Marchandise"><input name="merchandise" maxLength={200}/></Field>
        <Field title="Commentaire"><input name="comment" maxLength={250}/></Field>
        {source==='EXTERNAL'&&<Field title="Quantité"><input type="number" name="qty" min="1" max="1000" defaultValue="1"/></Field>}
        {source==='STOCK'&&Array.from({length:itemCount},(_,index)=><div className="wide form-grid" key={index}>
          <Field title={'Produit '+(index+1)}><select name={'product-'+index} required><option value="">Choisir…</option>{stock.data?.rows.map(row=>
            <option key={row.id} value={row.id}>{fmt(row.sku)} · {fmt(row.name)} ({fmt(row.available)} disponibles)</option>)}</select></Field>
          <Field title="Quantité"><input type="number" name={'quantity-'+index} min="1" max="1000" defaultValue="1" required/></Field>
        </div>)}
        {source==='STOCK'&&<button type="button" className="button secondary" onClick={()=>setItemCount(itemCount+1)}>Ajouter un produit</button>}
        <div className="actions wide"><label className="check"><input type="checkbox" name="canOpen"/> Peut ouvrir</label>
          <label className="check"><input type="checkbox" name="exchange"/> Colis remplacer</label></div>
        <Notice error={action.error}/>
        <button className="button primary wide" disabled={action.busy}>Créer la commande</button>
      </form>
    </Modal>}
    {pack&&<Modal title="Emballage groupé" onClose={()=>setPack(false)}>
      <form className="form-grid" onSubmit={event=>submit(event,data=>void action.run(async()=>{
        await api('/orders/packaging',{ids:selected,kind:value(data,'kind')||null,companyPacked:data.has('packed'),
          heavyOverride:value(data,'reason')||undefined,overrideCentimes:value(data,'override')?cents(data,'override'):undefined});setPack(false);
      }))}><Field title="Type"><select name="kind"><Options values={packagingKinds} empty="Aucun"/></select></Field>
        <label className="check"><input type="checkbox" name="packed"/> Emballé par TransitFlow</label>
        <Field title="Montant dérogatoire (MAD)"><input type="number" name="override" min="0" step=".01"/></Field>
        <Field title="Motif article lourd"><input name="reason" maxLength={250}/></Field>
        <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Appliquer à la sélection</button>
      </form>
    </Modal>}
    {open&&<Modal title={current.data?'Commande '+fmt(current.data.order.tracking_code):'Commande'} onClose={()=>setOpen('')}>
      {current.loading?<Busy/>:<Notice error={current.error||action.error} message={action.message}/>}
      {current.data&&<><div className="summary-grid">
        <div><small>Statut</small><Status value={current.data.order.status}/></div>
        <div><small>Détenteur</small><strong>{fmt(current.data.order.current_holder_type)||'—'}</strong></div>
        <div><small>Dernier scan</small><strong>{when(current.data.order.holder_updated_at)}</strong></div>
      </div>
      <h3>Historique des statuts</h3><ul className="timeline">{current.data.history.map((row,i)=><li key={i}><Status value={row.status}/><span>{when(row.occurred_at)} · {fmt(row.source)}</span></li>)}</ul>
      {can(user,'orders.status_override')&&<form className="form-grid" onSubmit={event=>submit(event,data=>void action.run(()=>api('/orders/'+open+'/correct',{
        status:value(data,'status'),reason:value(data,'reason'),returnAuthorized:data.has('authorized'),
      }),'Correction auditée.'))}>
        <Field title="Nouveau statut"><select name="status" defaultValue={fmt(current.data.order.status)}><Options values={orderStatuses}/></select></Field>
        <Field title="Motif obligatoire"><input name="reason" required maxLength={400}/></Field>
        <label className="check"><input type="checkbox" name="authorized"/> Autoriser le retour</label>
        <button className="button primary" disabled={action.busy}>Corriger le statut</button>
      </form>}</>}
    </Modal>}
  </>;
}
