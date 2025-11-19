// servicios.js (con Exportar Excel por sección + Botón GLOBAL "Exportar todo")

import { auth, db } from './firebase-init.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, deleteDoc, setDoc, getDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ===========================
   1) Catálogos y configuración
   =========================== */
const opciones = {
  tipoServicio: ['DIARIO','GENERAL','OTRO'],
  categoria:    ['NAVEGACIÓN','ALIMENTACIÓN','ATRACCIÓN TURÍSTICA','ENTRETENIMIENTO','TOUR','PARQUE ACUÁTICO','DISCO','OTRA'],
  formaPago:    ['EFECTIVO','CTA CORRIENTE','OTRO'],
  tipoCobro:    ['POR PERSONA','POR GRUPO', 'POR DIA', 'OTRO'],
  moneda:       ['PESO CHILENO','PESO ARGENTINO','REAL','USD','OTRO'],
  voucher:      ['FISICO','ELECTRONICO','CORREO', 'TICKET','NO APLICA'] // para la columna Voucher
};

// Orden y nombres de campos (mismo orden visual y de guardado)
const campos = [
  'servicio','tipoServicio','categoria','ciudad','restricciones',
  'proveedor','indicaciones','voucher','clave','tipoCobro','moneda','valorServicio','formaPago'
];

// Secciones por destino; `null` representa la sección "OTRO"
const destinos = ['BRASIL','BARILOCHE','SUR DE CHILE','NORTE DE CHILE', null];

/* ===========================
   2) Utilidades globales (para exportación)
   =========================== */
// Registro de secciones para exportación global
const allSections = []; // { name:string, getAOA:()=>string[][] }

// Carga perezosa de SheetJS
function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Script load error: ' + src));
    document.head.appendChild(s);
  });
}

