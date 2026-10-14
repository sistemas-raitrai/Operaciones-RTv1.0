// Campos opcionales. Conserva los horarios y rutas actuales de viajes.js.
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CAMPOS=[['fechaPresentacionIda','Fecha presentación IDA','date'],['fechaArriboIda','Fecha llegada IDA','date'],['fechaPresentacionVuelta','Fecha presentación REGRESO','date'],['fechaArriboVuelta','Fecha llegada REGRESO','date'],['zonaSalida','Zona horaria del origen','text'],['zonaLlegada','Zona horaria del destino','text']];
const TERRESTRE=[['presentacionIdaHora','Presentación IDA','time'],['arriboIdaHora','Llegada IDA','time'],['presentacionVueltaHora','Presentación REGRESO','time'],['arriboVueltaHora','Llegada REGRESO','time']];
const datos=new Map();
export function camposHorarioExtra(obj={}){return Object.fromEntries([...CAMPOS,...TERRESTRE].map(([k])=>[k,String(obj[k]??'')]));}
function fila(target,campos){const div=document.createElement('div');div.style.cssText='display:flex;flex-wrap:wrap;gap:12px;margin:12px 0';for(const [k,label,type]of campos){const lab=document.createElement('label');lab.innerHTML=escape(label)+'<br><input type="'+type+'" value="'+escape(target[k])+'" style="width:180px"'+(k.startsWith('zona')?' placeholder="America/Santiago"':'')+'>';lab.querySelector('input').oninput=e=>target[k]=e.target.value;div.append(lab);}return div;}
export function montarHorariosExtra(prefijo,obj={},tramos=[]){const form=document.getElementById(prefijo==='m'?'modal-form':'transfer-form');if(!form)return;let panel=form.querySelector('[data-horarios-extra]');if(!panel){panel=document.createElement('details');panel.dataset.horariosExtra='1';form.append(panel);}panel.innerHTML='<summary>Horarios complementarios y fechas de llegada</summary><p>Opcionales. Fecha explícita de llegada evita ambigüedad al cruzar medianoche. Zonas IANA, por ejemplo America/Santiago, America/Sao_Paulo o America/Argentina/Buenos_Aires. Las zonas corresponden al origen/destino de IDA; en regreso se invierten.</p>';
 const model=camposHorarioExtra(obj);datos.set(prefijo,model);panel.append(fila(model,[...CAMPOS,...TERRESTRE]));
 if(tramos.length){panel.append(document.createTextNode('Los campos siguientes corresponden a cada tramo aéreo. Presentación y aterrizaje se editan en la tabla principal.'));tramos.forEach((t,i)=>{const h=document.createElement('h4');h.textContent='Tramo '+(i+1);panel.append(h,fila(t,CAMPOS));});}
}
export function montarHorariosTramos(tramos){const model=datos.get('m')||{};montarHorariosExtra('m',model,tramos);}
export function aplicarHorariosExtra(pay,prefijo='m'){
 const model=datos.get(prefijo)||{};const fields=pay.tipoTransporte==='terrestre'?[...CAMPOS,...TERRESTRE]:CAMPOS;
 for(const [k]of fields)pay[k]=String(model[k]??'');return pay;
}
