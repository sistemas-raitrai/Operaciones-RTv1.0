import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, deleteDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const opciones = {
  tipoServicio:['DIARIO','GENERAL','OTRO'],
  categoria:   ['NAVEGACIÓN','ALIMENTACIÓN','ATRACCIÓN TURÍSTICA','ENTRETENIMIENTO','TOUR','PARQUE ACUÁTICO','DISCO','OTRA'],
  formaPago:   ['EFECTIVO','CTA CORRIENTE','OTRO'],
  tipoCobro:   ['POR PERSONA','POR GRUPO','OTRO'],
  moneda:      ['PESO CHILENO','PESO ARGENTINO','REAL','USD','OTRO']
};
const campos = ['servicio','tipoServicio','categoria','ciudad','restricciones','proveedor','tipoCobro','moneda','valorServicio','formaPago'];
const destinos = ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE', null];

let floating=null;
function showFloatingEditor(input){
  if(floating) floating.remove();
  floating=document.createElement('textarea');
  floating.className='floating-editor';
  floating.value=input.value;
  document.body.appendChild(floating);
  const r=input.getBoundingClientRect();
  floating.style.top=`${r.bottom+scrollY+4}px`;
  floating.style.left=`${r.left+scrollX}px`;
  floating.oninput=()=>{ input.value=floating.value; input.title=floating.value };
  floating.onblur=()=>{ floating.remove(); floating=null };
  floating.focus();
}

onAuthStateChanged(auth,u=>{
  if(!u) return location.href='login.html';
  init();
});

function init(){
  destinos.forEach(d=>createSection(d));
  document.getElementById('btnProv').onclick=openProveedores;
  window.closeProveedores=closeProveedores;
}