async function loadXLSX(){
  if (window.XLSX) return window.XLSX;
  // Probar varios CDNs por si alguno está bloqueado
  const cdns = [
    'https://cdn.jsdelivr.net/npm/xlsx@0.20.0/dist/xlsx.full.min.js',
    'https://unpkg.com/xlsx@0.20.0/dist/xlsx.full.min.js',
    'https://cdn.sheetjs.com/xlsx-0.20.0/package/dist/xlsx.full.min.js'
  ];
  for (const url of cdns){
    try {
      await loadScript(url);
      if (window.XLSX) return window.XLSX;
    } catch(e) {
      // sigue probando el siguiente
    }
  }
  throw new Error('No se pudo cargar XLSX desde los CDNs.');
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

function aoaToCSV(aoa){
  const esc = v => {
    const s = (v ?? '').toString();
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
    return s;
  };
  return aoa.map(row => row.map(esc).join(',')).join('\n');
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

  // Botón "Administrar Proveedores" ya existe (id=btnProv).
  const btnProv = document.getElementById('btnProv');
  const headerEl = btnProv ? btnProv.closest('header') : null; // evita tomar el header de encabezado.html
  if (headerEl && btnProv) {
    const group = document.createElement('div');
    group.style.display = 'flex';
    group.style.gap = '.5rem';

    // Inserta el contenedor justo antes del botón y luego mueve el botón dentro
    headerEl.insertBefore(group, btnProv);
    group.appendChild(btnProv);

    const btnAll = document.createElement('button');
    btnAll.id = 'btnExportAll';
    btnAll.textContent = '⬇️ Exportar todo';
    btnAll.onclick = exportAllSections;
    group.appendChild(btnAll);
  }

  // Modal proveedores (callbacks globales)
  document.getElementById('btnProv').onclick = openProveedores;
  window.closeProveedores = closeProveedores;
}

/* =======================================
   5) Filtro por destino
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

  // ——— contenedor de sección
  const sec = document.createElement('div');
  sec.className = 'section';
  sec.innerHTML = `<h3>${isOtro ? 'OTRO' : destFijo}</h3>`;
  document.getElementById('secciones').appendChild(sec);

  // ——— controles (incluye exportar por sección)
  const ctrl = document.createElement('div');
  ctrl.className = 'controls';
  [
    ['➕ Nueva fila',        add],
    ['➕➕ Agregar 10 filas', ()=>[...Array(10)].forEach(add)],
    ['💾 Guardar todo',      saveAll],
    ['💾 Guardar seleccionadas', saveSelected],
    ['🗑️ Eliminar seleccionadas', deleteSelected],
    ['⬇️ Exportar Excel',    exportExcel]    // ⬅️ POR SECCIÓN
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

  // ——— cabecera
  const thead = document.createElement('thead');
  const trh   = document.createElement('tr');
  const headerTitles = [
    '', 'No',
    'Servicio','Tipo Servicio','Categoría','Ciudad',
    'Restricciones','Proveedor',
    'Indicaciones',              // NUEVA
    'Voucher',                   // NUEVA
    'Clave',                     // NUEVA
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

  // ——— Claves únicas por sección (evitar colisiones locales)
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
  const serviceChanges = [];  // ← acumulamos cambios para propagar a itinerarios

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
        if (o.clave) clavesUsadas.add(o.clave);
        await add(o, doc(db,'Servicios',destFijo,'Listado',d.id));
      }
    })();
  }

  /* -----------------------
     Helpers internos
     ----------------------- */
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

  // Añadir fila
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

    // celdas en orden de `campos`
    for(let c of campos){
      const td = document.createElement('td');
      let inp;

      if(c === 'proveedor'){
        inp = document.createElement('select');
        inp.dataset.campo = c;
      }
      else if (c === 'voucher'){
        inp = document.createElement('select');
        inp.dataset.campo = c;
        opciones.voucher.forEach(v => inp.appendChild(new Option(v, v)));
        if (prefill[c]) {
          const opt = [...inp.options].find(o => o.value === prefill[c]);
          if (opt) opt.selected = true;
        }
      }
      else if (c === 'clave'){
        inp = document.createElement('input');
        inp.dataset.campo = c;
        inp.readOnly = true;
        inp.value = prefill[c] || '';
        inp.title = inp.value;
        if (inp.value) clavesUsadas.add(inp.value);
      }
      else if(opciones[c]){
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
        if(c !== 'valorServicio') inp.oninput = ()=> inp.value = (inp.value || '').toString().toUpperCase();
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

    // Voucher ↔ Clave
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
      if (voucherSel.value === 'ELECTRONICO' && !claveInp.value){
        claveInp.value = generarClaveUnica();
        claveInp.title = claveInp.value;
      }
    }

    // Insertar y registrar
    tbody.insertBefore(tr, tbody.firstChild);
    rows.unshift({ inputs, ref, checkbox: chk });
    updateRowNumbers();

    // Evitar pegados masivos
    inputs.forEach(inp => {
      inp.addEventListener('paste', e => e.stopPropagation());
    });

    applySearch(); // si hay filtro activo
  }

  // Guardar fila -> Firestore (y detectar cambios para propagar)
  async function commit(r, idx){
    // 1) Leer datos de la fila
    const data = {};
    r.inputs.forEach(i => {
      data[i.dataset.campo] = i.multiple
        ? [...i.selectedOptions].map(o=>o.value)
        : (i.value ?? '').toString().trim().toUpperCase();
    });
  
    // 2) Validaciones mínimas
    const destino = (destActivo && !isOtro) ? destActivo : data.destino;
    if(!destino)        throw new Error(`F${idx}: Falta Destino`);
    if(!data.servicio)  throw new Error(`F${idx}: Falta Servicio`);
    if(!data.proveedor) throw new Error(`F${idx}: Falta Proveedor`);
  
    // Asegura la "carpeta" de destino
    await setDoc(doc(db,'Servicios',destino), { _created: true }, { merge: true });
  
    // Doc objetivo
    const targetId = data.servicio; // usamos el nombre como id de doc
    const newRef   = doc(db, 'Servicios', destino, 'Listado', targetId);
  
    // Helpers para visibilidad
    const newVisible = _visibleSvc(data, targetId);
  
    if (r.ref) {
      // Teníamos doc original
      const parts = r.ref.path.split('/'); // Servicios/{dest}/Listado/{id}
      const oldDest = parts[1];
      const oldId   = parts[3];
      const destChanged = oldDest !== destino;
      const idChanged   = oldId !== targetId;
  
      // Leemos el doc viejo (para comparar nombre visible y aliases previos)
      let oldData = null;
      try {
        const oldSnap = await getDoc(r.ref);
        if (oldSnap.exists()) oldData = oldSnap.data();
      } catch(_) {}
      const oldVisible = _visibleSvc(oldData, oldId);
  
      if (!destChanged && !idChanged) {
        // ✅ Mismo doc → actualizar en sitio
        // Si cambió el "visible", guardamos alias viejo para no perder referencias antiguas
        const willAddAlias = oldVisible && oldVisible !== newVisible;
        const merged = willAddAlias
          ? { ...data, aliases: Array.from(new Set([...(oldData?.aliases || []), oldVisible])) }
          : data;
  
        await setDoc(r.ref, merged, { merge: true });
  
        if (willAddAlias) {
          serviceChanges.push({
            destino,
            oldId: oldId,
            newId: targetId,
            oldVisible,
            newVisible,
            aliases: [oldVisible]
          });
        } else {
          // Incluso si no cambió el visible, registrar cambio permite refrescar textos por si otros campos afectan
          serviceChanges.push({
            destino, oldId: targetId, newId: targetId,
            oldVisible: newVisible, newVisible,
            aliases: (oldData?.aliases || [])
          });
        }
      } else {
        // 🔁 Cambió ID y/o destino → crear nuevo y borrar el viejo, preservando historial/aliases
        const aliasSet = new Set((oldData?.aliases || []).map(a => _U(a)));
        const oldIdU   = _U(oldId);
        const oldVisU  = _U(oldVisible);
        if (oldIdU)   aliasSet.add(oldIdU);
        if (oldVisU)  aliasSet.add(oldVisU);
        aliasSet.delete(newVisible); // no dupliques el nuevo visible
  
        const merged = {
          ...data,
          aliases: Array.from(aliasSet),
          prevIds: Array.from(new Set([...(oldData?.prevIds || []), oldId]))
        };
  
        await setDoc(newRef, merged, { merge: true });
        try { await deleteDoc(r.ref); } catch(_) {}
  
        // Registrar cambio para propagación
        serviceChanges.push({
          destino,
          oldId,
          newId: targetId,
          oldVisible: oldVisible || oldId,
          newVisible,
          aliases: Array.from(aliasSet)
        });
  
        r.ref = newRef; // importante para futuras ediciones
      }
    } else {
      // Fila nueva
      await setDoc(newRef, data, { merge: true });
      r.ref = newRef;
  
      // Registrar alta para sincronizar textos por servicioId
      serviceChanges.push({
        destino,
        oldId: targetId,
        newId: targetId,
        oldVisible: newVisible,
        newVisible,
        aliases: []
      });
    }
  }
  
  async function saveAll(){
    const errs = [];
    for(let i=0;i<rows.length;i++){
      try{ await commit(rows[i], i+1) }
      catch(e){ errs.push(e.message) }
    }
    updateRowNumbers();
  
    // ⬇️ NUEVO: propagar si hay cambios
    if (serviceChanges.length){
      await propagarCambiosASItinerarios(serviceChanges, { ask: true });
      serviceChanges.length = 0; // limpiar
    }
  
    alert(errs.length ? '⚠️ Errores:\n' + errs.join('\n') : '✅ Todos guardados');
  }
  
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
  
    // ⬇️ NUEVO: propagar si hay cambios
    if (serviceChanges.length){
      await propagarCambiosASItinerarios(serviceChanges, { ask: true });
      serviceChanges.length = 0; // limpiar
    }
  
    alert(errs.length ? '⚠️ Errores:\n' + errs.join('\n') : '✅ Seleccionadas guardadas');
  }

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
    // Mantener solo las no marcadas
    const restantes = rows.filter(r=>!r.checkbox.checked);
    rows.splice(0, rows.length, ...restantes);
    updateRowNumbers();
    alert('🗑️ Seleccionadas eliminadas');
  }

  /* ===========================
     Exportación POR SECCIÓN
     =========================== */
  function rowsVisibles(){
    return rows.filter(r => {
      const tr = r.checkbox.closest('tr');
      return tr && tr.offsetParent !== null && tr.style.display !== 'none';
    });
  }

  function toAOA(){
    // Cabeceras: tomamos del thead (omitimos '' y 'No')
    const headers = ['No', ...headerTitles.slice(2)];
    const body = rowsVisibles().map(r => {
      const row = [];
      row.push(rows.indexOf(r) + 1); // No
      r.inputs.forEach(inp => {
        if (inp.multiple) row.push([...inp.selectedOptions].map(o=>o.value).join(' | '));
        else row.push((inp.value ?? '').toString());
      });
      return row;
    });
    return [headers, ...body];
  }

  async function exportExcel(){
    const aoa = toAOA();
    const nombre = `Servicios_${isOtro ? 'OTRO' : destFijo}_${new Date().toISOString().slice(0,10)}.xlsx`;
    try {
      const XLSX = await loadXLSX();
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, (isOtro ? 'OTRO' : destFijo).slice(0,31));
      XLSX.writeFile(wb, nombre);
    } catch {
      const csv = aoaToCSV(aoa);
      downloadBlob(new Blob([csv], {type:'text/csv;charset=utf-8'}), nombre.replace(/\.xlsx$/i,'.csv'));
      alert('No se pudo cargar XLSX. Se exportó CSV (abre en Excel).');
    }
  }

  // 👉 Registrar esta sección para el EXPORT GLOBAL
  allSections.push({
    name: (isOtro ? 'OTRO' : destFijo),
    getAOA: toAOA
  });
}

