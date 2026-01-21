// bitacora_actividad.js
// Bitácora por Grupo / por Actividad (lee desde Firestore)
// FUENTE:
// - índice: grupos/{gid}.asistencias[fechaISO][actKey].notas
// - bitácora real: grupos/{gid}/bitacora/{actKey}/{fechaISO}/{timeId} => {texto, byEmail, ts}

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ====================== UI ====================== */
const el = {
  destino:   document.getElementById('fDestino'),
  coord:     document.getElementById('fCoord'),
  grupo:     document.getElementById('fGrupo'),
  modo:      document.getElementById('fModo'),
  actividad: document.getElementById('fActividad'),
  limite:    document.getElementById('fLimite'),

  btnCargar: document.getElementById('btnCargar'),
  btnExportDestino: document.getElementById('btnExportDestino'),
  btnExportVisible: document.getElementById('btnExportVisible'),
  btnLimpiar:document.getElementById('btnLimpiar'),
  status:    document.getElementById('status'),

  buscador:  document.getElementById('buscador'),
  tbody:     document.getElementById('tbody'),
  count:     document.getElementById('countEntradas'),
};

/* ====================== STATE ====================== */
const state = {
  user: null,
  grupos: [],
  grupoById: new Map(),
  destinos: [],
  coords: [],
  actNameByKey: new Map(),
  filteredActKeys: [],
  rows: [], // base cargada (sin buscador)
};

const TZ = 'America/Santiago';

/* ====================== HELPERS ====================== */
const norm = (s='') => (s ?? '')
  .toString()
  .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase()
  .trim();

function slug(s=''){
  return norm(s)
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/-+/g,'-')
    .replace(/^-|-$/g,'');
}

function slugActKey(actName=''){
  const k = slug(actName);
  return k || 'actividad';
}

function setStatus(msg){ el.status.textContent = msg; }

function option(sel, value, label){
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  sel.appendChild(o);
}
function clearSelect(sel){ sel.innerHTML = ''; }

function grupoLabel(g){
  const n = (g.numeroNegocio ?? g.numero ?? '').toString().trim();
  const ng = (g.nombreGrupo ?? g.nombre ?? '').toString().trim();
  if(n && ng) return `(${n}) ${ng}`;
  if(ng) return ng;
  if(n) return `(${n})`;
  return g.id;
}

// ======================
// ✅ PAX FINAL por asistencia (fechaISO + actKey)
// Fuente: grupos/{gid}.asistencias[fechaISO][actKey].paxFinal
// ======================
function getPaxInfo(g, fechaISO, actKey){
  // esperado: cantidadGrupo (en tu firebase)
  const esperado = (typeof g?.cantidadGrupo === 'number' && isFinite(g.cantidadGrupo))
    ? g.cantidadGrupo
    : null;

  // final: paxFinal en asistencias[fechaISO][actKey]
  const asist = g?.asistencias || {};
  const day = asist?.[fechaISO] || {};
  const idx = day?.[actKey] || {};
  const final = (typeof idx?.paxFinal === 'number' && isFinite(idx.paxFinal))
    ? idx.paxFinal
    : null;

  return { esperado, final };
}


