// servicios.js
import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, deleteDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const opciones = {
  tipoServicio: ['DIARIO','GENERAL','OTRO'],
  categoria:    ['NAVEGACIÓN','ALIMENTACIÓN','ATRACCIÓN TURÍSTICA','ENTRETENIMIENTO','TOUR','PARQUE ACUÁTICO','DISCO','OTRA'],
  formaPago:    ['EFECTIVO','CTA CORRIENTE','OTRO'],
  tipoCobro:    ['POR PERSONA','POR GRUPO','OTRO'],
  moneda:       ['PESO CHILENO','PESO ARGENTINO','REAL','USD','OTRO']
};
const campos = ['servicio','tipoServicio','categoria','ciudad','restricciones','proveedor','tipoCobro','moneda','valorServicio','formaPago'];
const destinos = ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE', null];

let floating = null;
function showFloatingEditor(input){
  if(floating) floating.remove();
  floating = document.createElement('textarea');
  floating.className = 'floating-editor';
  floating.value = input.value;
  document.body.appendChild(floating);
  const r = input.getBoundingClientRect();
  floating.style.top  = `${r.bottom + scrollY + 4}px`;
  floating.style.left = `${r.left + scrollX}px`;
  floating.oninput = () => { input.value = floating.value; input.title = floating.value; };
  floating.onblur  = () => { floating.remove(); floating = null; };
  floating.focus();
}

onAuthStateChanged(auth, u => {
  if(!u) return location.href = 'login.html';
  init();
});

function init(){
  setupFilter();
  destinos.forEach(d => createSection(d));
  document.getElementById('btnProv').onclick = openProveedores;
  window.closeProveedores = closeProveedores;
}

function setupFilter(){
  const sel = document.getElementById('destFilter');
  // Pre-selecciona “ALL”
  sel.querySelector('option[value="ALL"]').selected = true;

  sel.addEventListener('change', () => {
    const vals = [...sel.selectedOptions].map(o => o.value);
    // Mostrar todo si ALL está seleccionado o no hay selección
    const mostrarTodas = vals.includes('ALL') || vals.length === 0;
    document.querySelectorAll('.section').forEach(sec => {
      const title = sec.querySelector('h3').textContent;
      sec.style.display = (mostrarTodas || vals.includes(title)) ? '' : 'none';
    });
    // Si mostramos todas, quedarnos sólo con ALL marcado
    if (mostrarTodas) {
      [...sel.options].forEach(o => o.selected = o.value === 'ALL');
    }
  });
}

