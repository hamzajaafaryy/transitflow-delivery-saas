'use client';

import { AlertCircle, ArrowDownToLine, ChevronLeft, ChevronRight, CircleHelp, Inbox, LoaderCircle, RefreshCw, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, display, fmt, type Reference, type Row } from '../lib';

export function useResource<T>(path:string|null, interval=0) {
  const [state,setState]=useState<{path:string|null;data?:T;error?:string}>({path:null});
  const [nonce,setNonce]=useState(0);
  const reload=useCallback(()=>setNonce(value=>value+1),[]);
  useEffect(()=>{
    if (!path) return;
    let live=true;
    async function fetchData() {
      try {
        const data=await api<T>(path!);
        if (live) setState({path,data});
      } catch (error) {
        if (live) setState({path,error:error instanceof Error?error.message:'Service indisponible.'});
      }
    }
    void fetchData();
    const timer=interval?window.setInterval(fetchData,interval):undefined;
    return ()=>{live=false;window.clearInterval(timer);};
  },[path,interval,nonce]);
  const current: {data?:T;error?:string}=state.path===path?state:{};
  return {...current,loading:Boolean(path&&!current.data&&!current.error),reload};
}

export function useAction(after?:()=>void) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  async function run<T>(task:()=>Promise<T>,success='Enregistré.') {
    if (busy) return;
    setBusy(true);setError('');setMessage('');
    try {
      const result=await task();
      setMessage(success);after?.();
      return result;
    } catch (fault) {
      setError(fault instanceof Error?fault.message:'Opération impossible.');
    } finally {
      setBusy(false);
    }
  }
  return {busy,error,message,run};
}

export function Status({value}:{value:unknown}) {
  const key=fmt(value);
  const tone=['LIVRE','RECU','RECU_VILLE','TERMINE','PAYE','CONFIRME_PAR_MARCHAND','RESOLUE','FERMEE'].includes(key)?'green':
    ['REFUSE','ANNULE','ANNULEE','ESCALADEE'].includes(key)?'red':
    ['MANQUE_STOCK','ATTENTE_RAMASSAGE','EN_ATTENTE','REPORTE','EN_COURS_TRAITEMENT','EN_ATTENTE_CONFIRMATION'].includes(key)?'amber':'blue';
  return <span className={'status '+tone}><i/>{display(value)}</span>;
}