function fmtTS(ms){
  if(!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('es-CL', { timeZone: TZ });
}
function fmtHoraFromMs(ms){
  if(!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('es-CL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

/* ======================
   ✅ DESTINO POR COMPONENTES ("Y")
====================== */
function destinoMatchPorComponentes(destinoGrupo='', destinoFiltro=''){
  if(!destinoFiltro) return true;

  const f = norm(destinoFiltro);
  const g = norm(destinoGrupo);

  if(!f || !g) return false;
  if(g === f) return true;

  const parts = g.split(/\s+y\s+/).map(p => p.trim()).filter(Boolean);
  return parts.includes(f);
}

/* ======================
   CSV HELPERS (Excel-friendly)
====================== */
function csvEscape(v){
  const s = (v ?? '').toString();
  if(/[",\n\r;]/.test(s)) return `"${s.replaceAll('"','""')}"`;
  return s;
}

function downloadTextFile(filename, text, mime='text/plain'){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

/* ======================
   CARGA BASE: GRUPOS
====================== */
async function cargarGruposBase(){
  setStatus('Cargando grupos...');
  const snap = await getDocs(collection(db,'grupos'));

  state.grupos = [];
  state.grupoById.clear();
  state.actNameByKey.clear();

  const destinosSet = new Set();
  const coordsSet = new Set();

  snap.forEach(d => {
    const data = d.data() || {};
    const g = { id: d.id, ...data };

    g.destino = (g.destino ?? '').toString().trim();
    g.coordinadorEmail = (g.coordinadorEmail ?? g.coordEmail ?? g.coordinador ?? '')
      .toString().trim().toLowerCase();
    g.numeroNegocio = (g.numeroNegocio ?? g.numero ?? g.id ?? '').toString().trim();
    g.nombreGrupo = (g.nombreGrupo ?? g.nombre ?? '').toString().trim();

    state.grupos.push(g);
    state.grupoById.set(g.id, g);

    if(g.destino) destinosSet.add(g.destino);
    if(g.coordinadorEmail) coordsSet.add(g.coordinadorEmail);

    const itin = g.itinerario || {};
    Object.keys(itin).forEach(fechaISO => {
      const arr = Array.isArray(itin[fechaISO]) ? itin[fechaISO] : [];
      arr.forEach(item => {
        const act = (item?.actividad ?? item?.act ?? '').toString().trim();
        if(!act) return;
        const key = slugActKey(act);
        if(!state.actNameByKey.has(key)) state.actNameByKey.set(key, act);
      });
    });
  });

  state.destinos = Array.from(destinosSet).sort((a,b)=> a.localeCompare(b,'es'));
  state.coords = Array.from(coordsSet).sort((a,b)=> a.localeCompare(b,'es'));

  setStatus(`Listo. Grupos cargados: ${state.grupos.length}.`);
}

/* ======================
   POBLAR FILTROS
====================== */
function poblarFiltros(){
  clearSelect(el.destino);
  option(el.destino, '', '(Todos)');
  state.destinos.forEach(d => option(el.destino, d, d));

  clearSelect(el.coord);
  option(el.coord, '', '(Todos)');
  state.coords.forEach(c => option(el.coord, c, c));

  clearSelect(el.grupo);
  option(el.grupo, '', '(Todos)');
  state.grupos
    .slice()
    .sort((a,b)=> grupoLabel(a).localeCompare(grupoLabel(b),'es'))
    .forEach(g => option(el.grupo, g.id, grupoLabel(g)));

  clearSelect(el.actividad);
  option(el.actividad, '', '(Selecciona destino y/o carga)');
  el.actividad.disabled = (el.modo.value !== 'ACTIVIDAD');
}

/* ======================
   FILTRAR GRUPOS ACTUALES
====================== */
function gruposFiltrados(){
  const d = el.destino.value;
  const c = el.coord.value;
  const gid = el.grupo.value;

  let arr = state.grupos;

  if(gid){
    const g = state.grupoById.get(gid);
    return g ? [g] : [];
  }

  if(d) arr = arr.filter(g => destinoMatchPorComponentes(g.destino || '', d));
  if(c) arr = arr.filter(g => (g.coordinadorEmail || '') === c);

  return arr;
}

/* ======================
   ACTIVIDADES DISPONIBLES (índice asistencias)
====================== */
function recalcularActividadesDisponibles(){
  const grupos = gruposFiltrados();
  const keysSet = new Set();

  grupos.forEach(g => {
    const asist = g.asistencias || {};
    Object.keys(asist).forEach(fechaISO => {
      const day = asist[fechaISO] || {};
      Object.keys(day).forEach(actKey => {
        const v = day[actKey] || {};
        if(v?.notas) keysSet.add(actKey);
      });
    });
  });

  const keys = Array.from(keysSet);
  keys.sort((a,b)=>{
    const A = state.actNameByKey.get(a) || a;
    const B = state.actNameByKey.get(b) || b;
    return A.localeCompare(B,'es');
  });

  state.filteredActKeys = keys;

  clearSelect(el.actividad);
  option(el.actividad, '', '(Selecciona actividad)');
  keys.forEach(k => option(el.actividad, k, state.actNameByKey.get(k) || k));

  if(!keys.length){
    clearSelect(el.actividad);
    option(el.actividad, '', '(Sin actividades con bitácora en este filtro)');
  }
}

/* ======================
   LECTURA BITÁCORA REAL
====================== */
async function fetchBitacoraDocs(grupoId, actKey, fechaISO){
  const col = collection(db, 'grupos', grupoId, 'bitacora', actKey, fechaISO);
  const snap = await getDocs(col);

  const out = [];
  snap.forEach(d => {
    const x = d.data() || {};
    out.push({
      texto: (x.texto ?? '').toString(),
      byEmail: (x.byEmail ?? '').toString(),
      ts: x.ts || null,
      _id: d.id
    });
  });
  return out;
}

/* ======================
   CARGAR BITÁCORA (tabla)
====================== */
async function cargarBitacora(){
  const modo = el.modo.value;
  const limite = Number(el.limite.value || 200);
  const grupos = gruposFiltrados();

  if(!grupos.length){
    renderRows([]);
    setStatus('Sin grupos para ese filtro.');
    return;
  }

  if(modo === 'ACTIVIDAD'){
    const actKey = el.actividad.value;
    if(!actKey){
      renderRows([]);
      setStatus('Selecciona una actividad.');
      return;
    }
  }

  setStatus('Leyendo bitácora en Firebase...');
  el.btnCargar.disabled = true;
  el.btnExportDestino.disabled = true;
  el.btnExportVisible.disabled = true;
  el.btnLimpiar.disabled = true;

  const rows = [];

  try{
    if(modo === 'GRUPO'){
      for(const g of grupos){
        const asist = g.asistencias || {};
        const fechas = Object.keys(asist).sort();

        for(const fechaISO of fechas){
          const day = asist[fechaISO] || {};
          const actKeys = Object.keys(day);

          for(const actKey of actKeys){
            const idx = day[actKey] || {};
            
            // ✅ NO dependemos de idx.notas: consultamos la bitácora real
            const docs = await fetchBitacoraDocs(g.id, actKey, fechaISO);
            if(!docs.length) continue;
            
            for(const d of docs){
              const tsMs = d.ts?.toMillis ? d.ts.toMillis() : null;
              const pax = getPaxInfo(g, fechaISO, actKey);
            
              rows.push({
                fechaISO,
                hora: fmtHoraFromMs(tsMs),
                grupoLabel: grupoLabel(g),
                paxEsperado: pax.esperado,
                paxFinal: pax.final,
                grupoId: g.id,
                actKey,
                actName: state.actNameByKey.get(actKey) || actKey,
                texto: d.texto,
                autor: d.byEmail || '—',
                tsMs,
                tsStr: fmtTS(tsMs)
              });
            
              if(rows.length >= limite) break;
            }

            if(rows.length >= limite) break;
          }
          if(rows.length >= limite) break;
        }
        if(rows.length >= limite) break;
      }
    } else {
      const actKey = el.actividad.value;

      for(const g of grupos){
        const asist = g.asistencias || {};
        const fechas = Object.keys(asist).sort();

        for(const fechaISO of fechas){
          const day = asist[fechaISO] || {};
          const idx = day[actKey] || null;
          
          // ✅ NO dependemos de idx.notas: consultamos la bitácora real
          const docs = await fetchBitacoraDocs(g.id, actKey, fechaISO);
          if(!docs.length) continue;
          
          for(const d of docs){
            const tsMs = d.ts?.toMillis ? d.ts.toMillis() : null;
            const pax = getPaxInfo(g, fechaISO, actKey);
          
            rows.push({
              fechaISO,
              hora: fmtHoraFromMs(tsMs),
              grupoLabel: grupoLabel(g),
              paxEsperado: pax.esperado,
              paxFinal: pax.final,
              grupoId: g.id,
              actKey,
              actName: state.actNameByKey.get(actKey) || actKey,
              texto: d.texto,
              autor: d.byEmail || '—',
              tsMs,
              tsStr: fmtTS(tsMs)
            });
          
            if(rows.length >= limite) break;
          }

          if(rows.length >= limite) break;
        }
        if(rows.length >= limite) break;
      }
    }

    rows.sort((a,b)=>{
      const A = a.tsMs || 0;
      const B = b.tsMs || 0;
      if(B !== A) return B - A;
      return String(b.fechaISO).localeCompare(String(a.fechaISO));
    });

    state.rows = rows;
    renderRows(rows);
    setStatus(`Listo. Entradas: ${rows.length} (límite ${limite}).`);
  } catch(err){
    console.error(err);
    renderRows([]);
    setStatus('Error leyendo Firebase (ver consola).');
  } finally{
    el.btnCargar.disabled = false;
    el.btnExportDestino.disabled = false;
    el.btnExportVisible.disabled = false;
    el.btnLimpiar.disabled = false;
  }
}

/* ======================
   ✅ EXPORTAR DESTINO (todo)
====================== */
async function exportarComentariosPorDestino(){
  const destinoSel = el.destino.value || '';
  const grupos = gruposFiltrados();

  if(!grupos.length){
    setStatus('No hay grupos para exportar con este filtro.');
    return;
  }

  const nombreDestinoArchivo = destinoSel ? destinoSel : 'TODOS';
  const safeName = slug(nombreDestinoArchivo).toUpperCase() || 'TODOS';

  setStatus(destinoSel
    ? `Exportando comentarios del destino: ${destinoSel}...`
    : 'Exportando comentarios de TODOS los destinos (puede demorar)...'
  );

  el.btnCargar.disabled = true;
  el.btnExportDestino.disabled = true;
  el.btnExportVisible.disabled = true;
  el.btnLimpiar.disabled = true;

  try{
    const header = [
      'destinoFiltro',
      'destinoGrupo',
      'grupoId',
      'grupo',
      'coordinadorEmail',
      'fechaISO',
      'actKey',
      'actividad',
      'paxFinal', // ✅ NUEVO
      'timeId',
      'autor',
      'tsMs',
      'tsLocal',
      'texto'
    ];


    const lines = [];
    lines.push(header.join(';'));

    let total = 0;
    const MAX_EXPORT = 20000;

    for(const g of grupos){
      const asist = g.asistencias || {};
      const fechas = Object.keys(asist).sort();

      for(const fechaISO of fechas){
        const day = asist[fechaISO] || {};
        const actKeys = Object.keys(day);

        for(const actKey of actKeys){
          const idx = day[actKey] || {};
          if(!idx?.notas) continue;

          const docs = await fetchBitacoraDocs(g.id, actKey, fechaISO);

          for(const d of docs){
            const tsMs = d.ts?.toMillis ? d.ts.toMillis() : null;

            const pax = getPaxInfo(g, fechaISO, actKey);
            
            const row = [
              destinoSel || 'TODOS',
              g.destino || '',
              g.id,
              grupoLabel(g),
              g.coordinadorEmail || '',
              fechaISO,
              actKey,
              state.actNameByKey.get(actKey) || actKey,
              (typeof pax.esperado === 'number' || typeof pax.final === 'number')
                ? `${(typeof pax.esperado === 'number') ? pax.esperado : ''}${(typeof pax.esperado === 'number' && typeof pax.final === 'number') ? ' -> ' : ''}${(typeof pax.final === 'number') ? pax.final : ''}`
                : '',

              d._id || '',
              d.byEmail || '',
              tsMs || '',
              tsMs ? fmtTS(tsMs) : '',
              d.texto || ''
            ].map(csvEscape).join(';');


            lines.push(row);
            total++;

            if(total % 250 === 0) setStatus(`Exportando... ${total} comentarios`);

            if(total >= MAX_EXPORT){
              setStatus(`Exportación cortada por protección: ${MAX_EXPORT} filas.`);
              break;
            }
          }
          if(total >= MAX_EXPORT) break;
        }
        if(total >= MAX_EXPORT) break;
      }
      if(total >= MAX_EXPORT) break;
    }

    const csv = '\uFEFF' + lines.join('\n');
    const filename = `bitacora_DESTINO_${safeName}_${new Date().toISOString().slice(0,10)}.csv`;
    downloadTextFile(filename, csv, 'text/csv;charset=utf-8');

    setStatus(`✅ Exportado DESTINO: ${total} comentarios (${nombreDestinoArchivo}).`);
  } catch(err){
    console.error(err);
    setStatus('Error exportando destino (ver consola).');
  } finally{
    el.btnCargar.disabled = false;
    el.btnExportDestino.disabled = false;
    el.btnExportVisible.disabled = false;
    el.btnLimpiar.disabled = false;
  }
}

/* ======================
   ✅ EXPORTAR LO VISIBLE (lo filtrado en pantalla)
   - usa state.rows + buscador actual
====================== */
function getVisibleRows(){
  const q = norm(el.buscador.value || '');
  if(!q) return state.rows.slice();

  return state.rows.filter(r => {
   
    const blob = norm([
      r.fechaISO, r.hora, r.grupoLabel,
      r.paxEsperado, r.paxFinal,
      r.actName, r.actKey, r.texto, r.autor, r.tsStr
    ].join(' '));

    return blob.includes(q);
  });
}

function exportarVisible(){
  const rows = getVisibleRows();

  if(!rows.length){
    setStatus('No hay filas visibles para exportar.');
    return;
  }

  const destinoSel = el.destino.value || 'TODOS';
  const modoSel = el.modo.value || 'GRUPO';
  const safeDestino = slug(destinoSel).toUpperCase() || 'TODOS';
  const safeModo = slug(modoSel).toUpperCase() || 'MODO';

  const header = [
    'fechaISO',
    'hora',
    'grupo',
    'pax', // esperado -> final
    'actividad',
    'texto',
    'autor',
    'timestampLocal'
  ];


  const lines = [];
  lines.push(header.join(';'));

  rows.forEach(r => {
    lines.push([
      r.fechaISO || '',
      r.hora || '',
      r.grupoLabel || '',
      (typeof r.paxEsperado === 'number' || typeof r.paxFinal === 'number')
        ? `${(typeof r.paxEsperado === 'number') ? r.paxEsperado : ''}${(typeof r.paxEsperado === 'number' && typeof r.paxFinal === 'number') ? ' -> ' : ''}${(typeof r.paxFinal === 'number') ? r.paxFinal : ''}`
        : '',

      r.actName || r.actKey || '',
      r.texto || '',
      r.autor || '',
      r.tsStr || ''
    ].map(csvEscape).join(';'));
  });

  const csv = '\uFEFF' + lines.join('\n');
  const filename = `bitacora_VISIBLE_${safeDestino}_${safeModo}_${new Date().toISOString().slice(0,10)}.csv`;
  downloadTextFile(filename, csv, 'text/csv;charset=utf-8');

  setStatus(`✅ Exportado VISIBLE: ${rows.length} filas.`);
}

/* ======================
   RENDER + BUSCADOR
====================== */
function escapeHtml(s=''){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

function renderRows(rows){
  el.count.textContent = String(rows.length);

  if(!rows.length){
    el.tbody.innerHTML = `<tr><td colspan="8" class="empty">Sin resultados.</td></tr>`;
    return;
  }

  el.tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="mono nowrap">${r.fechaISO || '—'}</td>
      <td class="mono nowrap">${r.hora || '—'}</td>
      <td>${escapeHtml(r.grupoLabel || '—')}</td>
  
      <!-- ✅ NUEVA COLUMNA PAX -->
      <td class="mono nowrap">${
        (typeof r.paxEsperado === 'number' && typeof r.paxFinal === 'number')
          ? `${r.paxEsperado} → ${r.paxFinal}`
          : (typeof r.paxEsperado === 'number')
            ? `${r.paxEsperado}`
            : (typeof r.paxFinal === 'number')
              ? `${r.paxFinal}`
              : '—'
      }</td>

  
      <td>${escapeHtml(r.actName || r.actKey || '—')}</td>
      <td class="texto">${escapeHtml(r.texto || '')}</td>
      <td class="hide-m">${escapeHtml(r.autor || '—')}</td>
      <td class="hide-m mono nowrap">${escapeHtml(r.tsStr || '—')}</td>
    </tr>
  `).join('');
}

function applySearch(){
  const filtered = getVisibleRows(); // <- usa misma lógica
  renderRows(filtered);
  setStatus(`Filtrado: ${filtered.length}/${state.rows.length}`);
}

/* ======================
   LIMPIAR
====================== */
function limpiar(){
  el.destino.value = '';
  el.coord.value = '';
  el.grupo.value = '';
  el.modo.value = 'GRUPO';
  el.actividad.disabled = true;
  el.limite.value = '200';
  el.buscador.value = '';
  state.rows = [];
  renderRows([]);
  setStatus('Listo.');
}

/* ======================
   EVENTOS
====================== */
function wire(){
  el.modo.addEventListener('change', () => {
    const isAct = el.modo.value === 'ACTIVIDAD';
    el.actividad.disabled = !isAct;
    if(isAct) recalcularActividadesDisponibles();
  });

  const refilter = () => {
    if(el.modo.value === 'ACTIVIDAD') recalcularActividadesDisponibles();
  };
  el.destino.addEventListener('change', refilter);
  el.coord.addEventListener('change', refilter);
  el.grupo.addEventListener('change', refilter);

  el.btnCargar.addEventListener('click', cargarBitacora);
  el.btnExportDestino.addEventListener('click', exportarComentariosPorDestino);
  el.btnExportVisible.addEventListener('click', exportarVisible);
  el.btnLimpiar.addEventListener('click', limpiar);
  el.buscador.addEventListener('input', applySearch);
}

/* ======================
   INIT + AUTH
====================== */
async function init(){
  await cargarGruposBase();
  poblarFiltros();
  wire();

  if(el.modo.value === 'ACTIVIDAD'){
    recalcularActividadesDisponibles();
  }

  renderRows([]);
}

onAuthStateChanged(auth, async (u) => {
  if(!u){
    window.location.href = 'login.html';
    return;
  }
  state.user = u;
  await init();
});
