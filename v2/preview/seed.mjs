import { randomUUID } from 'node:crypto';

const states=['ATTENTE_RAMASSAGE','ATTENTE_RAMASSAGE','ATTENTE_RAMASSAGE','RAMASSE','EXPEDIE',
  'REFUSE','REFUSE','MISE_EN_DISTRIBUTION','LIVRE','LIVRE','RECU_VILLE','REPORTE'];
const names=['Amal Demo','Yassine Demo','Meryem Demo','Nadia Demo','Samir Demo','Salma Demo',
  'Mehdi Demo','Aya Demo','Leïla Demo','Omar Demo','Hiba Demo','Sara Demo'];
export async function seedPreview(fixture,api,origin) {
  const sessions={};
  async function call(profile,method,path,payload,expected=200) {
    const response=await api.inject({method,url:'/api/v2'+path,payload,headers:{
      origin,'x-transitflow-request':'1',...(sessions[profile]?{cookie:sessions[profile]}:{}),
    }});
    if (response.statusCode!==expected) throw new Error('Preview seed failed: '+method+' '+path+' '+response.statusCode+' '+response.json()?.code);
    if (path==='/auth/login') sessions[profile]=response.headers['set-cookie'].split(';')[0];
    return response.json();
  }
  for (const profile of ['staff','agency','merchant']) {
    const {login,password}=fixture.accounts[profile];
    await call(profile,'POST','/auth/login',{login,password});
  }
  const merchantId=fixture.merchants[0].id,agencyId=fixture.agencies[0].id;
  const [product,otherProduct]=await Promise.all([
    call('staff','POST','/stock/products',{merchantId,sku:'ATLAS-01',name:'Sac Atlas'},201),
    call('staff','POST','/stock/products',{merchantId,sku:'ATLAS-02',name:'Pochette Rif'},201),
  ]);
  await call('staff','POST','/stock/products/'+product.id+'/replenish',{quantity:26});
  await call('staff','POST','/stock/products/'+otherProduct.id+'/replenish',{quantity:13});
  const orders=[];
  for (const [index,status] of states.entries()) {
    const stock=index%3===0;
    const row=await call('merchant','POST','/orders',{source:stock?'STOCK':'EXTERNAL',recipient:names[index],phone:'06000000'+String(10+index),
      address:(10+index)+' rue Exemple · Adresse fictive',city:'Tanger',codCentimes:18000+index*500,
      merchandise:stock?'Sac Atlas':'Colis démo',items:stock?[{productId:product.id,quantity:1}]:[]},201);
    orders.push({...row,target:status});
    if (status!=='ATTENTE_RAMASSAGE') await call('staff','POST','/orders/collect',{
      trackingCode:row.tracking_code,method:'MANUAL',confirmed:true,requestKey:randomUUID(),
    });
  }
  const sending=orders.filter(row=>!['ATTENTE_RAMASSAGE','RAMASSE','EXPEDIE'].includes(row.target));
  const dispatch=await call('staff','POST','/dispatch',{agencyId,city:'Tanger'},201);
  await call('staff','POST','/dispatch/'+dispatch.id+'/add',{ids:sending.map(row=>row.id)});
  await call('staff','POST','/dispatch/'+dispatch.id+'/state',{action:'SEND'});
  await call('staff','POST','/dispatch/agencies/'+agencyId+'/arrival',{codes:sending.map(row=>row.tracking_code),confirmed:true});
  const inTransit=orders.filter(row=>row.target==='EXPEDIE');
  const second=await call('staff','POST','/dispatch',{agencyId,city:'Tanger'},201);
  await call('staff','POST','/dispatch/'+second.id+'/add',{ids:inTransit.map(row=>row.id)});
  await call('staff','POST','/dispatch/'+second.id+'/state',{action:'SEND'});
  for (const row of sending) {
    if (row.target!=='RECU_VILLE') await call('staff','POST','/orders/'+row.id+'/correct',
      {status:row.target,reason:'État initial du scénario fictif de Preview'});
  }
  const refusals=orders.filter(row=>row.target==='REFUSE');
  const bon=await call('agency','POST','/return-bons',{agencyId,codes:refusals.map(row=>row.tracking_code)},201);
  await call('agency','POST','/return-bons/'+bon.bon.id+'/state',{action:'SEND'});
  const first=refusals[0];
  await call('staff','POST','/return-bons/'+bon.bon.id+'/receive',{
    trackingCode:first.tracking_code,method:'MANUAL',confirmed:true,requestKey:randomUUID(),
  });
  const merchantBon=await call('staff','POST','/merchant-returns',{merchantId},201);
  await call('staff','POST','/merchant-returns/'+merchantBon.id+'/add',{all:true});
  await call('staff','POST','/merchant-returns/'+merchantBon.id+'/state',{action:'SEND'});
  await call('staff','POST','/merchant-returns/'+merchantBon.id+'/state',{action:'RECEIVE',confirmed:true});
  const agencyPayment=await call('staff','POST','/finance/agencies/'+agencyId+'/bons',{all:true},201);
  await call('staff','POST','/finance/agency-bons/'+agencyPayment.id+'/remittance',{amount:15000,requestKey:randomUUID(),reference:'DÉMO-150'});
  await call('merchant','POST','/pickups',{zone:'Tanger',address:'12 rue Exemple · Adresse fictive'},201);
  await call('merchant','POST','/claims',{topic:'OTHER',subject:'Demande de suivi démo',message:'Bonjour, pouvez-vous vérifier le planning du ramassage ?'},201);
  return {order:orders[0],returnBon:bon.bon,returnCode:refusals[1].tracking_code,merchantBon,agencyPayment};
}
