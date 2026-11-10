'use client';

import { Camera, CheckCircle2, CircleAlert, Keyboard, RotateCw, ScanBarcode, Usb, Volume2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, fmt, type References } from '../lib';
import { Info, Modal } from './ui';

export type ScanInput={ trackingCode:string; requestKey:string;method:'MANUAL'|'BARCODE'|'CAMERA';confirmed?:true };
interface Entry { id:string;code:string;text:string;type:'success'|'duplicate'|'error';error?:ApiError;retry?:()=>void }
type SerialPort={
  readable:ReadableStream<Uint8Array>|null;
  open:(settings:{baudRate:number})=>Promise<void>;
  close:()=>Promise<void>;
};

export function Scanner({scan,title='Scanner un colis',extra,references,receipt=false}:{
  scan:(input:ScanInput)=>Promise<{outcome:string;code?:string}>;title?:string;extra?:ReactNode;references?:References;receipt?:boolean;
}) {
  const [input,setInput]=useState('');
  const [confirm,setConfirm]=useState('');
  const [camera,setCamera]=useState(false);
  const [serial,setSerial]=useState(false);
  const [rows,setRows]=useState<Entry[]>([]);
  const [toasts,setToasts]=useState<Entry[]>([]);
  const [counts,setCounts]=useState({success:0,duplicate:0,error:0});
  const [setup,setSetup]=useState('');
  const [busy,setBusy]=useState(false);
  const [mute,setMute]=useState(false);
  const video=useRef<HTMLVideoElement>(null);
  const field=useRef<HTMLInputElement>(null);
  const stopSerial=useRef<(()=>Promise<void>)|null>(null);
  const sound=useRef<AudioContext|null>(null);
  const queue=useRef(Promise.resolve());
  const mounted=useRef(true);
  const timers=useRef<number[]>([]);
  const handler=useRef(scan);
  handler.current=scan;
  useEffect(()=>{
    mounted.current=true;
    return ()=>{
      mounted.current=false;
      void stopSerial.current?.();
      void sound.current?.close();
      for (const timer of timers.current) window.clearTimeout(timer);
    };
  },[]);
  function setupSound() {
    if (mute) return;
    try {
      sound.current??=new AudioContext();
      if (sound.current.state==='suspended') void sound.current.resume().catch(()=>undefined);
    } catch { /* Audio support is optional. */ }
  }
  function beep(type:Entry['type']) {
    if (mute||!sound.current||type==='error') return;
    const context=sound.current,oscillator=context.createOscillator(),gain=context.createGain();
    oscillator.frequency.value=type==='success'?820:260;
    gain.gain.value=0.075;
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();oscillator.stop(context.currentTime+0.085);
  }
  function hide(id:string) {
    setToasts(previous=>previous.filter(row=>row.id!==id));
  }
  function add(entry:Entry) {
    if (!mounted.current) return;
    setCounts(previous=>({...previous,[entry.type]:previous[entry.type]+1}));
    setRows(previous=>[entry,...previous].slice(0,20));
    setToasts(previous=>[...previous.slice(-5),entry]);
    beep(entry.type);
    if (entry.type!=='error') timers.current.push(window.setTimeout(()=>hide(entry.id),2700));
  }
  function execute(scanRequest:ScanInput) {
    const scanHandler=handler.current;
    queue.current=queue.current.then(async()=>{
      if (!mounted.current) return;
      setBusy(true);
      try {
        const result=await scanHandler(scanRequest);
        add({id:crypto.randomUUID(),code:scanRequest.trackingCode,text:result.outcome==='REPLAY'?'Opération déjà enregistrée.':'Colis enregistré.',type:result.outcome==='REPLAY'?'duplicate':'success'});
      } catch (fault) {
        const error=fault instanceof ApiError?fault:undefined;
        const duplicate=error?.code==='SCAN_DUPLICATE';
        const recoverable=!error||error.status>=500||error.status===429;
        const correctAgency=references?.agencies.find(agency=>agency.id===error?.details?.agencyId)?.name;
        add({id:crypto.randomUUID(),code:scanRequest.trackingCode,
          text:(error?.message??'Connexion interrompue.')+(correctAgency?' Agence attendue : '+correctAgency+'.':''),
          type:duplicate?'duplicate':'error',error,retry:recoverable?()=>execute(scanRequest):undefined});
      } finally {
        if (mounted.current) {
          setBusy(false);
          field.current?.focus({preventScroll:true});
        }
      }
    });
  }
  function fromDevice(raw:string,method:'BARCODE'|'CAMERA') {
    const trackingCode=raw.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(trackingCode)) return;
    setInput(trackingCode);
    execute({trackingCode,method,requestKey:crypto.randomUUID()});
  }
  const device=useRef(fromDevice);
  device.current=fromDevice;
  useEffect(()=>{
    if (!camera||!video.current) return;
    let dispose=false,stop:(()=>void)|undefined,lastCode='',lastTime=0;
    async function startCamera() {
      try {
        const {BrowserMultiFormatReader}=await import('@zxing/browser');
        if (dispose||!video.current) return;
        const reader=new BrowserMultiFormatReader();
        const controls=await reader.decodeFromConstraints({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1024}}},video.current,
          (result)=>{
            const code=result?.getText();
            if (code&&(!dispose)&&(lastCode!==code||Date.now()-lastTime>1800)) {
              lastCode=code;lastTime=Date.now();device.current(code,'CAMERA');
            }
          });
        if (dispose) controls.stop();
        else stop=()=>controls.stop();
      } catch {
        if (!dispose) setSetup('Caméra inaccessible. Vérifiez la permission ou utilisez la saisie.');
      }
    }
    void startCamera();
    return ()=>{dispose=true;stop?.();};
  },[camera]);

  async function connectSerial() {
    setupSound();setSetup('');
    if (stopSerial.current) {await stopSerial.current();return;}
    const feature=(navigator as Navigator&{serial?:{requestPort:()=>Promise<SerialPort>}}).serial;
    if (!feature) {setSetup('USB série indisponible sur ce navigateur. Utilisez la caméra ou la saisie confirmée.');return;}
    let port:SerialPort|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
      port=await feature.requestPort();
      await port.open({baudRate:9600});
      reader=port.readable?.getReader();
      if (!reader) throw new Error('No serial stream');
      setSerial(true);
      stopSerial.current=async()=>{await reader?.cancel().catch(()=>undefined);};
      const decoder=new TextDecoder();
      let buffer='';
      for (;;) {
        const item=await reader.read();
        if (item.done) break;
        buffer+=decoder.decode(item.value,{stream:true});
        const messages=buffer.split(/[\r\n]+/);
        buffer=messages.pop()?.slice(-256)??'';
        for (const message of messages) device.current(message,'BARCODE');
      }
    } catch {
      if (mounted.current) setSetup('Le lecteur USB série n’a pas pu être connecté.');
    } finally {
      reader?.releaseLock();
      await port?.close().catch(()=>undefined);
      stopSerial.current=null;
      if (mounted.current) setSerial(false);
    }
  }

  return <section className="scanner">
    <div className="scanner-heading"><div className="scanner-icon"><ScanBarcode size={24}/></div>
      <div><h3>{title}</h3><p>Caméra, USB série ou saisie confirmée</p></div>
      <button className="icon-button" title={mute?'Activer le son':'Couper le son'} aria-label={mute?'Activer le son':'Couper le son'} onClick={()=>{setMute(!mute);setupSound();}}><Volume2 size={17}/></button>
    </div>
    <div className="scan-counters"><span className="green">{counts.success} acceptés</span><span className="amber">{counts.duplicate} doublons</span><span className="red">{counts.error} erreurs</span></div>
    {extra}
    <form className="scan-form" onSubmit={event=>{event.preventDefault();setupSound();setConfirm(input.trim().toUpperCase());}}>
      <input ref={field} aria-label="Code de suivi à scanner" placeholder="BOXSH…" value={input} onChange={event=>setInput(event.target.value)}
        autoComplete="off" spellCheck={false} required pattern={"[A-Za-z0-9][A-Za-z0-9\\-]{2,63}"}/>
      <button className="button primary" type="submit" disabled={busy}><Keyboard size={17}/> Valider la saisie</button>
    </form>
    <div className="actions scan-devices">
      <button className="button secondary" onClick={()=>{setupSound();setSetup('');setCamera(!camera);}}><Camera size={16}/>{camera?'Fermer la caméra':'Caméra'}</button>
      <button className="button secondary" onClick={()=>void connectSerial()}><Usb size={16}/>{serial?'Déconnecter USB':'Lecteur USB série'}</button>
    </div>
    {setup&&<Info>{setup}</Info>}
    {camera&&<video className="camera" ref={video} muted playsInline/>}
    {confirm&&<Modal title="Confirmer la saisie manuelle" onClose={()=>setConfirm('')}>
      <p>{receipt?'Vous confirmez la réception de ce colis sans scan physique. Cette opération sera enregistrée sous votre responsabilité.':
        'Vous confirmez cette opération sans scan physique. La saisie manuelle sera enregistrée sous votre responsabilité.'}</p>
      <p className="tracking">{confirm}</p>
      <button className="button primary" onClick={()=>{execute({trackingCode:confirm,method:'MANUAL',confirmed:true,requestKey:crypto.randomUUID()});setConfirm('');setInput('');}}>Confirmer sous ma responsabilité</button>
    </Modal>}
    {!!rows.length&&<details className="scan-log"><summary>Historique de la session · {rows.length} dernières entrées</summary>
      {rows.map(row=><div key={row.id}><code>{row.code}</code><span className={row.type}>{row.text}</span></div>)}</details>}
    <div className="toast-stack" aria-live="polite">{toasts.map(row=><div className={'toast '+row.type} key={row.id}>
      {row.type==='success'?<CheckCircle2 size={19}/>:<CircleAlert size={19}/>}
      <div><strong>{row.code}</strong><p>{row.text}</p>{row.retry&&<button className="text-button" onClick={()=>{hide(row.id);row.retry?.();}}><RotateCw size={14}/>Réessayer</button>}
        {row.error?.details?.orderId? <a href={'/?view=orders&record='+encodeURIComponent(fmt(row.error.details.orderId))} target="_blank" rel="noreferrer">Voir commande ↗</a>:null}
      </div><button className="icon-button" onClick={()=>hide(row.id)} aria-label="Masquer le message"><X size={16}/></button>
    </div>)}</div>
  </section>;
}
