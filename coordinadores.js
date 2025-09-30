/* coordinadores.js — FINAL + LOGS
   Instrumentación:
   - DEBUG switch + helper L(), W(), E()
   - window.onerror / unhandledrejection
   - console.time* en cargas y render
   - groupCollapsed en pasos críticos
   - contadores y tamaños en cada fase
*/

import { app, db } from './firebase-init.js';
import {
  collection, collectionGroup, getDocs, addDoc, doc, updateDoc, setDoc, deleteDoc,
  query, where, getDoc, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ===================== LOGGING ===================== */
const DEBUG = true;
const tag = 'RTV/coord';
const L = (...a)=> DEBUG && console.log(`[${tag}]`, ...a);
const W = (...a)=> DEBUG && console.warn(`[${tag}]`, ...a);
const E = (...a)=> DEBUG && console.error(`[${tag}]`, ...a);

window.addEventListener('error', (ev)=>{
  E('window.onerror:', ev.message, ev.error);
});
window.addEventListener('unhandledrejection', (ev)=>{
  E('unhandledrejection:', ev.reason || ev);
});

/* =========================================================
   Estado
   ========================================================= */
let COORDS = [];   // {id, nombre, rut, telefono, correo, destinos:string[], disponibilidad:[{inicio,fin}], activo, notas, _isNew?}
let GRUPOS = [];   // catálogo de viajes (grupos)
let SETS   = [];   // asignaciones (conjuntos)
let ID2GRUPO = new Map();
// Horas de inicio por grupo (cargadas desde 'vuelos')
let HORAS_INICIO = new Map(); // groupId -> { pres:'HH:MM'|null, inicio:'HH:MM'|null, fuente:'aereo|terrestre', vueloId:string|null }

let DESTINOS = []; // catálogo (normalizado) desde GRUPOS
// ===== Snapshot para diffs en guardado =====
const PREV = {
  grupos: new Map(),   // id -> { aliasGrupo, conjuntoId, coordinadorId, coordinador }
  sets:   new Map(),   // `${ownerCoordId}/${conjuntoId}` -> { viajes:[ids], confirmado:true, owner }
};

// Filtros de catálogo (resumen/libres)
const FILTER = { destino:'', programa:'', desde:'', hasta:'' };

// Buscador de CONJUNTOS (tokens)
const SEARCH = { tokens: [] };

// Filtros/búsquedas adicionales
const FILTER_SETS   = { day: '' };   // día exacto para asignados (SETS)
const FILTER_LIBRES = { day: '' };   // día exacto para libres
const SEARCH_LIBRES = { tokens: [] };// buscador para libres

let swapMode  = false;
let swapFirst = null;

/* =========================================================
   Helpers fecha/formato
   ========================================================= */
const toISO = d => (new Date(d)).toISOString().slice(0,10);
const addDaysISO = (iso, n) => { const D=new Date(iso+'T00:00:00'); D.setDate(D.getDate()+n); return toISO(D); };

function asISO(v){
  if (!v) return null;
  if (typeof v === 'string'){ const d = new Date(v); return isNaN(d) ? null : toISO(d); }
  if (v?.toDate)  return toISO(v.toDate());
  if (v?.seconds) return toISO(new Date(v.seconds*1000));
  if (v instanceof Date) return toISO(v);
  return null;
}

const cmpISO   = (a,b)=> (new Date(a)-new Date(b));
const overlap  = (a1,a2,b1,b2)=>!(new Date(a2)<new Date(b1)||new Date(b2)<new Date(a1));
const inAnyRange = (ini,fin,ranges=[]) => (ranges||[]).some(r=> new Date(ini)>=new Date(r.inicio) && new Date(fin)<=new Date(r.fin));
function gapDays(finA, iniB){ const A=new Date(finA+'T00:00:00'); const B=new Date(iniB+'T00:00:00'); return Math.round((B-A)/86400000)-1; }

// dd/mm/aaaa
function fmtDMY(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
// ===== Helpers HH:MM =====
function isHHMM(s){ return typeof s==='string' && /^\d{2}:\d{2}$/.test(s); }
function hhmmToMin(s){ if(!isHHMM(s)) return null; const [h,m]=s.split(':').map(Number); return (h*60)+m; }
function minHHMM(a,b){
  if (!isHHMM(a)) return b||''; if (!isHHMM(b)) return a||'';
  return (hhmmToMin(a) <= hhmmToMin(b)) ? a : b;
}

/* =========================================================
   Normalización de destinos (MAYÚSCULA)
   ========================================================= */
const normDest = s => (s||'').toString().trim().toUpperCase();
function cleanDestinos(arr){
  return (arr||[])
    .map(normDest)
    .filter(Boolean)
    .filter((v,i,a)=>a.indexOf(v)===i)
    .sort();
}
function isAptoDestino(coord, destino){
  const d = normDest(destino);
  if (!d) return true;
  const L = coord?.destinos || [];
  // lista vacía = apto para todos
  return !L.length || L.includes(d);
}

/* =========================================================
   Carga Firestore
   ========================================================= */
async function loadCoordinadores(){
  console.time('loadCoordinadores');
  COORDS = [];
  try{
    const snap = await getDocs(collection(db,'coordinadores'));
    L('Coordinadores: snap.size =', snap.size);
    snap.forEach(d=>{
      const x=d.data();
      const disp = Array.isArray(x.disponibilidad) ? x.disponibilidad
                 : Array.isArray(x.fechasDisponibles) ? x.fechasDisponibles : [];
      const disponibilidad = (disp||[])
        .map(r=>({inicio:asISO(r.inicio)||null, fin:asISO(r.fin)||null}))
        .filter(r=>r.inicio&&r.fin&&(new Date(r.inicio)<=new Date(r.fin)));

      COORDS.push({
        id:d.id,
        nombre:(x.nombre||'').trim(),
        rut:(x.rut||'').trim(),
        telefono:(x.telefono||'').trim(),
        correo:(x.correo||'').trim().toLowerCase(),
        destinos: cleanDestinos(x.destinos || x.destinosAptos || []),
        disponibilidad,
        activo:(x.activo!==false),
        notas:(x.notas||'').trim()
      });
    });
    L('Coordinadores cargados:', COORDS.length);
  }catch(err){
    E('loadCoordinadores error:', err);
    throw err;
  }finally{
    console.timeEnd('loadCoordinadores');
  }
}

async function loadGrupos(){
  console.time('loadGrupos');
  GRUPOS = [];
  ID2GRUPO.clear();

  try{
    const ref = collection(db,'grupos');
    const snap = await getDocs(ref);
    if (!snap || snap.empty){
      W('loadGrupos: snapshot vacío (¿colección "grupos" sin lectura o sin docs?)');
    } else {
      L('Grupos: snap.size =', snap.size);
    }

    let omitidosSinFecha = 0;
    let tomados = 0;

    const primerosIds = [];
    snap.forEach(d=>{
      if (primerosIds.length < 8) primerosIds.push(d.id);

      const x = d.data();
      x.id = d.id;

      // Fallbacks comunes de tus datos
      x.numeroNegocio = x.numeroNegocio || d.id;
      x.aliasGrupo    = x.aliasGrupo || limpiarAlias(x.nombreGrupo || String(d.id));

      const { ini, fin } = normalizarFechasGrupo(x);
      if (!ini || !fin){
        omitidosSinFecha++;
        return; // no lo incluimos si no hay fechas válidas
      }

      const g = {
        ...x,
        fechaInicio : ini,
        fechaFin    : fin,
        identificador: x.identificador || x.identificadorGrupo || x.codigoGrupo || x.codigo || '',
        programa    : x.programa || x.nombrePrograma || x.programaNombre || '',
        destino     : x.destino  || x.destinoPrincipal || x.ciudadDestino || x.ciudad || x.paisDestino || ''
      };

      GRUPOS.push(g);
      ID2GRUPO.set(g.id, g);
      tomados++;
    });

    // Orden por fecha de inicio
    GRUPOS.sort((a,b)=> (new Date(a.fechaInicio) - new Date(b.fechaInicio)));

    // Resumen de diagnóstico
    L('loadGrupos => tomados:', tomados,
      '| omitidosSinFecha:', omitidosSinFecha,
      '| ID2GRUPO size:', ID2GRUPO.size,
      '| primeros ids:', primerosIds);

    // Si al final quedó vacío, avisa
    if (!GRUPOS.length){
      W('loadGrupos: No se cargó ningún grupo. Revisa reglas/permiso y campos de fecha.');
    }
  }catch(err){
    E('loadGrupos error:', err);
    throw err;
  }finally{
    console.timeEnd('loadGrupos');
  }
}

async function loadHorasViajes(){
  console.time('loadHorasViajes');
  HORAS_INICIO.clear();
  try{
    // Cargamos TODOS los vuelos
    const snap = await getDocs(collection(db,'vuelos')); // requiere import getDocs, collection (ya los tienes)
    // Recorremos cada vuelo y sus grupos
    snap.forEach(d=>{
      const v = d.data() || {};
      const vId = d.id;
      const tipoTrans = (v.tipoTransporte || 'aereo').toLowerCase();

      // Helper para postular horas a un grupo
      const postularHoras = (groupId, fechaIda, pres, inicio)=>{
        const g = ID2GRUPO.get(groupId);
        if (!g) return;
        const fechaGrupo = g.fechaInicio; // ya normalizada por loadGrupos
        if (!fechaGrupo || !fechaIda || fechaGrupo !== fechaIda) return;

        const curr = HORAS_INICIO.get(groupId) || { pres:null, inicio:null, fuente:null, vueloId:null };
        const nuevo = {
          pres  : pres   && isHHMM(pres)   ? (curr.pres   ? minHHMM(curr.pres, pres)   : pres)   : curr.pres,
          inicio: inicio && isHHMM(inicio) ? (curr.inicio ? minHHMM(curr.inicio, inicio): inicio): curr.inicio,
          fuente: tipoTrans,
          vueloId: vId
        };
        HORAS_INICIO.set(groupId, nuevo);
      };

      // Caso AÉREO REGULAR MULTITRAMO: horas en tramos[]
      const isAereo = tipoTrans === 'aereo';
      const isRegMT = isAereo && v.tipoVuelo === 'regular' && Array.isArray(v.tramos) && v.tramos.length>0;

      if (isRegMT){
        (Array.isArray(v.grupos)?v.grupos:[]).forEach(gref=>{
          const gid = gref?.id; if(!gid) return;
          // para cada tramo con fechaIda
          (v.tramos||[]).forEach(t=>{
            const fIda = t?.fechaIda ? (new Date(t.fechaIda)).toISOString().slice(0,10) : '';
            if (!fIda) return;
            const pres = t.presentacionIdaHora || '';
            const ini  = t.vueloIdaHora || '';
            postularHoras(gid, fIda, pres, ini);
          });
        });
        return; // procesa siguiente vuelo
      }

      // Caso AÉREO simple/charter: top-level fechaIda + horas
      if (isAereo){
        const fIda = v?.fechaIda ? (new Date(v.fechaIda)).toISOString().slice(0,10) : '';
        const pres = v.presentacionIdaHora || '';
        const ini  = v.vueloIdaHora || '';
        (Array.isArray(v.grupos)?v.grupos:[]).forEach(gref=>{
          const gid = gref?.id; if(!gid) return;
          postularHoras(gid, fIda, pres, ini);
        });
        return;
      }

      // Caso TERRESTRE (bus): top-level fechaIda + idaHora
      if (tipoTrans==='terrestre'){
        const fIda = v?.fechaIda ? (new Date(v.fechaIda)).toISOString().slice(0,10) : '';
        const hr   = v.idaHora || '';
        (Array.isArray(v.grupos)?v.grupos:[]).forEach(gref=>{
          const gid = gref?.id; if(!gid) return;
          // en bus usamos la misma hora como presentación/inicio (si no definiste presentación aparte)
          postularHoras(gid, fIda, hr, hr);
        });
        return;
      }
    });

    // Opcional: volcar las horas al objeto GRUPOS
    GRUPOS.forEach(g=>{
      const h = HORAS_INICIO.get(g.id) || null;
      if (h) g._horasInicio = h; // pres, inicio, fuente, vueloId
    });

    console.log('[RTV/coord] HORAS_INICIO map size =', HORAS_INICIO.size);
  }catch(err){
    E('loadHorasViajes error:', err);
  }finally{
    console.timeEnd('loadHorasViajes');
  }
}

async function loadSets(){
  console.time('loadSets');
  SETS = [];

  // Seguridad: asegúrate de tener catálogo
  if (!GRUPOS.length || !ID2GRUPO.size){
    W('loadSets: GRUPOS vacío; reintentando loadGrupos() antes de continuar.');
    await loadGrupos();
  }

  try{
    console.groupCollapsed('[SETS] A) collectionGroup("conjuntos")');
    const mapByConj = new Map(); // conjuntoId -> {id, viajes, coordinadorId, confirmado, alertas, _ownerCoordId}
    const snap = await getDocs(collectionGroup(db, 'conjuntos'));
    L('Conjuntos (collectionGroup) snap.size =', snap.size);
    snap.forEach(d => {
      const x = d.data();
      const conjuntoId    = d.id;
      const coordinadorId = d.ref.parent.parent.id; // doc del coordinador
      const viajes        = (x.viajes || []).filter(id => ID2GRUPO.has(id));

      mapByConj.set(conjuntoId, {
        id: conjuntoId,
        viajes: viajes.slice(),
        coordinadorId,
        confirmado: !!x.confirmado,
        alertas: [],
        _ownerCoordId: coordinadorId
      });
    });
    L('A) conjuntos mapeados:', mapByConj.size);
    console.groupEnd();

    console.groupCollapsed('[SETS] B) Reconstruir desde grupos{conjuntoId}');
    let adds = 0;
    for (const g of GRUPOS){
      if (!g.conjuntoId) continue;
      const k = g.conjuntoId;

      if (!mapByConj.has(k)){
        let coordId = g.coordinadorId || null;
        if (!coordId && g.coordinador){
          const wanted = (g.coordinador||'').trim().toLowerCase();
          const hit = COORDS.find(c => (c.nombre||'').trim().toLowerCase() === wanted);
          if (hit) coordId = hit.id;
        }
        mapByConj.set(k, {
          id: k, viajes: [], coordinadorId: coordId, confirmado: true, alertas: [],
          _ownerCoordId: coordId || null
        });
        adds++;
      }
      const S = mapByConj.get(k);
      if (!S.coordinadorId && g.coordinadorId){
        S.coordinadorId = g.coordinadorId;
        S._ownerCoordId = g.coordinadorId;
      }
      if (ID2GRUPO.has(g.id) && !S.viajes.includes(g.id)){
        S.viajes.push(g.id);
      }
    }
    L('B) conjuntos agregados desde grupos:', adds);
    console.groupEnd();

    // C) Volcar
    SETS = Array.from(mapByConj.values()).map(S => ({
      ...S,
      viajes: (S.viajes || []).filter(id => ID2GRUPO.has(id))
    }));
    L('C) SETS preliminares:', SETS.length, 'Tot viajes:',
      SETS.reduce((n,s)=>n+(s.viajes?.length||0),0));

    // D) Post
    dedupeSetsInPlace();
    sortSetsInPlace();
    populateFilterOptions();
    evaluarAlertas();
    render();

    L('D) SETS finales:', SETS.length, 'Tot viajes:',
      SETS.reduce((n,s)=>n+(s.viajes?.length||0),0));
     // --- Construye snapshot PREV (para guardado por diffs) ---
      PREV.grupos.clear();
      GRUPOS.forEach(g=>{
        PREV.grupos.set(g.id, {
          aliasGrupo   : g.aliasGrupo || null,
          conjuntoId   : g.conjuntoId || null,
          coordinadorId: g.coordinadorId || null,
          coordinador  : g.coordinador || null,
        });
      });
      
      PREV.sets.clear();
      SETS.forEach(s=>{
        const owner = s._ownerCoordId || s.coordinadorId || null;
        const sid   = s.id || null;
        if (owner && sid) {
          PREV.sets.set(`${owner}/${sid}`, {
            viajes    : (s.viajes||[]).slice(),
            confirmado: !!s.confirmado,
            owner
          });
        }
      });

  }catch(err){
    E('loadSets error:', err);
    throw err;
  }finally{
    console.timeEnd('loadSets');
  }
}


/* =========================================================
   DOM refs
   ========================================================= */
const $ = s=>document.querySelector(s);
const elWrapLibres = $('#lista-viajes-libres');
const elWrapSets   = $('#conjuntos-wrap');
const elMsg        = $('#msg');

// Filtros de catálogo (resumen/libres)
const selDestino = $('#f-destino');
const selPrograma= $('#f-programa');
const inpDesde   = $('#f-desde');
const inpHasta   = $('#f-hasta');

// Buscador de CONJUNTOS (ubícalo en la cabecera de “Viajes”)
const inpBuscarSets = $('#buscar-sets');

const inpDiaSets      = $('#f-dia-sets');
const inpBuscarLibres = $('#buscar-libres');
const inpDiaLibres    = $('#f-dia-libres');

const wrapResumen= $('#resumen-wrap');
const wrapStats  = $('#stats-viajes-wrap');

// Modal
const mb               = $('#mb');
const modal            = $('#modal-coords');
const btnOpenModal     = $('#btn-modal-coords');
const btnCloseModal    = $('#close-modal');
const btnCerrar        = $('#btn-cerrar');
const btnGuardarCoords = $('#btn-guardar-coords');
const btnAddCoord      = $('#btn-add-coord');
const btnAddLote       = $('#btn-add-lote');
const inputExcel       = $('#input-excel');
const tbodyCoords      = $('#tabla-coords tbody');
const hintEmptyCoords  = $('#hint-empty-coords');

if (!elWrapLibres || !elWrapSets){
  W('DOM contenedores no encontrados:', { elWrapLibres: !!elWrapLibres, elWrapSets: !!elWrapSets });
}

// Toolbar
$('#btn-sugerir')?.addEventListener('click', sugerirConjuntos);
$('#btn-nuevo-conjunto')?.addEventListener('click', ()=>{
  L('Nuevo conjunto (borrador)');
  SETS.unshift({viajes:[], coordinadorId:null, confirmado:false, alertas:[], _isNew:true});
  render();
});
$('#btn-guardar')?.addEventListener('click', ()=>withBusy($('#btn-guardar'), 'Guardando…', guardarTodo, 'Guardar cambios', '✅ Guardado'));

// Modal handlers
btnOpenModal?.addEventListener('click', ()=>{ openModal(); renderCoordsTable(); });
btnCloseModal?.addEventListener('click', closeModal);
btnCerrar?.addEventListener('click', closeModal);
btnGuardarCoords?.addEventListener('click', ()=>withBusy(btnGuardarCoords, 'Guardando…', saveCoordsModal, 'Guardar coordinadores', '✅ Guardado'));
btnAddCoord?.addEventListener('click', ()=>{
  COORDS.unshift({nombre:'', rut:'', telefono:'', correo:'', destinos:[], disponibilidad:[], _isNew:true});
  renderCoordsTable(); setTimeout(initPickers,10);
});
btnAddLote?.addEventListener('click', ()=> inputExcel.click());
inputExcel?.addEventListener('change', handleExcel);

// Filtros (catálogo)
function populateFilterOptions(){
  console.time('populateFilterOptions');
  DESTINOS = [...new Set(GRUPOS.map(g=>normDest(g.destino)).filter(Boolean))].sort();

  const dests=[...new Set(GRUPOS.map(g=>g.destino).filter(Boolean))].sort();
  const progs=[...new Set(GRUPOS.map(g=>g.programa).filter(Boolean))].sort();
  if (selDestino)  selDestino.innerHTML  = `<option value="">Todos los destinos</option>` + dests.map(d=>`<option>${escapeHtml(d)}</option>`).join('');
  if (selPrograma) selPrograma.innerHTML = `<option value="">Todos los programas</option>` + progs.map(p=>`<option>${escapeHtml(p)}</option>`).join('');

  L('populateFilterOptions:', { destinos:dests.length, programas:progs.length });

  selDestino?.addEventListener('change',  ()=>{ FILTER.destino = selDestino.value; render(); });
  selPrograma?.addEventListener('change', ()=>{ FILTER.programa= selPrograma.value; render(); });
  inpDesde?.addEventListener('change',    ()=>{ FILTER.desde   = inpDesde.value||''; render(); });
  inpHasta?.addEventListener('change',    ()=>{ FILTER.hasta   = inpHasta.value||''; render(); });

   // — Asignados (SETS): día exacto
   inpDiaSets?.addEventListener('change', ()=>{
     FILTER_SETS.day = inpDiaSets.value || '';
     renderSets(); // refrescar solo los SETS
   });
   
   // — Libres: buscador (sin tildes gracias a norm())
   inpBuscarLibres?.addEventListener('input', ()=>{
     SEARCH_LIBRES.tokens = parseTokens(inpBuscarLibres.value);
     renderLibres(); // refrescar libres
   });
   
   // — Libres: día exacto
   inpDiaLibres?.addEventListener('change', ()=>{
     FILTER_LIBRES.day = inpDiaLibres.value || '';
     renderLibres();
   });

  inpBuscarSets?.addEventListener('input', ()=>{
    SEARCH.tokens = parseTokens(inpBuscarSets.value);
    L('Buscar conjuntos tokens:', SEARCH.tokens);
    renderSets();
  });
  console.timeEnd('populateFilterOptions');
}

/* =========================================================
   Utils generales
   ========================================================= */
function withBusy(btn, busyText, fn, normalText, okText){
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  Promise.resolve(fn()).then(()=>{
    btn.textContent = okText || 'Listo';
    setTimeout(()=>{ btn.textContent = normalText || prev; btn.disabled=false; }, 900);
  }).catch(err=>{
    E('withBusy error:', err);
    btn.textContent = '❌ Error';
    setTimeout(()=>{ btn.textContent = normalText || prev; btn.disabled=false; }, 1500);
    alert('Ocurrió un error. Revisa la consola.');
  });
}

function normalizarFechasGrupo(x){
  // Helpers seguros a ISO (YYYY-MM-DD)
  const toISO = d => (new Date(d)).toISOString().slice(0,10);
  const asISO = (v)=>{
    if (!v) return null;
    if (typeof v === 'string'){ const d = new Date(v); return isNaN(d) ? null : toISO(d); }
    if (v?.toDate)  return toISO(v.toDate());
    if (v?.seconds) return toISO(new Date(v.seconds*1000));
    if (v instanceof Date) return toISO(v);
    return null;
  };
  const addDaysISO = (iso, n) => { const D=new Date(iso+'T00:00:00'); D.setDate(D.getDate()+n); return toISO(D); };

  // Nombres de campos que solemos ver
  let ini=asISO(
    x.fechaInicio ?? x.fecha_inicio ?? x.inicio ??
    x.fecha ?? x.fechaDeViaje ?? x.fechaViaje ?? x.fechaInicioViaje
  );
  let fin=asISO(
    x.fechaFin ?? x.fecha_fin ?? x.fin ??
    x.fechaFinal ?? x.fechaFinViaje
  );

  // Derivar desde itinerario { 'YYYY-MM-DD': {...} }
  if ((!ini || !fin) && x.itinerario && typeof x.itinerario==='object'){
    const ks=Object.keys(x.itinerario).filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    if (ks.length){ ini = ini || ks[0]; fin = fin || ks[ks.length-1]; }
  }

  // Calcular fin desde duración/noches
  if (ini && !fin && (x.duracion || x.noches)){
    const days = Number(x.duracion) || (Number(x.noches)+1) || 1;
    fin = addDaysISO(ini, days-1);
  }

  // Normalizaciones finales
  if (ini && !fin) fin = ini;
  if (fin && !ini) ini = fin;

  return { ini, fin };
}

function sortSetsInPlace(){
  const news = SETS.filter(s=>s._isNew);
  const olds = SETS.filter(s=>!s._isNew);
  olds.sort((A,B)=>{
    const nA=A.viajes?.length||0, nB=B.viajes?.length||0;
    if (nA!==nB) return nB-nA;
    const fA=firstStartISO(A)||'9999-12-31', fB=firstStartISO(B)||'9999-12-31';
    return cmpISO(fA,fB);
  });
  SETS.length=0; SETS.push(...news,...olds);
}
function firstStartISO(s){
  const viajes=(s.viajes||[]).map(id=>ID2GRUPO.get(id)).filter(Boolean).sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
  return viajes[0]?.fechaInicio || null;
}
function norm(s){
  return (s ?? '')
    .toString()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // quita tildes/diacríticos
    .trim()
    .toLowerCase();
}
function parseTokens(s){ return (s||'').split(',').map(t=>norm(t)).filter(Boolean); }

function gruposFiltrados(arr=GRUPOS){
  return arr.filter(g=>{
    if (FILTER.destino && !norm(g.destino).includes(norm(FILTER.destino))) return false;
    if (FILTER.programa && !norm(g.programa).includes(norm(FILTER.programa))) return false;
    if (FILTER.desde && g.fechaInicio < FILTER.desde) return false;
    if (FILTER.hasta && g.fechaInicio > FILTER.hasta) return false;
    return true;
  });
}

// Conjuntos filtrados por SEARCH.tokens (AND entre tokens)
function setsFiltrados(arr=SETS){
  const toks = SEARCH.tokens || [];
  const day  = FILTER_SETS.day || '';

  // 1) Filtro por día (si hay valor)
  const base = day
    ? arr.filter(s=>{
        const viajes = (s.viajes||[]).map(id=>ID2GRUPO.get(id)).filter(Boolean);
        return viajes.some(v => v && v.fechaInicio === day);
      })
    : arr;

  // 2) Filtro por texto (tokens AND)
  if (!toks.length) return base;

  return base.filter(s=>{
    const coordName = s.coordinadorId ? (COORDS.find(c=>c.id===s.coordinadorId)?.nombre||'') : '';
    const viajes = (s.viajes||[]).map(id=>ID2GRUPO.get(id)).filter(Boolean);

    const hay = [];
    hay.push(norm(coordName));
    viajes.forEach(v=>{
      hay.push(
        norm(v.aliasGrupo),
        norm(v.nombreGrupo),
        norm('#'+(v.numeroNegocio||'')),
        norm(v.identificador),
        norm(v.programa),
        norm(v.destino),
        norm(v.id||'')
      );
      hay.push(norm(fmtDMY(v.fechaInicio)), norm(fmtDMY(v.fechaFin)));
      hay.push(norm(v.fechaInicio), norm(v.fechaFin));
    });

    return toks.every(tok => hay.some(h => h && h.includes(tok)));
  });
}

function filtrarLibresBusquedaYDia(arr){
  const toks = SEARCH_LIBRES.tokens || [];
  const day  = FILTER_LIBRES.day || '';

  const base = day ? arr.filter(g => g.fechaInicio === day) : arr;

  if (!toks.length) return base;

  return base.filter(g=>{
    const hay = [
      norm(g.aliasGrupo),
      norm(g.nombreGrupo),
      norm('#'+(g.numeroNegocio||'')),
      norm(g.identificador),
      norm(g.programa),
      norm(g.destino),
      norm(g.id||''),
      norm(fmtDMY(g.fechaInicio)),
      norm(fmtDMY(g.fechaFin)),
      norm(g.fechaInicio),
      norm(g.fechaFin)
    ];
    return toks.every(tok => hay.some(h => h && h.includes(tok)));
  });
}

/* =========================================================
   BLOQUEO por confirmación (coordinadores ya en uso)
   ========================================================= */
function getBlockedCoordIds(exceptSetIdx = null){
  const blocked = new Set();
  SETS.forEach((s, idx)=>{
    if (s.confirmado && s.coordinadorId){
      if (exceptSetIdx !== null && idx === exceptSetIdx) return;
      blocked.add(s.coordinadorId);
    }
  });
  GRUPOS.forEach(g=>{
    if (g.conjuntoId && g.coordinadorId){
      if (exceptSetIdx!==null && SETS[exceptSetIdx]?.coordinadorId === g.coordinadorId) return;
      blocked.add(g.coordinadorId);
    }
  });
  L('Blocked coordIds (except', exceptSetIdx, '):', blocked.size);
  return blocked;
}

/* =========================================================
   Render
   ========================================================= */
function render(){
  console.time('render');
  sortSetsInPlace();
  renderResumen();
  renderLibres();
  renderSets();
  renderViajesStats();
  elMsg && (elMsg.textContent='');
  console.timeEnd('render');
}

function renderResumen(){
  console.groupCollapsed('renderResumen');
  const arr=gruposFiltrados(GRUPOS);
  L('Resumen sobre grupos filtrados:', arr.length, '(de', GRUPOS.length, ')');
  const by=(fn)=>arr.reduce((m,g)=>{ const k=fn(g)||'(sin dato)'; m[k]=(m[k]||0)+1; return m; },{});
  const tDest=by(g=>g.destino);
  const tProg=by(g=>g.programa);
  const tIniISO=by(g=>g.fechaInicio);
  const tIniDMY={}; Object.entries(tIniISO).forEach(([iso,c])=>{ tIniDMY[fmtDMY(iso)]=c; });

  const mk=(title,obj)=>`
    <div class="panel" style="min-width:260px">
      <div class="hd">${title}</div>
      <div class="bd">
        ${Object.keys(obj).length?`
        <table><thead><tr><th>Clave</th><th style="width:72px">Total</th></tr></thead>
        <tbody>${Object.entries(obj).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>
        `:`<div class="empty">Sin datos.</div>`}
      </div>
    </div>`;
  wrapResumen && (wrapResumen.innerHTML=`
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${mk('Por destino',tDest)}
      ${mk('Por fecha de inicio',tIniDMY)}
      ${mk('Por programa',tProg)}
    </div>`);
  console.groupEnd();
}

function viajesUsadosSetIds(){
  const s = new Set();
  SETS.forEach(x => (x?.viajes || []).forEach(id => s.add(id)));
  return s;
}

function renderLibres(){
  console.groupCollapsed('renderLibres');
  const usados=viajesUsadosSetIds();
  const libresAll=GRUPOS.filter(g=>!usados.has(g.id));
  // 1) Aplico catálogo (destino/programa/desde/hasta)
  const pre = gruposFiltrados(libresAll);
  // 2) Aplico búsqueda y día específico para LIBRES
  const libres = filtrarLibresBusquedaYDia(pre);
  L('Libres:', libres.length, 'Usados en sets:', usados.size, 'Grupos totales:', GRUPOS.length);
  if (!elWrapLibres){ W('elWrapLibres no existe'); console.groupEnd(); return; }
  if (!libres.length){ elWrapLibres.innerHTML='<div class="empty">No hay viajes libres.</div>'; console.groupEnd(); return; }
  elWrapLibres.innerHTML=libres.map(g=>`
    <div class="card">
      <div class="hd">
        <div><b title="${escapeHtml(g.nombreGrupo||'')}">${g.aliasGrupo||'(sin alias)'}</b> <span class="muted">#${g.numeroNegocio}</span></div>
        <button class="btn small" data-add="${g.id}">Agregar a viaje…</button>
      </div>
      <div class="bd">
        <div class="muted">
           ${fmtDMY(g.fechaInicio)} a ${fmtDMY(g.fechaFin)}
           ${g._horasInicio && (g._horasInicio.pres || g._horasInicio.inicio)
             ? ` · ${g._horasInicio.pres ? 'Pres ' + g._horasInicio.pres : ''}${(g._horasInicio.pres && g._horasInicio.inicio)?' · ':''}${g._horasInicio.inicio ? 'Salida ' + g._horasInicio.inicio : ''}`
             : ''}
         </div>
        <div class="muted">${g.identificador?`ID: ${escapeHtml(g.identificador)} · `:''}${g.programa?`Prog: ${escapeHtml(g.programa)} · `:''}${g.destino?`Dest: ${escapeHtml(g.destino)}`:''}</div>
      </div>
    </div>`).join('');
  elWrapLibres.querySelectorAll('button[data-add]').forEach(b=> b.onclick=()=>seleccionarConjuntoDestino(b.dataset.add));
  console.groupEnd();
}

function renderSets(){
  console.groupCollapsed('renderSets');
  if (!elWrapSets){ W('elWrapSets no existe'); console.groupEnd(); return; }
  const list = setsFiltrados(SETS);
  L('SETS visibles:', list.length, 'SETS totales:', SETS.length);
  if (!list.length){ elWrapSets.innerHTML='<div class="empty">Sin viajes asignados (sin resultados en la búsqueda).</div>'; console.groupEnd(); return; }

  elWrapSets.innerHTML='';
  list.forEach((s)=>{
    const idx = SETS.indexOf(s);
    const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
    const setDestinos = [...new Set(viajes.map(v=>normDest(v.destino)).filter(Boolean))];

    const rows=viajes.map(v=>`
      <tr>
        <td style="width:36%"><input type="text" data-alias="${v.id}" value="${v.aliasGrupo||''}" title="${escapeHtml(v.nombreGrupo||'')}"></td>
        <td style="width:24%">
           ${fmtDMY(v.fechaInicio)} → ${fmtDMY(v.fechaFin)}
           ${v._horasInicio && (v._horasInicio.pres || v._horasInicio.inicio)
             ? `<div class="muted" style="margin-top:.2rem">
                  ${v._horasInicio.pres ? 'Pres ' + v._horasInicio.pres : ''}
                  ${(v._horasInicio.pres && v._horasInicio.inicio)?' · ':''}
                  ${v._horasInicio.inicio ? 'Salida ' + v._horasInicio.inicio : ''}
                </div>`
             : ''}
         </td>
        <td style="width:40%">
          <div class="muted">#${v.numeroNegocio}</div>
          ${v.identificador?`<div class="muted">ID: ${escapeHtml(v.identificador)}</div>`:''}
          ${v.programa?`<div class="muted">Programa: ${escapeHtml(v.programa)}</div>`:''}
          ${v.destino?`<div class="muted">Destino: ${escapeHtml(v.destino)}</div>`:''}
        </td>
      </tr>
      <tr><td colspan="3">
        <div class="row">
          <button class="btn small" data-swap="${v.id}" data-set="${idx}">Swap</button>
          <button class="btn small" data-move="${v.id}" data-set="${idx}">Mover…</button>
          <button class="btn small" data-del="${v.id}" data-set="${idx}">Quitar</button>
        </div>
      </td></tr>
    `).join('');

    const blocked = getBlockedCoordIds(idx);
    const opts=['<option value="">(Seleccionar)</option>'].concat(
      COORDS
        .slice()
        .sort((a,b)=>(a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}))
        .filter(c => !blocked.has(c.id) || c.id===s.coordinadorId)
        .map(c=>{
          const apto = setDestinos.every(d => isAptoDestino(c, d));
          const name = escapeHtml(c.nombre||'(sin nombre)') + (apto ? '' : ' (NO APTO)');
          const sel  = (s.coordinadorId===c.id)?'selected':'';
          return `<option value="${c.id}" ${sel}>${name}</option>`;
        })
    ).join('');

    const alertas=s.alertas||[];
    const alertHtml = alertas.length
      ? `<div>${alertas.map(a=>`<div class="${a.tipo==='err'?'err':'warn'}">• ${a.msg}</div>`).join('')}</div>`
      : '<div class="muted">Sin alertas.</div>';

    elWrapSets.insertAdjacentHTML('beforeend',`
      <div class="card">
        <div class="hd">
          <div class="row">
            <span class="tag">VIAJES ${idx+1}</span>
            ${s._isNew?'<span class="pill">Nuevo</span>':''}
            ${s.confirmado?'<span class="pill">Confirmado</span>':''}
          </div>
          <div class="row">
            <select data-coord="${idx}" title="Coordinador del viaje">${opts}</select>
            <button class="btn small" data-addv="${idx}">Agregar viaje</button>
            <button class="btn small" data-sugerirc="${idx}">Sugerir coord</button>
            <button class="btn small ${s.confirmado?'secondary':''}" data-confirm="${idx}">${s.confirmado?'Desconfirmar':'Confirmar'}</button>
            <button class="btn small" data-saveone="${idx}">💾 Guardar</button>
            <button class="btn small" data-delset="${idx}">Eliminar</button>
          </div>
        </div>
        <div class="bd">
          ${viajes.length?`
            <table>
              <thead><tr><th>Alias</th><th>Fechas</th><th>Info</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>`:`<div class="empty">Sin viajes en este grupo.</div>`}
          <div style="margin-top:.5rem">${alertHtml}</div>
        </div>
      </div>`);
  });

  elWrapSets.querySelectorAll('input[data-alias]').forEach(inp=>{
    inp.onchange=()=>{ const g=ID2GRUPO.get(inp.dataset.alias); if(g){ g.aliasGrupo=inp.value; } };
  });
  elWrapSets.querySelectorAll('button[data-del]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.set;   SETS[i].viajes = SETS[i].viajes.filter(id => id !== btn.dataset.del); refreshSets(); };
  });
  elWrapSets.querySelectorAll('button[data-move]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.set; moverViajeAotroConjunto(btn.dataset.move,i); };
  });
  elWrapSets.querySelectorAll('button[data-addv]').forEach(btn=>{
    btn.onclick=()=>agregarViajeAConjunto(+btn.dataset.addv);
  });
  elWrapSets.querySelectorAll('button[data-delset]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.delset; if(!confirm('¿Eliminar este grupo de viajes?'))return; SETS.splice(i,1); refreshSets(); };
  });
  elWrapSets.querySelectorAll('button[data-sugerirc]').forEach(btn=>{
    btn.onclick=()=>sugerirCoordinador(+btn.dataset.sugerirc);
  });
  elWrapSets.querySelectorAll('button[data-confirm]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.confirm; SETS[i].confirmado=!SETS[i].confirmado; refreshSets(); };
  });
  elWrapSets.querySelectorAll('select[data-coord]').forEach(sel=>{
    sel.onchange=()=>{ const i=+sel.dataset.coord; SETS[i].coordinadorId = sel.value||null; refreshSets(); };
  });

  elWrapSets.querySelectorAll('button[data-swap]').forEach(btn=>{
    btn.onclick=()=>{ const setIdx=+btn.dataset.set; const gid=btn.dataset.swap; handleSwapClick(setIdx,gid,btn); };
  });

  elWrapSets.querySelectorAll('button[data-saveone]').forEach(btn=>{
    btn.onclick = () => guardarSet(+btn.dataset.saveone);
  });


  document.body.addEventListener('click', e=>{
    if (!e.target.closest('button[data-swap]')){
      swapMode=false; swapFirst=null;
      elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap'));
    }
  }, true);
  console.groupEnd();
}