/* =========================================================
   8) Exportación GLOBAL (todas las secciones a un .xlsx)
   ========================================================= */
async function exportAllSections(){
  const fecha = new Date().toISOString().slice(0,10);
  try {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();

    allSections.forEach(sec => {
      const aoa = sec.getAOA();                 // respeta buscador (filas visibles)
      const ws  = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, sec.name.slice(0,31));
    });

    XLSX.writeFile(wb, `Servicios_TODOS_${fecha}.xlsx`);
  } catch {
    // Fallback: un CSV por sección
    allSections.forEach(sec => {
      const csv = aoaToCSV(sec.getAOA());
      downloadBlob(new Blob([csv], {type:'text/csv;charset=utf-8'}), `Servicios_${sec.name}_${fecha}.csv`);
    });
    alert('No se pudo cargar XLSX. Se exportó un CSV por sección.');
  }
}

/* ======================================================
   Reparación masiva: propagar cambios de Servicios → Itinerarios
   ====================================================== */
function _U(s){ return (s ?? '').toString().trim().toUpperCase(); }
function _visibleSvc(data, id){ return _U(data?.nombre || data?.servicio || id); }

/**
 * Aplica a TODOS los grupos los cambios de servicios detectados.
 * changes: [{ destino, oldId, newId, oldVisible, newVisible, aliases[] }]
 */