export function Notice({error,message}:{error?:string;message?:string}) {
  return error?<div className="notice error" role="alert"><AlertCircle size={17}/>{error}</div>:
    message?<div className="notice success" role="status">{message}</div>:null;
}
export function Busy() {
  return <div className="empty"><LoaderCircle className="spin" size={22}/> Chargement…</div>;
}
export function Empty({text='Aucun résultat pour cette sélection.'}:{text?:string}) {
  return <div className="empty"><Inbox size={29}/><span>{text}</span></div>;
}
export function Panel({title,description,actions,children}:{title:string;description?:string;actions?:ReactNode;children:ReactNode}) {
  return <section className="panel"><div className="panel-head"><div><h2>{title}</h2>{description&&<p>{description}</p>}</div>
    {actions&&<div className="actions">{actions}</div>}</div>{children}</section>;
}
export function Table({rows,columns,open,selected,toggle,empty}:{rows:Row[];columns:{title:string;cell:(row:Row)=>ReactNode}[];
  open?:(id:string)=>void;selected?:string[];toggle?:(id:string)=>void;empty?:string}) {
  if (!rows.length) return <Empty text={empty}/>;
  return <div className="table-wrap"><table className="responsive-table" role="table">
    <thead role="rowgroup"><tr role="row">{toggle&&<th scope="col" className="tick" role="columnheader">Choix</th>}
      {columns.map(column=><th scope="col" key={column.title} role="columnheader">{column.title}</th>)}
      {open&&<th scope="col" role="columnheader">Actions</th>}
    </tr></thead>
    <tbody role="rowgroup">{rows.map(row=>{
      const checked=selected?.includes(row.id)||false;
      return <tr key={row.id} role="row" data-selected={checked||undefined}>{toggle&&<td role="cell" className="table-select">
        <label><input type="checkbox" aria-label={'Sélectionner '+fmt(row.tracking_code||row.id)} checked={checked} onChange={()=>toggle(row.id)}/>
          <span>Choisir</span></label>
      </td>}
      {columns.map(column=><td role="cell" key={column.title} data-label={column.title}><div>{column.cell(row)}</div></td>)}
      {open&&<td role="cell" className="table-open"><button className="text-button" onClick={()=>open(row.id)}>Ouvrir<ChevronRight size={16}/></button></td>}
    </tr>;})}</tbody></table></div>;
}
export function FilterGroup({search,children,active=0}:{search:ReactNode;children:ReactNode;active?:number}) {
  const [expanded,setExpanded]=useState(false);
  const id=useId();
  return <div className="filters mobile-filters" data-expanded={expanded}>
    <div className="filter-search">{search}</div>
    <button className="button secondary filter-toggle" type="button" aria-expanded={expanded} aria-controls={id}
      onClick={()=>setExpanded(!expanded)}><SlidersHorizontal size={17}/> Filtres{active>0&&<span className="filter-count">{active}</span>}</button>
    <div id={id} className="filter-fields">{children}</div>
  </div>;
}
export function Pagination({page,total,onPage}:{page:number;total:number;onPage:(page:number)=>void}) {
  return <div className="pagination"><span>{total.toLocaleString('fr-MA')} résultat{total===1?'':'s'} · Page {page}</span>
    <div className="actions"><button className="icon-button" aria-label="Page précédente" disabled={page<=1} onClick={()=>onPage(page-1)}><ChevronLeft size={18}/></button>
      <button className="icon-button" aria-label="Page suivante" disabled={page*50>=total} onClick={()=>onPage(page+1)}><ChevronRight size={18}/></button></div></div>;
}
export function Download({path,children}:{path:string;children:ReactNode}) {
  return <a className="button secondary" href={'/api/v2'+path}><ArrowDownToLine size={16}/>{children}</a>;
}
export function Refresh({reload}:{reload:()=>void}) {
  return <button className="button secondary" onClick={reload}><RefreshCw size={15}/>Actualiser</button>;
}
export function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}) {
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{
    const element=dialog.current;
    element?.showModal();
    return ()=>element?.close();
  },[]);
  return <dialog className="modal" ref={dialog} aria-label={title} onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="modal-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Fermer" onClick={onClose}><X size={20}/></button></div>
    <div className="modal-body">{children}</div>
  </dialog>;
}
export function Field({title,children,hint}:{title:string;children:ReactNode;hint?:string}) {
  return <label className="field"><span>{title}</span>{children}{hint&&<small>{hint}</small>}</label>;
}
export function RefOptions({rows,empty='Choisir…'}:{rows:Reference[];empty?:string}) {
  return <><option value="">{empty}</option>{rows.map(row=><option value={row.id} key={row.id}>{row.name}{row.city?' · '+row.city:''}</option>)}</>;
}
export function Options({values,empty}:{values:string[];empty?:string}) {
  return <>{empty&&<option value="">{empty}</option>}{values.map(value=><option key={value} value={value}>{display(value)}</option>)}</>;
}
export function submit(event:FormEvent<HTMLFormElement>,callback:(values:FormData)=>void) {
  event.preventDefault();
  callback(new FormData(event.currentTarget));
}
export const value=(data:FormData,name:string)=>String(data.get(name)??'').trim();
export const integer=(data:FormData,name:string)=>Number(value(data,name));
export const cents=(data:FormData,name:string)=>Math.round(Number(value(data,name))*100);
export function Info({children}:{children:ReactNode}) {
  return <div className="notice info"><CircleHelp size={17}/>{children}</div>;
}
