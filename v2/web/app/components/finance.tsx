'use client';

import { Banknote, ClipboardCheck, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, can, dateBoundary, fmt, href, money, short, when, type PageRows,type References,type Row,type User } from '../lib';
import { Busy, Field, Modal, Notice, Options, Pagination, Panel, RefOptions, Status, Table, cents, submit, useAction, useResource, value } from './ui';

export function Finance({user,refs}:{user:User;refs:References}) {
  const mayAgency=can(user,'agency_payments.read');
  const mayCreate=can(user,'agency_payments.create');
  const mayMerchant=can(user,'merchant_finance.read');
  const [mode,setMode]=useState(mayAgency?'agency':'merchant');
  const [agency,setAgency]=useState('');
  const [merchant,setMerchant]=useState(user.merchantId??'');
  const [record,setRecord]=useState('');
  const [creation,setCreation]=useState(false);
  const [invoice,setInvoice]=useState(false);
  const [pay,setPay]=useState('');
  const [page,setPage]=useState(1);
  const [from,setFrom]=useState('');
  const [to,setTo]=useState('');
  const [today,setToday]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const range={from:today||dateBoundary(from),to:dateBoundary(to)};
  const payments=useResource<PageRows>(mode==='agency'?href('/finance/agencies',{agencyId:agency,page}):null);
  const invoices=useResource<PageRows&{balance_centimes:string;reserved_centimes:string}>(mode==='merchant'?
    href('/finance/merchant',{merchantId:merchant,page}):null);
  const candidates=useResource<PageRows>(creation&&agency?href('/finance/agencies/'+agency+'/eligible',{...range,page}):null);
  const detail=useResource<{bon:Row;lines:Row[];receipts:Row[]}>(record?'/finance/agency-bons/'+record:null);
  const action=useAction(()=>{payments.reload();invoices.reload();detail.reload();candidates.reload();});
  const bon=detail.data?.bon;
  async function create(all:boolean) {
    await action.run(async()=>{
      const row=await api<Row>('/finance/agencies/'+agency+'/bons',{all:all?true:undefined,ids:all?undefined:selected,
        from:range.from||undefined,to:range.to||undefined});
      setRecord(row.id);setCreation(false);setSelected([]);setPage(1);
    },'Bon de paiement créé.');
  }

  return <>
    {mayAgency&&mayMerchant&&<div className="segmented"><button className={mode==='agency'?'active':''} onClick={()=>{setMode('agency');setPage(1);}}>Paiements agence</button>
      <button className={mode==='merchant'?'active':''} onClick={()=>{setMode('merchant');setPage(1);}}>Relevés marchands</button></div>}
    {mode==='agency'&&<Panel title="Bons de Paiement Agence" description="Remises partielles, reste à recevoir et confirmation financière."
      actions={mayCreate&&<button className="button primary" onClick={()=>{setCreation(true);setPage(1);}}><Plus size={16}/>Nouveau bon</button>}>
      <div className="filters"><Field title="Agence"><select value={agency} onChange={e=>{setAgency(e.target.value);setPage(1);setSelected([]);}}><RefOptions rows={refs.agencies} empty="Toutes les agences"/></select></Field></div>
      <Notice error={payments.error||action.error} message={action.message}/>
      {payments.loading?<Busy/>:<Table rows={payments.data?.rows??[]} open={setRecord} columns={[
        {title:'Bon',cell:r=><strong className="tracking">PA-{short(r.id)}</strong>},{title:'Agence',cell:r=>fmt(r.agency)},
        {title:'Statut',cell:r=><Status value={r.status}/>},{title:'Attendu',cell:r=>money(r.expected_centimes)},
        {title:'Reçu',cell:r=>money(r.received_centimes)},{title:'Reste',cell:r=><strong>{money(r.outstanding_centimes)}</strong>},
      ]}/>}
      <Pagination page={page} total={payments.data?.total??0} onPage={setPage}/>
    </Panel>}
    {mode==='merchant'&&<Panel title="Relevés et COD marchand" description="Solde issu du journal de centimes, indépendant des remises agence."
      actions={user.role==='ADMIN'&&<button className="button primary" disabled={!merchant} onClick={()=>setInvoice(true)}><Plus size={16}/>Créer un relevé</button>}>
      {!user.merchantId&&<div className="filters"><Field title="Marchand"><select value={merchant} onChange={e=>{setMerchant(e.target.value);setPage(1);}}><RefOptions rows={refs.merchants}/></select></Field></div>}
      {merchant&&<div className="summary-grid">
        <div><small>Solde comptable</small><strong>{money(invoices.data?.balance_centimes)}</strong></div>
        <div><small>Réservé sur des relevés</small><strong>{money(invoices.data?.reserved_centimes)}</strong></div>
        <div><small>Disponible</small><strong>{money(Number(invoices.data?.balance_centimes??0)-Number(invoices.data?.reserved_centimes??0))}</strong></div>
      </div>}
      <Notice error={invoices.error||action.error} message={action.message}/>
      <Table rows={invoices.data?.rows??[]} columns={[
        {title:'Référence',cell:r=><strong className="tracking">PM-{short(r.id)}</strong>},{title:'Colis',cell:r=>fmt(r.parcels)},
        {title:'Montant',cell:r=>money(r.total_centimes)},{title:'Date',cell:r=>when(r.created_at)},
        {title:'Statut',cell:r=><Status value={r.paid_at?'PAYE':'EN_COURS_TRAITEMENT'}/>},
        {title:'Action',cell:r=>user.role==='ADMIN'&&!r.paid_at?<button className="text-button" onClick={()=>setPay(r.id)}>Payer</button>:'—'},
      ]}/>
      <Pagination page={page} total={invoices.data?.total??0} onPage={setPage}/>
    </Panel>}
    {creation&&<Modal title="Préparer un paiement agence" onClose={()=>{setCreation(false);setPage(1);}}>
      <div className="filters"><Field title="Agence"><select value={agency} onChange={e=>{setAgency(e.target.value);setSelected([]);setPage(1);}}><RefOptions rows={refs.agencies}/></select></Field>
        <Field title="Du"><input type="date" value={from} disabled={Boolean(today)} onChange={e=>{setFrom(e.target.value);setSelected([]);}}/></Field>
        <Field title="Avant le"><input type="date" value={to} onChange={e=>{setTo(e.target.value);setSelected([]);}}/></Field>
        <label className="check"><input type="checkbox" checked={Boolean(today)} onChange={e=>{setToday(e.target.checked?new Date(Date.now()-86_400_000).toISOString():'');setPage(1);setSelected([]);}}/>Dernières 24 h</label>
      </div>
      <Table rows={candidates.data?.rows??[]} columns={[{title:'Code suivi',cell:r=>fmt(r.tracking_code)},{title:'Livré le',cell:r=>when(r.delivered_at)},
        {title:'COD',cell:r=>money(r.cod_centimes)}]} selected={selected} toggle={id=>setSelected(previous=>previous.includes(id)?previous.filter(x=>x!==id):[...previous,id])}/>
      <Pagination page={page} total={candidates.data?.total??0} onPage={setPage}/>
      <Notice error={action.error}/>
      <div className="actions"><button className="button secondary" disabled={!selected.length||action.busy} onClick={()=>void create(false)}>Créer avec la sélection</button>
        <button className="button primary" disabled={!candidates.data?.total||action.busy} onClick={()=>void create(true)}>Tout ajouter</button></div>
    </Modal>}
    {record&&<Modal title={'Paiement PA-'+short(record)} onClose={()=>setRecord('')}>
      {detail.loading?<Busy/>:<Notice error={detail.error||action.error} message={action.message}/>}
      {bon&&<><div className="summary-grid"><div><small>Attendu</small><strong>{money(bon.expected_centimes)}</strong></div>
        <div><small>Reçu</small><strong>{money(bon.received_centimes)}</strong></div><div><small>Reste</small><strong>{money(bon.outstanding_centimes)}</strong></div></div>
        <div className="action-strip"><Status value={bon.status}/>{Number(bon.excess_centimes)>0&&<span className="tag">Excédent {money(bon.excess_centimes)}</span>}
          {bon.paid_at!=null&&<span>Confirmé le {when(bon.paid_at)}</span>}</div>
        <Table rows={(detail.data?.lines??[]).map((row,index)=>({...row,id:fmt(row.tracking_code)||String(index)}))}
          columns={[{title:'Code suivi',cell:r=>fmt(r.tracking_code)},{title:'COD',cell:r=>money(r.cod_centimes)},{title:'Éligible',cell:r=>r.eligible?'Oui':'Non'}]}/>
        <h3>Versements</h3><Table rows={detail.data?.receipts??[]} columns={[
          {title:'Montant',cell:r=>money(r.amount_centimes)},{title:'Référence',cell:r=>fmt(r.reference)||'—'},{title:'Date',cell:r=>when(r.received_at)},
        ]}/>
        {mayCreate&&bon.status!=='PAYE'&&Number(bon.outstanding_centimes)>0&&<form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(()=>api(
          '/finance/agency-bons/'+record+'/remittance',{amount:cents(form,'amount'),reference:value(form,'reference')||undefined,requestKey:crypto.randomUUID()}),'Remise enregistrée.'))}>
          <Field title="Remise (MAD)"><input name="amount" type="number" min=".01" step=".01" required/></Field>
          <Field title="Référence"><input name="reference" maxLength={140}/></Field>
          <button className="button secondary wide" disabled={action.busy}><Banknote size={16}/>Enregistrer la remise</button>
        </form>}
        {can(user,'agency_payments.confirm_paid')&&bon.status!=='PAYE'&&Number(bon.expected_centimes)===Number(bon.received_centimes)&&
          <button className="button primary" onClick={()=>{if(window.confirm('Confirmer le règlement complet et figer le bon ?'))
            void action.run(()=>api('/finance/agency-bons/'+record+'/confirm-paid',{confirmed:true}),'Bon payé.');}}><ClipboardCheck size={16}/>Confirmer Payé</button>}
      </>}
    </Modal>}
    {invoice&&<Modal title="Créer un relevé marchand" onClose={()=>setInvoice(false)}><form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(async()=>{
      const ids=value(form,'ids').split(/[\s,]+/).filter(Boolean);
      await api('/finance/merchant/'+merchant+'/invoices',{ids:ids.length?ids:undefined,all:!ids.length?true:undefined,
        from:dateBoundary(value(form,'from'))||undefined,to:dateBoundary(value(form,'to'))||undefined});
      setInvoice(false);
    }))}><Field title="Identifiants commandes" hint="Séparés par un espace. Laisser vide pour tous les colis éligibles du filtre."><textarea name="ids" rows={3}/></Field>
      <Field title="Du"><input type="date" name="from"/></Field><Field title="Avant le"><input type="date" name="to"/></Field>
      <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Créer le relevé</button></form></Modal>}
    {pay&&<Modal title="Payer le relevé marchand" onClose={()=>setPay('')}><form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(async()=>{
      await api('/finance/invoices/'+pay+'/pay',{method:value(form,'method'),reference:value(form,'reference')||undefined,confirmed:true});setPay('');
    }))}><Field title="Mode"><select name="method"><Options values={['ESPECES','VIREMENT']}/></select></Field>
      <Field title="Référence de virement"><input name="reference" maxLength={140}/></Field><Notice error={action.error}/>
      <button className="button primary wide" disabled={action.busy}>Valider et figer</button></form></Modal>}
  </>;
}