async function propagarCambiosASItinerarios(changes, { ask = true } = {}) {
  if (!Array.isArray(changes) || changes.length === 0) return;

  if (ask) {
    const ok = confirm(
      `Se detectaron ${changes.length} servicio(s) cambiado(s).\n` +
      `¿Propagar los cambios a todos los itinerarios ahora?`
    );
    if (!ok) return;
  }

  const gSnap = await getDocs(collection(db, 'grupos'));
  let gruposMod = 0, actsMod = 0;

  for (const d of gSnap.docs) {
    const g = d.data() || {};
    const it = g.itinerario || {};
    if (!it || Object.keys(it).length === 0) continue;

    let touched = false;
    const nuevo = {};
    for (const f of Object.keys(it)) {
      const arr = Array.isArray(it[f]) ? it[f] : [];
      const out = arr.map(a0 => {
        const A = { ...a0 };
        const actName = _U(A.actividad);
        const actId   = _U(A.servicioId);

        for (const ch of changes) {
          const newId   = _U(ch.newId);
          const oldId   = _U(ch.oldId || '');
          const newName = _U(ch.newVisible);
          const oldName = _U(ch.oldVisible || '');
          const aliases = (ch.aliases || []).map(_U);

          const hitId  = actId && (actId === newId || (oldId && actId === oldId));
          const hitTxt = !A.servicioId && (actName === oldName || aliases.includes(actName));

          if (hitId || hitTxt) {
            A.servicioId      = ch.newId;
            A.servicioNombre  = ch.newVisible;
            A.servicioDestino = ch.destino;
            A.actividad       = ch.newVisible;   // reflejar nombre vigente
            touched = true;
            actsMod++;
            break;
          }
        }
        return A;
      });
      nuevo[f] = out;
    }

    if (touched) {
      await updateDoc(doc(db, 'grupos', d.id), { itinerario: nuevo });
      gruposMod++;
    }
  }

  alert(
    'Propagación completa.\n' +
    `Grupos modificados: ${gruposMod}\n` +
    `Actividades actualizadas: ${actsMod}`
  );
}

/* =====================================================
   9) Editor flotante (se mantiene igual)
   ===================================================== */
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

/* =====================================================
   10) Modal de proveedores (igual)
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