function createSection(destFijo){
  const isOtro=destFijo===null;
  let destActivo=destFijo;

  const sec=document.createElement('div'); sec.className='section';
  sec.innerHTML=`<h3>${isOtro?'OTRO':destFijo}</h3>`;
  document.getElementById('secciones').appendChild(sec);

  const ctrl=document.createElement('div'); ctrl.className='controls';
  [
    ['➕ Nueva fila', add],
    ['➕➕ Agregar 10 filas', ()=>[...Array(10)].forEach(add)],
    ['💾 Guardar todo', saveAll],
    ['💾 Guardar seleccionadas', saveSelected],
    ['🗑️ Eliminar seleccionadas', deleteSelected]
  ].forEach(([txt,fn])=>{
    const b=document.createElement('button');
    b.textContent=txt; b.onclick=fn;
    ctrl.appendChild(b);
  });
  sec.appendChild(ctrl);

  const wrap=document.createElement('div'); wrap.className='table-wrapper';
  const tbl=document.createElement('table');
  const thead=document.createElement('thead');
  const trh=document.createElement('tr');
  ['','Servicio','Tipo Servicio','Categoría','Ciudad','Restricciones','Proveedor','Tipo Cobro','Moneda','Valor Servicio','Forma de Pago']
    .forEach(txt=>{
      const th=document.createElement('th');
      th.textContent=txt;
      trh.appendChild(th);
    });
  thead.appendChild(trh);
  tbl.appendChild(thead);
  const tbody=document.createElement('tbody');
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  sec.appendChild(wrap);

  const rows=[];

  if(!isOtro){
    (async()=>{
      const snap=await getDocs(query(
        collection(db,'Servicios',destFijo,'Listado'),
        orderBy('servicio','asc')
      ));
      for(let d of snap.docs){
        const o=d.data(); o.servicio=d.id;
        await add(o, doc(db,'Servicios',destFijo,'Listado',d.id));
      }
    })();
  }

  async function loadProvs(tr, selectedProv){
    const sel=tr.querySelector('select[data-campo=proveedor]');
    sel.innerHTML='<option value="">—</option>';
    if(!destActivo) return;
    const snap=await getDocs(query(
      collection(db,'Proveedores',destActivo,'Listado'),
      orderBy('proveedor','asc')
    ));
    snap.forEach(d=>sel.appendChild(new Option(d.id,d.id)));
    if(selectedProv) sel.value=selectedProv;
  }

  async function add(prefill={}, ref=null){
    const tr=document.createElement('tr');
    const inputs=[];

    const tdChk=document.createElement('td');
    const chk=document.createElement('input'); chk.type='checkbox';
    tdChk.appendChild(chk); tr.appendChild(tdChk);

    for(let c of campos){
      const td=document.createElement('td');
      let inp;
      if(c==='proveedor'){
        inp=document.createElement('select');
        inp.dataset.campo=c;
      } else if(opciones[c]){
        inp=document.createElement('select');
        inp.dataset.campo=c;
        if(c==='categoria'||c==='formaPago') inp.multiple=true;
        opciones[c].forEach(o=>inp.appendChild(new Option(o,o)));
        if(prefill[c]){
          const arr=Array.isArray(prefill[c])?prefill[c]:[prefill[c]];
          arr.forEach(v=>{
            const opt=[...inp.options].find(x=>x.value===v);
            if(opt) opt.selected=true;
          });
        }
      } else {
        inp=document.createElement('input');
        inp.value=prefill[c]||'';
        if(c!=='valorServicio') inp.oninput=()=>inp.value=inp.value.toUpperCase();
        inp.dataset.campo=c;
        inp.onfocus=()=>showFloatingEditor(inp);
        inp.title=inp.value;
      }
      td.appendChild(inp); tr.appendChild(td);
      inputs.push(inp);
    }

    if(!isOtro){
      destActivo=destFijo;
      await loadProvs(tr, prefill.proveedor);
    }

    tbody.appendChild(tr);
    rows.push({ inputs, ref, checkbox: chk });
  }

  async function commit(r, idx){
    const data={};
    r.inputs.forEach(i=>{
      data[i.dataset.campo] = i.multiple
        ? [...i.selectedOptions].map(o=>o.value)
        : i.value.trim().toUpperCase();
    });
    const destino=isOtro? data.destino: destActivo;
    if(!destino) throw new Error(`F${idx}: Falta Destino`);
    if(!data.servicio) throw new Error(`F${idx}: Falta Servicio`);
    if(!data.proveedor) throw new Error(`F${idx}: Falta Proveedor`);
    await setDoc(doc(db,'Servicios',destino),{_created:true},{merge:true});
    await setDoc(
      doc(collection(db,'Servicios',destino,'Listado'),data.servicio),
      data
    );
  }

  async function saveAll(){
    const errs=[];
    for(let i=0;i<rows.length;i++){
      try{ await commit(rows[i], i+1) }
      catch(e){ errs.push(e.message) }
    }
    alert(errs.length? '⚠️ Errores:\n'+errs.join('\n') : '✅ Todos guardados');
  }

  async function saveSelected(){
    const sel=rows.filter(r=>r.checkbox.checked);
    if(sel.length===0){ alert('❗ No hay filas seleccionadas'); return; }
    const errs=[];
    for(let r of sel){
      const idx=rows.indexOf(r)+1;
      try{ await commit(r, idx) }
      catch(e){ errs.push(e.message) }
    }
    alert(errs.length? '⚠️ Errores:\n'+errs.join('\n') : '✅ Seleccionadas guardadas');
  }

  async function deleteSelected(){
    const sel=rows.filter(r=>r.checkbox.checked);
    if(sel.length===0){ alert('❗ No hay filas seleccionadas'); return; }
    for(let r of sel){
      if(r.ref) await deleteDoc(r.ref);
      r.checkbox.closest('tr').remove();
    }
    rows.splice(0, rows.length, ...rows.filter(r=>!r.checkbox.checked));
    alert('🗑️ Seleccionadas eliminadas');
  }
}

function openProveedores(){
  document.getElementById('iframe-prov').src='proveedores.html';
  document.getElementById('backdrop-prov').style.display='block';
  document.getElementById('modal-prov').style.display='block';
}
function closeProveedores(){
  document.getElementById('iframe-prov').src='';
  document.getElementById('backdrop-prov').style.display='none';
  document.getElementById('modal-prov').style.display='none';
}