/* =========================================================
   Sugeridor (respeta confirmados memoria + persistido)
   ========================================================= */
function sugerirConjuntos(){
  console.groupCollapsed('sugerirConjuntos');
  const fixedSetsMem = SETS.filter(s => s.confirmado && !!s.coordinadorId);
  const fixedTripIds = new Set();
  fixedSetsMem.forEach(s => (s.viajes||[]).forEach(id => fixedTripIds.add(id)));
  L('Fijos en memoria:', fixedSetsMem.length);

  const mapConjunto = new Map();
  for (const g of GRUPOS){
    if (g.conjuntoId && g.coordinadorId){
      if (!mapConjunto.has(g.conjuntoId)){
        mapConjunto.set(g.conjuntoId, { id:g.conjuntoId, viajes:[], coordinadorId:g.coordinadorId, confirmado:true, alertas:[] });
      }
      mapConjunto.get(g.conjuntoId).viajes.push(g.id);
    }
  }
  const fixedFromGrupos = Array.from(mapConjunto.values());
  const fixedFromGruposFiltered = fixedFromGrupos.filter(fs => !fs.viajes.some(id => fixedTripIds.has(id)));
  L('Fijos persistidos:', fixedFromGrupos.length, 'Usables:', fixedFromGruposFiltered.length);

  fixedFromGruposFiltered.forEach(fs => fs.viajes.forEach(id => fixedTripIds.add(id)));
  const pool = GRUPOS
    .filter(g => !fixedTripIds.has(g.id))
    .sort((a,b) => cmpISO(a.fechaInicio, b.fechaInicio));
  L('Pool para sugerir:', pool.length);

  const work = [];
  for (const g of pool){
    let best = -1;
    let bestAvail = null;
    for (let i=0;i<work.length;i++){
      const s = work[i];
      const gap = gapDays(s.lastFin, g.fechaInicio);
      const ok = (gap >= 1) || (gap === 0 && s.zeroChain < 2);
      if (!ok) continue;
      const avail = addDaysISO(s.lastFin, 1);
      if (best===-1 || cmpISO(avail, bestAvail) < 0){ best = i; bestAvail = avail; }
    }
    if (best === -1){
      work.push({ viajes:[g.id], lastFin:g.fechaFin, zeroChain:0 });
    } else {
      const s = work[best];
      const gap = gapDays(s.lastFin, g.fechaInicio);
      s.viajes.push(g.id);
      s.zeroChain = (gap === 0) ? s.zeroChain + 1 : 0;
      s.lastFin = g.fechaFin;
    }
  }

  const suggested = work.map(() => ({ viajes:[], coordinadorId:null, confirmado:false, alertas:[], _isNew:true }));
  for (let i=0;i<work.length;i++){ suggested[i].viajes = work[i].viajes.slice(); }
  SETS = fixedSetsMem.concat(fixedFromGruposFiltered).concat(suggested);

  L('Sugerencias generadas:', suggested.length, 'SETS total ahora:', SETS.length);
  dedupeSetsInPlace();
  sortSetsInPlace();
  render();
  console.groupEnd();
}

