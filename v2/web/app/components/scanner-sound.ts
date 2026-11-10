'use client';

import { useEffect, useRef, useState } from 'react';

export type ScanTone='success'|'duplicate'|'error';
const preference='transitflow.scanMuted';
const patterns: Record<ScanTone, readonly number[]> = {
  success:[720,980],
  duplicate:[390,390],
  error:[470,280],
};

export function useScannerSound() {
  const context=useRef<AudioContext | undefined>(undefined);
  const mutedRef=useRef(false);
  const [muted,setMuted]=useState(false);
  const [available,setAvailable]=useState(true);

  useEffect(()=>{
    try {mutedRef.current=localStorage.getItem(preference)==='1';setMuted(mutedRef.current);} catch { /* Storage is optional. */ }
    return ()=>{
      void context.current?.close().catch(()=>undefined);
      context.current=undefined;
    };
  },[]);

  function activate() {
    try {
      context.current??=new AudioContext();
      if (context.current.state==='running') return Promise.resolve();
      return context.current.resume().then(()=>setAvailable(true),()=>setAvailable(false));
    } catch {
      setAvailable(false);
      return Promise.resolve();
    }
  }

  function play(tone:ScanTone) {
    const audio=context.current;
    if (mutedRef.current || audio?.state!=='running') return;
    try {
      const start=audio.currentTime+0.008;
      patterns[tone].forEach((frequency,index)=>{
        const at=start+index*0.092;
        const oscillator=audio.createOscillator();
        const gain=audio.createGain();
        oscillator.frequency.value=frequency;
        gain.gain.setValueAtTime(0.001,at);
        gain.gain.linearRampToValueAtTime(0.18,at+0.008);
        gain.gain.exponentialRampToValueAtTime(0.001,at+0.067);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.addEventListener('ended',()=>{oscillator.disconnect();gain.disconnect();},{once:true});
        oscillator.start(at);
        oscillator.stop(at+0.07);
      });
    } catch {setAvailable(false);}
  }

  function toggle() {
    const next=!mutedRef.current;
    mutedRef.current=next;
    setMuted(next);
    try {localStorage.setItem(preference,next?'1':'0');} catch { /* Storage is optional. */ }
    if (!next) void activate();
  }

  return { muted,available,toggle,play,activate:()=>mutedRef.current?Promise.resolve():activate() };
}
