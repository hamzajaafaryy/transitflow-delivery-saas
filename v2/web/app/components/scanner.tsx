'use client';

import { Camera, CheckCircle2, CircleAlert, Copy, Keyboard, LoaderCircle, RotateCw, ScanBarcode, Usb, Volume2, VolumeX, Wifi, WifiOff, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, fmt, type References } from '../lib';
import { Modal } from './ui';
import { useScannerSound, type ScanTone } from './scanner-sound';

export type ScanInput={ trackingCode:string; requestKey:string;method:'MANUAL'|'BARCODE'|'CAMERA';confirmed?:true };
type SubmitScan=(input:ScanInput,signal:AbortSignal)=>Promise<{outcome:string;code?:string}>;
type ScanTask={input:ScanInput;submit:SubmitScan};
interface Entry { id:string;code:string;text:string;type:ScanTone;orderId?:string;retry?:ScanTask }
type SerialPort={
  readable:ReadableStream<Uint8Array>|null;
  open:(settings:{baudRate:number})=>Promise<void>;
  close:()=>Promise<void>;
};

const trackingPattern=/^[A-Z0-9][A-Z0-9-]{2,63}$/;
const caption={success:'Colis accepté',duplicate:'Déjà scanné',error:'Colis non validé'};
const icons={success:CheckCircle2,duplicate:Copy,error:CircleAlert};

function FollowUp({row,retry,disabled}:{row:Entry;retry:(row:Entry)=>void;disabled:boolean}) {
  return <div className="scan-followup">
    {row.retry&&<button className="button secondary" onClick={()=>retry(row)} disabled={disabled}><RotateCw size={16}/>Réessayer ce code</button>}
    {row.orderId&&<a className="button secondary" href={'/?view=orders&record='+encodeURIComponent(row.orderId)} target="_blank" rel="noreferrer">Voir la commande ↗</a>}
  </div>;
}