function createSection(destFijo){
  const isOtro = destFijo === null;
  let destActivo = destFijo;

  // sección contenedora
  const sec = document.createElement('div');
  sec.className = 'section';
  sec.innerHTML = `<h3>${isOtro ? 'OTRO' : destFijo}</h3>`;
  document.getElementById('secciones').appendChild(sec);

  // controles
  const ctrl = document.createElement('div');
  ctrl.className = 'controls';
  [
    ['➕ Nueva fila',        add],
    ['➕➕ Agregar 10 filas', ()=>[...Array(10)].forEach(add)],
    ['💾 Guardar todo',      saveAll],
    ['💾 Guardar seleccionadas', saveSelected],
    ['🗑️ Eliminar seleccionadas', deleteSelected]
  ].forEach(([txt, fn]) => {
    const b = document.createElement('button');
    b.textContent = txt;
    b.onclick = fn;
    ctrl.appendChild(b);
  });
  sec.appendChild(ctrl);

  // tabla
  const wrap = document.createElement('div');
  wrap.className = 'table-wrapper';
  const tbl = document.createElement('table');

  // cabecera con columna número
  const thead = document.createElement('thead');
  const trh   = document.createElement('tr');
  const headerTitles = [
    '', 'No',
    'Servicio','Tipo Servicio','Categoría','Ciudad',
    'Restricciones','Proveedor','Tipo Cobro',
    'Moneda','Valor Servicio','Forma de Pago'
  ];
  headerTitles.forEach(txt => {
    const th = document.createElement('th');
    th.textContent = txt;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  tbl.appendChild(thead);

  // cuerpo
  const tbody = document.createElement('tbody');
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  sec.appendChild(wrap);

  const rows = [];

  // cargar datos existentes
  if(!isOtro){
    (async () => {
      const snap = await getDocs(query(
        collection(db,'Servicios',destFijo,'Listado'),
        orderBy('servicio','asc')
      ));
      for(let d of snap.docs){
        const o = d.data();
        o.servicio = d.id;
        await add(o, doc(db,'Servicios',destFijo,'Listado',d.id));
      }
    })();
  }

  // helpers
  async function loadProvs(tr, selProv){
    const sel = tr.querySelector('select[data-campo=proveedor]');
    sel.innerHTML = '<option value="">—</option>';
    if(!destActivo) return;
    const snap = await getDocs(query(
      collection(db,'Proveedores',destActivo,'Listado'),
      orderBy('proveedor','asc')
    ));
    snap.forEach(d => sel.appendChild(new Option(d.id,d.id)));
    if(selProv) sel.value = selProv;
  }

  function updateRowNumbers(){
    rows.forEach((r,i) => {
      r.checkbox.closest('tr').children[1].textContent = i + 1;
    });
  }

  // añadir fila al inicio
  async function add(prefill = {}, ref = null){
    const tr = document.createElement('tr');
    const inputs = [];

    // checkbox
    const tdChk = document.createElement('td');
    const chk   = document.createElement('input');
    chk.type    = 'checkbox';
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    // número de fila
    const tdNum = document.createElement('td');
    tr.appendChild(tdNum);

    // celdas de datos
    for(let c of campos){
      const td = document.createElement('td');
      let inp;
      if(c === 'proveedor'){
        inp = document.createElement('select');
        inp.dataset.campo = c;
      } else if(opciones[c]){
        inp = document.createElement('select');
        inp.dataset.campo = c;
        if(c === 'categoria' || c === 'formaPago') inp.multiple = true;
        opciones[c].forEach(o => inp.appendChild(new Option(o,o)));
        if(prefill[c]){
          const arr = Array.isArray(prefill[c]) ? prefill[c] : [prefill[c]];
          arr.forEach(v => {
            const opt = [...inp.options].find(x => x.value === v);
            if(opt) opt.selected = true;
          });
        }
      } else {
        inp = document.createElement('input');
        inp.value = prefill[c] || '';
        if(c !== 'valorServicio') inp.oninput = ()=> inp.value = inp.value.toUpperCase();
        inp.dataset.campo = c;
        inp.onfocus = ()=> showFloatingEditor(inp);
        inp.title   = inp.value;
      }
      td.appendChild(inp);
      tr.appendChild(td);
      inputs.push(inp);
    }

    if(!isOtro){
      destActivo = destFijo;
      await loadProvs(tr, prefill.proveedor);
    }

    // insertar al inicio
    tbody.insertBefore(tr, tbody.firstChild);
    rows.unshift({ inputs, ref, checkbox: chk });
    updateRowNumbers();

    // interceptar paste para que no se creen filas
    inputs.forEach(inp => {
      inp.addEventListener('paste', e => e.stopPropagation());
    });
  }

  // guardar una fila
  async function commit(r, idx){
    const data = {};
    r.inputs.forEach(i => {
      data[i.dataset.campo] = i.multiple
        ? [...i.selectedOptions].map(o=>o.value)
        : i.value.trim().toUpperCase();
    });
    const destino = isOtro ? data.destino : destActivo;
    if(!destino)     throw new Error(`F${idx}: Falta Destino`);
    if(!data.servicio)throw new Error(`F${idx}: Falta Servicio`);
    if(!data.proveedor)throw new Error(`F${idx}: Falta Proveedor`);

    await setDoc(doc(db,'Servicios',destino),{_created:true},{merge:true});
    await setDoc(
      doc(collection(db,'Servicios',destino,'Listado'),data.servicio),
      data
    );
  }

  // guardar todo
  async function saveAll(){
    const errs = [];
    for(let i=0;i<rows.length;i++){
      try{ await commit(rows[i], i+1) }
      catch(e){ errs.push(e.message) }
    }
    updateRowNumbers();
    alert(errs.length ? '⚠️ Errores:\n' + errs.join('\n') : '✅ Todos guardados');
  }

  // guardar seleccionadas
  async function saveSelected(){
    const sel = rows.filter(r=>r.checkbox.checked);
    if(sel.length === 0){
      alert('❗ No hay filas seleccionadas');
      return;
    }
    const errs = [];
    for(let r of sel){
      const idx = rows.indexOf(r) + 1;
      try{ await commit(r, idx) }
      catch(e){ errs.push(e.message) }
    }
    updateRowNumbers();
    alert(errs.length ? '⚠️ Errores:\n' + errs.join('\n') : '✅ Seleccionadas guardadas');
  }

  // eliminar seleccionadas
  async function deleteSelected(){
    const sel = rows.filter(r=>r.checkbox.checked);
    if(sel.length === 0){
      alert('❗ No hay filas seleccionadas');
      return;
    }
    for(let r of sel){
      if(r.ref) await deleteDoc(r.ref);
      r.checkbox.closest('tr').remove();
    }
    rows.splice(0, rows.length, ...rows.filter(r=>!r.checkbox.checked));
    updateRowNumbers();
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
