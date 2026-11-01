const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let nextId=0;
export function stockLinesMarkup(){return '<div data-stock-lines></div><button type="button" class="btn outline ghost small" data-add-stock-line>＋ Ajouter un produit</button>';}
export function readStockLines(form){return [...form.querySelectorAll('[data-stock-line]')].map(row=>({productId:row.querySelector('[name="productId"]').value,quantity:Number(row.querySelector('[name="quantity"]').value)}));}
export function wireStockLines(form,getProducts){
 const container=form.querySelector('[data-stock-lines]'),add=form.querySelector('[data-add-stock-line]');
 if(!container)return;
 const sync=()=>{const enabled=form.elements.source.value==='STOCK';for(const input of container.querySelectorAll('input,select')){input.disabled=!enabled;input.required=enabled;}add.disabled=!enabled||container.children.length>=20;};
 const insert=()=>{
  if(container.children.length>=20)return;
  const ident='stock-line-'+nextId++,row=document.createElement('div');row.className='stock-order-line';row.dataset.stockLine='';
  row.innerHTML=`<div class="field"><label for="${ident}-product">Produit (SKU)</label><select name="productId" id="${ident}-product"><option value="">Choisir un produit</option>${getProducts().map(p=>`<option value="${esc(p.id)}">${esc(p.sku)} · ${esc(p.name)} (${Number(p.available)||0} disponibles)</option>`).join('')}</select></div><div class="field"><label for="${ident}-quantity">Quantité</label><input name="quantity" id="${ident}-quantity" type="number" min="1" step="1" value="1"></div><button type="button" class="btn outline ghost small" aria-label="Supprimer cette ligne produit" data-remove-stock-line>×</button>`;
  container.appendChild(row);sync();
 };
 add.onclick=insert;
 container.onclick=event=>{const button=event.target.closest('[data-remove-stock-line]');if(button&&container.children.length>1){button.closest('[data-stock-line]').remove();sync();}};
 form.elements.source.addEventListener('change',sync);
 form.addEventListener('reset',()=>setTimeout(()=>{container.innerHTML='';insert();sync();},0));
 const reset=()=>{container.innerHTML='';insert();sync();};reset();return {reset,sync};
}
