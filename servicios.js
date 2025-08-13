// servicios.js (versión mejorada y comentada, manteniendo TODO lo que ya funciona)

import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, deleteDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ===========================
   1) Catálogos y configuración
   =========================== */
const opciones = {
  tipoServicio: ['DIARIO','GENERAL','OTRO'],
  categoria:    ['NAVEGACIÓN','ALIMENTACIÓN','ATRACCIÓN TURÍSTICA','ENTRETENIMIENTO','TOUR','PARQUE ACUÁTICO','DISCO','OTRA'],
  formaPago:    ['EFECTIVO','CTA CORRIENTE','OTRO'],
  tipoCobro:    ['POR PERSONA','POR GRUPO','OTRO'],
  moneda:       ['PESO CHILENO','PESO ARGENTINO','REAL','USD','OTRO'],
  // NUEVO: selector de Voucher
  voucher:      ['FISICO','ELECTRONICO','NO APLICA']
};

// Orden y nombres de campos en la tabla (en este orden se renderizan y guardan)
// ⬇️ Insertamos Indicaciones, Voucher y Clave entre Proveedor y Tipo de Cobro
const campos = [
  'servicio','tipoServicio','categoria','ciudad','restricciones',
  'proveedor','indicaciones','voucher','clave','tipoCobro','moneda','valorServicio','formaPago'
];

// Secciones por destino; `null` representa la sección "OTRO" (sin cambios)
const destinos = ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE', null];

/* ===========================
   2) Editor flotante (no tocar)
   =========================== */
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

/* ===============================================
   3) Autenticación: si no hay sesión, redirige
   =============================================== */
onAuthStateChanged(auth, u => {
  if(!u) return location.href = 'login.html';
  init();
});

/* =====================================================
   4) Inicialización de la página (filtros y construcción)
   ===================================================== */
function init(){
  setupFilter();   // Filtro por destino (multiselect con "— Todos —")
  setupSearch();   // 🔎 Buscador global
  destinos.forEach(d => createSection(d));
  document.getElementById('btnProv').onclick = openProveedores;
  window.closeProveedores = closeProveedores;
}

/* =======================================
   5) Filtro por destino (sin cambios)
   ======================================= */
function setupFilter(){
  const sel = document.getElementById('destFilter');
  [...sel.options].forEach(o => o.selected = (o.value === 'ALL'));
  sel.addEventListener('change', () => {
    const vals = [...sel.selectedOptions].map(o => o.value);
    const mostrarTodas = vals.includes('ALL') || vals.length === 0;
    document.querySelectorAll('.section').forEach(sec => {
      const title = sec.querySelector('h3').textContent;
      sec.style.display = (mostrarTodas || vals.includes(title)) ? '' : 'none';
    });
    if (mostrarTodas) {
      [...sel.options].forEach(o => o.selected = (o.value === 'ALL'));
    }
  });
}

/* =========================================================
   6) Buscador global – filtra filas en todas las secciones
   ========================================================= */
function _norm(s){
  return (s || '')
    .toString()
    .normalize('NFD').replace(/\p{Diacritic}/gu,'')
    .toUpperCase();
}
function applySearch(){
  const input = document.getElementById('srvSearch');
  if(!input) return;
  const q = _norm(input.value.trim());
  const rows = document.querySelectorAll('#secciones tbody tr');
  rows.forEach(tr => {
    let txt = '';
    tr.querySelectorAll('input, select').forEach(el => {
      if (el.tagName === 'SELECT' && el.multiple) {
        txt += [...el.selectedOptions].map(o => o.value).join(' ') + ' ';
      } else if (el.tagName === 'SELECT') {
        txt += (el.value || '') + ' ';
      } else {
        txt += (el.value || '') + ' ';
      }
    });
    tr.style.display = _norm(txt).includes(q) ? '' : 'none';
  });
}
function setupSearch(){
  const input = document.getElementById('srvSearch');
  if(!input) return;
  input.addEventListener('input', applySearch);
}

