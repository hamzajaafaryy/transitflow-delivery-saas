'use client';

import { ArrowLeft, LockKeyhole, Plus, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, attachment, can, display, fmt, href, short, when, type PageRows,type Row,type User } from '../lib';
import { Busy, Field, Modal, Notice, Options, Pagination, Panel, Status, Table, submit, useAction, useResource, value } from './ui';

export function Claims({user,initialId}:{user:User;initialId?:string}) {
  const [record,setRecord]=useState(initialId??'');
  const [page,setPage]=useState(1);
  const [newClaim,setNewClaim]=useState(false);
  const [topic,setTopic]=useState('OTHER');
  const rows=useResource<PageRows>(href('/claims',{page}),10_000);
  const data=useResource<{claim:Row;messages:Row[];parcels:Row[]}>(record?'/claims/'+record:null);
  const metrics=useResource<{rows:Row[]}>(['ADMIN','RESPONSABLE'].includes(user.role)&&can(user,'claims.supervise')?'/claims/performance':null);
  const action=useAction(()=>{rows.reload();data.reload();metrics.reload();});
  useEffect(()=>{
    if (!record) return;
    const stream=new EventSource('/api/v2/claims/'+record+'/stream');
    function refresh(){data.reload();rows.reload();}
    stream.addEventListener('refresh',refresh);
    return ()=>stream.close();
  },[record,data.reload,rows.reload]);
  const claim=data.data?.claim;
  const active=claim&&['OUVERTE','EN_COURS','ESCALADEE'].includes(fmt(claim.status));
  function change(actionName:string,extra:Record<string,unknown>={}) {
    void action.run(()=>api('/claims/'+record+'/state',{action:actionName,...extra}));
  }
  return <>
    {!record?<Panel title="Réclamations" description="Conversations suivies, réponses et délais ouvrés."
      actions={user.merchantId&&<button className="button primary" onClick={()=>setNewClaim(true)}><Plus size={16}/>Nouvelle réclamation</button>}>
      <Notice error={rows.error||action.error} message={action.message}/>
      {rows.loading?<Busy/>:<Table rows={rows.data?.rows??[]} open={setRecord} columns={[
        {title:'Dossier',cell:r=><strong className="tracking">REC-{short(r.id)}</strong>},{title:'Sujet',cell:r=>fmt(r.subject)},
        {title:'Thème',cell:r=>display(r.topic)},{title:'Statut',cell:r=><Status value={r.status}/>},
        {title:'Attribué à',cell:r=>fmt(r.assignee)||'—'},{title:'Dernier message',cell:r=>when(r.updated_at)},
        {title:'SLA',cell:r=>r.sla==='LATE'?<span className="tag red">En retard</span>:r.urgent?<span className="tag amber">Urgent</span>:'—'},
      ]}/>}
      <Pagination page={page} total={rows.data?.total??0} onPage={setPage}/>
    </Panel>:<Panel title={fmt(claim?.subject)||'Réclamation'} description={'REC-'+short(record)+' · '+display(claim?.topic)}
      actions={<button className="button secondary" onClick={()=>setRecord('')}><ArrowLeft size={16}/>Liste</button>}>
      <Notice error={data.error||action.error} message={action.message}/>
      {data.loading?<Busy/>:claim&&<>
        <div className="action-strip"><Status value={claim.status}/>{claim.urgent===true&&<span className="tag amber">Urgent</span>}
          {!user.merchantId&&active&&<>
            {claim.topic==='RETURN'&&!claim.assignee_id&&can(user,'returns.manage')&&<button className="button secondary" onClick={()=>change('CLAIM')}>Prendre en charge</button>}
            <button className="button secondary" onClick={()=>change('RESOLVE')}>Résoudre</button>
            <button className="button secondary" onClick={()=>change('CLOSE')}>Fermer</button>
            {claim.status!=='ESCALADEE'&&<button className="button secondary" onClick={()=>change('ESCALATE')}>Escalader</button>}</>}
          {user.role==='ADMIN'&&<><button className="button secondary" onClick={()=>change('URGENT',{urgent:!claim.urgent})}>{claim.urgent?'Retirer l’urgence':'Marquer urgent'}</button>
            {claim.status==='ESCALADEE'&&<button className="button secondary" onClick={()=>{const id=window.prompt('Identifiant du responsable délégué');if(id?.trim()) change('DELEGATE',{assigneeId:id.trim()});}}>Déléguer</button>}</>}
          {user.merchantId&&claim.status!=='ANNULEE'&&<button className="button danger" onClick={()=>{if(window.confirm('Annuler cette réclamation ?')) change('CANCEL');}}>Annuler</button>}
          {user.merchantId&&['RESOLUE','FERMEE'].includes(fmt(claim.status))&&Number(claim.reopen_count)<3&&
            <button className="button secondary" onClick={()=>change('REOPEN')}>Rouvrir · {3-Number(claim.reopen_count)} restant(s)</button>}
        </div>
        {!!data.data?.parcels.length&&<div className="chip-list">{data.data.parcels.map(row=><span className="tag" key={row.id}>{fmt(row.tracking_code)}</span>)}</div>}
        <div className="chat">{data.data?.messages.map(row=><article key={row.id} className={'message '+(row.private_note?'private':row.role==='MERCHANT'?'merchant':'staff')}>
          <header><strong>{fmt(row.author)}</strong><span>{when(row.created_at)}</span></header>
          {row.private_note===true&&<span className="tag"><LockKeyhole size={13}/>Note privée</span>}
          <p>{fmt(row.body)}</p>{row.file_id!=null&&<a href={'/api/v2/claims/'+record+'/files/'+fmt(row.file_id)}>Télécharger la pièce jointe</a>}
        </article>)}</div>
        {active&&<form className="form-grid padded" onSubmit={event=>{const element=event.currentTarget;submit(event,form=>void action.run(async()=>{
          await api('/claims/'+record+'/messages',{body:value(form,'body'),privateNote:form.has('private'),
            attachment:await attachment(form.get('file') as File)});element.reset();
        },'Message envoyé.'));}}>
          <Field title="Votre message"><textarea name="body" rows={3} required maxLength={4000}/></Field>
          <Field title="Pièce jointe"><input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf"/></Field>
          {!user.merchantId&&<label className="check"><input type="checkbox" name="private"/> Note interne</label>}
          <button className="button primary" disabled={action.busy}><Send size={16}/>Envoyer</button>
        </form>}
      </>}
    </Panel>}
    {!record&&metrics.data&&<Panel title="Suivi équipe" description="Accès responsables.">
      <Table rows={metrics.data.rows} columns={[{title:'Responsable',cell:r=>fmt(r.display_name)},{title:'Actives',cell:r=>fmt(r.active)},{title:'Fermées',cell:r=>fmt(r.closed)}]}/>
    </Panel>}
    {newClaim&&<Modal title="Nouvelle réclamation" onClose={()=>setNewClaim(false)}><form className="form-grid" onSubmit={event=>submit(event,form=>void action.run(async()=>{
      const row=await api<Row>('/claims',{topic,referenceId:value(form,'ref')||undefined,subject:value(form,'subject'),
        message:value(form,'message'),parcels:value(form,'parcels').split(/[\s,]+/).filter(Boolean),attachment:await attachment(form.get('file') as File)});
      setNewClaim(false);setRecord(row.id);
    }))}>
      <Field title="Thème"><select value={topic} onChange={e=>setTopic(e.target.value)}><Options values={['OTHER','ORDER','PICKUP','STOCK','INVOICE','SETTLEMENT','RETURN']}/></select></Field>
      {topic!=='OTHER'&&<Field title="Identifiant de la référence"><input name="ref" required/></Field>}
      <Field title="Sujet"><input name="subject" required maxLength={160}/></Field>
      {topic==='RETURN'&&<Field title="Identifiants des colis concernés (facultatif)"><input name="parcels"/></Field>}
      <Field title="Message"><textarea name="message" required rows={4} maxLength={4000}/></Field>
      <Field title="Pièce jointe"><input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf"/></Field>
      <Notice error={action.error}/><button className="button primary wide" disabled={action.busy}>Créer la réclamation</button>
    </form></Modal>}
  </>;
}