export function Scanner({scan,title='Scanner un colis',extra,references,receipt=false}:{scan:SubmitScan;
  title?:string;extra?:ReactNode;references?:References;receipt?:boolean}) {
  const labelId=useId();
  const inputId=useId();
  const [input,setInput]=useState('');
  const [inputError,setInputError]=useState('');
  const [confirm,setConfirm]=useState<ScanTask|null>(null);
  const [camera,setCamera]=useState<'off'|'loading'|'ready'>('off');
  const [serial,setSerial]=useState<'off'|'connecting'|'ready'>('off');
  const [online,setOnline]=useState(true);
  const [rows,setRows]=useState<Entry[]>([]);
  const [toasts,setToasts]=useState<Entry[]>([]);
  const [counts,setCounts]=useState({success:0,duplicate:0,error:0});
  const [setup,setSetup]=useState('');
  const [busy,setBusy]=useState('');
  const sound=useScannerSound();
  const panel=useRef<HTMLElement>(null);
  const video=useRef<HTMLVideoElement>(null);
  const field=useRef<HTMLInputElement>(null);
  const stopSerial=useRef<(()=>Promise<void>)|null>(null);
  const cameraSession=useRef(0);
  const serialSession=useRef(0);
  const pending=useRef(new Set<string>());
  const queue=useRef(Promise.resolve());
  const activeRequest=useRef<AbortController|null>(null);
  const mounted=useRef(false);
  const timers=useRef(new Set<number>());
  const manualOpen=useRef(false);
  const handler=useRef(scan);
  handler.current=scan;

  useEffect(()=>{
    mounted.current=true;
    function connectionChanged() {
      setOnline(navigator.onLine);
      if (!navigator.onLine) {
        cameraSession.current++;
        setCamera('off');
        serialSession.current++;
        void stopSerial.current?.();
        setSerial('off');
      }
    }
    connectionChanged();
    window.addEventListener('online',connectionChanged);
    window.addEventListener('offline',connectionChanged);
    if (matchMedia('(max-width: 760px)').matches) panel.current?.scrollIntoView({block:'start'});
    return ()=>{
      mounted.current=false;
      cameraSession.current++;
      serialSession.current++;
      activeRequest.current?.abort();
      void stopSerial.current?.();
      for (const timer of timers.current) window.clearTimeout(timer);
      window.removeEventListener('online',connectionChanged);
      window.removeEventListener('offline',connectionChanged);
    };
  },[]);

  function hide(id:string) {
    setToasts(previous=>previous.filter(row=>row.id!==id));
  }

  function report(entry:Omit<Entry,'id'>) {
    if (!mounted.current) return;
    const row={...entry,id:crypto.randomUUID()};
    setCounts(previous=>({...previous,[row.type]:previous[row.type]+1}));
    setRows(previous=>[row,...previous].slice(0,20));
    setToasts(previous=>[...previous.slice(-5),row]);
    sound.play(row.type);
    if (row.type==='success') {
      const timer=window.setTimeout(()=>{timers.current.delete(timer);hide(row.id);},3600);
      timers.current.add(timer);
    }
  }

  function execute(task:ScanTask) {
    const {trackingCode,requestKey}=task.input;
    if (pending.current.has(requestKey)) return;
    pending.current.add(requestKey);
    queue.current=queue.current.then(async()=>{
      try {
        if (!mounted.current) return;
        if (!navigator.onLine) {
          report({code:trackingCode,text:'Connexion coupée. Réessayez ce code une fois reconnecté.',type:'error',retry:task});
          return;
        }
        setBusy(trackingCode);
        const controller=new AbortController();
        activeRequest.current=controller;
        const timer=window.setTimeout(()=>controller.abort(),10_000);
        try {
          const result=await task.submit(task.input,controller.signal);
          report({code:trackingCode,text:result.outcome==='REPLAY'?'Colis déjà enregistré. Reprise confirmée.':'Colis enregistré.',type:'success'});
        } catch (fault) {
          const error=fault instanceof ApiError?fault:undefined;
          const duplicate=error?.code==='SCAN_DUPLICATE';
          const disconnected=controller.signal.aborted||fault instanceof TypeError||!navigator.onLine;
          const retryable=disconnected||Boolean(error&&(error.status>=500||error.status===429));
          const agency=references?.agencies.find(item=>item.id===error?.details?.agencyId)?.name;
          report({code:trackingCode,text:(error?.message??(disconnected?'Réponse non reçue. Réessayez ce code.':fault instanceof Error?fault.message:'Vérification impossible.'))+
            (agency?' Agence attendue : '+agency+'.':''),type:duplicate?'duplicate':'error',orderId:fmt(error?.details?.orderId),retry:retryable?task:undefined});
        } finally {
          window.clearTimeout(timer);
          activeRequest.current=null;
        }
      } finally {
        pending.current.delete(requestKey);
        if (mounted.current) {
          setBusy('');
          if (task.input.method==='MANUAL'&&matchMedia('(pointer: fine)').matches&&document.activeElement===document.body) {
            field.current?.focus({preventScroll:true});
          }
        }
      }
    });
  }

  function retry(row:Entry) {
    if (!row.retry) return;
    hide(row.id);
    setRows(previous=>previous.map(item=>item.id===row.id?{...item,retry:undefined}:item));
    void sound.activate();
    execute(row.retry);
  }

  function fromDevice(trackingCode:string,method:'BARCODE'|'CAMERA') {
    if (!mounted.current||manualOpen.current||!navigator.onLine) return;
    if (!trackingPattern.test(trackingCode)) {
      report({code:'Code illisible',text:'Visez le code de suivi du colis, par exemple BOXSH34789066.',type:'error'});
      return;
    }
    execute({input:{trackingCode,method,requestKey:crypto.randomUUID()},submit:handler.current});
  }
  const device=useRef(fromDevice);
  device.current=fromDevice;

  const cameraOpen=camera!=='off';
  useEffect(()=>{
    if (!cameraOpen||!video.current) return;
    const session=++cameraSession.current;
    const element=video.current;
    let stop:(()=>void)|undefined;
    let visibleCode='',seenAt=0;
    async function start() {
      try {
        const {BrowserMultiFormatReader}=await import('@zxing/browser');
        if (session!==cameraSession.current) return;
        const reader=new BrowserMultiFormatReader(undefined,{delayBetweenScanAttempts:130,delayBetweenScanSuccess:220});
        const controls=await reader.decodeFromConstraints({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1024}}},element,
          result=>{
            if (session!==cameraSession.current||manualOpen.current||!navigator.onLine) return;
            const raw=result?.getText().trim().toUpperCase();
            const now=performance.now();
            if (!raw) {
              if (now-seenAt>=1000) visibleCode='';
              return;
            }
            seenAt=now;
            if (raw===visibleCode) return;
            visibleCode=raw;
            device.current(raw,'CAMERA');
          });
        if (session!==cameraSession.current) controls.stop();
        else {stop=()=>controls.stop();setCamera('ready');}
      } catch {
        if (session===cameraSession.current) {
          setCamera('off');
          setSetup('Impossible d’ouvrir la caméra. Autorisez-la dans le navigateur ou saisissez le code.');
        }
      }
    }
    void start();
    return ()=>{cameraSession.current++;stop?.();};
  },[cameraOpen]);

  function toggleCamera() {
    void sound.activate();
    setSetup('');
    if (cameraOpen) {cameraSession.current++;setCamera('off');return;}
    if (!navigator.mediaDevices?.getUserMedia) {
      setSetup('La caméra est indisponible ici. Utilisez un navigateur compatible en HTTPS ou saisissez le code.');
      return;
    }
    serialSession.current++;
    void stopSerial.current?.();
    setSerial('off');
    setCamera('loading');
  }

  async function connectSerial() {
    void sound.activate();
    setSetup('');
    if (stopSerial.current) {await stopSerial.current();return;}
    const feature=(navigator as Navigator&{serial?:{requestPort:()=>Promise<SerialPort>}}).serial;
    if (!feature) {
      setSetup('Ce navigateur ne détecte pas les lecteurs USB série. Pour une douchette clavier, utilisez le champ Code de suivi.');
      return;
    }
    cameraSession.current++;
    setCamera('off');
    setSerial('connecting');
    const session=++serialSession.current;
    let port:SerialPort|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,cancel:(()=>Promise<void>)|undefined;
    try {
      port=await feature.requestPort();
      if (session!==serialSession.current) return;
      await port.open({baudRate:9600});
      if (session!==serialSession.current) return;
      reader=port.readable?.getReader();
      if (!reader) throw new Error('No serial stream');
      setSerial('ready');
      cancel=async()=>{await reader?.cancel().catch(()=>undefined);};
      stopSerial.current=cancel;
      const decoder=new TextDecoder();
      let buffer='';
      for (;;) {
        const item=await reader.read();
        if (item.done||session!==serialSession.current) break;
        buffer+=decoder.decode(item.value,{stream:true});
        const messages=buffer.split(/[\r\n]+/);
        buffer=messages.pop()??'';
        if (buffer.length>256) buffer='';
        for (const message of messages) {
          const code=message.trim().toUpperCase();
          if (code) device.current(code,'BARCODE');
        }
      }
    } catch {
      if (session===serialSession.current) setSetup('Impossible de connecter le lecteur USB. Vérifiez le câble puis réessayez.');
    } finally {
      reader?.releaseLock();
      await port?.close().catch(()=>undefined);
      if (stopSerial.current===cancel) stopSerial.current=null;
      if (session===serialSession.current) setSerial('off');
    }
  }

  function prepareManual(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sound.activate();
    const trackingCode=input.trim().toUpperCase();
    if (!trackingPattern.test(trackingCode)) {
      setInputError('Saisissez le code de suivi complet, par exemple BOXSH34789066.');
      return;
    }
    manualOpen.current=true;
    setConfirm({input:{trackingCode,method:'MANUAL',confirmed:true,requestKey:crypto.randomUUID()},submit:handler.current});
  }

  function closeManual() {
    manualOpen.current=false;
    setConfirm(null);
  }

  const last=rows[0];
  const ResultIcon=busy?LoaderCircle:last?icons[last.type]:online?ScanBarcode:WifiOff;
  return <section className="scanner" ref={panel} aria-labelledby={labelId}>
    <div className="scanner-heading">
      <span className="scanner-icon"><ScanBarcode size={26}/></span>
      <div><h3 id={labelId}>{title}</h3><p>Présentez un code à la fois.</p></div>
      <span className={'scan-connection '+(online?'':'offline')}>{online?<Wifi size={16}/>:<WifiOff size={16}/>} {online?'En ligne':'Hors ligne'}</span>
    </div>
    {!online&&<p className="scan-help warning" role="alert">Connexion coupée. Reconnectez-vous pour scanner.</p>}
    <div className={'scan-result '+(busy?'pending':last?.type??'ready')} role="status" aria-atomic="true">
      <ResultIcon size={25} className={busy?'spin':undefined}/>
      <div><strong>{busy?'Vérification en cours…':last?caption[last.type]:online?'Prêt à scanner':'Scanner en pause'}</strong>
        {busy?<code>{busy}</code>:last?<><code>{last.code}</code><p>{last.text}</p></>:<p>{online?'Ouvrez la caméra ou saisissez le code du colis.':'La connexion est nécessaire pour valider un colis.'}</p>}
        {!busy&&last&&(last.retry||last.orderId)&&<FollowUp row={last} retry={retry} disabled={!online}/>}
      </div>
    </div>
    <div className="scan-counters" aria-label="Compteurs de la session">
      <span className="green"><strong>{counts.success}</strong> Validés</span>
      <span className="red"><strong>{counts.duplicate}</strong> Doublons</span>
      <span className="amber"><strong>{counts.error}</strong> À vérifier</span>
    </div>
    {extra}
    <div className="scan-devices">
      <button className="button primary" type="button" onClick={toggleCamera} disabled={!online||serial==='connecting'} aria-expanded={cameraOpen}><Camera size={20}/>
        {cameraOpen?'Fermer la caméra':'Scanner avec la caméra'}</button>
      <button className="button secondary" type="button" onClick={()=>void connectSerial()} disabled={!online||serial==='connecting'}><Usb size={19}/>
        {serial==='ready'?'Déconnecter USB':serial==='connecting'?'Connexion USB…':'Lecteur USB série'}</button>
    </div>
    {setup&&<p className="scan-help warning" role="status">{setup}</p>}
    {serial==='ready'&&<p className="scan-help" role="status">Lecteur connecté. Scannez un code à la fois.</p>}
    {cameraOpen&&<div className="scan-viewfinder">
      <video className="camera" ref={video} muted playsInline autoPlay aria-label="Aperçu caméra"/>
      <span className="scan-frame" aria-hidden="true"/>
      <span className="scan-viewfinder-tip">{camera==='loading'?'Ouverture de la caméra…':'Centrez le code puis retirez le colis après validation.'}</span>
    </div>}
    <form className="scan-form" onSubmit={prepareManual} noValidate>
      <div className="scan-field">
        <label htmlFor={inputId}>Code de suivi</label>
        <input id={inputId} ref={field} aria-label="Code de suivi à scanner" aria-describedby={inputError?inputId+'-error':inputId+'-hint'}
          aria-invalid={Boolean(inputError)} placeholder="BOXSH34789066" value={input} onChange={event=>{setInput(event.target.value);setInputError('');}}
          autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} enterKeyHint="go" maxLength={64}/>
      </div>
      <button className="button secondary" type="submit" disabled={!online||Boolean(busy)||!input.trim()}><Keyboard size={18}/>Valider la saisie</button>
      <small id={inputId+'-hint'}>Saisie ou douchette clavier. Une confirmation est demandée.</small>
      {inputError&&<p id={inputId+'-error'} className="scan-help warning" role="alert">{inputError}</p>}
    </form>
    <div className="scan-settings">
      <button className="button secondary" type="button" aria-pressed={!sound.muted} onClick={sound.toggle}>
        {sound.muted?<VolumeX size={17}/>:<Volume2 size={17}/>} {sound.muted?'Son coupé':'Son activé'}</button>
      <button className="text-button" type="button" disabled={sound.muted||!sound.available}
        onClick={()=>void sound.activate().then(()=>sound.play('success'))}>Tester le son</button>
    </div>
    {confirm&&<Modal title="Confirmer la saisie manuelle" onClose={closeManual}>
      <p>{receipt?'Vous confirmez la réception de ce colis sans scan physique. Cette opération sera enregistrée sous votre responsabilité.':
        'Vous confirmez cette opération sans scan physique. La saisie manuelle sera enregistrée sous votre responsabilité.'}</p>
      <p className="tracking scan-confirm-code">{confirm.input.trackingCode}</p>
      <div className="scan-confirm-actions">
        <button className="button primary" type="button" disabled={!online} onClick={()=>{
          void sound.activate();execute(confirm);closeManual();setInput('');
        }}>Confirmer sous ma responsabilité</button>
        <button className="button secondary" type="button" onClick={closeManual}>Corriger le code</button>
      </div>
    </Modal>}
    {!!rows.length&&<details className="scan-log"><summary>Derniers scans · {rows.length}</summary>
      <ul>{rows.map(row=><li key={row.id}><code>{row.code}</code><strong className={row.type}>{caption[row.type]}</strong>
        <span>{row.text}</span>{(row.retry||row.orderId)&&<FollowUp row={row} retry={retry} disabled={!online||Boolean(busy)}/>}</li>)}</ul>
    </details>}
    <div className="toast-stack" aria-label="Messages de scan">{toasts.map(row=>{
      const Icon=icons[row.type];
      return <div className={'toast '+row.type} key={row.id}>
        <Icon size={19}/><div><strong>{row.code}</strong><p>{row.text}</p></div>
        <button className="icon-button" onClick={()=>hide(row.id)} aria-label="Masquer le message"><X size={16}/></button>
      </div>;
    })}</div>
  </section>;
}