/* ==========================================================
   7) Construcción de una sección (destino) con su tabla
   ========================================================== */
function createSection(destFijo){
  const isOtro = destFijo === null;
  let destActivo = destFijo;

  // ——— sección contenedora
  const sec = document.createElement('div');
  sec.className = 'section';
  sec.innerHTML = `<h3>${isOtro ? 'OTRO' : destFijo}</h3>`;
  document.getElementById('secciones').appendChild(sec);

  // ——— controles superiores
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

  // ——— tabla
  const wrap = document.createElement('div');
  wrap.className = 'table-wrapper';
  const tbl = document.createElement('table');

  // ——— cabecera (con columnas nuevas)
  const thead = document.createElement('thead');
  const trh   = document.createElement('tr');
  const headerTitles = [
    '', 'No',
    'Servicio','Tipo Servicio','Categoría','Ciudad',
    'Restricciones','Proveedor',
    'Indicaciones',              // NUEVA
    'Voucher',                   // NUEVA
    'Clave',                     // NUEVA (autogenerada si voucher = ELECTRONICO)
    'Tipo Cobro','Moneda','Valor Servicio','Forma de Pago'
  ];
  headerTitles.forEach(txt => {
    const th = document.createElement('th');
    th.textContent = txt;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  tbl.appendChild(thead);

  // ——— cuerpo
  const tbody = document.createElement('tbody');
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  sec.appendChild(wrap);

  // ——— Claves únicas por sección (para evitar colisiones locales)
  const clavesUsadas = new Set();
  function generarClaveUnica(){
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    do {
      code = Array.from({length:12}, () => ABC[Math.floor(Math.random()*ABC.length)]).join('');
    } while (clavesUsadas.has(code));
    clavesUsadas.add(code);
    return code;
  }

  // Estructura de filas en memoria
  const rows = []; // { inputs:[], ref?, checkbox:HTMLInputElement }

  // ——— carga de datos existentes para destinos fijos
  if(!isOtro){
    (async () => {
      const snap = await getDocs(query(
        collection(db,'Servicios',destFijo,'Listado'),
        orderBy('servicio','asc')
      ));
      for(let d of snap.docs){
        const o = d.data();
        o.servicio = d.id;
        // Si ya existe "clave", reservarla para evitar colisiones
        if (o.clave) clavesUsadas.add(o.clave);
        await add(o, doc(db,'Servicios',destFijo,'Listado',d.id));
      }
    })();
  }

  /* -----------------------
     Helpers internos
     ----------------------- */

  // Cargar proveedores en el <select> según el destino activo
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

  // Re-numera la columna "No"
  function updateRowNumbers(){
    rows.forEach((r,i) => {
      r.checkbox.closest('tr').children[1].textContent = i + 1;
    });
  }

  // Añadir fila al INICIO del tbody (con Indicaciones, Voucher y Clave)
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

    // celdas de datos (en el orden de `campos`)
    for(let c of campos){
      const td = document.createElement('td');
      let inp;

      if(c === 'proveedor'){
        // Select que se llena con proveedores del destino activo
        inp = document.createElement('select');
        inp.dataset.campo = c;
      }
      else if (c === 'voucher'){
        // NUEVO: Select con 3 opciones
        inp = document.createElement('select');
        inp.dataset.campo = c;
        opciones.voucher.forEach(v => inp.appendChild(new Option(v, v)));
        if (prefill[c]) {
          const opt = [...inp.options].find(o => o.value === prefill[c]);
          if (opt) opt.selected = true;
        }
      }
      else if (c === 'clave'){
        // NUEVO: Clave autogenerada si voucher = ELECTRONICO (solo lectura)
        inp = document.createElement('input');
        inp.dataset.campo = c;
        inp.readOnly = true;
        inp.value = prefill[c] || '';
        inp.title = inp.value;
        // Si viene prefill, reservarla para no duplicar
        if (inp.value) clavesUsadas.add(inp.value);
      }
      else if(opciones[c]){
        // Catálogos (algunos son multiselect)
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
        // Inputs de texto/número
        inp = document.createElement('input');
        inp.value = prefill[c] || '';
        // Todo menos valorServicio se guarda en mayúsculas
        if(c !== 'valorServicio') inp.oninput = ()=> inp.value = (inp.value || '').toString().toUpperCase();
        inp.dataset.campo = c;
        // Editor flotante para textos medianos/largos (indicaciones/restricciones, etc.)
        inp.onfocus = ()=> showFloatingEditor(inp);
        inp.title   = inp.value;
      }

      td.appendChild(inp);
      tr.appendChild(td);
      inputs.push(inp);
    }

    // Para destinos fijos, cargar proveedores automáticamente
    if(!isOtro){
      destActivo = destFijo;
      await loadProvs(tr, prefill.proveedor);
    }

    // —— Vínculo Voucher ↔ Clave ——
    const voucherSel = tr.querySelector('select[data-campo="voucher"]');
    const claveInp   = tr.querySelector('input[data-campo="clave"]');
    if (voucherSel && claveInp){
      const ensureClave = () => {
        const v = voucherSel.value;
        if (v === 'ELECTRONICO'){
          if (!claveInp.value) claveInp.value = generarClaveUnica();
        } else {
          if (claveInp.value) claveInp.value = '';
        }
        claveInp.title = claveInp.value;
      };
      voucherSel.addEventListener('change', ensureClave);

      // Prefill: si viene ELECTRONICO sin clave → generar
      if (voucherSel.value === 'ELECTRONICO' && !claveInp.value){
        claveInp.value = generarClaveUnica();
        claveInp.title = claveInp.value;
      }
    }

    // Insertar al INICIO y registrar en memoria
    tbody.insertBefore(tr, tbody.firstChild);
    rows.unshift({ inputs, ref, checkbox: chk });
    updateRowNumbers();

    // Evitar que el pegado dispare pegados masivos
    inputs.forEach(inp => {
      inp.addEventListener('paste', e => e.stopPropagation());
    });

    // Si hay término activo en el buscador, evaluar la nueva fila
    applySearch();
  }

  // Construye el objeto y guarda/actualiza una fila en Firestore
  async function commit(r, idx){
    const data = {};
    r.inputs.forEach(i => {
      data[i.dataset.campo] = i.multiple
        ? [...i.selectedOptions].map(o=>o.value)
        : (i.value ?? '').toString().trim().toUpperCase();
    });

    // NOTA: tu lógica de "destino" se mantiene tal cual
    const destino = isOtro ? data.destino : destActivo;
    if(!destino)       throw new Error(`F${idx}: Falta Destino`);
    if(!data.servicio) throw new Error(`F${idx}: Falta Servicio`);
    if(!data.proveedor)throw new Error(`F${idx}: Falta Proveedor`);

    // Asegura documento padre de la colección de servicios por destino
    await setDoc(doc(db,'Servicios',destino),{_created:true},{merge:true});

    // Guarda en subcolección Listado usando `servicio` como id
    await setDoc(
      doc(collection(db,'Servicios',destino,'Listado'),data.servicio),
      data
    );
  }

  // Guardar TODAS las filas de la sección
  async function saveAll(){
    const errs = [];
    for(let i=0;i<rows.length;i++){
      try{ await commit(rows[i], i+1) }
      catch(e){ errs.push(e.message) }
    }
    updateRowNumbers();
    alert(errs.length ? '⚠️ Errores:\n' + errs.join('\n') : '✅ Todos guardados');
  }

  // Guardar SOLO las seleccionadas con el checkbox
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

  // Eliminar SOLO las seleccionadas (y sus docs si tenían ref)
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
    // Mantener solo las no marcadas en memoria
    rows.splice(0, rows.length, ...rows.filter(r=>!r.checkbox.checked));
    updateRowNumbers();
    alert('🗑️ Seleccionadas eliminadas');
  }
}

/* =====================================================
   8) Apertura / cierre del modal de proveedores (igual)
   ===================================================== */
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