/* =========================================================
   Unicidad: cada viaje puede estar en un único conjunto
   ========================================================= */
function dedupeSetsInPlace() {
  const owner = new Map();
  for (let i = 0; i < SETS.length; i++) {
    const orig = Array.isArray(SETS[i].viajes) ? SETS[i].viajes : [];
    const uniq = [];
    for (const gid of orig) {
      if (!ID2GRUPO.has(gid)) continue;
      if (!owner.has(gid)) {
        owner.set(gid, i);
        uniq.push(gid);
      }
    }
    SETS[i].viajes = uniq;
  }
  L('dedupeSetsInPlace: owner size', owner.size);
}

function refreshSets() {
  L('refreshSets()');
  dedupeSetsInPlace();
  sortSetsInPlace();
  render();
}


/* =========================================================
   Alertas / Consistencia (incluye aptitud destinos)
   ========================================================= */
function evaluarAlertas(){
  console.groupCollapsed('evaluarAlertas');
  SETS.forEach(s=> s.alertas=[]);
  SETS.forEach(s=>{
    const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean).sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));
    s.viajes=viajes.map(v=>v.id);
    let consec=0;
    for (let i=0;i<viajes.length-1;i++){
      const A=viajes[i], B=viajes[i+1];
      if (overlap(A.fechaInicio,A.fechaFin,B.fechaInicio,B.fechaFin)) s.alertas.push({tipo:'err', msg:`Solape entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      const gap=gapDays(A.fechaFin,B.fechaInicio);
      if (gap<0) s.alertas.push({tipo:'err', msg:`Orden inconsistente entre ${A.aliasGrupo||A.nombreGrupo} y ${B.aliasGrupo||B.nombreGrupo}`});
      else if (gap===0) consec++; else consec=0;
      if (consec>=2) s.alertas.push({tipo:'warn', msg:`3 viajes seguidos sin día de descanso`});
    }

    if (s.coordinadorId){
      const c=COORDS.find(x=>x.id===s.coordinadorId);
      if (c){
        viajes.forEach(v=>{
          if (!inAnyRange(v.fechaInicio,v.fechaFin,c.disponibilidad||[])){
            s.alertas.push({tipo:'warn', msg:`Coordinador fuera de disponibilidad en ${v.aliasGrupo||v.nombreGrupo}`});
          }
        });
        if ((c.destinos||[]).length){
          viajes.forEach(v=>{
            const d = normDest(v.destino);
            if (d && !c.destinos.includes(d)){
              s.alertas.push({tipo:'warn', msg:`Coordinador no apto para destino ${d} en ${v.aliasGrupo||v.nombreGrupo}`});
            }
          });
        }
      }
    }
  });

  for (let i=0;i<SETS.length;i++){
    for (let j=i+1;j<SETS.length;j++){
      const A=SETS[i], B=SETS[j]; if (!A.coordinadorId || A.coordinadorId!==B.coordinadorId) continue;
      const va=A.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const vb=B.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
      const pisado=va.some(a=>vb.some(b=>overlap(a.fechaInicio,a.fechaFin,b.fechaInicio,b.fechaFin)));
      if (pisado){
        const name=(COORDS.find(c=>c.id===A.coordinadorId)?.nombre)||'(coordinador)';
        A.alertas.push({tipo:'err', msg:`${name} también asignado en Viajes ${j+1} con fechas que se cruzan`});
        B.alertas.push({tipo:'err', msg:`${name} también asignado en Viajes ${i+1} con fechas que se cruzan`});
      }
    }
  }
  L('evaluarAlertas: sets con alertas:',
    SETS.filter(s=> (s.alertas||[]).length).length);
  console.groupEnd();
}

/* =========================================================
   Acciones sobre viajes
   ========================================================= */
function seleccionarConjuntoDestino(grupoId){
  if (!SETS.length){ alert('Primero crea un grupo de viajes.'); return; }
  const n=prompt(`¿A qué grupo mover este viaje? (1..${SETS.length})`); if (!n) return;
  const idx=(+n)-1; if (idx<0||idx>=SETS.length){ alert('Número inválido'); return; }
  if (SETS.some(s=>s.viajes.includes(grupoId))) SETS.forEach(s=> s.viajes=s.viajes.filter(id=>id!==grupoId));
  SETS[idx].viajes.push(grupoId);
  refreshSets();
}
function moverViajeAotroConjunto(grupoId, desdeIdx){
  if (SETS.length<=1){ alert('No hay otro grupo.'); return; }
  const n=prompt(`Mover al grupo (1..${SETS.length}, distinto de ${desdeIdx+1})`); if(!n) return;
  const to=(+n)-1; if(to===desdeIdx||to<0||to>=SETS.length){ alert('Número inválido'); return; }
  SETS[desdeIdx].viajes = SETS[desdeIdx].viajes.filter(id=>id!==grupoId);
  SETS[to].viajes.push(grupoId);
  refreshSets();
}
function agregarViajeAConjunto(setIdx){
  const usados=viajesUsadosSetIds();
  const libresAll=GRUPOS.filter(g=>!usados.has(g.id));
  const libres=gruposFiltrados(libresAll);
  if (!libres.length){ alert('No quedan viajes libres con los filtros actuales.'); return; }
  const listado=libres.map((g,i)=>`${i+1}) ${g.aliasGrupo||g.nombreGrupo} [${fmtDMY(g.fechaInicio)}→${fmtDMY(g.fechaFin)}] • #${g.numeroNegocio} • ${g.programa||''} • ${g.destino||''}`).join('\n');
  const n=prompt(`Selecciona # de viaje a agregar (filtrado):\n${listado}`); if(!n) return;
  const i=(+n)-1; if(i<0||i>=libres.length) return;
  SETS[setIdx].viajes.push(libres[i].id);
  refreshSets();
}
function handleSwapClick(setIdx, grupoId, btn){
  if (!swapMode){ swapMode=true; swapFirst={setIdx,grupoId}; elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap')); btn.classList.add('selected-swap'); return; }
  if (swapFirst && (swapFirst.setIdx!==setIdx || swapFirst.grupoId!==grupoId)) swapBetweenSets(swapFirst,{setIdx,grupoId});
  swapMode=false; swapFirst=null; elWrapSets.querySelectorAll('button[data-swap].selected-swap').forEach(b=>b.classList.remove('selected-swap'));
}
function swapBetweenSets(a,b){
  SETS[a.setIdx].viajes=SETS[a.setIdx].viajes.filter(id=>id!==a.grupoId);
  SETS[b.setIdx].viajes=SETS[b.setIdx].viajes.filter(id=>id!==b.grupoId);
  SETS[a.setIdx].viajes.push(b.grupoId);
  SETS[b.setIdx].viajes.push(a.grupoId);
  refreshSets();
}

// Sugerir coordinador (filtra bloqueados, disponibilidad y aptitud por destino)
function sugerirCoordinador(setIdx){
  const s=SETS[setIdx];
  const viajes=s.viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
  const blocked = getBlockedCoordIds(setIdx);
  const destSet = [...new Set(viajes.map(v=>normDest(v.destino)).filter(Boolean))];

  const ok=COORDS.filter(c =>
    !blocked.has(c.id) &&
    viajes.every(v => inAnyRange(v.fechaInicio, v.fechaFin, c.disponibilidad||[])) &&
    destSet.every(d => isAptoDestino(c, d))
  );
  L('sugerirCoordinador: candidatos', ok.length, 'de', COORDS.length);
  if (!ok.length){ alert('No hay coordinadores disponibles (fechas/destinos) que cubran todo el grupo.'); return; }
  s.coordinadorId = ok[0].id;
  refreshSets();
}

/* =========================================================
   Guardado / IDs de coordinador
   ========================================================= */
function slugNombre(nombre){
  return (nombre||'')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80) || 'coord';
}
async function findCoordId({rut, nombre}) {
  if (rut){ const q1=query(collection(db,'coordinadores'), where('rut','==',rut)); const s1=await getDocs(q1); if(!s1.empty) return s1.docs[0].id; }
  if (nombre){ const q2=query(collection(db,'coordinadores'), where('nombre','==',nombre)); const s2=await getDocs(q2); if(!s2.empty) return s2.docs[0].id; }
  return null;
}
function cleanRanges(arr){
  return (arr||[])
    .map(r=>({ inicio: asISO(r.inicio)||asISO(r.inicioRaw)||null, fin: asISO(r.fin)||asISO(r.finRaw)||null }))
    .filter(r=>r.inicio && r.fin && (new Date(r.inicio)<=new Date(r.fin)));
}

// 💾 Guardar UNA fila de coordinador (con meta correcto)
async function saveOneCoord(i){
  const c = COORDS[i];
  const nombre=(c.nombre||'').trim();
  if (!nombre){ alert('Debe indicar nombre.'); return; }

  const base = {
    nombre,
    rut:(c.rut||'').replace(/\s+/g,'').toUpperCase(),
    telefono:(c.telefono||'').trim(),
    correo:(c.correo||'').trim().toLowerCase(),
    destinos: cleanDestinos(c.destinos),
    disponibilidad: cleanRanges(c.disponibilidad),
    activo:(c.activo!==false),
    notas:(c.notas||'').trim(),
  };

  let id = c.id || await findCoordId({ rut: base.rut, nombre: base.nombre });
  let isNew = false;

  if (!id){
    const wanted = slugNombre(base.nombre);
    const exists = await getDoc(doc(db,'coordinadores', wanted));
    id   = exists.exists() ? `${wanted}-${Date.now().toString(36).slice(-4)}` : wanted;
    isNew = true;
  }

  L('saveOneCoord:', { nombre: base.nombre, id, isNew });

  const ref = doc(db, 'coordinadores', id);
  await setDoc(
    ref,
    {
      ...base,
      meta: isNew
        ? { creadoEn: serverTimestamp(), actualizadoEn: serverTimestamp() }
        : { actualizadoEn: serverTimestamp() }
    },
    { merge: true }
  );

  c.id = id;
  delete c._isNew;
}

// Guardar todas las filas del modal
async function saveCoordsModal(){
  console.time('saveCoordsModal');
  for (let i=0;i<COORDS.length;i++){
    const c=COORDS[i];
    if (!c.nombre || !c.nombre.trim()) continue;
    await saveOneCoord(i);
  }
  await loadCoordinadores();
  closeModal(); render();
  console.timeEnd('saveCoordsModal');
}

/* =========================================================
   Estadísticas de viajes (sobre todos los SETS)
   ========================================================= */
function computeViajesStats(){
  const sizes = SETS.map(s => s.viajes?.length || 0);
  const totalGrupos = sizes.length;
  const totalTramos = sizes.reduce((a,b)=>a+b,0);
  const dist = {}; sizes.forEach(n => { dist[n] = (dist[n]||0) + 1; });

  let paresSinDescanso = 0,
      gruposConGap0   = 0,
      paresSolapados  = 0,
      paresOrdenMalo  = 0,
      gruposTodosDescanso = 0;

  let totalErr = 0, totalWarn = 0, confirmados = 0, conCoordinador = 0;
  const coordsAsignados = new Set();

  for (const s of SETS){
    const viajes = (s.viajes||[])
      .map(id => ID2GRUPO.get(id)).filter(Boolean)
      .sort((a,b)=>cmpISO(a.fechaInicio,b.fechaInicio));

    if (s.confirmado) confirmados++;
    if (s.coordinadorId){ conCoordinador++; coordsAsignados.add(s.coordinadorId); }
    (s.alertas||[]).forEach(a => (a.tipo==='err' ? totalErr++ : totalWarn++));
    let tuvo0 = false;
    let todosOK = true;

    for (let i=0;i<viajes.length-1;i++){
      const A = viajes[i], B = viajes[i+1];
      const gap = gapDays(A.fechaFin, B.fechaInicio);
      if (gap < 0) paresOrdenMalo++;
      if (gap === 0){ paresSinDescanso++; tuvo0 = true; }
      if (gap < 1) todosOK = false;
      if (overlap(A.fechaInicio,A.fechaFin,B.fechaInicio,B.fechaFin)) paresSolapados++;
    }
    if (tuvo0) gruposConGap0++;
    if (viajes.length >= 2 && todosOK) gruposTodosDescanso++;
  }

  const min = sizes.length ? Math.min(...sizes) : 0;
  const max = sizes.length ? Math.max(...sizes) : 0;
  const promedio = totalGrupos ? (totalTramos/totalGrupos) : 0;
  const mediana = (() => {
    if (!sizes.length) return 0;
    const s = sizes.slice().sort((a,b)=>a-b), m = Math.floor(s.length/2);
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
  })();

  return {
    totalGrupos,totalTramos,dist,min,max,promedio,mediana,
    paresSinDescanso,gruposConGap0,gruposTodosDescanso,
    paresSolapados,paresOrdenMalo,
    totalErr,totalWarn,confirmados,conCoordinador,
    coordsUnicos: coordsAsignados.size
  };
}

function renderViajesStats(){
  if (!wrapStats) return;
  if (!SETS.length){ wrapStats.innerHTML='<div class="empty">AÚN NO HAY GRUPOS DE VIAJES.</div>'; return; }
  const s=computeViajesStats();
  L('renderViajesStats:', s);

  const tbl=(title,rows)=>`<div class="panel" style="min-width:280px"><div class="hd">${title}</div><div class="bd">${rows}</div></div>`;
  const rowsKV=(kv)=>`<table><thead><tr><th>CLAVE</th><th style="width:90px">TOTAL</th></tr></thead><tbody>${Object.entries(kv).map(([k,v])=>`<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>`;

  const totales=`
    <table><tbody>
      <tr><th>TOTAL DE VIAJES (GRUPOS)</th><td>${s.totalGrupos}</td></tr>
      <tr><th>TOTAL DE TRAMOS (VIAJES ASIGNADOS)</th><td>${s.totalTramos}</td></tr>
      <tr><th>PROMEDIO TRAMOS POR VIAJE</th><td>${s.promedio.toFixed(2)}</td></tr>
      <tr><th>MEDIANA TRAMOS POR VIAJE</th><td>${s.mediana}</td></tr>
      <tr><th>MÁXIMO / MÍNIMO TRAMOS</th><td>${s.max} / ${s.min}</td></tr>
    </tbody></table>`;

  const distOrdenada=Object.fromEntries(
    Object.entries(s.dist).sort((a,b)=>Number(b[0])-Number(a[0])).map(([n,c])=>[`${n} TRAMO${n==1?'':'S'}`,c])
  );

  const consistencia=`
    <table><tbody>
      <tr><th>CAMBIOS DE VIAJE SIN DÍA LIBRE (0 DÍAS)</th><td>${s.paresSinDescanso}</td></tr>
      <tr><th>GRUPOS CON ALGÚN CAMBIO SIN DÍA LIBRE</th><td>${s.gruposConGap0}</td></tr>
      <tr><th>GRUPOS QUE RESPETAN 1+ DÍA LIBRE ENTRE TODOS SUS CAMBIOS</th><td>${s.gruposTodosDescanso}</td></tr>
      <tr><th>FECHAS QUE SE PISAN ENTRE VIAJES</th><td>${s.paresSolapados}</td></tr>
      <tr><th>FECHAS EN ORDEN INCORRECTO</th><td>${s.paresOrdenMalo}</td></tr>
      <tr><th>ALERTAS (ERRORES / AVISOS)</th><td>${s.totalErr} / ${s.totalWarn}</td></tr>
    </tbody></table>`;

  const asignaciones=`
    <table><tbody>
      <tr><th>VIAJES CONFIRMADOS</th><td>${s.confirmados}</td></tr>
      <tr><th>VIAJES CON COORDINADOR</th><td>${s.conCoordinador}</td></tr>
      <tr><th>COORDINADORES ÚNICOS ASIGNADOS</th><td>${s.coordsUnicos}</td></tr>
    </tbody></table>`;

  wrapStats.innerHTML=`
    <div class="row" style="gap:.8rem; align-items:flex-start; flex-wrap:wrap;">
      ${tbl('TOTALES',totales)}
      ${tbl('DISTRIBUCIÓN POR TAMAÑO (TRAMOS POR VIAJE)', rowsKV(distOrdenada))}
      ${tbl('CONSISTENCIA / ALERTAS', consistencia)}
      ${tbl('ASIGNACIONES', asignaciones)}
    </div>`;
}

/* =========================================================
   Modal coordinadores (con columna DESTINOS)
   ========================================================= */
function openModal(){ mb && (mb.style.display='block'); modal && (modal.style.display='flex'); }
function closeModal(){ if(modal) modal.style.display='none'; if(mb) mb.style.display='none'; }

function renderCoordsTable(){
  console.groupCollapsed('renderCoordsTable');
  if (!tbodyCoords){ W('tbodyCoords no existe'); console.groupEnd(); return; }
  tbodyCoords.innerHTML=''; hintEmptyCoords && (hintEmptyCoords.style.display=COORDS.length?'none':'block');

  const arr=COORDS.slice().sort((a,b)=> (!!a._isNew!==!!b._isNew) ? (a._isNew?-1:1) : (a.nombre||'').localeCompare(b.nombre||'','es',{sensitivity:'base'}));
  L('Filas visibles:', arr.length);

  arr.forEach((c,visibleIdx)=>{
    const i=COORDS.indexOf(c);

    const filas=(c.disponibilidad||[]).map((r,ri)=>`
      <div style="display:flex; gap:.3rem; align-items:center; margin:.15rem 0;">
        <input class="picker-range" data-cid="${i}" data-ridx="${ri}" type="text" value="${r.inicio && r.fin ? `${fmtDMY(r.inicio)} a ${fmtDMY(r.fin)}` : ''}" placeholder="dd/mm/aaaa a dd/mm/aaaa" readonly>
        <button class="btn small" data-delrng="${i}:${ri}">❌</button>
      </div>`).join('');

    const optsDest = DESTINOS.map(d=>{
      const sel = (c.destinos||[]).includes(d) ? 'selected' : '';
      return `<option value="${escapeHtml(d)}" ${sel}>${escapeHtml(d)}</option>`;
    }).join('');

    tbodyCoords.insertAdjacentHTML('beforeend',`
      <tr>
        <td style="text-align:center">${visibleIdx+1}</td>
        <td><input type="text" data-f="nombre"   data-i="${i}" value="${c.nombre||''}"   placeholder="Nombre"></td>
        <td><input type="text" data-f="rut"      data-i="${i}" value="${c.rut||''}"      placeholder="RUT"></td>
        <td><input type="text" data-f="telefono" data-i="${i}" value="${c.telefono||''}" placeholder="Teléfono"></td>
        <td><input type="text" data-f="correo"   data-i="${i}" value="${c.correo||''}"   placeholder="Correo"></td>

        <td>
          <select multiple size="3" class="sel-dest" data-i="${i}" style="min-width:180px">
            ${optsDest}
          </select>
          <div class="row" style="margin-top:.25rem">
            <input type="text" class="add-dest" data-i="${i}" placeholder="Agregar destino…" style="width:160px">
            <button class="btn small" data-adddest="${i}">+</button>
          </div>
          <div class="muted" style="margin-top:.25rem; font-size:.85em">(Vacío = apto para todos)</div>
        </td>

        <td>${filas}<button class="btn small" data-addrng="${i}">+ Rango</button></td>

        <td>
          <div class="row">
            <button class="btn small" data-saverc="${i}">💾 Guardar</button>
            <button class="btn small" data-delcoord="${i}">🗑️ Eliminar</button>
          </div>
        </td>
      </tr>`);
  });

  tbodyCoords.querySelectorAll('input[data-f]').forEach(inp=>{
    inp.onchange=()=>{ const i=+inp.dataset.i, f=inp.dataset.f; COORDS[i][f]=inp.value; };
  });

  tbodyCoords.querySelectorAll('select.sel-dest').forEach(sel=>{
    sel.onchange=()=>{
      const i=+sel.dataset.i;
      const selected=[...sel.selectedOptions].map(o=>normDest(o.value));
      COORDS[i].destinos = cleanDestinos(selected);
    };
  });

  tbodyCoords.querySelectorAll('button[data-adddest]').forEach(btn=>{
    btn.onclick=()=>{
      const i=+btn.dataset.adddest;
      const input = tbodyCoords.querySelector(`input.add-dest[data-i="${i}"]`);
      const val = normDest(input.value);
      if (!val) return;
      if (!DESTINOS.includes(val)) DESTINOS.push(val), DESTINOS.sort();
      COORDS[i].destinos = cleanDestinos([...(COORDS[i].destinos||[]), val]);
      renderCoordsTable(); setTimeout(initPickers,10);
    };
  });

  tbodyCoords.querySelectorAll('button[data-addrng]').forEach(btn=>{
    btn.onclick=()=>{ const i=+btn.dataset.addrng; COORDS[i].disponibilidad ||= []; COORDS[i].disponibilidad.push({inicio:'',fin:''}); renderCoordsTable(); setTimeout(initPickers,10); };
  });
  tbodyCoords.querySelectorAll('button[data-delrng]').forEach(btn=>{
    btn.onclick=()=>{ const [i,j]=btn.dataset.delrng.split(':').map(Number); COORDS[i].disponibilidad.splice(j,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });

  tbodyCoords.querySelectorAll('button[data-delcoord]').forEach(btn=>{
    btn.onclick=async()=>{ const i=+btn.dataset.delcoord; if (COORDS[i].id){ await deleteDoc(doc(db,'coordinadores',COORDS[i].id)); } COORDS.splice(i,1); renderCoordsTable(); setTimeout(initPickers,10); };
  });
  tbodyCoords.querySelectorAll('button[data-saverc]').forEach(btn=>{
    btn.onclick=async()=>{
      const i=+btn.dataset.saverc;
      btn.disabled=true; const prev=btn.textContent; btn.textContent='Guardando…';
      try{
        await saveOneCoord(i);
        btn.textContent='✅ Guardado';
        setTimeout(()=>{ btn.textContent=prev; btn.disabled=false; }, 900);
      }catch(e){
        E('saveOneCoord (fila) error:', e);
        btn.textContent='❌ Error';
        setTimeout(()=>{ btn.textContent=prev; btn.disabled=false; }, 1500);
      }
    };
  });

  initPickers();
  console.groupEnd();
}

function initPickers(){
  if (window.flatpickr && window.flatpickr.l10ns && window.flatpickr.l10ns.es){
    flatpickr.localize(flatpickr.l10ns.es);
  }
  tbodyCoords?.querySelectorAll('.picker-range')?.forEach(inp=>{
    if (inp._flatpickr) inp._flatpickr.destroy();
    flatpickr(inp, {
      mode:'range',
      dateFormat:'d/m/Y',
      allowInput:true,
      onClose:(dates)=>{
        if (dates.length===2){
          const inicio = toISO(dates[0]);
          const fin    = toISO(dates[1]);
          const i=+inp.dataset.cid, j=+inp.dataset.ridx;
          COORDS[i].disponibilidad[j]={inicio, fin};
          inp.value = `${fmtDMY(inicio)} a ${fmtDMY(fin)}`;
        }
      }
    });
  });
}

/* =========================================================
   Utils varios
   ========================================================= */
function limpiarAlias(nombreCompleto){
  return (nombreCompleto||'').replace(/\d{4}/g,'')
    .replace(/\b(colegio|instituto|escuela|curso|año|de|del|la|el|los)\b/gi,'')
    .replace(/[^\w\s]/g,'').replace(/\s+/g,' ').trim();
}
function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function sameArr(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* =========================================================
   Guardar CAMBIOS (persiste SOLO confirmados)
   ========================================================= */
async function guardarTodo(){
  console.time('guardarTodo[DIFF]');
  try{
    const nowTS = serverTimestamp();
    const ops = [];

    // Helper commit en chunks
    const commitOpsInChunks = async (ops, chunkSize = 450) => {
      for (let i = 0; i < ops.length; i += chunkSize) {
        const batch = writeBatch(db);
        const slice = ops.slice(i, i + chunkSize);
        slice.forEach(fn => fn(batch));
        await batch.commit();
      }
    };

    // 1) Alias de grupos: solo si cambió
    for (const g of GRUPOS){
      const prev = PREV.grupos.get(g.id) || {};
      const nowAlias = g.aliasGrupo || null;
      if ((prev.aliasGrupo || null) !== nowAlias){
        const gref = doc(db, 'grupos', g.id);
        ops.push(b => b.update(gref, { aliasGrupo: nowAlias }));
      }
    }

    // 2) SETS confirmados: crear/mover/borrar según diff
    const nowKeys = new Set();
    const touchedGroupIds = new Set();

    for (const s of SETS){
      const isOk = !!s.confirmado && !!s.coordinadorId;

      if (isOk){
        // ¿cambió de owner? borra doc viejo y fuerza id nuevo
        if (s.id && s._ownerCoordId && s._ownerCoordId !== s.coordinadorId){
          ops.push(b=> b.delete(doc(db,'coordinadores', s._ownerCoordId, 'conjuntos', s.id)));
          s.id = null;
        }
        if (!s.id){
          s.id = doc(collection(db,'coordinadores', s.coordinadorId, 'conjuntos')).id;
        }
        s._ownerCoordId = s.coordinadorId;

        const key = `${s._ownerCoordId}/${s.id}`;
        nowKeys.add(key);

        const prev = PREV.sets.get(key);
        const viajes = (s.viajes||[]).slice();
        const conjRef = doc(db,'coordinadores', s._ownerCoordId, 'conjuntos', s.id);

        if (!prev || !sameArr(prev.viajes, viajes) || !prev.confirmado){
          ops.push(b=> b.set(conjRef, {
            viajes, confirmado:true,
            meta: { actualizadoEn: nowTS, ...(s._isNew ? { creadoEn: nowTS } : {}) }
          }, { merge:true }));
        }

        const coordNombre = COORDS.find(c=>c.id===s.coordinadorId)?.nombre || null;
        for (const gid of viajes){
          const prevG = PREV.grupos.get(gid) || {};
          if (prevG.conjuntoId !== s.id || prevG.coordinadorId !== s.coordinadorId || prevG.coordinador !== coordNombre){
            ops.push(b=> b.update(doc(db,'grupos', gid), {
              conjuntoId: s.id,
              coordinador: coordNombre,
              coordinadorId: s.coordinadorId
            }));
          }
          touchedGroupIds.add(gid);
        }

        delete s._isNew;
      } else {
        // No confirmado: si existía antes, bórralo y limpia sus grupos actuales (si estaban marcados)
        const potentialOwner = s._ownerCoordId || s.coordinadorId || null;
        if (s.id && potentialOwner){
          const key = `${potentialOwner}/${s.id}`;
          if (PREV.sets.has(key)){
            ops.push(b=> b.delete(doc(db,'coordinadores', potentialOwner, 'conjuntos', s.id)));
          }
        }
        for (const gid of (s.viajes||[])){
          const prevG = PREV.grupos.get(gid) || {};
          if (prevG.conjuntoId){
            ops.push(b=> b.update(doc(db,'grupos', gid), {
              conjuntoId: null, coordinador: null, coordinadorId: null
            }));
          }
          touchedGroupIds.add(gid);
        }
      }
    }

    // 3) Borra conjuntos que existían y ahora no; y limpia grupos que estaban asignados antes pero ya no
    for (const [key, prevSet] of PREV.sets.entries()){
      if (!nowKeys.has(key)){
        ops.push(b=> b.delete(doc(db,'coordinadores', prevSet.owner, 'conjuntos', key.split('/')[1])));
      }
    }

    for (const [gid, prevG] of PREV.grupos.entries()){
      if (prevG.conjuntoId && !touchedGroupIds.has(gid)){
        ops.push(b=> b.update(doc(db,'grupos', gid), {
          conjuntoId: null, coordinador: null, coordinadorId: null
        }));
      }
    }

    L('guardarTodo[DIFF] ops =', ops.length);
    await commitOpsInChunks(ops, 450);

    // 4) Refresca snapshot PREV desde el estado actual en memoria
    PREV.grupos.clear();
    GRUPOS.forEach(g=>{
      PREV.grupos.set(g.id, {
        aliasGrupo   : g.aliasGrupo || null,
        conjuntoId   : g.conjuntoId || null,
        coordinadorId: g.coordinadorId || null,
        coordinador  : g.coordinador || null,
      });
    });
    PREV.sets.clear();
    SETS.forEach(s=>{
      const owner = s._ownerCoordId || s.coordinadorId || null;
      if (owner && s.id){
        PREV.sets.set(`${owner}/${s.id}`, {
          viajes:(s.viajes||[]).slice(), confirmado:!!s.confirmado, owner
        });
      }
    });

    L('guardarTodo[DIFF] OK');
  }catch(err){
    E('guardarTodo[DIFF] error:', err);
    throw err;
  }finally{
    console.timeEnd('guardarTodo[DIFF]');
  }
}

async function guardarSet(i){
  const s = SETS[i];
  if (!s) return;
  console.time(`guardarSet[${i}]`);
  try{
    const nowTS = serverTimestamp();
    const ops = [];
    const commit = async (ops)=> {
      const batch = writeBatch(db);
      ops.forEach(fn=>fn(batch));
      await batch.commit();
    };

    // Alias: solo de los grupos del set
    const viajes = (s.viajes||[]).slice();
    const gruposSet = viajes.map(id=>ID2GRUPO.get(id)).filter(Boolean);
    for (const g of gruposSet){
      const prev = PREV.grupos.get(g.id) || {};
      if ((prev.aliasGrupo||null) !== (g.aliasGrupo||null)){
        ops.push(b=> b.update(doc(db,'grupos', g.id), { aliasGrupo: g.aliasGrupo || null }));
      }
    }

    if (s.confirmado && s.coordinadorId){
      // mover/borrar por cambio de owner
      if (s.id && s._ownerCoordId && s._ownerCoordId !== s.coordinadorId){
        ops.push(b=> b.delete(doc(db,'coordinadores', s._ownerCoordId, 'conjuntos', s.id)));
        s.id = null;
      }
      if (!s.id){
        s.id = doc(collection(db,'coordinadores', s.coordinadorId, 'conjuntos')).id;
      }
      s._ownerCoordId = s.coordinadorId;

      const conjRef = doc(db,'coordinadores', s._ownerCoordId, 'conjuntos', s.id);
      const keyNow  = `${s._ownerCoordId}/${s.id}`;
      const prevSet = PREV.sets.get(keyNow);

      if (!prevSet || !sameArr(prevSet.viajes, viajes) || !prevSet.confirmado){
        ops.push(b=> b.set(conjRef, { viajes, confirmado:true, meta:{ actualizadoEn:nowTS } }, { merge:true }));
      }

      const coordNombre = COORDS.find(c=>c.id===s.coordinadorId)?.nombre || null;
      for (const gid of viajes){
        const prevG = PREV.grupos.get(gid)||{};
        if (prevG.conjuntoId !== s.id || prevG.coordinadorId !== s.coordinadorId || prevG.coordinador !== coordNombre){
          ops.push(b=> b.update(doc(db,'grupos', gid), {
            conjuntoId: s.id, coordinador: coordNombre, coordinadorId: s.coordinadorId
          }));
        }
      }

      // Limpia grupos que antes estaban en este mismo set y salieron
      if (prevSet){
        for (const gid of prevSet.viajes){
          if (!viajes.includes(gid)){
            ops.push(b=> b.update(doc(db,'grupos', gid), {
              conjuntoId:null, coordinador:null, coordinadorId:null
            }));
          }
        }
      }
    } else {
      // No confirmado: borra doc (si existía) y limpia sus grupos actuales si estaban marcados
      const owner = s._ownerCoordId || s.coordinadorId || null;
      if (s.id && owner){
        const key = `${owner}/${s.id}`;
        if (PREV.sets.has(key)){
          ops.push(b=> b.delete(doc(db,'coordinadores', owner, 'conjuntos', s.id)));
        }
      }
      for (const gid of viajes){
        const prevG = PREV.grupos.get(gid)||{};
        if (prevG.conjuntoId){
          ops.push(b=> b.update(doc(db,'grupos', gid), {
            conjuntoId:null, coordinador:null, coordinadorId:null
          }));
        }
      }
    }

    await commit(ops);

    // Refresca solo lo tocado en PREV
    gruposSet.forEach(g=>{
      const prev = PREV.grupos.get(g.id) || {};
      PREV.grupos.set(g.id, {
        aliasGrupo: g.aliasGrupo || null,
        // si se confirmó, queda marcado; si se desconfirmó y este set era el dueño previo, limpia
        conjuntoId: (s.confirmado && s.coordinadorId) ? s.id : (prev.conjuntoId === s.id ? null : prev.conjuntoId),
        coordinadorId: (s.confirmado && s.coordinadorId) ? s.coordinadorId : (prev.conjuntoId === s.id ? null : prev.coordinadorId),
        coordinador: (s.confirmado && s.coordinadorId) ? (COORDS.find(c=>c.id===s.coordinadorId)?.nombre||null) : (prev.conjuntoId === s.id ? null : prev.coordinador),
      });
    });
    if (s._ownerCoordId && s.id){
      PREV.sets.set(`${s._ownerCoordId}/${s.id}`, { viajes: (s.viajes||[]).slice(), confirmado: !!s.confirmado, owner: s._ownerCoordId });
    }

    console.log(`guardarSet[${i}] OK · ops=${ops.length}`);
  }catch(e){
    E(`guardarSet[${i}] error:`, e);
    alert('Error al guardar este grupo. Revisa la consola.');
  }finally{
    console.timeEnd(`guardarSet[${i}]`);
  }
}

/* =========================================================
   Carga por Excel (coordinadores)
   ========================================================= */
function handleExcel(evt){
  const file = evt.target.files?.[0];
  if(!file) return;

  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const wb = XLSX.read(e.target.result, { type:'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval:'', raw:false, blankrows:false });

      const byName = new Map(COORDS.map(c => [ (c.nombre||'').trim().toUpperCase(), c ]));
      const byRut  = new Map(COORDS.filter(c=>c.rut).map(c => [ c.rut.replace(/\s+/g,'').toUpperCase(), c ]));

      L('Excel filas:', rows.length);

      for(const r of rows){
        const nombre   = (r.Nombre || r.NOMBRE || r.nombre || '').toString().trim();
        if(!nombre) continue;
        const rut      = (r.RUT || r.rut || '').toString().replace(/\s+/g,'').toUpperCase();
        const telefono = (r.TELEFONO || r['TELÉFONO'] || r.tel || r.Tel || r.telefono || '').toString().trim();
        const correo   = (r.Correo || r.CORREO || r.Email || r.EMAIL || r.email || '').toString().trim().toLowerCase();
        const destinosCell = (r.Destinos || r.DESTINOS || r.destinos || '').toString();
        const destinosXLS  = cleanDestinos(destinosCell.split(','));

        let c = (rut && byRut.get(rut)) || byName.get(nombre.toUpperCase());
        if (c){
          c.nombre = nombre; c.rut = rut; c.telefono = telefono; c.correo = correo;
          if (destinosXLS.length){
            c.destinos = cleanDestinos([...(c.destinos||[]), ...destinosXLS]);
          }
        } else {
          c = { nombre, rut, telefono, correo, destinos:destinosXLS, disponibilidad:[], _isNew:true };
          COORDS.unshift(c);
          byName.set(nombre.toUpperCase(), c);
          if (rut) byRut.set(rut, c);
        }
      }

      renderCoordsTable();
      setTimeout(initPickers,10);
    } catch (err){
      E('handleExcel error:', err);
      alert('No se pudo leer el Excel. Asegúrate de que sea .xlsx/.xls y que tenga la columna "Nombre".');
    } finally {
      evt.target.value = '';
    }
  };
  reader.readAsBinaryString(file);
}


/* =========================================================
   Boot
   ========================================================= */
window.addEventListener('DOMContentLoaded', async ()=>{
  console.groupCollapsed('BOOT');
  try{
    console.time('BOOT');

    await loadCoordinadores();
    console.log('[RTV/coord] COORDS cargados =', COORDS.length);

    await loadGrupos();
    console.log('[RTV/coord] GRUPOS cargados =', GRUPOS.length,
                '| primeros ids =', GRUPOS.slice(0,5).map(g=>g.id));

    // NUEVO: Cargar horas por grupo desde 'vuelos'
    await loadHorasViajes();

    await loadSets();
    console.log('[RTV/coord] SETS construidos =', SETS.length);

    populateFilterOptions();
    render();

  }catch(err){
    console.error('[RTV/coord] BOOT error:', err);
  }finally{
    console.timeEnd('BOOT');
    console.groupEnd();
  }

  // 🔧 Ganchos de depuración desde la consola
  window.__dbg = {
    get sizes(){ return { coords: COORDS.length, grupos: GRUPOS.length, sets: SETS.length }; },
    COORDS, GRUPOS, SETS,
    reloadAll: async ()=>{
      await loadCoordinadores();
      await loadGrupos();
      await loadHorasViajes(); // ← NUEVO
      await loadSets();
      render();
      return { coords: COORDS.length, grupos: GRUPOS.length, sets: SETS.length };
    }
  };
});

/* =========================================================
   Probe directo a Firestore para "grupos"
   Llama:  await __probeGrupos()
   ========================================================= */
async function __probeGrupos(){
  try{
    console.time('__probeGrupos');
    const snap = await getDocs(collection(db,'grupos'));
    console.log('[RTV/coord] __probeGrupos size =', snap.size);
    snap.docs.slice(0,5).forEach(d=>{
      const x = d.data();
      console.log(' - id:', d.id, '| fechaInicio:', x.fechaInicio, '| fechaFin:', x.fechaFin, '| identificador:', x.identificador || x.codigo || x.codigoGrupo || '');
    });
  }catch(e){
    console.error('[RTV/coord] __probeGrupos error:', e);
  }finally{
    console.timeEnd('__probeGrupos');
  }
}
window.__probeGrupos = __probeGrupos;
