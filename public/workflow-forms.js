const localTime=ms=>new Date(ms-new Date(ms).getTimezoneOffset()*60000).toISOString().slice(0,16);
export async function workflowForm({c,call,has,label,table,esc},action,kind,id){
 const state=c.state,boot=state.workflowBoot||{},data=state.workflowData||{},f=c.field,role=state.me.user.role;
 const options=(labelText,name,values,selected)=>`<div class="field"><label for="wf-${name}">${esc(labelText)}</label><select id="wf-${name}" name="${name}">${values.map(x=>`<option value="${esc(x.value)}" ${x.value===selected?'selected':''}>${esc(x.label)}</option>`).join('')}</select></div>`;
 const textarea=(labelText,name,required=true)=>`<div class="field"><label for="wf-${name}">${esc(labelText)}</label><textarea id="wf-${name}" name="${name}" maxlength="4000" ${required?'required minlength="5"':''}></textarea></div>`;
 const merchants=(boot.merchants||[]).map(m=>({value:m.id,label:m.name}));
 const users=(roles,agencyId)=>boot.users?.filter(u=>roles.includes(u.role)&&(!agencyId||!u.agency_id||u.agency_id===agencyId)).map(u=>({value:u.id,label:u.full_name}))||[];
 const agencies=(boot.agencies||[]).map(a=>({value:a.id,label:a.city+' · '+a.name}));
 const modal=(title,fields,submit,onReady)=>{
  const m=c.modal(title,`<form class="form workflow-form">${fields}<button class="btn" type="submit">Enregistrer</button></form>`),form=m.querySelector('form');
  form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button[type="submit"]');button.disabled=true;try{const result=await submit(Object.fromEntries(new FormData(form)),form);m.remove();if(result?.kind){state.tab=result.kind;state.workflowDetail={kind:result.kind,id:result.id};}c.toast('Opération enregistrée');await c.refresh();}catch(err){c.toast(err.message,true);button.disabled=false;}};
  if(onReady)Promise.resolve(onReady(form,m)).catch(e=>c.toast(e.message,true));return {m,form};
 };
 const resolveParcel=async tracking=>{const value=String(tracking||'').trim();if(/^[a-f0-9-]{36}$/i.test(value))return (await c.api('/shipments/'+value)).shipment;const rows=(await c.api('/shipments?q='+encodeURIComponent(value)+'&limit=50')).shipments,s=rows.find(x=>x.tracking.toUpperCase()===value.toUpperCase());if(!s)throw Error('Tracking introuvable dans votre compte');return s;};
 const checklist=(ships,form)=>{form.querySelector('#workflow-parcels').innerHTML=ships.length?ships.map(s=>`<label class="parcel-check"><input type="checkbox" name="shipmentIds" value="${esc(s.id)}"><span><strong class="code">${esc(s.tracking)}</strong><small>${esc(s.recipient)} · ${esc(s.city)} · ${c.money(s.cod_centimes)}</small></span></label>`).join(''):'<p class="note">Aucun colis disponible pour cette sélection.</p>';};
 if(action==='contact'){
  modal('Contact destinataire / report',options('Résultat','outcome',[{value:'REACHED',label:'Client joint'},{value:'NO_ANSWER',label:'Sans réponse'},{value:'WRONG_NUMBER',label:'Numéro erroné'},{value:'CALLBACK',label:'Rappeler plus tard'}])+f('Prochaine tentative convenue','nextAttemptAt',{type:'datetime-local'})+textarea('Compte rendu / engagement du destinataire','note'),v=>call('/shipments/'+id+'/contact',{...v,nextAttemptAt:v.nextAttemptAt?new Date(v.nextAttemptAt).toISOString():undefined}));return;
 }
 if(action==='recover'){modal('Réception du colis retrouvé',f('Scanner le tracking / ID','scan',{required:true})+textarea('Lieu et circonstances de récupération','note'),v=>call('/shipments/'+id+'/recover',v));return;}
 if(action==='incident'){
  modal('Confirmer une perte / un dommage',options('Incident','kind',[{value:'LOST',label:'Colis perdu'},{value:'DAMAGED',label:'Colis endommagé'}])+textarea('Constat et circonstances','note')+'<p class="note">Le statut est tracé. Une indemnisation éventuelle passe séparément par la comptabilité.</p>',v=>call('/shipments/'+id+'/incident',v));return;
 }
 if(action==='new'&&kind==='pickups'){
  if(!merchants.length){c.toast('Créez d’abord un marchand et ses commandes',true);return;}
  modal('Nouvelle demande de ramassage',(role==='MERCHANT'?'':options('Marchand','merchantId',merchants))+options('Point de ramassage','pointId',[])+f('Date prévue','scheduledAt',{type:'datetime-local',required:true,value:localTime(Date.now()+3600000)})+f('Créneau / consignes','slot',{placeholder:'Ex. entre 14h et 16h'})+'<div><h3>Colis à remettre</h3><div id="workflow-parcels" class="parcel-checklist"></div></div>',async(v,form)=>{const r=await call('/pickups',{...v,scheduledAt:new Date(v.scheduledAt).toISOString(),shipmentIds:new FormData(form).getAll('shipmentIds')});return {kind,id:r.id};},async form=>{
   const load=async()=>{const mid=role==='MERCHANT'?state.me.user.merchant_id:form.elements.merchantId.value,[points,eligible]=await Promise.all([call('/pickup-points?merchantId='+mid),call('/eligible?kind=pickup&merchantId='+mid)]);form.elements.pointId.innerHTML=points.points.map(p=>`<option value="${esc(p.id)}">${esc(p.label)} · ${esc(p.city)}</option>`).join('');checklist(eligible.shipments,form);};if(role!=='MERCHANT')form.elements.merchantId.onchange=()=>load().catch(e=>c.toast(e.message,true));await load();});return;
 }
 if(action==='point'){
  modal('Point de ramassage',(role==='MERCHANT'?'':options('Marchand','merchantId',merchants))+f('Libellé','label',{required:true,placeholder:'Boutique / fournisseur / dépôt'})+f('Contact sur place','contactName',{required:true})+f('Téléphone','phone',{required:true})+f('Ville de collecte','city',{required:true})+f('Adresse précise','address',{required:true})+textarea('Consignes d’accès','notes',false),v=>call('/pickup-points',v));return;
 }
 if(action==='new'&&kind==='vehicles'){
  modal('Véhicule de collecte / livraison',f('Immatriculation','plate',{required:true})+options('Type','kind',[{value:'CAR',label:'Voiture'},{value:'VAN',label:'Fourgon'},{value:'MOTORCYCLE',label:'Moto'},{value:'TRUCK',label:'Camion'}])+options('Propriété','ownership',[{value:'DRIVER',label:'Véhicule personnel du conducteur'},{value:'COMPANY',label:'Véhicule de la société'}])+options('Conducteur propriétaire / habituel','driverId',[{value:'',label:'À affecter (véhicule société)'},...users(['PICKUP_DRIVER','DRIVER'])]),v=>call('/vehicles',v));return;
 }
 if(action==='assign'&&kind==='pickups'){
  const vehicles=(await call('/vehicles')).vehicles,drivers=users(['PICKUP_DRIVER','DRIVER']);
  modal('Affecter le ramassage',options('Ramasseur','driverId',drivers)+options('Véhicule','vehicleId',[]),v=>call('/pickups/'+id+'/assign',v),form=>{const sync=()=>{form.elements.vehicleId.innerHTML=vehicles.filter(v=>v.active&&(v.ownership==='COMPANY'||v.driver_id===form.elements.driverId.value)).map(v=>`<option value="${esc(v.id)}">${esc(v.plate)} · ${v.ownership==='DRIVER'?'Personnel':'Société'}</option>`).join('');};form.elements.driverId.onchange=sync;sync();});return;
 }
 if(action==='complete-pickup'){
  modal('Terminer la collecte',f('Nom de la personne ayant remis les colis','receiverName',{required:true})+textarea('Observation / raison des colis manquants','note',false)+'<p class="note">Les colis non scannés seront signalés manquants et pourront faire l’objet d’une nouvelle demande. Les colis collectés doivent encore être réceptionnés au warehouse.</p>',v=>call('/pickups/'+id+'/complete',v));return;
 }
 if(action==='cancel'){
  modal('Annuler la demande',textarea('Motif','reason'),v=>call('/'+kind+'/'+id+'/cancel',v));return;
 }
 if(action==='new'&&kind==='returns'){
  modal('Demande de retour / échange',f('Tracking ou ID du colis','tracking',{required:true})+options('Type','kind',[{value:'RETURN',label:'Retour de colis'},{value:'EXCHANGE',label:'Échange avec remplacement après contrôle'}])+textarea('Motif détaillé','reason'),async v=>{const s=await resolveParcel(v.tracking),r=await call('/returns',{shipmentId:s.id,kind:v.kind,reason:v.reason});return {kind,id:r.id};});return;
 }
 if(action==='authorize'){
  modal('Décision retour',options('Décision','accepted',[{value:'true',label:'Autoriser le retour'},{value:'false',label:'Refuser la demande'}])+textarea('Motif / consignes','note'),v=>call('/returns/'+id+'/authorize',{...v,accepted:v.accepted==='true'}));return;
 }
 if(action==='assign-return'){
  modal('Conducteur du retour',options('Conducteur','driverId',users(['DRIVER','PICKUP_DRIVER'])),v=>call('/returns/'+id+'/assign',v));return;
 }
 if(action==='ship-return'){
  modal('Remise physique du retour',f('Référence du bon / preuve de prise en charge','proofReference',{required:true,placeholder:'Bon de retour signé / référence de remise'}),v=>call('/returns/'+id+'/ship',v));return;
 }
 if(action==='receive-return'){
  modal('Réception du colis retourné',f('Scanner tracking / ID','scan',{required:true})+options('État physique constaté','condition',[{value:'SEALED',label:'Scellé'},{value:'GOOD',label:'Conforme'},{value:'DAMAGED',label:'Endommagé'},{value:'INCOMPLETE',label:'Incomplet'}])+textarea('Observation / détail de l’écart','note',false)+'<p class="note">La réception seule ne remet aucun produit en stock disponible.</p>',v=>call('/returns/'+id+'/receive',v));return;
 }
 if(action==='inspect-return'){
  const stock=data.shipment.order_source==='STOCK',good=['GOOD','SEALED'].includes(data.return.condition),choices=[...(stock&&good?[{value:'RESTOCK',label:'Remettre les produits conformes en stock'}]:[]),...(good?[{value:'RESHIP',label:'Préparer une réexpédition'}]:[]),{value:'RETURN_MERCHANT',label:'Remettre le colis au marchand'},{value:'DISCARD',label:'Écarter du stock / décision sur marchandise abîmée'}];
  modal('Contrôle du retour',options('Décision physique','disposition',choices)+f('Emplacement de stock si validé','location',{value:'ENTREPOT / RETOURS VALIDÉS'})+textarea('Résultat du contrôle (quantités, état, conformité)','note'),v=>call('/returns/'+id+'/inspect',v));return;
 }
 if(action==='complete-return'){
  modal('Clôturer le retour',(data.return.disposition==='RETURN_MERCHANT'?f('Nom du marchand réceptionnaire','receiverName',{required:true})+f('Référence de preuve de remise','proofReference',{required:true}):'<p>Le contrôle et la décision physique ont été enregistrés. Confirmez la clôture de ce retour.</p>'),v=>call('/returns/'+id+'/complete',v));return;
 }
 if(action==='reexpedite'||action==='replacement'){
  const exchange=action==='replacement';
  let products=[];if(exchange){const stock=role==='MERCHANT'?await c.api('/merchant/stock'):await c.api('/inventory');products=(stock.products||[]).filter(p=>!p.merchant_id||p.merchant_id===data.shipment.merchant_id).map(p=>({value:p.id,label:p.sku+' · '+p.name}));}
  modal(exchange?'Commande de remplacement':'Réexpédition du colis retourné',f('Nouveau destinataire','recipient',{required:true})+f('Téléphone','phone',{required:true})+options('Ville','city',(boot.agencies||[]).map(a=>({value:a.city,label:a.city})))+f('Adresse complète','address',{required:true})+f('Montant COD du nouvel envoi (MAD)','cod',{type:'number',step:'0.01',min:0,required:true,value:data.shipment.cod_centimes/100})+(exchange?options('Produit de remplacement du stock','productId',products)+f('Quantité','quantity',{type:'number',min:1,value:1,required:true}):'<p class="note">Un nouveau tracking sera créé. Les produits stock conformes remis en stock seront réservés à nouveau avant préparation.</p>'),async v=>{const order={recipient:v.recipient,phone:v.phone,city:v.city,address:v.address,cod:v.cod};if(exchange){order.source='STOCK';order.items=[{productId:v.productId,quantity:Number(v.quantity)}];}return call('/returns/'+id+'/'+(exchange?'replacement':'reexpedite'),{order});});return;
 }
 if(action==='new'&&kind==='claims'){
  let pickups=[];if(['pickups.create','pickups.manage','pickups.self','pickups.read'].some(has))try{pickups=(await call('/pickups')).pickups;}catch{}
  modal('Nouvelle réclamation',f('Tracking du colis (facultatif)','tracking')+options('Ramassage concerné (facultatif)','pickupId',[{value:'',label:'Sans ramassage lié'},...pickups.map(p=>({value:p.id,label:p.reference}))])+options('Catégorie','category',['DELAY','DELIVERY','RETURN','STOCK','PAYMENT','DAMAGED','LOST','TECHNICAL','OTHER'].map(value=>({value,label:label(value)})))+options('Priorité','priority',['NORMAL','HIGH','URGENT'].map(value=>({value,label:label(value)})))+f('Sujet','subject',{required:true})+textarea('Décrivez le problème et le résultat attendu','message'),async v=>{const s=v.tracking?await resolveParcel(v.tracking):null,r=await call('/claims',{subject:v.subject,message:v.message,category:v.category,priority:v.priority,shipmentId:s?.id,pickupId:v.pickupId||undefined});return {kind,id:r.id};});return;
 }
 if(action==='claim-status'){
  const t=data.claim,manager=has('claims.manage'),states=manager?['IN_PROGRESS','WAITING_MERCHANT','WAITING_AGENCY','RESOLVED',...(t.state==='RESOLVED'?['CLOSED']:[])]:t.state==='RESOLVED'?['CLOSED','IN_PROGRESS']:['IN_PROGRESS'];
  modal('Traitement de la réclamation',options('État','state',states.map(value=>({value,label:label(value)})))+(manager?options('Agent en charge','assignedTo',[{value:'',label:'Non affecté'},...users(['SUPPORT','OPERATIONS','ADMIN'])],t.assigned_to):'')+textarea('Réponse / résolution / motif de réouverture','note'),v=>call('/claims/'+id+'/update',v));return;
 }
 if(action==='new'&&kind==='routes'){
  const vehicles=has('routes.manage')?(await call('/vehicles')).vehicles:[];
  modal('Préparer une tournée',options('Agence de départ','agencyId',agencies)+options('Livreur','driverId',[])+options('Véhicule (facultatif)','vehicleId',[{value:'',label:'Non précisé'},...vehicles.filter(v=>v.active).map(v=>({value:v.id,label:v.plate}))])+f('Jour de tournée','date',{type:'date',value:localTime(Date.now()).slice(0,10),required:true})+'<div><h3>Colis de l’agence</h3><div id="workflow-parcels" class="parcel-checklist"></div></div>'+textarea('Motif de dérogation (si report futur / limite de tentatives)','overrideReason',false),async(v,form)=>{const r=await call('/routes',{...v,vehicleId:v.vehicleId||undefined,shipmentIds:new FormData(form).getAll('shipmentIds')});return {kind,id:r.id};},async form=>{const load=async()=>{form.elements.driverId.innerHTML=users(['DRIVER'],form.elements.agencyId.value).map(u=>`<option value="${esc(u.value)}">${esc(u.label)}</option>`).join('');checklist((await call('/eligible?kind=route&agencyId='+form.elements.agencyId.value)).shipments,form);};form.elements.agencyId.onchange=()=>load().catch(e=>c.toast(e.message,true));await load();});return;
 }
 if(action==='attempt'){
  const s=data.items.find(i=>i.shipment_id===id);if(!s)throw Error('Colis absent de cette tournée');const requestId=crypto.randomUUID();
  modal('Résultat de la tentative — '+s.tracking,options('Résultat','result',[{value:'DELIVERED',label:'Livré'},{value:'REFUSED',label:'Refusé par le destinataire'},{value:'UNREACHABLE',label:'Injoignable'},{value:'POSTPONED',label:'Reporté à une date'},{value:'BAD_ADDRESS',label:'Adresse incorrecte'}])+`<div id="attempt-success">${f('Nom du réceptionnaire','receiverName')}${f('Montant réellement encaissé (MAD)','collectedAmount',{type:'number',min:0,step:'0.01',value:s.cod_centimes/100})}${options('Mode','paymentMethod',[{value:'CASH',label:'Espèces'},{value:'CARD',label:'Carte — justificatif obligatoire'}])}${f('Référence de paiement carte','paymentReference')}</div><div id="attempt-failure" hidden>${f('Prochaine tentative (obligatoire pour un report)','nextAttemptAt',{type:'datetime-local'})}</div>${textarea('Observation / motif','note',false)}`,v=>call('/shipments/'+id+'/attempts',{...v,collectedAmount:v.result==='DELIVERED'?v.collectedAmount:0,nextAttemptAt:v.result!=='DELIVERED'&&v.nextAttemptAt?new Date(v.nextAttemptAt).toISOString():undefined,requestId}),form=>{const sync=()=>{const ok=form.elements.result.value==='DELIVERED';form.querySelector('#attempt-success').hidden=!ok;form.querySelector('#attempt-failure').hidden=ok;};form.elements.result.onchange=sync;sync();});return;
 }
 if(action==='remittance'){
  const rows=(data.receipts||[]).filter(r=>r.state==='DECLARED');if(!rows.length){c.toast('Aucun fonds déclaré disponible pour remise',true);return;}
  const groups=[...new Map(rows.map(r=>[r.holder_user_id||r.holder_agency_id,{value:r.holder_user_id||r.holder_agency_id,label:r.holder_name||r.agency_name}])).values()];
  modal('Déclarer une remise de fonds',options('Détenteur','holder',groups)+'<div id="workflow-parcels" class="parcel-checklist"></div>'+f('Référence de preuve de remise','proofReference',{required:true})+textarea('Observation','note',false),async(v,form)=>call('/cash/remittances',{receiptIds:new FormData(form).getAll('receiptIds'),proofReference:v.proofReference,note:v.note}),form=>{const sync=()=>{form.querySelector('#workflow-parcels').innerHTML=rows.filter(r=>(r.holder_user_id||r.holder_agency_id)===form.elements.holder.value).map(r=>`<label class="parcel-check"><input type="checkbox" checked name="receiptIds" value="${r.id}"><span>${esc(r.tracking)} · ${c.money(r.amount_centimes)}</span></label>`).join('');};form.elements.holder.onchange=sync;sync();});return;
 }
 if(action==='reconcile'){
  const r=data.remittances.find(r=>r.id===id);modal('Rapprocher '+r.reference,`<p>COD brut : <strong>${c.money(r.declared_centimes)}</strong><br>Frais agence : ${c.money(r.fee_centimes)}<br>Net à rapprocher : <strong>${c.money(r.expected_centimes)}</strong></p>`+f('Montant net reçu (négatif si paiement à l’agence) (MAD)','receivedAmount',{type:'number',step:'0.01',required:true,value:r.received_centimes===null?r.expected_centimes/100:r.received_centimes/100})+textarea('Observation / motif de différence','note',false)+'<p class="note">Un montant négatif constate un versement manuel à l’agence. Un écart reste en litige. Le COD n’est confirmé qu’après rapprochement exact des fonds.</p>',v=>call('/cash/remittances/'+id+'/reconcile',v));return;
 }
 if(action==='new'&&kind==='adjustments'){
  const returns=(await call('/returns')).returns.filter(r=>r.after_delivery&&['RECEIVED','INSPECTED','COMPLETED'].includes(r.state));
  modal('Ajustement du compte marchand',options('Marchand','merchantId',merchants)+options('Nature','kind',[{value:'REFUND',label:'Remboursement à déduire (montant négatif)'},{value:'COMPENSATION',label:'Indemnisation (montant positif)'},{value:'FEE_CORRECTION',label:'Correction de frais (+ ou −)'}])+f('Montant signé (MAD)','amount',{type:'number',step:'0.01',required:true})+options('Retour concerné','returnId',[{value:'',label:'Sans retour lié'},...returns.map(r=>({value:r.id,label:r.reference+' · '+r.tracking}))])+f('Référence justificative unique','reference',{required:true})+textarea('Motif comptable / preuve du remboursement','note'),v=>call('/adjustments',{...v,returnId:v.returnId||undefined}));return;
 }
 throw Error('Cette action n’est pas disponible dans cet écran');
}
