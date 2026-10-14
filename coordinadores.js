/* coordinadores.js — FINAL + LOGS
   Instrumentación:
   - DEBUG switch + helper L(), W(), E()
   - window.onerror / unhandledrejection
   - console.time* en cargas y render
   - groupCollapsed en pasos críticos
   - contadores y tamaños en cada fase
*/
import {
  crearAmpliacionCoordinadores,
  destinoCoord,
  DESTINOS_COORD
} from './coordinadores-ampliacion.js';

import { app, db } from './firebase-init.js';
import {
  collection, collectionGroup, getDocs, addDoc, doc, updateDoc, setDoc, deleteDoc,
  query, where, getDoc, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ===================== LOGGING ===================== */
const RT_COORD = crearAmpliacionCoordinadores({
  estado: () => ({
    ano: ANO_COORDINADORES,
    COORDS,
    GRUPOS,
    SETS,
    ID2GRUPO,
    PREV
  }),

  setAno: ano => {
    ANO_COORDINADORES = ano;
  },

  setGrupos: rows => {
    GRUPOS = rows;

    ID2GRUPO = new Map(
      rows.map(g => [g.id, g])
    );
  },

  setCoordinadores: rows => {
    COORDS = rows;
  },

  setSets: rows => {
    SETS = rows;
  },

  setHoras: mapa => {
    HORAS_INICIO = mapa;
  },

  setHoteles: (mapa, nombres) => {
    HOTELES_POR_GRUPO = mapa;
    HOTELS_BY_ID = nombres;
  },

  gruposFiltrados,

  refresh: () => refreshSets(),

  boot: () => __bootCoordinadores()
});

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

let HORAS_INICIO = new Map(); // groupId -> { pres:'HH:MM'|null, inicio:'HH:MM'|null, fuente:'aereo|terrestre', vueloId:string|null }

// Hoteles asignados por grupo (ya depurados sin solapes y tomando el último creado)
let HOTELES_POR_GRUPO = new Map(); // groupId -> [{ nombre, ini, fin }]

// Catálogo de hoteles: id → nombre (y otros datos si quisieras después)
let HOTELS_BY_ID = new Map(); // hotelId -> nombreHotel

/* =========================================================
   Año operativo de coordinadores
   ========================================================= */

function getAnoOperativoCoordinadores() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date());

  const ano = Number(
    partes.find(p => p.type === 'year')?.value
  );

  const mes = Number(
    partes.find(p => p.type === 'month')?.value
  );

  return mes >= 3 ? ano : ano - 1;
}

let ANO_COORDINADORES = getAnoOperativoCoordinadores();

function getAnoGrupo(g) {
  return Number(
    g?.anoViaje ??
    g?.anio ??
    g?.year ??
    0
  ) || null;
}

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

/* =========================================================
   Triestado aceptación del coordinador (SET-level)
   ========================================================= */
const ESTADO_VALUES = ['pendiente','aprobado','rechazado'];
const normalizeEstado = (v) => {
  const x = (v||'').toString().toLowerCase();
  return ESTADO_VALUES.includes(x) ? x : 'pendiente';
};
const nextEstado = (v) => {
  const i = ESTADO_VALUES.indexOf(normalizeEstado(v));
  return ESTADO_VALUES[(i+1) % ESTADO_VALUES.length];
};
const estadoIcon  = (v) => ({pendiente:'⏳', aprobado:'✅', rechazado:'⛔'})[normalizeEstado(v)];
const estadoLabel = v => ({
  pendiente: 'Pendiente',
  aprobado: 'Aceptado',
  rechazado: 'Rechazado'
})[normalizeEstado(v)];

function estadoBgStyle(est){
  const v = normalizeEstado(est);
  // verde suave (aprobado), amarillo suave (pendiente), rojo suave (rechazado)
  if (v === 'aprobado')  return 'background-color: rgba(16,185,129,.18)';   // green-500 @ ~18%
  if (v === 'rechazado') return 'background-color: rgba(239,68,68,.18)';    // red-500  @ ~18%
  return 'background-color: rgba(234,179,8,.22)';                           // amber-400 @ ~22% (pendiente)
}

function estadoClass(v){
  switch (normalizeEstado(v)) {
    case 'aprobado':  return 'estado-ok';
    case 'rechazado': return 'estado-bad';
    default:          return 'estado-pend';
  }
}

let swapMode  = false;
let swapFirst = null;

/* =========================================================
   AJUSTES MANUALES DE SUGERENCIA
   ========================================================= */

let ULTIMA_ESTRATEGIA_SUGERENCIA =
  null;


function normalizarAjusteSugerencia(
  valor
){
  const v =
    String(
      valor ||
      'normal'
    )
      .trim()
      .toLowerCase();


  if (
    [
      'normal',
      'cerrado',
      'abierto',
      'excluir'
    ].includes(
      v
    )
  ) {
    return v;
  }


  return 'normal';
}


function normalizarMaxAdicionales(
  valor
){
  const n =
    Number.parseInt(
      String(
        valor ??
        1
      ),
      10
    );


  if (
    !Number.isFinite(
      n
    )
  ) {
    return 1;
  }


  return Math.min(
    2,
    Math.max(
      1,
      n
    )
  );
}


/* =========================================================
   EJECUTAR UNA MODALIDAD
   ========================================================= */

function ejecutarEstrategiaSugerencia(
  estrategia
){
  ULTIMA_ESTRATEGIA_SUGERENCIA =
    estrategia;


  switch (
    estrategia
  ) {

    case 'continuidad':
      sugerirConjuntosContinuidad();
      break;


    case 'temporada':
      sugerirConjuntosTemporada();
      break;


    case 'temporada-pares':
      sugerirConjuntosTemporadaPares();
      break;


    default:
      W(
        'Estrategia de sugerencia desconocida:',
        estrategia
      );
  }
}


/* =========================================================
   RECALCULAR RESPETANDO AJUSTES
   ========================================================= */

function recalcularSugerenciaConAjustes(){
  if (
    !ULTIMA_ESTRATEGIA_SUGERENCIA
  ) {
    alert(
      'Primero genera una sugerencia para elegir la modalidad de trabajo.'
    );

    return;
  }


  ejecutarEstrategiaSugerencia(
    ULTIMA_ESTRATEGIA_SUGERENCIA
  );
}

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
const normDest = s =>
  s ? destinoCoord(s) : '';
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

// Resolver el ID real del grupo a partir de un grupoId que viene en hotelAssignments
function resolveGrupoIdFromHotelAssignment(rawGrupoId){
  const k = (rawGrupoId || '').toString().trim();
  if (!k) return null;

  // 1) Coincide con el ID del documento de grupos
  if (ID2GRUPO.has(k)) return k;

  // 2) Coincide con numeroNegocio del grupo
  const hit = GRUPOS.find(g => String(g.numeroNegocio || '').trim() === k);
  return hit ? hit.id : null;
}

/* =========================================================
   Carga Firestore
   ========================================================= */
async function loadCoordinadores() {
  await RT_COORD.loadCoordinadores();
}

async function loadGrupos() {
  await RT_COORD.loadGrupos();
}

async function loadHorasViajes() {
  await RT_COORD.loadHoras();
}

async function loadHotelAssignments() {
  await RT_COORD.loadHoteles();
}

async function loadSets() {
  await RT_COORD.loadSets();
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
$('#btn-sugerir')?.addEventListener(
  'click',
  abrirSelectorSugerencia
);

/* =========================================================
   BOTÓN RECALCULAR RESPETANDO AJUSTES
   ========================================================= */

function asegurarBotonRecalcularAjustes(){
  if (
    document.getElementById(
      'btn-recalcular-ajustes'
    )
  ) {
    return;
  }


  const btnSugerir =
    document.getElementById(
      'btn-sugerir'
    );


  if (!btnSugerir) {
    return;
  }


  const btn =
    document.createElement(
      'button'
    );


  btn.id =
    'btn-recalcular-ajustes';

  btn.type =
    'button';

  btn.className =
    'btn';

  btn.textContent =
    '🔄 Recalcular ajustes';

  btn.title =
    'Vuelve a calcular respetando grupos cerrados, abiertos y excluidos';


  btn.addEventListener(
    'click',
    recalcularSugerenciaConAjustes
  );


  btnSugerir.insertAdjacentElement(
    'afterend',
    btn
  );
}


asegurarBotonRecalcularAjustes();

$('#btn-nuevo-conjunto')?.addEventListener(
  'click',
  () => {
    L(
      'Nuevo conjunto',
      ANO_COORDINADORES
    );

    SETS.unshift({
      anoViaje:
        Number(
          ANO_COORDINADORES
        ),

      viajes:
        [],

      coordinadorId:
        null,

      confirmado:
        false,

      estadoCoord:
        'pendiente',

      alertas:
        [],

      _isNew:
        true
    });

    render();
  }
);
$('#btn-guardar')?.addEventListener('click', ()=>withBusy($('#btn-guardar'), 'Guardando…', guardarTodo, 'Guardar cambios', '✅ Guardado'));

// Modal handlers
btnOpenModal?.addEventListener('click', ()=>{ openModal(); renderCoordsTable(); });
btnCloseModal?.addEventListener('click', closeModal);
btnCerrar?.addEventListener('click', closeModal);
btnGuardarCoords?.addEventListener('click', ()=>withBusy(btnGuardarCoords, 'Guardando…', saveCoordsModal, 'Guardar coordinadores', '✅ Guardado'));
btnAddCoord?.addEventListener('click', ()=>{
   COORDS.unshift({
     nombre:'', rut:'',
     fechaNacimiento: null,
   
     // ← NUEVO
     datosTransferir: '',
   
     telefono:'', correo:'',
     destinos:[], disponibilidad:[],
     _isNew:true
   });

  renderCoordsTable(); setTimeout(initPickers,10);
});
btnAddLote?.addEventListener('click', ()=> inputExcel.click());
inputExcel?.addEventListener('change', handleExcel);

/* =========================================================
   EXCEL COORDINADORES
   ========================================================= */

function asegurarBotonExportExcelCoordinadores(){
  if (
    document.getElementById(
      'btn-exportar-coordinadores-excel'
    )
  ) {
    return;
  }

  if (!btnAddLote) {
    W(
      'No se encontró btn-add-lote para ubicar el botón Excel.'
    );

    return;
  }

  const btn =
    document.createElement(
      'button'
    );

  btn.id =
    'btn-exportar-coordinadores-excel';

  btn.type =
    'button';

  btn.className =
    'btn';

  btn.textContent =
    '📥 Descargar Excel';

  btn.title =
    'Descargar coordinadores, planificación, viajes y resumen';

  btn.addEventListener(
    'click',
    exportarGestionCoordinadoresExcel
  );

  btnAddLote.insertAdjacentElement(
    'afterend',
    btn
  );
}


asegurarBotonExportExcelCoordinadores();

// Filtros (catálogo)
function populateFilterOptions() {
  DESTINOS = DESTINOS_COORD.slice();

  if (selDestino) {
    selDestino.innerHTML =
      '<option value="">Todos los destinos</option>' +
      DESTINOS.map(d =>
        `<option value="${d}">${d}</option>`
      ).join('');

    selDestino.value = FILTER.destino;

    selDestino.onchange = () => {
      FILTER.destino = selDestino.value;
      render();
    };
  }

  FILTER.programa = '';

  if (selPrograma) {
    selPrograma.hidden = true;
  }

  if (inpDesde) {
    inpDesde.onchange = () => {
      FILTER.desde = inpDesde.value || '';
      render();
    };
  }

  if (inpHasta) {
    inpHasta.onchange = () => {
      FILTER.hasta = inpHasta.value || '';
      render();
    };
  }

  if (inpDiaSets) {
    inpDiaSets.onchange = () => {
      FILTER_SETS.day = inpDiaSets.value || '';
      render();
    };
  }

  if (inpBuscarLibres) {
    inpBuscarLibres.oninput = () => {
      SEARCH_LIBRES.tokens =
        parseTokens(inpBuscarLibres.value);

      renderLibres();
    };
  }

  if (inpDiaLibres) {
    inpDiaLibres.onchange = () => {
      FILTER_LIBRES.day =
        inpDiaLibres.value || '';

      renderLibres();
    };
  }

  if (inpBuscarSets) {
    inpBuscarSets.oninput = () => {
      SEARCH.tokens =
        parseTokens(inpBuscarSets.value);

      renderSets();
    };
  }
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

function gruposFiltrados(arr = GRUPOS) {
  return arr.filter(g => {
    if (
      FILTER.destino &&
      destinoCoord(g.destino) !== FILTER.destino
    ) {
      return false;
    }

    if (
      FILTER.desde &&
      g.fechaInicio < FILTER.desde
    ) {
      return false;
    }

    if (
      FILTER.hasta &&
      g.fechaInicio > FILTER.hasta
    ) {
      return false;
    }

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
function getBlockedCoordIds() {
  // Permite revisar la ficha de todas las personas.
  // Los conflictos se muestran como alertas.
  return new Set();
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

function renderResumen() {
  RT_COORD.resumen();
}

function viajesUsadosSetIds(){
  const conteo =
    new Map();


  SETS.forEach(s => {
    const vistosSet =
      new Set();

    (
      s.viajes ||
      []
    ).forEach(gid => {
      if (
        vistosSet.has(
          gid
        )
      ) {
        return;
      }

      vistosSet.add(
        gid
      );

      conteo.set(
        gid,
        (
          conteo.get(gid) ||
          0
        ) + 1
      );
    });
  });


  const completos =
    new Set();


  for (
    const g
    of GRUPOS
  ) {
    const usados =
      conteo.get(
        g.id
      ) ||
      0;

    const requeridos =
      getCantidadCoordinadoresGrupo(
        g
      );


    if (
      usados >=
      requeridos
    ) {
      completos.add(
        g.id
      );
    }
  }


  return completos;
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
  
  if (!libres.length){
    elWrapLibres.innerHTML = '<div class="empty">No hay viajes libres.</div>';
    console.groupEnd();
    return;
  }

  elWrapLibres.innerHTML = libres.map(g=>`
    <div class="card">
      <div class="hd">
        <div>
          <b title="${escapeHtml(g.nombreGrupo||'')}">
            ${g.aliasGrupo || '(sin alias)'}
          </b>
          <span class="muted">#${g.numeroNegocio}</span>
        </div>
        <button class="btn small" data-add="${g.id}">Agregar a viaje…</button>
      </div>
      <div class="bd">
        <div class="muted">
           ${fmtDMY(g.fechaInicio)} a ${fmtDMY(g.fechaFin)}
           ${g._horasInicio && (g._horasInicio.pres || g._horasInicio.inicio)
             ? ` · ${g._horasInicio.pres ? 'Pres ' + g._horasInicio.pres : ''}${(g._horasInicio.pres && g._horasInicio.inicio)?' · ':''}${g._horasInicio.inicio ? 'Salida ' + g._horasInicio.inicio : ''}`
             : ''}
        </div>
        <div class="muted">
          ${g.identificador?`ID: ${escapeHtml(g.identificador)} · `:''}
          ${g.programa?`Prog: ${escapeHtml(g.programa)} · `:''}
          ${g.destino?`Dest: ${escapeHtml(g.destino)}`:''}
        </div>
        ${getHotelResumenHtmlForGroup(g)}
      </div>
    </div>`).join('');

  elWrapLibres.querySelectorAll('button[data-add]').forEach(b=> b.onclick=()=>seleccionarConjuntoDestino(b.dataset.add));
  console.groupEnd();
}

function renderSets(){
  console.groupCollapsed(
    'renderSets'
  );


  if (
    !elWrapSets
  ) {
    W(
      'elWrapSets no existe'
    );

    console.groupEnd();

    return;
  }


  const list =
    setsFiltrados(
      SETS
    );


  L(
    'SETS visibles:',
    list.length,
    'SETS totales:',
    SETS.length
  );


  if (
    !list.length
  ) {
    elWrapSets.innerHTML =
      '<div class="empty">Sin viajes asignados (sin resultados en la búsqueda).</div>';

    console.groupEnd();

    return;
  }


  elWrapSets.innerHTML =
    '';


  list.forEach(
    s => {
      const idx =
        SETS.indexOf(
          s
        );


      const viajes =
        (
          s.viajes ||
          []
        )
          .map(
            id =>
              ID2GRUPO.get(
                String(
                  id
                )
              )
          )
          .filter(
            Boolean
          );


      const setDestinos =
        [
          ...new Set(
            viajes
              .map(
                v =>
                  normDest(
                    v.destino
                  )
              )
              .filter(
                Boolean
              )
          )
        ];


      // ===================================================
      // FILAS DE VIAJES
      // ===================================================

      const rows =
        viajes
          .map(
            v => {
              const cobertura =
                getCoberturaGrupo(
                  v.id
                );


              return `
                <tr>

                  <td style="width:36%">
                    <input
                      type="text"
                      class="${estadoClass(s.estadoCoord)}"
                      data-alias="${v.id}"
                      value="${escapeHtml(v.aliasGrupo || '')}"
                      title="${escapeHtml(v.nombreGrupo || '')}"
                    >
                  </td>


                  <td style="width:24%">
                    ${fmtDMY(v.fechaInicio)}
                    →
                    ${fmtDMY(v.fechaFin)}

                    ${
                      v._horasInicio &&
                      (
                        v._horasInicio.pres ||
                        v._horasInicio.inicio
                      )
                        ? `
                          <div
                            class="muted"
                            style="margin-top:.2rem"
                          >
                            ${
                              v._horasInicio.pres
                                ? `Pres ${v._horasInicio.pres}`
                                : ''
                            }

                            ${
                              (
                                v._horasInicio.pres &&
                                v._horasInicio.inicio
                              )
                                ? ' · '
                                : ''
                            }

                            ${
                              v._horasInicio.inicio
                                ? `Salida ${v._horasInicio.inicio}`
                                : ''
                            }
                          </div>
                        `
                        : ''
                    }
                  </td>


                  <td style="width:40%">

                    <div class="muted">
                      #${escapeHtml(v.numeroNegocio || '')}
                    </div>

                    ${
                      v.identificador
                        ? `
                          <div class="muted">
                            ID:
                            ${escapeHtml(v.identificador)}
                          </div>
                        `
                        : ''
                    }

                    ${
                      v.programa
                        ? `
                          <div class="muted">
                            Programa:
                            ${escapeHtml(v.programa)}
                          </div>
                        `
                        : ''
                    }

                    ${
                      v.destino
                        ? `
                          <div class="muted">
                            Destino:
                            ${escapeHtml(v.destino)}
                          </div>
                        `
                        : ''
                    }


                    <div
                      class="muted"
                      style="
                        margin-top:.25rem;
                        font-weight:600;
                      "
                    >
                      Coordinadores:
                      ${cobertura.usados}/${cobertura.requeridos}

                      ${
                        cobertura.confirmados
                          ? `
                            ·
                            ${cobertura.confirmados}
                            confirmado${
                              cobertura.confirmados === 1
                                ? ''
                                : 's'
                            }
                          `
                          : ''
                      }
                    </div>


                    ${getHotelResumenHtmlForGroup(v)}

                  </td>

                </tr>


                <tr>
                  <td colspan="3">

                    <div class="row">

                      <button
                        class="btn small"
                        data-swap="${v.id}"
                        data-set="${idx}"
                      >
                        Swap
                      </button>


                      <button
                        class="btn small"
                        data-move="${v.id}"
                        data-set="${idx}"
                      >
                        Mover…
                      </button>


                      <button
                        class="btn small"
                        data-del="${v.id}"
                        data-set="${idx}"
                      >
                        Quitar
                      </button>

                    </div>

                  </td>
                </tr>
              `;
            }
          )
          .join(
            ''
          );


      // ===================================================
      // COORDINADORES DISPONIBLES
      // ===================================================

      const blocked =
        getBlockedCoordIds(
          idx
        );


      const opts =
        [
          '<option value="">(Seleccionar)</option>'
        ]
          .concat(
            COORDS
              .slice()
              .sort(
                (
                  a,
                  b
                ) =>
                  (
                    a.nombre ||
                    ''
                  )
                    .localeCompare(
                      b.nombre ||
                      '',
                      'es',
                      {
                        sensitivity:
                          'base'
                      }
                    )
              )
              .filter(
                c =>
                  !blocked.has(
                    c.id
                  ) ||
                  c.id ===
                    s.coordinadorId
              )
              .map(
                c => {
                  const apto =
                    setDestinos.every(
                      d =>
                        isAptoDestino(
                          c,
                          d
                        )
                    );


                  const name =
                    escapeHtml(
                      c.nombre ||
                      '(sin nombre)'
                    ) +
                    (
                      apto
                        ? ''
                        : ' (NO APTO)'
                    );


                  const sel =
                    s.coordinadorId ===
                    c.id
                      ? 'selected'
                      : '';


                  return `
                    <option
                      value="${c.id}"
                      ${sel}
                    >
                      ${name}
                    </option>
                  `;
                }
              )
          )
          .join(
            ''
          );


      // ===================================================
      // ALERTAS
      // ===================================================

      const alertas =
        s.alertas ||
        [];


      const alertHtml =
        alertas.length
          ? `
            <div>
              ${
                alertas
                  .map(
                    a => `
                      <div
                        class="${
                          a.tipo === 'err'
                            ? 'err'
                            : 'warn'
                        }"
                      >
                        • ${escapeHtml(a.msg)}
                      </div>
                    `
                  )
                  .join(
                    ''
                  )
              }
            </div>
          `
          : `
            <div class="muted">
              Sin alertas.
            </div>
          `;


      // ===================================================
      // AJUSTE DE SUGERENCIA
      // ===================================================

      const ajuste =
        normalizarAjusteSugerencia(
          s.ajusteSugerencia
        );


      const maxAdicionales =
        normalizarMaxAdicionales(
          s.maxAdicionales
        );


      const controlesAjuste =
        !s.confirmado
          ? `
            <div
              class="row"
              style="
                margin-top:.35rem;
                gap:.35rem;
                align-items:center;
              "
            >

              <span
                class="muted"
                style="font-weight:600"
              >
                Recalcular:
              </span>


              <select
                data-ajuste-sugerencia="${idx}"
                title="Cómo debe tratar este grupo de viajes el próximo recálculo"
                style="
                  padding:5px 7px;
                  border:1px solid #cbd5e1;
                  border-radius:6px;
                  background:#fff;
                "
              >

                <option
                  value="normal"
                  ${
                    ajuste === 'normal'
                      ? 'selected'
                      : ''
                  }
                >
                  Normal
                </option>


                <option
                  value="cerrado"
                  ${
                    ajuste === 'cerrado'
                      ? 'selected'
                      : ''
                  }
                >
                  🔒 Cerrado
                </option>


                <option
                  value="abierto"
                  ${
                    ajuste === 'abierto'
                      ? 'selected'
                      : ''
                  }
                >
                  🔓 Abierto
                </option>


                <option
                  value="excluir"
                  ${
                    ajuste === 'excluir'
                      ? 'selected'
                      : ''
                  }
                >
                  ⛔ Excluir
                </option>

              </select>


              ${
                ajuste === 'abierto'
                  ? `
                    <span class="muted">
                      Puede sumar:
                    </span>


                    <select
                      data-max-adicionales="${idx}"
                      style="
                        padding:5px 7px;
                        border:1px solid #cbd5e1;
                        border-radius:6px;
                        background:#fff;
                      "
                    >

                      <option
                        value="1"
                        ${
                          maxAdicionales === 1
                            ? 'selected'
                            : ''
                        }
                      >
                        +1
                      </option>


                      <option
                        value="2"
                        ${
                          maxAdicionales === 2
                            ? 'selected'
                            : ''
                        }
                      >
                        +2
                      </option>

                    </select>
                  `
                  : ''
              }


              ${
                ajuste === 'cerrado'
                  ? `
                    <span class="muted">
                      Esta combinación no se modifica.
                    </span>
                  `
                  : ''
              }


              ${
                ajuste === 'excluir'
                  ? `
                    <span class="muted">
                      Estos viajes quedan fuera del próximo cálculo.
                    </span>
                  `
                  : ''
              }

            </div>
          `
          : '';


      // ===================================================
      // TARJETA
      // ===================================================

      elWrapSets.insertAdjacentHTML(
        'beforeend',
        `
          <div class="card">

            <div class="hd">

              <div>

                <div class="row">

                  <span class="tag">
                    VIAJES ${idx + 1}
                  </span>

                  ${
                    s._isNew
                      ? '<span class="pill">Nuevo</span>'
                      : ''
                  }

                  ${
                    s.confirmado
                      ? '<span class="pill">Confirmado</span>'
                      : ''
                  }

                  ${
                    ajuste === 'cerrado' &&
                    !s.confirmado
                      ? '<span class="pill">🔒 Cerrado</span>'
                      : ''
                  }

                  ${
                    ajuste === 'abierto' &&
                    !s.confirmado
                      ? '<span class="pill">🔓 Abierto</span>'
                      : ''
                  }

                  ${
                    ajuste === 'excluir' &&
                    !s.confirmado
                      ? '<span class="pill">⛔ Excluir</span>'
                      : ''
                  }

                </div>


                ${controlesAjuste}

              </div>


              <div class="row">

                <select
                  data-coord="${idx}"
                  title="Coordinador del viaje"
                  style="${estadoBgStyle(s.estadoCoord)}"
                >
                  ${opts}
                </select>


                <button
                  class="btn small"
                  data-addv="${idx}"
                >
                  Agregar viaje
                </button>


                <button
                  class="btn small"
                  data-sugerirc="${idx}"
                >
                  Sugerir coord
                </button>


                <button
                  class="btn small ${
                    s.confirmado
                      ? 'secondary'
                      : ''
                  }"
                  data-confirm="${idx}"
                >
                  ${
                    s.confirmado
                      ? 'Desconfirmar'
                      : 'Confirmar'
                  }
                </button>


                <button
                  class="btn small"
                  data-estado="${idx}"
                  title="Estado: ${estadoLabel(s.estadoCoord || 'pendiente')}"
                >
                  ${estadoIcon(s.estadoCoord || 'pendiente')}
                  ${estadoLabel(s.estadoCoord || 'pendiente')}
                </button>


                <button
                  class="btn small"
                  data-saveone="${idx}"
                >
                  💾 Guardar
                </button>


                <button
                  class="btn small"
                  data-delset="${idx}"
                >
                  Eliminar
                </button>

              </div>

            </div>


            <div class="bd">

              ${
                viajes.length
                  ? `
                    <table>

                      <thead>
                        <tr>
                          <th>Alias</th>
                          <th>Fechas</th>
                          <th>Info</th>
                        </tr>
                      </thead>

                      <tbody>
                        ${rows}
                      </tbody>

                    </table>
                  `
                  : `
                    <div class="empty">
                      Sin viajes en este grupo.
                    </div>
                  `
              }


              <div style="margin-top:.5rem">
                ${alertHtml}
              </div>

            </div>

          </div>
        `
      );
    }
  );


  // =======================================================
  // AJUSTES DE SUGERENCIA
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'select[data-ajuste-sugerencia]'
    )
    .forEach(
      sel => {
        sel.onchange =
          () => {
            const i =
              Number(
                sel.dataset.ajusteSugerencia
              );


            const s =
              SETS[i];


            if (!s) {
              return;
            }


            s.ajusteSugerencia =
              normalizarAjusteSugerencia(
                sel.value
              );


            if (
              s.ajusteSugerencia ===
                'abierto'
            ) {
              s.maxAdicionales =
                normalizarMaxAdicionales(
                  s.maxAdicionales ||
                  1
                );
            }


            // Solo redibujar.
            // NO recalcular todavía.
            renderSets();
          };
      }
    );


  elWrapSets
    .querySelectorAll(
      'select[data-max-adicionales]'
    )
    .forEach(
      sel => {
        sel.onchange =
          () => {
            const i =
              Number(
                sel.dataset.maxAdicionales
              );


            const s =
              SETS[i];


            if (!s) {
              return;
            }


            s.maxAdicionales =
              normalizarMaxAdicionales(
                sel.value
              );


            renderSets();
          };
      }
    );


  // =======================================================
  // ALIAS
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'input[data-alias]'
    )
    .forEach(
      inp => {
        inp.onchange =
          () => {
            const g =
              ID2GRUPO.get(
                inp.dataset.alias
              );


            if (g) {
              g.aliasGrupo =
                inp.value;
            }
          };
      }
    );


  // =======================================================
  // QUITAR VIAJE
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-del]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () => {
            const i =
              Number(
                btn.dataset.set
              );


            if (
              !SETS[i]
            ) {
              return;
            }


            SETS[i].viajes =
              (
                SETS[i].viajes ||
                []
              ).filter(
                id =>
                  String(
                    id
                  ) !==
                  String(
                    btn.dataset.del
                  )
              );


            SETS[i].estadoCoord =
              'pendiente';


            refreshSets();
          };
      }
    );


  // =======================================================
  // MOVER
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-move]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () => {
            const i =
              Number(
                btn.dataset.set
              );


            moverViajeAotroConjunto(
              btn.dataset.move,
              i
            );
          };
      }
    );


  // =======================================================
  // AGREGAR
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-addv]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () =>
            agregarViajeAConjunto(
              Number(
                btn.dataset.addv
              )
            );
      }
    );


  // =======================================================
  // ELIMINAR SET
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-delset]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () => {
            const i =
              Number(
                btn.dataset.delset
              );


            if (
              !confirm(
                '¿Eliminar este grupo de viajes?'
              )
            ) {
              return;
            }


            SETS.splice(
              i,
              1
            );


            refreshSets();
          };
      }
    );


  // =======================================================
  // SUGERIR COORDINADOR
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-sugerirc]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () =>
            sugerirCoordinador(
              Number(
                btn.dataset.sugerirc
              )
            );
      }
    );


  // =======================================================
  // CONFIRMAR
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-confirm]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () => {
            const i =
              Number(
                btn.dataset.confirm
              );


            const s =
              SETS[i];


            if (!s) {
              return;
            }


            const newVal =
              !s.confirmado;


            s.confirmado =
              newVal;


            if (
              !newVal
            ) {
              s.estadoCoord =
                'pendiente';

            } else {
              // Una vez confirmado deja de ser
              // un simple ajuste temporal.
              s.ajusteSugerencia =
                'normal';

              s.maxAdicionales =
                null;
            }


            refreshSets();
          };
      }
    );


  // =======================================================
  // COORDINADOR
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'select[data-coord]'
    )
    .forEach(
      sel => {
        sel.onchange =
          () => {
            const i =
              Number(
                sel.dataset.coord
              );


            const s =
              SETS[i];


            if (!s) {
              return;
            }


            s.coordinadorId =
              sel.value ||
              null;


            s.estadoCoord =
              'pendiente';


            refreshSets();
          };
      }
    );


  // =======================================================
  // SWAP
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-swap]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () => {
            const setIdx =
              Number(
                btn.dataset.set
              );


            const gid =
              btn.dataset.swap;


            handleSwapClick(
              setIdx,
              gid,
              btn
            );
          };
      }
    );


  // =======================================================
  // GUARDAR UNO
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-saveone]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () =>
            withBusy(
              btn,
              'Guardando…',
              () =>
                guardarSet(
                  Number(
                    btn.dataset.saveone
                  )
                ),
              '💾 Guardar',
              '✅ Guardado'
            );
      }
    );


  // =======================================================
  // ESTADO COORDINADOR
  // =======================================================

  elWrapSets
    .querySelectorAll(
      'button[data-estado]'
    )
    .forEach(
      btn => {
        btn.onclick =
          () => {
            const i =
              Number(
                btn.dataset.estado
              );


            const s =
              SETS[i];


            if (!s) {
              return;
            }


            s.estadoCoord =
              nextEstado(
                s.estadoCoord
              );


            refreshSets();
          };
      }
    );


  console.groupEnd();
}

/* =========================================================
   Sugeridor (respeta confirmados memoria + persistido)
   ========================================================= */
/* =========================================================
   SUGERIDORES DE GRUPOS DE VIAJE
   ========================================================= */


/* =========================================================
   SELECTOR DE ESTRATEGIA
   ========================================================= */

function abrirSelectorSugerencia(){
  document
    .getElementById(
      'modal-estrategia-sugerencia'
    )
    ?.remove();


  const overlay =
    document.createElement(
      'div'
    );


  overlay.id =
    'modal-estrategia-sugerencia';


  overlay.style.cssText = `
    position:fixed;
    inset:0;
    z-index:99999;
    background:rgba(15,23,42,.48);
    display:flex;
    align-items:center;
    justify-content:center;
    padding:20px;
  `;


  overlay.innerHTML = `
    <div
      style="
        width:min(680px, 100%);
        background:#fff;
        border-radius:14px;
        box-shadow:0 20px 60px rgba(0,0,0,.25);
        padding:20px;
      "
    >

      <div
        style="
          font-size:20px;
          font-weight:700;
          margin-bottom:6px;
        "
      >
        ¿Cómo quieres organizar los viajes?
      </div>


      <div
        style="
          color:#64748b;
          margin-bottom:18px;
          line-height:1.4;
        "
      >
        Elige la forma en que quieres que el sistema arme los grupos de viaje.
      </div>


      <div
        style="
          display:grid;
          gap:12px;
        "
      >

        <button
          type="button"
          data-estrategia="continuidad"
          style="
            text-align:left;
            padding:15px;
            border:1px solid #cbd5e1;
            border-radius:10px;
            background:#fff;
            cursor:pointer;
          "
        >
          <strong>
            Continuidad
          </strong>

          <div
            style="
              margin-top:4px;
              color:#64748b;
              font-size:13px;
              line-height:1.4;
            "
          >
            Agrupa viajes según las fechas para aprovechar al máximo cada coordinador.
          </div>
        </button>


        <button
          type="button"
          data-estrategia="temporada"
          style="
            text-align:left;
            padding:15px;
            border:1px solid #cbd5e1;
            border-radius:10px;
            background:#fff;
            cursor:pointer;
          "
        >
          <strong>
            Menos grupos
          </strong>

          <div
            style="
              margin-top:4px;
              color:#64748b;
              font-size:13px;
              line-height:1.4;
            "
          >
            Busca usar la menor cantidad posible de grupos de viaje. Puede asignar hasta 3 viajes cuando conviene.
          </div>
        </button>


        <button
          type="button"
          data-estrategia="temporada-pares"
          style="
            text-align:left;
            padding:15px;
            border:1px solid #cbd5e1;
            border-radius:10px;
            background:#fff;
            cursor:pointer;
          "
        >
          <strong>
            Grupos de 2
          </strong>

          <div
            style="
              margin-top:4px;
              color:#64748b;
              font-size:13px;
              line-height:1.4;
            "
          >
            Busca formar la mayor cantidad posible de grupos con 2 viajes. No crea grupos de 3.
          </div>
        </button>

      </div>


      <div
        style="
          display:flex;
          justify-content:flex-end;
          margin-top:16px;
        "
      >

        <button
          type="button"
          data-cerrar
          class="btn secondary"
        >
          Cancelar
        </button>

      </div>

    </div>
  `;


  document.body.appendChild(
    overlay
  );


  const cerrar =
    () => {
      overlay.remove();
    };


  // =====================================================
  // CERRAR
  // =====================================================

  overlay
    .querySelector(
      '[data-cerrar]'
    )
    ?.addEventListener(
      'click',
      cerrar
    );


  overlay.addEventListener(
    'click',
    e => {
      if (
        e.target === overlay
      ) {
        cerrar();
      }
    }
  );


  // =====================================================
  // CONTINUIDAD
  // =====================================================

  overlay
    .querySelector(
      '[data-estrategia="continuidad"]'
    )
    ?.addEventListener(
      'click',
      () => {
        cerrar();

        ejecutarEstrategiaSugerencia(
          'continuidad'
        );
      }
    );


  // =====================================================
  // MENOS GRUPOS
  // =====================================================

  overlay
    .querySelector(
      '[data-estrategia="temporada"]'
    )
    ?.addEventListener(
      'click',
      () => {
        cerrar();

        ejecutarEstrategiaSugerencia(
          'temporada'
        );
      }
    );


  // =====================================================
  // GRUPOS DE 2
  // =====================================================

  overlay
    .querySelector(
      '[data-estrategia="temporada-pares"]'
    )
    ?.addEventListener(
      'click',
      () => {
        cerrar();

        ejecutarEstrategiaSugerencia(
          'temporada-pares'
        );
      }
    );
}

/* =========================================================
   BASE PARA TODAS LAS SUGERENCIAS
   ========================================================= */

function obtenerBaseSugerencia(){

  // =====================================================
  // 1) SETS REALMENTE CONFIRMADOS
  // =====================================================

  const fixedSetsMem =
    SETS.filter(
      s =>
        s.confirmado &&
        !!s.coordinadorId
    );


  // =====================================================
  // 2) AJUSTES MANUALES
  // =====================================================

  const ajustesCerrados =
    [];

  const ajustesAbiertos =
    [];

  const ajustesExcluidos =
    [];

  const gruposExcluidos =
    new Set();


  for (
    const s
    of SETS
  ) {

    // Los confirmados reales
    // ya están protegidos arriba.
    if (
      s.confirmado &&
      s.coordinadorId
    ) {
      continue;
    }


    const ajuste =
      normalizarAjusteSugerencia(
        s.ajusteSugerencia
      );


    // ===================================================
    // EXCLUIR
    //
    // El SET permanece visible,
    // pero sus viajes NO participan en el recálculo.
    // ===================================================

    if (
      ajuste ===
      'excluir'
    ) {
      const viajes =
        [
          ...new Set(
            (
              s.viajes ||
              []
            )
              .map(String)
              .filter(
                gid =>
                  ID2GRUPO.has(
                    gid
                  )
              )
          )
        ];


      if (
        viajes.length
      ) {
        viajes.forEach(
          gid => {
            gruposExcluidos.add(
              gid
            );
          }
        );


        ajustesExcluidos.push({
          ...s,

          viajes,

          confirmado:
            false,

          ajusteSugerencia:
            'excluir',

          _ajusteManual:
            true
        });
      }


      continue;
    }


    // ===================================================
    // CERRADO
    // ===================================================

    if (
      ajuste ===
      'cerrado'
    ) {
      const viajes =
        [
          ...new Set(
            (
              s.viajes ||
              []
            )
              .map(String)
              .filter(
                gid =>
                  ID2GRUPO.has(
                    gid
                  )
              )
          )
        ];


      if (
        viajes.length
      ) {
        ajustesCerrados.push({
          ...s,

          viajes,

          confirmado:
            false,

          ajusteSugerencia:
            'cerrado',

          _ajusteManual:
            true
        });
      }


      continue;
    }


    // ===================================================
    // ABIERTO
    // ===================================================

    if (
      ajuste ===
      'abierto'
    ) {
      const viajes =
        [
          ...new Set(
            (
              s.viajes ||
              []
            )
              .map(String)
              .filter(
                gid =>
                  ID2GRUPO.has(
                    gid
                  )
              )
          )
        ];


      if (
        viajes.length
      ) {
        ajustesAbiertos.push({
          ...s,

          viajes,

          confirmado:
            false,

          ajusteSugerencia:
            'abierto',

          maxAdicionales:
            normalizarMaxAdicionales(
              s.maxAdicionales
            ),

          _ajusteManual:
            true
        });
      }


      continue;
    }
  }


  // =====================================================
  // 3) CONTAR CUPOS YA OCUPADOS
  //
  // Confirmados, cerrados y abiertos consumen cupos.
  //
  // Los excluidos NO necesitan entrar aquí,
  // porque sus grupos directamente serán omitidos
  // completamente del pool.
  // =====================================================

  const ocupadosPorGrupo =
    new Map();


  const registrarSetOcupado =
    s => {
      const vistos =
        new Set();


      (
        s.viajes ||
        []
      ).forEach(
        rawGid => {
          const gid =
            String(
              rawGid
            );


          if (
            vistos.has(
              gid
            )
          ) {
            return;
          }


          vistos.add(
            gid
          );


          ocupadosPorGrupo.set(
            gid,
            (
              ocupadosPorGrupo.get(
                gid
              ) ||
              0
            ) +
            1
          );
        }
      );
    };


  fixedSetsMem.forEach(
    registrarSetOcupado
  );

  ajustesCerrados.forEach(
    registrarSetOcupado
  );

  ajustesAbiertos.forEach(
    registrarSetOcupado
  );


  // =====================================================
  // 4) CREAR POOL DE CUPOS PENDIENTES
  // =====================================================

  const pool =
    [];


  for (
    const g
    of GRUPOS
  ) {
    const gid =
      String(
        g.id
      );


    // ===================================================
    // EXCLUIDOS
    //
    // Ningún cupo de este grupo participa.
    // ===================================================

    if (
      gruposExcluidos.has(
        gid
      )
    ) {
      continue;
    }


    const requeridos =
      getCantidadCoordinadoresGrupo(
        g
      );


    const ocupados =
      Math.min(
        requeridos,
        ocupadosPorGrupo.get(
          gid
        ) ||
        0
      );


    for (
      let cupo = ocupados;
      cupo < requeridos;
      cupo++
    ) {
      pool.push({
        ...g,

        _cupoCoordinador:
          cupo +
          1,

        _slotKey:
          `${gid}__${cupo + 1}`
      });
    }
  }


  // =====================================================
  // 5) ORDEN CRONOLÓGICO
  // =====================================================

  pool.sort(
    (
      a,
      b
    ) =>
      cmpISO(
        a.fechaInicio,
        b.fechaInicio
      )
  );


  // Por ahora se mantiene por compatibilidad
  // con las tres estrategias.
  const fixedFromGruposFiltered =
    [];


  // =====================================================
  // LOG
  // =====================================================

  L(
    'obtenerBaseSugerencia AJUSTADA:',
    {
      confirmados:
        fixedSetsMem.length,

      cerrados:
        ajustesCerrados.length,

      abiertos:
        ajustesAbiertos.length,

      setsExcluidos:
        ajustesExcluidos.length,

      gruposExcluidos:
        gruposExcluidos.size,

      cuposPendientes:
        pool.length
    }
  );


  return {
    fixedSetsMem,

    fixedFromGruposFiltered,

    pool,

    ajustesCerrados,

    ajustesAbiertos,

    ajustesExcluidos,

    gruposExcluidos
  };
}

/* =========================================================
   AJUSTES MANUALES → COMPLETAR GRUPOS ABIERTOS
   ========================================================= */


/* =========================================================
   CONVERTIR IDS A OBJETOS DE GRUPO
   ========================================================= */

function getObjetosViajesPorIds(
  ids
){
  return (
    ids ||
    []
  )
    .map(
      gid =>
        ID2GRUPO.get(
          String(
            gid
          )
        )
    )
    .filter(
      Boolean
    )
    .sort(
      (
        a,
        b
      ) =>
        cmpISO(
          a.fechaInicio,
          b.fechaInicio
        )
    );
}


/* =========================================================
   VALIDAR UNA CADENA COMPLETA
   ========================================================= */

function esCadenaValidaParaAjuste(
  idsViajes,
  estrategia
){
  const viajes =
    getObjetosViajesPorIds(
      idsViajes
    );


  if (
    viajes.length !==
    (
      idsViajes ||
      []
    ).length
  ) {
    return false;
  }


  // -----------------------------------------------------
  // Un mismo grupo no puede aparecer dos veces
  // dentro de la MISMA agenda.
  // -----------------------------------------------------

  const unicos =
    new Set(
      viajes.map(
        g =>
          String(
            g.id
          )
      )
    );


  if (
    unicos.size !==
    viajes.length
  ) {
    return false;
  }


  // -----------------------------------------------------
  // Modalidad "grupos de 2"
  // -----------------------------------------------------

  if (
    estrategia ===
      'temporada-pares' &&
    viajes.length >
      2
  ) {
    return false;
  }


  // -----------------------------------------------------
  // Las otras modalidades no generan agendas
  // de más de 3 viajes.
  // -----------------------------------------------------

  if (
    estrategia !==
      'temporada-pares' &&
    viajes.length >
      3
  ) {
    return false;
  }


  // -----------------------------------------------------
  // Revisar consecutivos
  // -----------------------------------------------------

  for (
    let i = 0;
    i < viajes.length - 1;
    i++
  ) {
    const A =
      viajes[i];

    const B =
      viajes[
        i + 1
      ];


    // Solape real jamás permitido.
    if (
      overlap(
        A.fechaInicio,
        A.fechaFin,
        B.fechaInicio,
        B.fechaFin
      )
    ) {
      return false;
    }


    const gap =
      gapDays(
        A.fechaFin,
        B.fechaInicio
      );


    if (
      gap <
      0
    ) {
      return false;
    }


    // Las modalidades basadas en temporada
    // deben además respetar su compatibilidad.
    if (
      estrategia ===
        'temporada' ||
      estrategia ===
        'temporada-pares'
    ) {
      if (
        !sonViajesCompatiblesTemporada(
          A,
          B
        )
      ) {
        return false;
      }
    }
  }


  return true;
}


/* =========================================================
   PUNTAJE DE UNA CADENA
   ========================================================= */

function puntuarCadenaAjuste(
  idsViajes
){
  const viajes =
    getObjetosViajesPorIds(
      idsViajes
    );


  if (
    viajes.length <=
    1
  ) {
    return 0;
  }


  let conDescanso =
    0;

  let totalGap =
    0;

  let gapsCero =
    0;


  for (
    let i = 0;
    i < viajes.length - 1;
    i++
  ) {
    const gap =
      gapDays(
        viajes[i].fechaFin,
        viajes[
          i + 1
        ].fechaInicio
      );


    if (
      gap >=
      1
    ) {
      conDescanso++;
    }


    if (
      gap ===
      0
    ) {
      gapsCero++;
    }


    totalGap +=
      Math.max(
        0,
        gap
      );
  }


  // Prioridad:
  //
  // 1. tener descanso
  // 2. evitar cadenas pegadas
  // 3. no dejar huecos absurdamente grandes
  return (
    conDescanso *
      100000
    -
    gapsCero *
      10000
    -
    totalGap
  );
}


/* =========================================================
   COMPLETAR UN SET ABIERTO
   ========================================================= */

function completarSetAbiertoDesdeSugeridos(
  setAbierto,
  suggested,
  estrategia
){
  const abierto =
    {
      ...setAbierto,

      viajes:
        (
          setAbierto.viajes ||
          []
        ).slice(),

      ajusteSugerencia:
        'abierto',

      confirmado:
        false,

      _ajusteManual:
        true
    };


  const limiteTotal =
    estrategia ===
      'temporada-pares'
      ? 2
      : 3;


  const espacioFisico =
    Math.max(
      0,
      limiteTotal -
      abierto.viajes.length
    );


  const maxAdicionales =
    Math.min(
      normalizarMaxAdicionales(
        abierto.maxAdicionales
      ),
      espacioFisico
    );


  let agregados =
    0;


  while (
    agregados <
    maxAdicionales
  ) {
    let mejor =
      null;


    for (
      let setIdx = 0;
      setIdx < suggested.length;
      setIdx++
    ) {
      const origen =
        suggested[
          setIdx
        ];


      for (
        let viajeIdx = 0;
        viajeIdx < (
          origen.viajes ||
          []
        ).length;
        viajeIdx++
      ) {
        const gid =
          String(
            origen.viajes[
              viajeIdx
            ]
          );


        if (
          abierto.viajes.includes(
            gid
          )
        ) {
          continue;
        }


        const prueba =
          abierto.viajes
            .concat(
              gid
            );


        if (
          !esCadenaValidaParaAjuste(
            prueba,
            estrategia
          )
        ) {
          continue;
        }


        const score =
          puntuarCadenaAjuste(
            prueba
          );


        if (
          !mejor ||
          score >
            mejor.score
        ) {
          mejor = {
            setIdx,
            viajeIdx,
            gid,
            score
          };
        }
      }
    }


    if (
      !mejor
    ) {
      break;
    }


    abierto.viajes.push(
      mejor.gid
    );


    abierto.viajes =
      getObjetosViajesPorIds(
        abierto.viajes
      ).map(
        g =>
          String(
            g.id
          )
      );


    suggested[
      mejor.setIdx
    ].viajes.splice(
      mejor.viajeIdx,
      1
    );


    agregados++;
  }


  return abierto;
}


/* =========================================================
   APLICAR TODOS LOS AJUSTES A LA SUGERENCIA
   ========================================================= */

function aplicarAjustesManualesASugerencia({
  ajustesCerrados = [],
  ajustesAbiertos = [],
  ajustesExcluidos = [],
  suggested = [],
  estrategia
} = {}){

  // =====================================================
  // COPIA DE LOS SETS GENERADOS
  // =====================================================

  const restantesSuggested =
    (
      suggested ||
      []
    ).map(
      s => ({
        ...s,

        viajes:
          (
            s.viajes ||
            []
          ).slice()
      })
    );


  const manuales =
    [];


  // =====================================================
  // 1) EXCLUIDOS
  //
  // Se mantienen exactamente como estaban.
  // No absorben viajes.
  // No participan en la sugerencia.
  // =====================================================

  ajustesExcluidos.forEach(
    s => {
      manuales.push({
        ...s,

        viajes:
          (
            s.viajes ||
            []
          ).slice(),

        confirmado:
          false,

        ajusteSugerencia:
          'excluir',

        _ajusteManual:
          true
      });
    }
  );


  // =====================================================
  // 2) CERRADOS
  //
  // Se mantienen exactamente como están.
  // =====================================================

  ajustesCerrados.forEach(
    s => {
      manuales.push({
        ...s,

        viajes:
          (
            s.viajes ||
            []
          ).slice(),

        confirmado:
          false,

        ajusteSugerencia:
          'cerrado',

        _ajusteManual:
          true
      });
    }
  );


  // =====================================================
  // 3) ABIERTOS
  //
  // Mantienen sus viajes actuales y pueden absorber
  // +1 o +2 viajes dependiendo del ajuste.
  // =====================================================

  ajustesAbiertos.forEach(
    s => {
      const completado =
        completarSetAbiertoDesdeSugeridos(
          s,
          restantesSuggested,
          estrategia
        );


      manuales.push(
        completado
      );
    }
  );


  // =====================================================
  // 4) ELIMINAR SETS AUTOMÁTICOS VACÍOS
  // =====================================================

  const restantesLimpios =
    restantesSuggested.filter(
      s =>
        (
          s.viajes ||
          []
        ).length >
        0
    );


  return {
    manuales,

    restantesSuggested:
      restantesLimpios
  };
}

/* =========================================================
   ESTRATEGIA 1
   CONTINUIDAD
   = lógica que ya tenías
   ========================================================= */

function sugerirConjuntosContinuidad(){
  console.groupCollapsed(
    'sugerirConjuntosContinuidad'
  );


  try{
    const {
      fixedSetsMem,
      fixedFromGruposFiltered,
      pool,
      ajustesCerrados,
      ajustesAbiertos,
      ajustesExcluidos
    } =
      obtenerBaseSugerencia();


    L(
      'Pool continuidad:',
      pool.length
    );


    // =====================================================
    // 1) PRIORIDAD:
    //
    // ESPECIAL
    // + TEMPORADA
    // + TEMPORADA
    // =====================================================

    const {
      trios,
      restantes
    } =
      extraerTriosEspeciales(
        pool
      );


    const work =
      [];


    // =====================================================
    // 2) INCORPORAR TRÍOS ESPECIALES
    //
    // Quedan completos en 3.
    // =====================================================

    trios.forEach(
      t => {
        const viajes =
          t.viajes
            .slice()
            .sort(
              (
                a,
                b
              ) =>
                cmpISO(
                  a.fechaInicio,
                  b.fechaInicio
                )
            );


        const gap1 =
          gapDays(
            viajes[0].fechaFin,
            viajes[1].fechaInicio
          );


        const gap2 =
          gapDays(
            viajes[1].fechaFin,
            viajes[2].fechaInicio
          );


        work.push({
          viajes:
            viajes.map(
              g =>
                String(
                  g.id
                )
            ),

          lastFin:
            viajes[
              viajes.length -
              1
            ].fechaFin,

          zeroChain:
            gap2 === 0
              ? (
                  gap1 === 0
                    ? 2
                    : 1
                )
              : 0,

          trioEspecial:
            true
        });
      }
    );


    // =====================================================
    // 3) CONTINUIDAD NORMAL
    // =====================================================

    const ordenados =
      restantes
        .slice()
        .sort(
          (
            a,
            b
          ) =>
            cmpISO(
              a.fechaInicio,
              b.fechaInicio
            )
        );


    for (
      const g
      of ordenados
    ) {
      const gid =
        String(
          g.id
        );


      const clasG =
        clasificarTipoViajeTemporada(
          g
        );


      // ===================================================
      // OTRO / UNIDAD:
      //
      // siempre quedan en un SET individual.
      // ===================================================

      if (
        clasG.individual
      ) {
        work.push({
          viajes:
            [
              gid
            ],

          lastFin:
            g.fechaFin,

          zeroChain:
            0,

          trioEspecial:
            false
        });


        continue;
      }


      // ===================================================
      // BUSCAR MEJOR SET
      //
      // PRIORIDAD:
      // 1. completar parejas
      // 2. tener al menos 1 día de descanso
      // 3. usar huecos razonablemente cortos
      // 4. trío sólo si no hay buena pareja
      // ===================================================

      let mejor =
        null;


      for (
        let i = 0;
        i < work.length;
        i++
      ) {
        const s =
          work[i];


        if (
          s.trioEspecial
        ) {
          continue;
        }


        if (
          (
            s.viajes ||
            []
          ).length >=
          3
        ) {
          continue;
        }


        // MULTI COORDINADOR:
        // mismo grupo jamás dos veces dentro
        // de la misma agenda.
        if (
          (
            s.viajes ||
            []
          ).includes(
            gid
          )
        ) {
          continue;
        }


        const viajesSet =
          (
            s.viajes ||
            []
          )
            .map(
              id =>
                ID2GRUPO.get(
                  String(
                    id
                  )
                )
            )
            .filter(
              Boolean
            )
            .sort(
              (
                a,
                b
              ) =>
                cmpISO(
                  a.fechaInicio,
                  b.fechaInicio
                )
            );


        if (
          !viajesSet.length
        ) {
          continue;
        }


        const ultimo =
          viajesSet[
            viajesSet.length -
            1
          ];


        // =================================================
        // COMPATIBILIDAD DE TEMPORADA
        // =================================================

        if (
          !sonViajesCompatiblesTemporada(
            ultimo,
            g
          )
        ) {
          continue;
        }


        // =================================================
        // NUNCA SOLAPAR
        // =================================================

        if (
          overlap(
            ultimo.fechaInicio,
            ultimo.fechaFin,
            g.fechaInicio,
            g.fechaFin
          )
        ) {
          continue;
        }


        const gap =
          gapDays(
            ultimo.fechaFin,
            g.fechaInicio
          );


        if (
          gap <
          0
        ) {
          continue;
        }


        const nuevoZeroChain =
          gap === 0
            ? (
                s.zeroChain ||
                0
              ) +
              1
            : 0;


        // Evitar 3 viajes seguidos sin
        // ningún día de descanso.
        if (
          nuevoZeroChain >=
          2
        ) {
          continue;
        }


        const cantidadActual =
          (
            s.viajes ||
            []
          ).length;


        // Una pareja tiene prioridad enorme
        // por sobre convertir algo inmediatamente
        // en trío.
        let score =
          0;


        if (
          cantidadActual ===
          1
        ) {
          score +=
            1000000;

        } else {
          score +=
            100000;
        }


        if (
          gap >=
          1
        ) {
          score +=
            10000;
        }


        // Entre alternativas similares:
        // continuidad más cercana.
        score -=
          Math.min(
            Math.max(
              gap,
              0
            ),
            365
          );


        if (
          !mejor ||
          score >
            mejor.score
        ) {
          mejor = {
            idx:
              i,

            score,

            gap,

            nuevoZeroChain
          };
        }
      }


      // ===================================================
      // AGREGAR AL MEJOR O CREAR NUEVO
      // ===================================================

      if (
        mejor
      ) {
        const destino =
          work[
            mejor.idx
          ];


        destino.viajes.push(
          gid
        );


        destino.lastFin =
          g.fechaFin;


        destino.zeroChain =
          mejor.nuevoZeroChain;

      } else {
        work.push({
          viajes:
            [
              gid
            ],

          lastFin:
            g.fechaFin,

          zeroChain:
            0,

          trioEspecial:
            false
        });
      }
    }


    // =====================================================
    // 4) CONVERTIR A SETS DEL SISTEMA
    // =====================================================

    const suggested =
      work.map(
        w => {
          const viajesOrdenados =
            (
              w.viajes ||
              []
            )
              .map(
                gid =>
                  ID2GRUPO.get(
                    String(
                      gid
                    )
                  )
              )
              .filter(
                Boolean
              )
              .sort(
                (
                  a,
                  b
                ) =>
                  cmpISO(
                    a.fechaInicio,
                    b.fechaInicio
                  )
              );


          return {
            anoViaje:
              Number(
                ANO_COORDINADORES
              ),

            viajes:
              [
                ...new Set(
                  viajesOrdenados.map(
                    g =>
                      String(
                        g.id
                      )
                  )
                )
              ],

            coordinadorId:
              null,

            confirmado:
              false,

            estadoCoord:
              'pendiente',

            alertas:
              [],

            _isNew:
              true,

            estrategiaSugerencia:
              'continuidad'
          };
        }
      )
      .filter(
        s =>
          s.viajes.length
      );


    // =====================================================
    // 5) APLICAR AJUSTES MANUALES
    // =====================================================

    const {
      manuales,
      restantesSuggested
    } =
      aplicarAjustesManualesASugerencia({
        ajustesCerrados,
        ajustesAbiertos,
        ajustesExcluidos,
        suggested,
        estrategia:
          'continuidad'
      });


    // =====================================================
    // 6) RESULTADO
    // =====================================================

    SETS =
      fixedSetsMem
        .concat(
          fixedFromGruposFiltered
        )
        .concat(
          manuales
        )
        .concat(
          restantesSuggested
        );


    dedupeSetsInPlace();

    sortSetsInPlace();

    evaluarAlertas();

    render();


    const resultadoNuevo =
      manuales.concat(
        restantesSuggested
      );


    L(
      'Continuidad resultado:',
      {
        gruposViaje:
          resultadoNuevo.length,

        deUno:
          resultadoNuevo.filter(
            s =>
              s.viajes.length ===
              1
          ).length,

        deDos:
          resultadoNuevo.filter(
            s =>
              s.viajes.length ===
              2
          ).length,

        deTres:
          resultadoNuevo.filter(
            s =>
              s.viajes.length ===
              3
          ).length,

        ajustesCerrados:
          ajustesCerrados.length,

        ajustesAbiertos:
          ajustesAbiertos.length,

        cuposProcesados:
          pool.length
      }
    );


  }finally{
    console.groupEnd();
  }
}

/* =========================================================
   CLASIFICACIÓN POR TEMPORADA
   ========================================================= */

/* =========================================================
   ESTRATEGIA TEMPORADA
   ========================================================= */


/* =========================================================
   CLASIFICAR TIPO DE VIAJE
   ========================================================= */

function clasificarTipoViajeTemporada(g){
  if (!g) {
    return {
      tipo:
        'UNIDAD',

      individual:
        true
    };
  }

  // =====================================================
  // OTRO
  //
  // Siempre es grupo de viaje independiente.
  // Puede después compartir coordinador con otro SET,
  // pero nunca comparte este mismo SET.
  // =====================================================

  if (
    normDest(
      g.destino
    ) === 'OTRO'
  ) {
    return {
      tipo:
        'OTRO',

      individual:
        true
    };
  }

  const ini =
    String(
      g.fechaInicio ||
      ''
    );

  const fin =
    String(
      g.fechaFin ||
      ''
    );

  const mesIni =
    Number(
      ini.slice(
        5,
        7
      )
    );

  const mesFin =
    Number(
      fin.slice(
        5,
        7
      )
    );

  // =====================================================
  // SEPTIEMBRE ESPECIAL
  //
  // Cualquier viaje que EMPIEZA O TERMINA en septiembre.
  //
  // Puede combinarse con TEMPORADA.
  // No puede combinarse con:
  // - otro septiembre
  // - octubre puro
  // - noviembre puro
  // =====================================================

  if (
    mesIni === 9 ||
    mesFin === 9
  ) {
    return {
      tipo:
        'SEPTIEMBRE',

      individual:
        false
    };
  }

  // =====================================================
  // OCTUBRE PURO
  //
  // Empieza Y termina en octubre.
  // =====================================================

  if (
    mesIni === 10 &&
    mesFin === 10
  ) {
    return {
      tipo:
        'OCTUBRE',

      individual:
        false
    };
  }

  // =====================================================
  // NOVIEMBRE PURO
  //
  // Empieza Y termina en noviembre.
  // =====================================================

  if (
    mesIni === 11 &&
    mesFin === 11
  ) {
    return {
      tipo:
        'NOVIEMBRE',

      individual:
        false
    };
  }

  // =====================================================
  // TEMPORADA
  //
  // CASO 1:
  // empieza en noviembre y termina en diciembre.
  //
  // CASO 2:
  // empieza y termina en diciembre.
  // =====================================================

  if (
    (
      mesIni === 11 &&
      mesFin === 12
    ) ||
    (
      mesIni === 12 &&
      mesFin === 12
    )
  ) {
    return {
      tipo:
        'TEMPORADA',

      individual:
        false
    };
  }

  // =====================================================
  // CUALQUIER OTRO CASO
  //
  // Por seguridad queda como unidad independiente.
  // =====================================================

  return {
    tipo:
      'UNIDAD',

    individual:
      true
  };
}


/* =========================================================
   COMPATIBILIDAD ENTRE TIPOS
   ========================================================= */

function sonTiposCompatiblesTemporada(
  tipoA,
  tipoB
){
  if (
    !tipoA ||
    !tipoB
  ) {
    return false;
  }

  // OTRO / UNIDAD:
  // nunca comparten grupo de viajes.
  if (
    tipoA === 'OTRO' ||
    tipoB === 'OTRO' ||
    tipoA === 'UNIDAD' ||
    tipoB === 'UNIDAD'
  ) {
    return false;
  }

  // =====================================================
  // TEMPORADA + TEMPORADA
  // =====================================================

  if (
    tipoA === 'TEMPORADA' &&
    tipoB === 'TEMPORADA'
  ) {
    return true;
  }

  // =====================================================
  // ESPECIALES + TEMPORADA
  //
  // Septiembre + temporada
  // Octubre puro + temporada
  // Noviembre puro + temporada
  // =====================================================

  const especiales =
    new Set([
      'SEPTIEMBRE',
      'OCTUBRE',
      'NOVIEMBRE'
    ]);

  if (
    tipoA === 'TEMPORADA' &&
    especiales.has(
      tipoB
    )
  ) {
    return true;
  }

  if (
    tipoB === 'TEMPORADA' &&
    especiales.has(
      tipoA
    )
  ) {
    return true;
  }

  // =====================================================
  // ENTRE ESPECIALES NO SE COMBINAN
  // =====================================================

  return false;
}


/* =========================================================
   COMPATIBILIDAD REAL ENTRE DOS VIAJES
   ========================================================= */

function sonViajesCompatiblesTemporada(
  A,
  B
){
  if (
    !A ||
    !B ||
    A.id === B.id
  ) {
    return false;
  }

  const tipoA =
    clasificarTipoViajeTemporada(
      A
    );

  const tipoB =
    clasificarTipoViajeTemporada(
      B
    );

  if (
    tipoA.individual ||
    tipoB.individual
  ) {
    return false;
  }

  if (
    !sonTiposCompatiblesTemporada(
      tipoA.tipo,
      tipoB.tipo
    )
  ) {
    return false;
  }

  const ordenados =
    [A, B]
      .slice()
      .sort(
        (a, b) =>
          cmpISO(
            a.fechaInicio,
            b.fechaInicio
          )
      );

  const primero =
    ordenados[0];

  const segundo =
    ordenados[1];

  // =====================================================
  // SOLAPE REAL:
  // PROHIBIDO.
  // =====================================================

  if (
    overlap(
      primero.fechaInicio,
      primero.fechaFin,
      segundo.fechaInicio,
      segundo.fechaFin
    )
  ) {
    return false;
  }

  const gap =
    gapDays(
      primero.fechaFin,
      segundo.fechaInicio
    );

  return gap >= 0;
}

/* =========================================================
   ¿ES VIAJE ESPECIAL?
   ========================================================= */

function esTipoEspecialTemporada(
  tipo
){
  return [
    'SEPTIEMBRE',
    'OCTUBRE',
    'NOVIEMBRE'
  ].includes(
    tipo
  );
}


/* =========================================================
   ¿UN SET CONTIENE VIAJE ESPECIAL?
   ========================================================= */

function getEspecialDeViajes(
  viajes
){
  const especiales =
    (
      viajes ||
      []
    )
      .filter(Boolean)
      .filter(
        g => {
          const c =
            clasificarTipoViajeTemporada(
              g
            );

          return esTipoEspecialTemporada(
            c.tipo
          );
        }
      );

  return especiales[0] ||
    null;
}

/* =========================================================
   INFORMACIÓN / PUNTAJE DE UNA PAREJA
   ========================================================= */

function puntuarParejaViajes(
  A,
  B
){
  if (
    !sonViajesCompatiblesTemporada(
      A,
      B
    )
  ) {
    return null;
  }

  const viajes =
    [A, B]
      .slice()
      .sort(
        (a, b) =>
          cmpISO(
            a.fechaInicio,
            b.fechaInicio
          )
      );

  const gap =
    gapDays(
      viajes[0].fechaFin,
      viajes[1].fechaInicio
    );

  return {
    viajes,

    gap,

    descansoCompleto:
      gap >= 1
        ? 1
        : 0,

    // El descanso es un desempate.
    // No debe ganarle a formar más parejas.
    scoreDescanso:
      Math.min(
        Math.max(
          gap,
          0
        ),
        60
      )
  };
}


/* =========================================================
   CALIDAD DE UNA PAREJA
   ========================================================= */

function scoreCalidadPareja(
  A,
  B
){
  const p =
    puntuarParejaViajes(
      A,
      B
    );

  if (!p) {
    return -Infinity;
  }

  // Tener al menos 1 día completo
  // pesa más que tener simplemente más días.
  return (
    (
      p.descansoCompleto
        ? 1000
        : 0
    ) +
    p.scoreDescanso
  );
}


/* =========================================================
   CONTAR CUÁNTOS VIAJES TODAVÍA TIENEN OPCIÓN
   DE SER EMPAREJADOS
   ========================================================= */

function contarViajesConParejaPosible(
  grupos
){
  let total =
    0;

  for (
    let i = 0;
    i < grupos.length;
    i++
  ) {
    const g =
      grupos[i];

    const tiene =
      grupos.some(
        (otro, j) =>
          i !== j &&
          sonViajesCompatiblesTemporada(
            g,
            otro
          )
      );

    if (tiene) {
      total++;
    }
  }

  return total;
}


/* =========================================================
   EMPAREJAMIENTO BASE
   ========================================================= */

function construirEmparejamientoBase(
  grupos
){
  const pendientes =
    grupos
      .slice()
      .sort(
        (a, b) =>
          cmpISO(
            a.fechaInicio,
            b.fechaInicio
          )
      );

  const parejas =
    [];

  while (
    pendientes.length >= 2
  ) {
    // ===================================================
    // PRIMERO ELEGIMOS EL VIAJE MÁS DIFÍCIL
    //
    // Es decir:
    // el que tenga menos compañeros posibles.
    //
    // Esto evita "gastarse" un viaje flexible y dejar
    // otro sin pareja.
    // ===================================================

    let idxBase =
      -1;

    let candidatosBase =
      null;

    for (
      let i = 0;
      i < pendientes.length;
      i++
    ) {
      const candidatos =
        [];

      for (
        let j = 0;
        j < pendientes.length;
        j++
      ) {
        if (
          i === j
        ) {
          continue;
        }

        if (
          sonViajesCompatiblesTemporada(
            pendientes[i],
            pendientes[j]
          )
        ) {
          candidatos.push(
            j
          );
        }
      }

      if (
        !candidatos.length
      ) {
        continue;
      }

      if (
        idxBase === -1 ||
        candidatos.length <
          candidatosBase.length
      ) {
        idxBase =
          i;

        candidatosBase =
          candidatos;
      }
    }

    // Ningún viaje restante puede emparejarse.
    if (
      idxBase === -1
    ) {
      break;
    }

    const base =
      pendientes[
        idxBase
      ];

    let mejor =
      null;

    // ===================================================
    // ELEGIR COMPAÑERO
    //
    // PRIORIDAD:
    //
    // 1. dejar la mayor cantidad de viajes restantes
    //    todavía emparejables.
    //
    // 2. recién después mejorar el descanso.
    // ===================================================

    for (
      const idxComp
      of candidatosBase
    ) {
      const comp =
        pendientes[
          idxComp
        ];

      const restantes =
        pendientes.filter(
          (_, idx) =>
            idx !== idxBase &&
            idx !== idxComp
        );

      const emparejablesDespues =
        contarViajesConParejaPosible(
          restantes
        );

      const calidad =
        scoreCalidadPareja(
          base,
          comp
        );

      if (
        !mejor ||
        emparejablesDespues >
          mejor.emparejablesDespues ||
        (
          emparejablesDespues ===
            mejor.emparejablesDespues &&
          calidad >
            mejor.calidad
        )
      ) {
        mejor = {
          idxComp,
          comp,
          emparejablesDespues,
          calidad
        };
      }
    }

    if (!mejor) {
      break;
    }

    parejas.push(
      {
        viajes:
          [base, mejor.comp]
            .sort(
              (a, b) =>
                cmpISO(
                  a.fechaInicio,
                  b.fechaInicio
                )
            )
      }
    );

    // Borrar índices de mayor a menor.
    const borrar =
      [
        idxBase,
        mejor.idxComp
      ]
        .sort(
          (a, b) =>
            b - a
        );

    borrar.forEach(
      idx =>
        pendientes.splice(
          idx,
          1
        )
    );
  }

  return {
    parejas,

    sueltos:
      pendientes
  };
}


/* =========================================================
   REPARAR EMPAREJAMIENTO
   ========================================================= */

function repararEmparejamientoTemporada(
  parejas,
  sueltos
){
  let P =
    parejas.map(
      p => ({
        viajes:
          p.viajes.slice()
      })
    );

  let S =
    sueltos.slice();

  let cambio =
    true;

  while (cambio) {
    cambio =
      false;

    // ===================================================
    // A) DOS SUELTOS QUE PUEDAN FORMAR UNA PAREJA
    // ===================================================

    outerDirecto:
    for (
      let i = 0;
      i < S.length - 1;
      i++
    ) {
      for (
        let j = i + 1;
        j < S.length;
        j++
      ) {
        if (
          sonViajesCompatiblesTemporada(
            S[i],
            S[j]
          )
        ) {
          P.push(
            {
              viajes:
                [S[i], S[j]]
                  .sort(
                    (a, b) =>
                      cmpISO(
                        a.fechaInicio,
                        b.fechaInicio
                      )
                  )
            }
          );

          S.splice(
            j,
            1
          );

          S.splice(
            i,
            1
          );

          cambio =
            true;

          break outerDirecto;
        }
      }
    }

    if (cambio) {
      continue;
    }

    // ===================================================
    // B) REPARACIÓN 2x2
    //
    // Tenemos:
    //
    // pareja A+B
    // suelto C
    // suelto D
    //
    // buscamos:
    //
    // A+C
    // B+D
    //
    // o:
    //
    // A+D
    // B+C
    //
    // Esto reduce:
    //
    // 3 grupos → 2 grupos.
    //
    // Es exactamente el tipo de caso:
    //
    // 04-09 + 13-20
    // y quedan solos 05-12 / 10-16
    //
    // que queremos corregir.
    // ===================================================

    let mejorReparacion =
      null;

    for (
      let pIdx = 0;
      pIdx < P.length;
      pIdx++
    ) {
      const [
        A,
        B
      ] =
        P[pIdx].viajes;

      for (
        let i = 0;
        i < S.length - 1;
        i++
      ) {
        for (
          let j = i + 1;
          j < S.length;
          j++
        ) {
          const C =
            S[i];

          const D =
            S[j];

          const alternativas =
            [
              [
                [A, C],
                [B, D]
              ],

              [
                [A, D],
                [B, C]
              ]
            ];

          for (
            const alt
            of alternativas
          ) {
            const [
              par1,
              par2
            ] =
              alt;

            if (
              !sonViajesCompatiblesTemporada(
                par1[0],
                par1[1]
              ) ||
              !sonViajesCompatiblesTemporada(
                par2[0],
                par2[1]
              )
            ) {
              continue;
            }

            const score =
              scoreCalidadPareja(
                par1[0],
                par1[1]
              ) +
              scoreCalidadPareja(
                par2[0],
                par2[1]
              );

            if (
              !mejorReparacion ||
              score >
                mejorReparacion.score
            ) {
              mejorReparacion = {
                pIdx,
                i,
                j,
                par1,
                par2,
                score
              };
            }
          }
        }
      }
    }

    if (
      mejorReparacion
    ) {
      const r =
        mejorReparacion;

      P[r.pIdx] = {
        viajes:
          r.par1
            .slice()
            .sort(
              (a, b) =>
                cmpISO(
                  a.fechaInicio,
                  b.fechaInicio
                )
            )
      };

      P.push(
        {
          viajes:
            r.par2
              .slice()
              .sort(
                (a, b) =>
                  cmpISO(
                    a.fechaInicio,
                    b.fechaInicio
                  )
              )
        }
      );

      S.splice(
        r.j,
        1
      );

      S.splice(
        r.i,
        1
      );

      cambio =
        true;
    }
  }

  return {
    parejas:
      P,

    sueltos:
      S
  };
}


/* =========================================================
   MEJORAR DESCANSOS SIN CAMBIAR CANTIDAD DE PAREJAS
   ========================================================= */

function mejorarDescansoParejas(
  parejas
){
  const P =
    parejas.map(
      p => ({
        viajes:
          p.viajes.slice()
      })
    );

  let cambio =
    true;

  let vueltas =
    0;

  while (
    cambio &&
    vueltas < 20
  ) {
    cambio =
      false;

    vueltas++;

    outer:
    for (
      let i = 0;
      i < P.length - 1;
      i++
    ) {
      for (
        let j = i + 1;
        j < P.length;
        j++
      ) {
        const [
          A,
          B
        ] =
          P[i].viajes;

        const [
          C,
          D
        ] =
          P[j].viajes;

        const actual =
          scoreCalidadPareja(
            A,
            B
          ) +
          scoreCalidadPareja(
            C,
            D
          );

        const alternativas =
          [
            [
              [A, C],
              [B, D]
            ],

            [
              [A, D],
              [B, C]
            ]
          ];

        for (
          const alt
          of alternativas
        ) {
          const [
            p1,
            p2
          ] =
            alt;

          if (
            !sonViajesCompatiblesTemporada(
              p1[0],
              p1[1]
            ) ||
            !sonViajesCompatiblesTemporada(
              p2[0],
              p2[1]
            )
          ) {
            continue;
          }

          const nuevo =
            scoreCalidadPareja(
              p1[0],
              p1[1]
            ) +
            scoreCalidadPareja(
              p2[0],
              p2[1]
            );

          if (
            nuevo >
            actual
          ) {
            P[i].viajes =
              p1
                .slice()
                .sort(
                  (a, b) =>
                    cmpISO(
                      a.fechaInicio,
                      b.fechaInicio
                    )
                );

            P[j].viajes =
              p2
                .slice()
                .sort(
                  (a, b) =>
                    cmpISO(
                      a.fechaInicio,
                      b.fechaInicio
                    )
                );

            cambio =
              true;

            break outer;
          }
        }
      }
    }
  }

  return P;
}


/* =========================================================
   EMPAREJAR TEMPORADA
   ========================================================= */

function emparejarViajesTemporada(
  grupos
){
  // =====================================================
  // 1) EMPAREJAMIENTO BASE
  // =====================================================

  const base =
    construirEmparejamientoBase(
      grupos
    );

  // =====================================================
  // 2) REPARAR SUELTOS
  //
  // Acá priorizamos reducir la cantidad total de SETS.
  // =====================================================

  const reparado =
    repararEmparejamientoTemporada(
      base.parejas,
      base.sueltos
    );

  // =====================================================
  // 3) CON LA CANTIDAD DE PAREJAS YA RESUELTA,
  //    OPTIMIZAMOS DESCANSO.
  // =====================================================

  const parejasMejoradas =
    mejorarDescansoParejas(
      reparado.parejas
    );

  return {
    parejas:
      parejasMejoradas,

    sueltos:
      reparado.sueltos
  };
}


/* =========================================================
   VALIDAR TRÍO
   ========================================================= */

function evaluarTrioTemporada(
  viajes
){
  if (
    !Array.isArray(
      viajes
    ) ||
    viajes.length !== 3
  ) {
    return null;
  }


  const arr =
    viajes
      .slice()
      .filter(Boolean)
      .sort(
        (a, b) =>
          cmpISO(
            a.fechaInicio,
            b.fechaInicio
          )
      );


  if (
    arr.length !== 3
  ) {
    return null;
  }


  // =====================================================
  // MULTI-COORDINADOR:
  //
  // Dos cupos del MISMO grupo nunca pueden quedar
  // en la misma agenda.
  // =====================================================

  if (
    new Set(
      arr.map(
        g =>
          String(
            g.id
          )
      )
    ).size !== 3
  ) {
    return null;
  }


  const clasificaciones =
    arr.map(
      g =>
        clasificarTipoViajeTemporada(
          g
        )
    );


  // OTRO / UNIDAD nunca pueden formar trío.
  if (
    clasificaciones.some(
      c =>
        c.individual
    )
  ) {
    return null;
  }


  // =====================================================
  // REGLA DEL TRÍO
  //
  // Debe existir EXACTAMENTE:
  //
  // 1 viaje especial:
  //   SEPTIEMBRE
  //   OCTUBRE
  //   NOVIEMBRE
  //
  // +
  //
  // 2 viajes TEMPORADA
  //
  // No permitimos:
  //
  // TEMPORADA + TEMPORADA + TEMPORADA
  // ESPECIAL + ESPECIAL + TEMPORADA
  // =====================================================

  const cantidadEspeciales =
    clasificaciones.filter(
      c =>
        esTipoEspecialTemporada(
          c.tipo
        )
    ).length;


  const cantidadTemporada =
    clasificaciones.filter(
      c =>
        c.tipo ===
        'TEMPORADA'
    ).length;


  if (
    cantidadEspeciales !== 1 ||
    cantidadTemporada !== 2
  ) {
    return null;
  }


  // =====================================================
  // ORDEN / SOLAPES / DESCANSOS
  // =====================================================

  const gaps =
    [];


  for (
    let i = 0;
    i < arr.length - 1;
    i++
  ) {
    const A =
      arr[i];

    const B =
      arr[i + 1];


    if (
      overlap(
        A.fechaInicio,
        A.fechaFin,
        B.fechaInicio,
        B.fechaFin
      )
    ) {
      return null;
    }


    const gap =
      gapDays(
        A.fechaFin,
        B.fechaInicio
      );


    if (
      gap < 0
    ) {
      return null;
    }


    gaps.push(
      gap
    );
  }


  // =====================================================
  // PROTECCIÓN DE DESCANSO
  //
  // Permitimos un cambio sin día completo.
  //
  // No permitimos:
  //
  // viaje 1
  // → 0 días
  // viaje 2
  // → 0 días
  // viaje 3
  // =====================================================

  const cambiosSinDescanso =
    gaps.filter(
      g =>
        g === 0
    ).length;


  if (
    cambiosSinDescanso >= 2
  ) {
    return null;
  }


  return {
    viajes:
      arr,

    gaps,

    descansoCompleto:
      gaps.filter(
        g =>
          g >= 1
      ).length,

    totalDescanso:
      gaps.reduce(
        (
          total,
          gap
        ) =>
          total +
          Math.max(
            gap,
            0
          ),
        0
      )
  };
}

/* =========================================================
   EXTRAER TRÍOS ESPECIALES
   ========================================================= */

function extraerTriosEspeciales(
  pool
){
  let restantes =
    (
      pool ||
      []
    ).slice();


  const trios =
    [];


  // =====================================================
  // Buscar:
  //
  // ESPECIAL + TEMPORADA + TEMPORADA
  //
  // antes de organizar el resto.
  //
  // Esto permite reducir realmente la cantidad de
  // grupos de viaje.
  // =====================================================

  while (true) {
    let mejor =
      null;


    // ===================================================
    // Primero contamos las alternativas de cada especial.
    //
    // Queremos resolver primero al especial que tenga
    // MENOS posibilidades.
    //
    // Así evitamos gastar viajes de temporada flexibles
    // y dejar un especial sin posibilidad de trío.
    // ===================================================

    for (
      let i = 0;
      i < restantes.length;
      i++
    ) {
      const especial =
        restantes[i];


      const clasEspecial =
        clasificarTipoViajeTemporada(
          especial
        );


      if (
        !esTipoEspecialTemporada(
          clasEspecial.tipo
        )
      ) {
        continue;
      }


      const opciones =
        [];


      for (
        let j = 0;
        j < restantes.length - 1;
        j++
      ) {
        if (
          j === i
        ) {
          continue;
        }


        const T1 =
          restantes[j];


        if (
          clasificarTipoViajeTemporada(
            T1
          ).tipo !==
          'TEMPORADA'
        ) {
          continue;
        }


        for (
          let k = j + 1;
          k < restantes.length;
          k++
        ) {
          if (
            k === i
          ) {
            continue;
          }


          const T2 =
            restantes[k];


          if (
            clasificarTipoViajeTemporada(
              T2
            ).tipo !==
            'TEMPORADA'
          ) {
            continue;
          }


          const prueba =
            evaluarTrioTemporada(
              [
                especial,
                T1,
                T2
              ]
            );


          if (!prueba) {
            continue;
          }


          // =============================================
          // CALIDAD DEL TRÍO
          //
          // La prioridad principal ya es FORMAR el trío.
          //
          // Entre varios tríos posibles:
          // 1) más cambios con 1+ día
          // 2) después más descanso total
          // =============================================

          const score =
            (
              prueba.descansoCompleto *
              10000
            ) +
            Math.min(
              prueba.totalDescanso,
              365
            );


          opciones.push({
            i,
            j,
            k,

            especial,

            T1,
            T2,

            prueba,

            score
          });
        }
      }


      if (
        !opciones.length
      ) {
        continue;
      }


      opciones.sort(
        (
          A,
          B
        ) =>
          B.score -
          A.score
      );


      const candidato =
        opciones[0];


      candidato.cantidadOpciones =
        opciones.length;


      // =================================================
      // PRIORIDAD:
      //
      // especial con menos opciones primero.
      //
      // Si empatan:
      // mejor descanso.
      // =================================================

      if (
        !mejor ||
        candidato.cantidadOpciones <
          mejor.cantidadOpciones ||
        (
          candidato.cantidadOpciones ===
            mejor.cantidadOpciones &&
          candidato.score >
            mejor.score
        )
      ) {
        mejor =
          candidato;
      }
    }


    // Ya no hay ningún trío posible.
    if (!mejor) {
      break;
    }


    trios.push({
      viajes:
        mejor.prueba.viajes
          .slice()
    });


    // ===================================================
    // BORRAR LOS 3 OBJETOS UTILIZADOS
    //
    // Importante:
    // usamos índices porque en multi-coordinador puede
    // haber dos objetos con el mismo grupoId pero
    // representan cupos diferentes.
    // ===================================================

    const borrar =
      [
        mejor.i,
        mejor.j,
        mejor.k
      ]
        .sort(
          (
            a,
            b
          ) =>
            b - a
        );


    borrar.forEach(
      idx => {
        restantes.splice(
          idx,
          1
        );
      }
    );
  }


  L(
    'extraerTriosEspeciales:',
    {
      trios:
        trios.length,

      viajesEnTrios:
        trios.length *
        3,

      restantes:
        restantes.length
    }
  );


  return {
    trios,
    restantes
  };
}

/* =========================================================
   ABSORBER ALGUNOS SUELTOS EN TRÍOS
   ========================================================= */

function optimizarSueltosEnParejas(
  parejas,
  sueltos
){
  const sets =
    parejas.map(
      p => ({
        viajes:
          p.viajes.slice()
      })
    );

  const restantes =
    sueltos.slice();

  let cambio =
    true;

  while (
    cambio &&
    restantes.length
  ) {
    cambio =
      false;

    let mejor =
      null;

    for (
      let sIdx = 0;
      sIdx < restantes.length;
      sIdx++
    ) {
      const suelto =
        restantes[
          sIdx
        ];

      for (
        let setIdx = 0;
        setIdx < sets.length;
        setIdx++
      ) {
        const set =
          sets[
            setIdx
          ];

        if (
          set.viajes.length !== 2
        ) {
          continue;
        }

        const prueba =
          evaluarTrioTemporada(
            [
              ...set.viajes,
              suelto
            ]
          );

        if (!prueba) {
          continue;
        }

        // =================================================
        // Mantener la mayoría de los SETS con 2 viajes.
        //
        // Si absorbemos este suelto:
        //
        // - desaparece 1 grupo individual
        // - una pareja pasa a ser trío
        // =================================================

        const paresActuales =
          sets.filter(
            x =>
              x.viajes.length === 2
          ).length;

        const paresDespues =
          paresActuales - 1;

        const totalSetsDespues =
          sets.length +
          restantes.length -
          1;

        if (
          paresDespues <=
          totalSetsDespues / 2
        ) {
          continue;
        }

        const score =
          (
            prueba.descansoCompleto *
            1000
          ) +
          prueba.totalDescanso;

        if (
          !mejor ||
          score >
            mejor.score
        ) {
          mejor = {
            sIdx,
            setIdx,
            prueba,
            score
          };
        }
      }
    }

    if (mejor) {
      sets[
        mejor.setIdx
      ].viajes =
        mejor.prueba.viajes;

      restantes.splice(
        mejor.sIdx,
        1
      );

      cambio =
        true;
    }
  }

  // =====================================================
  // LOS QUE SIGUEN SUELTOS
  // =====================================================

  restantes.forEach(
    g => {
      sets.push(
        {
          viajes:
            [g]
        }
      );
    }
  );

  return sets;
}


/* =========================================================
   SUGERIR POR TEMPORADA
   ========================================================= */

function sugerirConjuntosTemporada(){
  console.groupCollapsed(
    'sugerirConjuntosTemporada'
  );


  try{
    const {
      fixedSetsMem,
      fixedFromGruposFiltered,
      pool,
      ajustesCerrados,
      ajustesAbiertos,
      ajustesExcluidos
    } =
      obtenerBaseSugerencia();


    L(
      'Pool temporada:',
      pool.length
    );


    // =====================================================
    // 1) PRIMERA PRIORIDAD:
    //
    // ESPECIAL
    // + TEMPORADA
    // + TEMPORADA
    // =====================================================

    const {
      trios,
      restantes
    } =
      extraerTriosEspeciales(
        pool
      );


    // =====================================================
    // 2) CLASIFICAR LO QUE QUEDÓ
    // =====================================================

    const individuales =
      [];

    const combinables =
      [];


    for (
      const g
      of restantes
    ) {
      const clasificacion =
        clasificarTipoViajeTemporada(
          g
        );


      if (
        clasificacion.individual
      ) {
        individuales.push(
          g
        );

      } else {
        combinables.push(
          g
        );
      }
    }


    L(
      'Temporada después de tríos:',
      {
        trios:
          trios.length,

        combinables:
          combinables.length,

        individuales:
          individuales.length
      }
    );


    // =====================================================
    // 3) MAXIMIZAR PAREJAS
    // =====================================================

    const {
      parejas,
      sueltos
    } =
      emparejarViajesTemporada(
        combinables
      );


    // =====================================================
    // 4) INTENTAR COMPLETAR ALGUNOS TRÍOS
    //
    // ESPECIAL + TEMP + TEMP
    // =====================================================

    const optimizados =
      optimizarSueltosEnParejas(
        parejas,
        sueltos
      );


    // =====================================================
    // 5) RESULTADO BASE
    // =====================================================

    const todosSets =
      [
        ...trios.map(
          t => ({
            viajes:
              t.viajes.slice()
          })
        ),

        ...optimizados
      ];


    // =====================================================
    // 6) OTRO / UNIDADES
    // =====================================================

    individuales.forEach(
      g => {
        todosSets.push({
          viajes:
            [
              g
            ]
        });
      }
    );


    // =====================================================
    // 7) CONVERTIR A SETS DEL SISTEMA
    // =====================================================

    const suggested =
      todosSets.map(
        s => {
          const viajesOrdenados =
            s.viajes
              .slice()
              .sort(
                (
                  a,
                  b
                ) =>
                  cmpISO(
                    a.fechaInicio,
                    b.fechaInicio
                  )
              );


          return {
            anoViaje:
              Number(
                ANO_COORDINADORES
              ),

            viajes:
              viajesOrdenados.map(
                g =>
                  String(
                    g.id
                  )
              ),

            coordinadorId:
              null,

            confirmado:
              false,

            estadoCoord:
              'pendiente',

            alertas:
              [],

            _isNew:
              true,

            estrategiaSugerencia:
              'temporada'
          };
        }
      );


    // =====================================================
    // 8) APLICAR AJUSTES MANUALES
    // =====================================================

    const {
      manuales,
      restantesSuggested
    } =
      aplicarAjustesManualesASugerencia({
        ajustesCerrados,
        ajustesAbiertos,
        ajustesExcluidos,
        suggested,
        estrategia:
          'temporada'
      });


    // =====================================================
    // 9) CONSERVAR CONFIRMADOS + MANUALES + NUEVOS
    // =====================================================

    SETS =
      fixedSetsMem
        .concat(
          fixedFromGruposFiltered
        )
        .concat(
          manuales
        )
        .concat(
          restantesSuggested
        );


    dedupeSetsInPlace();

    sortSetsInPlace();

    evaluarAlertas();

    render();


    // =====================================================
    // 10) ESTADÍSTICAS DEL RESULTADO FINAL
    // =====================================================

    const resultadoNuevo =
      manuales.concat(
        restantesSuggested
      );


    const deUno =
      resultadoNuevo.filter(
        s =>
          s.viajes.length ===
          1
      ).length;


    const deDos =
      resultadoNuevo.filter(
        s =>
          s.viajes.length ===
          2
      ).length;


    const deTres =
      resultadoNuevo.filter(
        s =>
          s.viajes.length ===
          3
      ).length;


    const totalViajes =
      resultadoNuevo.reduce(
        (
          n,
          s
        ) =>
          n +
          s.viajes.length,
        0
      );


    L(
      'Temporada resultado FINAL:',
      {
        viajes:
          totalViajes,

        gruposViaje:
          resultadoNuevo.length,

        uno:
          deUno,

        dos:
          deDos,

        tres:
          deTres,

        triosEspecialesPrioritarios:
          trios.length,

        ajustesCerrados:
          ajustesCerrados.length,

        ajustesAbiertos:
          ajustesAbiertos.length
      }
    );


  }finally{
    console.groupEnd();
  }
}

/* =========================================================
   ESTRATEGIA 3
   TEMPORADA — GRUPOS DE 2
   ========================================================= */

function sugerirConjuntosTemporadaPares(){
  console.groupCollapsed(
    'sugerirConjuntosTemporadaPares'
  );


  try{
    const {
      fixedSetsMem,
      fixedFromGruposFiltered,
      pool,
      ajustesCerrados,
      ajustesAbiertos,
      ajustesExcluidos
    } =
      obtenerBaseSugerencia();


    L(
      'Pool temporada pares:',
      pool.length
    );


    // =====================================================
    // 1) SEPARAR INDIVIDUALES OBLIGATORIOS
    //
    // OTRO
    // UNIDAD
    // =====================================================

    const individuales =
      [];

    const combinables =
      [];


    for (
      const g
      of pool
    ) {
      const clasificacion =
        clasificarTipoViajeTemporada(
          g
        );


      if (
        clasificacion.individual
      ) {
        individuales.push(
          g
        );

      } else {
        combinables.push(
          g
        );
      }
    }


    L(
      'Temporada pares clasificación:',
      {
        combinables:
          combinables.length,

        individuales:
          individuales.length
      }
    );


    // =====================================================
    // 2) MAXIMIZAR PAREJAS
    //
    // NO crea tríos.
    // =====================================================

    const {
      parejas,
      sueltos
    } =
      emparejarViajesTemporada(
        combinables
      );


    // =====================================================
    // 3) CONVERTIR PAREJAS
    // =====================================================

    const organizados =
      parejas.map(
        p => ({
          viajes:
            p.viajes
              .slice()
        })
      );


    // =====================================================
    // 4) SUELTOS
    // =====================================================

    sueltos.forEach(
      g => {
        organizados.push({
          viajes:
            [
              g
            ]
        });
      }
    );


    // =====================================================
    // 5) OTRO / UNIDADES
    // =====================================================

    individuales.forEach(
      g => {
        organizados.push({
          viajes:
            [
              g
            ]
        });
      }
    );


    // =====================================================
    // 6) CONVERTIR A SETS DEL SISTEMA
    // =====================================================

    const suggested =
      organizados.map(
        s => {
          const viajesOrdenados =
            s.viajes
              .slice()
              .sort(
                (
                  a,
                  b
                ) =>
                  cmpISO(
                    a.fechaInicio,
                    b.fechaInicio
                  )
              );


          return {
            anoViaje:
              Number(
                ANO_COORDINADORES
              ),

            viajes:
              viajesOrdenados.map(
                g =>
                  String(
                    g.id
                  )
              ),

            coordinadorId:
              null,

            confirmado:
              false,

            estadoCoord:
              'pendiente',

            alertas:
              [],

            _isNew:
              true,

            estrategiaSugerencia:
              'temporada-pares'
          };
        }
      );


    // =====================================================
    // 7) APLICAR AJUSTES MANUALES
    //
    // IMPORTANTE:
    // En esta modalidad el helper impedirá
    // que un ABIERTO supere 2 viajes.
    // =====================================================

    const {
      manuales,
      restantesSuggested
    } =
      aplicarAjustesManualesASugerencia({
        ajustesCerrados,
        ajustesAbiertos,
        ajustesExcluidos,
        suggested,
        estrategia:
          'temporada-pares'
      });


    // =====================================================
    // 8) CONSERVAR CONFIRMADOS
    // =====================================================

    SETS =
      fixedSetsMem
        .concat(
          fixedFromGruposFiltered
        )
        .concat(
          manuales
        )
        .concat(
          restantesSuggested
        );


    // =====================================================
    // 9) SEGURIDAD MULTI-COORDINADOR
    // =====================================================

    dedupeSetsInPlace();

    sortSetsInPlace();

    evaluarAlertas();

    render();


    // =====================================================
    // 10) ESTADÍSTICAS
    // =====================================================

    const resultadoNuevo =
      manuales.concat(
        restantesSuggested
      );


    const deUno =
      resultadoNuevo.filter(
        s =>
          s.viajes.length ===
          1
      ).length;


    const deDos =
      resultadoNuevo.filter(
        s =>
          s.viajes.length ===
          2
      ).length;


    const deTres =
      resultadoNuevo.filter(
        s =>
          s.viajes.length >=
          3
      ).length;


    const totalViajes =
      resultadoNuevo.reduce(
        (
          total,
          s
        ) =>
          total +
          s.viajes.length,
        0
      );


    L(
      'Temporada PARES resultado FINAL:',
      {
        viajes:
          totalViajes,

        gruposViaje:
          resultadoNuevo.length,

        uno:
          deUno,

        dos:
          deDos,

        tresOMas:
          deTres,

        ajustesCerrados:
          ajustesCerrados.length,

        ajustesAbiertos:
          ajustesAbiertos.length,

        cuposProcesados:
          pool.length
      }
    );


    // =====================================================
    // CONTROL
    // =====================================================

    if (
      deTres >
      0
    ) {
      W(
        'ATENCIÓN: temporada-pares contiene un SET con 3+ viajes.',
        resultadoNuevo
          .filter(
            s =>
              s.viajes.length >=
              3
          )
          .map(
            s =>
              ({
                viajes:
                  s.viajes,

                ajuste:
                  s.ajusteSugerencia ||
                  'normal'
              })
          )
      );
    }


  }finally{
    console.groupEnd();
  }
}

/* =========================================================
   CUPOS DE COORDINADORES POR GRUPO
   ========================================================= */

function getCantidadCoordinadoresGrupo(
  grupoOrId
){
  const g =
    typeof grupoOrId ===
      'string'
      ? ID2GRUPO.get(
          grupoOrId
        )
      : grupoOrId;


  const n =
    Number.parseInt(
      String(
        g?.cantidadCoordinadores ??
        1
      ),
      10
    );


  if (
    !Number.isFinite(n)
  ) {
    return 1;
  }


  return Math.min(
    3,
    Math.max(
      1,
      n
    )
  );
}


function getSetsQueContienenGrupo(
  grupoId,
  {
    soloConfirmados = false
  } = {}
){
  return SETS.filter(s => {
    if (
      soloConfirmados &&
      (
        !s.confirmado ||
        !s.coordinadorId
      )
    ) {
      return false;
    }


    return (
      s.viajes ||
      []
    ).includes(
      grupoId
    );
  });
}


function getCantidadCuposUsadosGrupo(
  grupoId
){
  return getSetsQueContienenGrupo(
    grupoId
  ).length;
}


function getCantidadAsignadaGrupo(
  grupoId
){
  const coordinadores =
    new Set();


  getSetsQueContienenGrupo(
    grupoId,
    {
      soloConfirmados:
        true
    }
  ).forEach(s => {
    if (
      s.coordinadorId
    ) {
      coordinadores.add(
        s.coordinadorId
      );
    }
  });


  return coordinadores.size;
}


function getCuposPendientesGrupo(
  grupoId
){
  return Math.max(
    0,
    getCantidadCoordinadoresGrupo(
      grupoId
    ) -
    getCantidadCuposUsadosGrupo(
      grupoId
    )
  );
}


function getCoberturaGrupo(
  grupoId
){
  const requeridos =
    getCantidadCoordinadoresGrupo(
      grupoId
    );

  const usados =
    getCantidadCuposUsadosGrupo(
      grupoId
    );

  const confirmados =
    getCantidadAsignadaGrupo(
      grupoId
    );


  return {
    requeridos,
    usados,
    confirmados,
    pendientes:
      Math.max(
        0,
        requeridos -
        usados
      )
  };
}

/* =========================================================
   Unicidad: cada viaje puede estar en un único conjunto
   ========================================================= */
function dedupeSetsInPlace() {
  // =====================================================
  // NUEVA REGLA:
  //
  // un grupo puede aparecer tantas veces
  // como cantidadCoordinadores indique.
  //
  // Pero:
  // - sólo una vez dentro del mismo SET
  // - un mismo coordinador no puede cubrir
  //   dos cupos del mismo grupo.
  //
  // Los confirmados tienen prioridad.
  // =====================================================

  const usadosPorGrupo =
    new Map();

  const usadosPorGrupoCoord =
    new Set();


  const indices =
    SETS
      .map(
        (_, idx) =>
          idx
      )
      .sort(
        (a, b) => {
          const A =
            SETS[a];

          const B =
            SETS[b];

          const aConfirmado =
            !!A.confirmado &&
            !!A.coordinadorId;

          const bConfirmado =
            !!B.confirmado &&
            !!B.coordinadorId;

          if (
            aConfirmado !==
            bConfirmado
          ) {
            return aConfirmado
              ? -1
              : 1;
          }

          return a - b;
        }
      );


  for (
    const idx
    of indices
  ) {
    const s =
      SETS[idx];

    const local =
      new Set();

    const nuevosViajes =
      [];


    for (
      const rawGid
      of (
        s.viajes ||
        []
      )
    ) {
      const gid =
        String(
          rawGid
        );


      if (
        !ID2GRUPO.has(
          gid
        )
      ) {
        continue;
      }


      // Nunca dos veces dentro
      // de la misma agenda.
      if (
        local.has(
          gid
        )
      ) {
        continue;
      }


      const requeridos =
        getCantidadCoordinadoresGrupo(
          gid
        );

      const usados =
        usadosPorGrupo.get(
          gid
        ) ||
        0;


      // Si ya alcanzó el máximo,
      // no agregar otro cupo.
      if (
        usados >=
        requeridos
      ) {
        continue;
      }


      // Un mismo coordinador no puede
      // cubrir dos cupos del mismo viaje.
      if (
        s.coordinadorId
      ) {
        const key =
          `${gid}__${s.coordinadorId}`;

        if (
          usadosPorGrupoCoord.has(
            key
          )
        ) {
          continue;
        }

        usadosPorGrupoCoord.add(
          key
        );
      }


      local.add(
        gid
      );

      nuevosViajes.push(
        gid
      );

      usadosPorGrupo.set(
        gid,
        usados + 1
      );
    }


    s.viajes =
      nuevosViajes;
  }


  L(
    'dedupeSetsInPlace multi-coordinador:',
    Object.fromEntries(
      usadosPorGrupo
    )
  );
}

function refreshSets() {
  L('refreshSets()');
  dedupeSetsInPlace();
  sortSetsInPlace();
  evaluarAlertas();
  render();
}


/* =========================================================
   Alertas / Consistencia (incluye aptitud destinos)
   ========================================================= */
function evaluarAlertas() {
  RT_COORD.evaluar();
}

/* =========================================================
   Acciones sobre viajes
   ========================================================= */
function seleccionarConjuntoDestino(
  grupoId
){
  if (!SETS.length) {
    alert(
      'Primero crea un grupo de viajes.'
    );

    return;
  }


  const g =
    ID2GRUPO.get(
      grupoId
    );


  if (!g) {
    alert(
      'No se encontró el grupo.'
    );

    return;
  }


  const cobertura =
    getCoberturaGrupo(
      grupoId
    );


  // =====================================================
  // SI YA ESTÁ COMPLETO NO DEJAMOS AGREGAR MÁS CUPOS
  // =====================================================

  if (
    cobertura.usados >=
    cobertura.requeridos
  ) {
    alert(
      `Este grupo ya tiene cubiertos sus ${cobertura.requeridos} cupo(s) de coordinador.`
    );

    return;
  }


  const n =
    prompt(
      `¿A qué grupo de viajes agregar este cupo? (1..${SETS.length})\n\n` +
      `Cobertura actual: ${cobertura.usados}/${cobertura.requeridos}`
    );


  if (!n) {
    return;
  }


  const idx =
    Number(n) -
    1;


  if (
    idx < 0 ||
    idx >= SETS.length
  ) {
    alert(
      'Número inválido.'
    );

    return;
  }


  const destino =
    SETS[idx];


  // =====================================================
  // EL MISMO GRUPO NO PUEDE ESTAR DOS VECES
  // DENTRO DEL MISMO SET.
  // =====================================================

  if (
    (
      destino.viajes ||
      []
    ).includes(
      grupoId
    )
  ) {
    alert(
      'Este grupo ya está dentro de ese grupo de viajes.'
    );

    return;
  }


  // =====================================================
  // SI EL SET YA TIENE COORDINADOR,
  // ESA MISMA PERSONA NO PUEDE CUBRIR OTRO CUPO
  // DEL MISMO GRUPO EN OTRO SET.
  // =====================================================

  if (
    destino.coordinadorId
  ) {
    const mismoCoordinadorYaUsado =
      SETS.some(
        (s, otroIdx) =>
          otroIdx !== idx &&
          s.coordinadorId ===
            destino.coordinadorId &&
          (
            s.viajes ||
            []
          ).includes(
            grupoId
          )
      );


    if (
      mismoCoordinadorYaUsado
    ) {
      const nombre =
        COORDS.find(
          c =>
            c.id ===
            destino.coordinadorId
        )?.nombre ||
        'Este coordinador';


      alert(
        `${nombre} ya cubre otro cupo de este mismo grupo. Debes usar otro coordinador.`
      );

      return;
    }
  }


  // =====================================================
  // IMPORTANTE:
  //
  // NO BORRAMOS grupoId DE LOS OTROS SETS.
  //
  // Puede aparecer:
  //
  // - 1 vez si requiere 1 coordinador
  // - 2 veces si requiere 2
  // - 3 veces si requiere 3
  // =====================================================

  destino.viajes.push(
    grupoId
  );


  destino.estadoCoord =
    'pendiente';


  refreshSets();
}
function moverViajeAotroConjunto(
  grupoId,
  desdeIdx
){
  if (
    SETS.length <= 1
  ) {
    alert(
      'No hay otro grupo de viajes.'
    );

    return;
  }


  const n =
    prompt(
      `Mover al grupo (1..${SETS.length}, distinto de ${desdeIdx + 1})`
    );


  if (!n) {
    return;
  }


  const to =
    Number(n) -
    1;


  if (
    to === desdeIdx ||
    to < 0 ||
    to >= SETS.length
  ) {
    alert(
      'Número inválido.'
    );

    return;
  }


  // El mismo grupo no puede aparecer dos veces
  // dentro del mismo SET.
  if (
    (
      SETS[to].viajes ||
      []
    ).includes(
      grupoId
    )
  ) {
    alert(
      'Ese grupo ya está dentro del grupo de viajes de destino.'
    );

    return;
  }


  // Si el destino ya tiene coordinador,
  // verificar que esa persona no esté cubriendo
  // otro cupo de este mismo grupo.
  const coordDestino =
    SETS[to].coordinadorId ||
    null;


  if (
    coordDestino
  ) {
    const repetido =
      SETS.some(
        (s, idx) =>
          idx !== desdeIdx &&
          idx !== to &&
          s.coordinadorId ===
            coordDestino &&
          (
            s.viajes ||
            []
          ).includes(
            grupoId
          )
      );


    if (repetido) {
      const nombre =
        COORDS.find(
          c =>
            c.id ===
            coordDestino
        )?.nombre ||
        'Ese coordinador';


      alert(
        `${nombre} ya cubre este grupo en otro grupo de viajes.`
      );

      return;
    }
  }


  SETS[desdeIdx].viajes =
    SETS[desdeIdx].viajes.filter(
      id =>
        id !== grupoId
    );


  SETS[to].viajes.push(
    grupoId
  );


  SETS[desdeIdx].estadoCoord =
    'pendiente';

  SETS[to].estadoCoord =
    'pendiente';


  refreshSets();
}
function agregarViajeAConjunto(
  setIdx
){
  const destino =
    SETS[setIdx];


  if (!destino) {
    return;
  }


  const usados =
    viajesUsadosSetIds();


  // =====================================================
  // GRUPOS QUE TODAVÍA TIENEN AL MENOS UN CUPO
  // =====================================================

  const libresAll =
    GRUPOS.filter(
      g =>
        !usados.has(
          g.id
        )
    );


  // =====================================================
  // NO MOSTRAR UN GRUPO QUE YA ESTÁ DENTRO DE ESTE SET
  //
  // Aunque necesite 2 o 3 coordinadores,
  // esos cupos deben estar en OTROS SETS.
  // =====================================================

  const candidatos =
    libresAll.filter(
      g =>
        !(
          destino.viajes ||
          []
        ).includes(
          g.id
        )
    );


  const libres =
    gruposFiltrados(
      candidatos
    );


  if (!libres.length) {
    alert(
      'No quedan viajes con cupos disponibles para agregar a este grupo de viajes.'
    );

    return;
  }


  const listado =
    libres
      .map(
        (g, i) => {
          const cobertura =
            getCoberturaGrupo(
              g.id
            );


          return (
            `${i + 1}) ` +
            `${g.aliasGrupo || g.nombreGrupo} ` +
            `[${fmtDMY(g.fechaInicio)}→${fmtDMY(g.fechaFin)}] ` +
            `• #${g.numeroNegocio} ` +
            `• Coord. ${cobertura.usados}/${cobertura.requeridos} ` +
            `• ${g.programa || ''} ` +
            `• ${g.destino || ''}`
          );
        }
      )
      .join(
        '\n'
      );


  const n =
    prompt(
      `Selecciona # de viaje a agregar:\n\n${listado}`
    );


  if (!n) {
    return;
  }


  const i =
    Number(n) -
    1;


  if (
    i < 0 ||
    i >= libres.length
  ) {
    alert(
      'Número inválido.'
    );

    return;
  }


  const elegido =
    libres[i];


  // =====================================================
  // SEGURIDAD EXTRA
  // =====================================================

  if (
    (
      destino.viajes ||
      []
    ).includes(
      elegido.id
    )
  ) {
    alert(
      'Este grupo ya está dentro de este grupo de viajes.'
    );

    return;
  }


  // =====================================================
  // SI EL SET YA TIENE COORDINADOR:
  //
  // comprobar que no esté cubriendo este mismo grupo
  // mediante otro SET.
  // =====================================================

  if (
    destino.coordinadorId
  ) {
    const yaLoCubre =
      SETS.some(
        (s, idx) =>
          idx !== setIdx &&
          s.coordinadorId ===
            destino.coordinadorId &&
          (
            s.viajes ||
            []
          ).includes(
            elegido.id
          )
      );


    if (yaLoCubre) {
      const nombre =
        COORDS.find(
          c =>
            c.id ===
            destino.coordinadorId
        )?.nombre ||
        'Este coordinador';


      alert(
        `${nombre} ya cubre otro cupo de este grupo.`
      );

      return;
    }
  }


  destino.viajes.push(
    elegido.id
  );


  destino.estadoCoord =
    'pendiente';


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
  SETS[a.setIdx].estadoCoord = 'pendiente';
  SETS[b.setIdx].estadoCoord = 'pendiente';
  refreshSets();
}

// Sugerir coordinador (filtra bloqueados, disponibilidad y aptitud por destino)
function sugerirCoordinador(i) {
  RT_COORD.sugerir(i);
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
async function saveOneCoord(i) {
  await RT_COORD.saveCoord(i);
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

function renderViajesStats() {
  RT_COORD.stats();
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
         
         <!-- ← NUEVO: FECHA NACIMIENTO (después del RUT) -->
         <td>
           <input
             type="text"
             class="picker-birth"
             data-i="${i}"
             value="${c.fechaNacimiento ? fmtDMY(c.fechaNacimiento) : ''}"
             placeholder="dd/mm/aaaa"
             readonly>
         </td>

         <!-- ← NUEVO: DATOS PARA TRANSFERIR (al lado de fecha nacimiento) -->
         <td>
           <input
             type="text"
             data-f="datosTransferir"
             data-i="${i}"
             value="${escapeHtml(c.datosTransferir||'')}"
             placeholder="Datos para transferir">
         </td>

         
         
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
   // ← NUEVO: datepicker para fecha de nacimiento
   tbodyCoords?.querySelectorAll('.picker-birth')?.forEach(inp=>{
     if (inp._flatpickr) inp._flatpickr.destroy();
     flatpickr(inp, {
       dateFormat:'d/m/Y',
       allowInput:true,
       onClose:(dates)=>{
         const i = +inp.dataset.i;
         if (dates.length===1){
           const iso = toISO(dates[0]);      // "YYYY-MM-DD"
           COORDS[i].fechaNacimiento = iso;
           inp.value = fmtDMY(iso);          // "dd/mm/aaaa"
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

function getHotelResumenHtmlForGroup(g){
  if (!g) return '';
  const gid = g.id;
  const lista = gid ? (HOTELES_POR_GRUPO.get(gid) || []) : [];
  if (!lista.length) return '';

  const partes = lista.map(h =>
    `${escapeHtml(h.nombre)} (${fmtDMY(h.ini)} → ${fmtDMY(h.fin)})`
  );
  return `<div class="muted">Hotel: ${partes.join(' · ')}</div>`;
}

function sameArr(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* =========================================================
   RESUMEN DE COORDINADORES QUE SE GRABA EN EL GRUPO
   ========================================================= */

function construirAsignacionesGrupoDesdeSets(
  grupoId
){
  const out =
    [];

  const coordinadoresUsados =
    new Set();


  SETS.forEach(s => {
    if (
      !s.confirmado ||
      !s.coordinadorId ||
      !s.id
    ) {
      return;
    }


    if (
      !(
        s.viajes ||
        []
      ).includes(
        grupoId
      )
    ) {
      return;
    }


    // Un coordinador sólo una vez
    // para el mismo grupo.
    if (
      coordinadoresUsados.has(
        s.coordinadorId
      )
    ) {
      return;
    }


    coordinadoresUsados.add(
      s.coordinadorId
    );


    const c =
      COORDS.find(
        x =>
          x.id ===
          s.coordinadorId
      );


    out.push({
      coordinadorId:
        s.coordinadorId,

      coordinador:
        c?.nombre ||
        '',

      conjuntoId:
        s.id,

      estadoCoord:
        normalizeEstado(
          s.estadoCoord
        ),

      anoViaje:
        Number(
          s.anoViaje ||
          ANO_COORDINADORES
        )
    });
  });


  return out;
}


function resolverEstadoResumenGrupo(
  asignaciones
){
  if (
    !asignaciones.length
  ) {
    return null;
  }


  const estados =
    asignaciones.map(
      a =>
        normalizeEstado(
          a.estadoCoord
        )
    );


  if (
    estados.includes(
      'rechazado'
    )
  ) {
    return 'rechazado';
  }


  if (
    estados.every(
      e =>
        e === 'aprobado'
    )
  ) {
    return 'aprobado';
  }


  return 'pendiente';
}


function construirPayloadCoordinadoresGrupo(
  grupoId
){
  const asignaciones =
    construirAsignacionesGrupoDesdeSets(
      grupoId
    );


  const primero =
    asignaciones[0] ||
    null;


  return {
    coordinadorIds:
      asignaciones.map(
        x =>
          x.coordinadorId
      ),

    coordinadores:
      asignaciones.map(
        x =>
          x.coordinador
      ),

    conjuntoIds:
      asignaciones.map(
        x =>
          x.conjuntoId
      ),

    coordinadoresAsignados:
      asignaciones,

    // ===================================================
    // COMPATIBILIDAD LEGACY
    // ===================================================

    coordinadorId:
      primero?.coordinadorId ||
      null,

    coordinador:
      primero?.coordinador ||
      null,

    conjuntoId:
      primero?.conjuntoId ||
      null,

    coordEstado:
      resolverEstadoResumenGrupo(
        asignaciones
      )
  };
}


function aplicarPayloadCoordinadoresEnMemoria(
  grupoId,
  payload
){
  const g =
    ID2GRUPO.get(
      grupoId
    );

  if (!g) {
    return;
  }


  Object.assign(
    g,
    payload
  );
}

/* =========================================================
   Guardar CAMBIOS (persiste SOLO confirmados)
   ========================================================= */
async function guardarTodo() {
  await RT_COORD.save();
}

async function reconstruirResumenGrupoDesdeFirestore(
  grupoId
){
  const g =
    ID2GRUPO.get(
      grupoId
    );

  if (!g) {
    return null;
  }


  const snap =
    await getDocs(
      query(
        collectionGroup(
          db,
          'conjuntos'
        ),
        where(
          'viajes',
          'array-contains',
          grupoId
        )
      )
    );


  const asignaciones =
    [];

  const usados =
    new Set();


  snap.forEach(d => {
    const x =
      d.data() ||
      {};

    if (
      !x.confirmado
    ) {
      return;
    }


    const ano =
      Number(
        x.anoViaje
      ) ||
      null;


    if (
      ano &&
      Number(
        g.anoViaje ||
        ANO_COORDINADORES
      ) !==
        ano
    ) {
      return;
    }


    const coordinadorId =
      d.ref.parent.parent.id;


    if (
      usados.has(
        coordinadorId
      )
    ) {
      return;
    }


    usados.add(
      coordinadorId
    );


    const c =
      COORDS.find(
        z =>
          z.id ===
          coordinadorId
      );


    asignaciones.push({
      coordinadorId,

      coordinador:
        c?.nombre ||
        '',

      conjuntoId:
        d.id,

      estadoCoord:
        normalizeEstado(
          x.estadoCoord
        ),

      anoViaje:
        Number(
          x.anoViaje ||
          ANO_COORDINADORES
        )
    });
  });


  const primero =
    asignaciones[0] ||
    null;


  const payload = {
    coordinadorIds:
      asignaciones.map(
        x =>
          x.coordinadorId
      ),

    coordinadores:
      asignaciones.map(
        x =>
          x.coordinador
      ),

    conjuntoIds:
      asignaciones.map(
        x =>
          x.conjuntoId
      ),

    coordinadoresAsignados:
      asignaciones,

    coordinadorId:
      primero?.coordinadorId ||
      null,

    coordinador:
      primero?.coordinador ||
      null,

    conjuntoId:
      primero?.conjuntoId ||
      null,

    coordEstado:
      resolverEstadoResumenGrupo(
        asignaciones
      )
  };


  await updateDoc(
    doc(
      db,
      'grupos',
      grupoId
    ),
    payload
  );


  aplicarPayloadCoordinadoresEnMemoria(
    grupoId,
    payload
  );


  return payload;
}

async function guardarSet(i) {
  await RT_COORD.save(i);
}
/* =========================================================
   EXCEL GESTIÓN COORDINADORES
   ========================================================= */


/* =========================================================
   HELPERS EXCEL
   ========================================================= */

function excelTexto(v){
  if (
    v === null ||
    v === undefined
  ) {
    return '';
  }

  return String(v).trim();
}


function normalizarRutExcel(v){
  return excelTexto(v)
    .replace(/\s+/g, '')
    .toUpperCase();
}


function disponibilidadAExcel(
  disponibilidad
){
  return (
    disponibilidad ||
    []
  )
    .map(r => {
      const ini =
        asISO(
          r?.inicio
        );

      const fin =
        asISO(
          r?.fin
        );

      if (
        !ini ||
        !fin
      ) {
        return '';
      }

      return `${ini}/${fin}`;
    })
    .filter(Boolean)
    .join('; ');
}


function disponibilidadDesdeExcel(
  valor
){
  const texto =
    excelTexto(
      valor
    );

  if (!texto) {
    return [];
  }

  return texto
    .split(/[;\n]+/)
    .map(
      parte =>
        parte.trim()
    )
    .filter(Boolean)
    .map(parte => {
      // Formato recomendado:
      //
      // 2026-09-01/2026-09-30

      let m =
        parte.match(
          /^(\d{4}-\d{2}-\d{2})\s*\/\s*(\d{4}-\d{2}-\d{2})$/
        );

      if (m) {
        return {
          inicio:
            m[1],

          fin:
            m[2]
        };
      }

      // También aceptamos:
      //
      // 01/09/2026 a 30/09/2026

      m =
        parte.match(
          /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(?:a|al|-)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/i
        );

      if (m) {
        const ini =
          `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;

        const fin =
          `${m[6]}-${String(m[5]).padStart(2,'0')}-${String(m[4]).padStart(2,'0')}`;

        return {
          inicio:
            ini,

          fin:
            fin
        };
      }

      return null;
    })
    .filter(
      r =>
        r &&
        r.inicio &&
        r.fin &&
        r.inicio <= r.fin
    );
}


function booleanDesdeExcel(
  valor,
  defaultValue = true
){
  const texto =
    norm(
      valor
    );

  if (!texto) {
    return defaultValue;
  }

  if (
    [
      'si',
      'sí',
      'true',
      '1',
      'activo',
      'activa',
      'ok'
    ].includes(
      texto
    )
  ) {
    return true;
  }

  if (
    [
      'no',
      'false',
      '0',
      'inactivo',
      'inactiva'
    ].includes(
      texto
    )
  ) {
    return false;
  }

  return defaultValue;
}


function getCampoExcel(
  fila,
  nombres
){
  for (
    const nombre
    of nombres
  ) {
    if (
      fila[nombre] !==
        undefined &&
      fila[nombre] !==
        null
    ) {
      return fila[nombre];
    }
  }

  // Fallback:
  // comparación sin tildes/mayúsculas.
  const buscados =
    nombres.map(
      n =>
        norm(n)
    );

  for (
    const [
      key,
      value
    ]
    of Object.entries(
      fila
    )
  ) {
    if (
      buscados.includes(
        norm(key)
      )
    ) {
      return value;
    }
  }

  return '';
}


/* =========================================================
   DATOS DE COORDINADOR PARA XLS
   ========================================================= */

function construirFilasExcelCoordinadores(){
  return COORDS
    .slice()
    .sort(
      (a, b) =>
        (
          a.nombre ||
          ''
        ).localeCompare(
          b.nombre ||
          '',
          'es',
          {
            sensitivity:
              'base'
          }
        )
    )
    .map(c => {
      const setsCoord =
        SETS.filter(
          s =>
            s.coordinadorId ===
              c.id
        );

      const viajesIds =
        new Set();

      setsCoord.forEach(
        s =>
          (
            s.viajes ||
            []
          ).forEach(
            gid =>
              viajesIds.add(
                gid
              )
          )
      );

      return {
        ID_COORDINADOR:
          c.id ||
          '',

        NOMBRE:
          c.nombre ||
          '',

        RUT:
          c.rut ||
          '',

        FECHA_NACIMIENTO:
          c.fechaNacimiento ||
          '',

        TELEFONO:
          c.telefono ||
          '',

        CORREO:
          c.correo ||
          '',

        DATOS_PARA_TRANSFERIR:
          c.datosTransferir ||
          '',

        DESTINOS:
          (
            c.destinos ||
            []
          ).join(
            ', '
          ),

        DISPONIBILIDAD:
          disponibilidadAExcel(
            c.disponibilidad
          ),

        ACTIVO:
          c.activo !== false
            ? 'SI'
            : 'NO',

        NOTAS:
          c.notas ||
          '',

        GRUPOS_DE_VIAJE:
          setsCoord.length,

        VIAJES_ASIGNADOS:
          viajesIds.size
      };
    });
}


/* =========================================================
   PLANIFICACIÓN
   Una fila = un grupo de viajes / SET
   ========================================================= */

function construirFilasExcelPlanificacion(){
  return SETS.map(
    (
      s,
      idx
    ) => {
      const coord =
        COORDS.find(
          c =>
            c.id ===
            s.coordinadorId
        );

      const viajes =
        (
          s.viajes ||
          []
        )
          .map(
            gid =>
              ID2GRUPO.get(
                gid
              )
          )
          .filter(Boolean)
          .sort(
            (a, b) =>
              cmpISO(
                a.fechaInicio,
                b.fechaInicio
              )
          );

      const row = {
        ANO:
          Number(
            s.anoViaje ||
            ANO_COORDINADORES
          ),

        N_GRUPO_VIAJES:
          idx + 1,

        ID_CONJUNTO:
          s.id ||
          '',

        ID_COORDINADOR:
          s.coordinadorId ||
          '',

        COORDINADOR:
          coord?.nombre ||
          '',

        CONFIRMADO:
          s.confirmado
            ? 'SI'
            : 'NO',

        ESTADO:
          normalizeEstado(
            s.estadoCoord
          ).toUpperCase(),

        CANTIDAD_VIAJES:
          viajes.length,

        ALERTAS:
          (
            s.alertas ||
            []
          )
            .map(
              a =>
                a.msg ||
                ''
            )
            .filter(Boolean)
            .join(
              ' | '
            )
      };

      // Actualmente tu sistema admite grupos de 1, 2 o 3
      // según la estrategia.
      //
      // Dejamos 3 bloques disponibles.

      for (
        let i = 0;
        i < 3;
        i++
      ) {
        const v =
          viajes[i];

        const n =
          i + 1;

        row[
          `VIAJE_${n}_ID`
        ] =
          v?.id ||
          '';

        row[
          `VIAJE_${n}_NEGOCIO`
        ] =
          v?.numeroNegocio ||
          '';

        row[
          `VIAJE_${n}_ALIAS`
        ] =
          v?.aliasGrupo ||
          v?.nombreGrupo ||
          '';

        row[
          `VIAJE_${n}_INICIO`
        ] =
          v?.fechaInicio ||
          '';

        row[
          `VIAJE_${n}_FIN`
        ] =
          v?.fechaFin ||
          '';

        row[
          `VIAJE_${n}_DESTINO`
        ] =
          v?.destino ||
          '';

        row[
          `VIAJE_${n}_PROGRAMA`
        ] =
          v?.programa ||
          '';
      }

      return row;
    }
  );
}


/* =========================================================
   VIAJES
   Una fila = un grupo real
   ========================================================= */

function construirFilasExcelViajes(){
  return GRUPOS
    .slice()
    .sort(
      (a, b) =>
        cmpISO(
          a.fechaInicio,
          b.fechaInicio
        )
    )
    .map(g => {
      const setsGrupo =
        SETS.filter(
          s =>
            (
              s.viajes ||
              []
            ).includes(
              g.id
            )
        );

      const coordinadores =
        setsGrupo
          .map(
            s =>
              COORDS.find(
                c =>
                  c.id ===
                  s.coordinadorId
              )?.nombre ||
              ''
          )
          .filter(Boolean);

      const estados =
        setsGrupo
          .map(
            s =>
              normalizeEstado(
                s.estadoCoord
              )
          )
          .filter(Boolean);

      const conjuntoIds =
        setsGrupo
          .map(
            s =>
              s.id ||
              ''
          )
          .filter(Boolean);

      const cobertura =
        getCoberturaGrupo(
          g.id
        );

      return {
        ANO:
          Number(
            g.anoViaje ||
            ANO_COORDINADORES
          ),

        ID_GRUPO:
          g.id ||
          '',

        NUMERO_NEGOCIO:
          g.numeroNegocio ||
          '',

        ALIAS:
          g.aliasGrupo ||
          '',

        NOMBRE_GRUPO:
          g.nombreGrupo ||
          '',

        FECHA_INICIO:
          g.fechaInicio ||
          '',

        FECHA_FIN:
          g.fechaFin ||
          '',

        DESTINO:
          g.destino ||
          '',

        PROGRAMA:
          g.programa ||
          '',

        COORDINADORES_REQUERIDOS:
          cobertura.requeridos,

        CUPOS_USADOS:
          cobertura.usados,

        CUPOS_CONFIRMADOS:
          cobertura.confirmados,

        COORDINADORES:
          coordinadores.join(
            ' | '
          ),

        ID_CONJUNTOS:
          conjuntoIds.join(
            ' | '
          ),

        ESTADOS:
          estados
            .map(
              e =>
                e.toUpperCase()
            )
            .join(
              ' | '
            )
      };
    });
}


/* =========================================================
   RESUMEN
   ========================================================= */

function construirFilasExcelResumen(){
  const stats =
    computeViajesStats();

  const viajesAsignados =
    new Set();

  SETS.forEach(
    s =>
      (
        s.viajes ||
        []
      ).forEach(
        gid =>
          viajesAsignados.add(
            gid
          )
      )
  );

  const activos =
    COORDS.filter(
      c =>
        c.activo !==
        false
    ).length;

  const usados =
    new Set(
      SETS
        .map(
          s =>
            s.coordinadorId
        )
        .filter(Boolean)
    ).size;

  return [
    {
      INDICADOR:
        'AÑO',

      VALOR:
        ANO_COORDINADORES
    },
    {
      INDICADOR:
        'COORDINADORES TOTALES',

      VALOR:
        COORDS.length
    },
    {
      INDICADOR:
        'COORDINADORES ACTIVOS',

      VALOR:
        activos
    },
    {
      INDICADOR:
        'COORDINADORES UTILIZADOS',

      VALOR:
        usados
    },
    {
      INDICADOR:
        'VIAJES / GRUPOS OPERATIVOS',

      VALOR:
        GRUPOS.length
    },
    {
      INDICADOR:
        'VIAJES CON AL MENOS UN CUPO ASIGNADO',

      VALOR:
        viajesAsignados.size
    },
    {
      INDICADOR:
        'VIAJES SIN ASIGNACIÓN',

      VALOR:
        Math.max(
          0,
          GRUPOS.length -
          viajesAsignados.size
        )
    },
    {
      INDICADOR:
        'GRUPOS DE VIAJE / SETS',

      VALOR:
        SETS.length
    },
    {
      INDICADOR:
        'SETS DE 1 VIAJE',

      VALOR:
        stats.dist?.[1] ||
        0
    },
    {
      INDICADOR:
        'SETS DE 2 VIAJES',

      VALOR:
        stats.dist?.[2] ||
        0
    },
    {
      INDICADOR:
        'SETS DE 3 VIAJES',

      VALOR:
        stats.dist?.[3] ||
        0
    },
    {
      INDICADOR:
        'SETS CONFIRMADOS',

      VALOR:
        stats.confirmados
    },
    {
      INDICADOR:
        'SETS CON COORDINADOR',

      VALOR:
        stats.conCoordinador
    },
    {
      INDICADOR:
        'CAMBIOS SIN DÍA LIBRE',

      VALOR:
        stats.paresSinDescanso
    },
    {
      INDICADOR:
        'SOLAPES DETECTADOS',

      VALOR:
        stats.paresSolapados
    },
    {
      INDICADOR:
        'ERRORES',

      VALOR:
        stats.totalErr
    },
    {
      INDICADOR:
        'AVISOS',

      VALOR:
        stats.totalWarn
    }
  ];
}


/* =========================================================
   FORMATO BÁSICO DE HOJA
   ========================================================= */

function prepararHojaExcel(
  ws,
  {
    freeze = true,
    autofilter = true
  } = {}
){
  const range =
    XLSX.utils.decode_range(
      ws['!ref'] ||
      'A1:A1'
    );

  if (freeze) {
    ws['!freeze'] = {
      xSplit:
        0,

      ySplit:
        1,

      topLeftCell:
        'A2',

      activePane:
        'bottomLeft',

      state:
        'frozen'
    };
  }

  if (autofilter) {
    ws['!autofilter'] = {
      ref:
        XLSX.utils.encode_range(
          {
            s: {
              r:
                0,

              c:
                range.s.c
            },

            e: {
              r:
                range.e.r,

              c:
                range.e.c
            }
          }
        )
    };
  }

  const widths =
    [];

  for (
    let c = range.s.c;
    c <= range.e.c;
    c++
  ) {
    let max =
      10;

    for (
      let r = range.s.r;
      r <= Math.min(
        range.e.r,
        200
      );
      r++
    ) {
      const ref =
        XLSX.utils.encode_cell(
          {
            r,
            c
          }
        );

      const val =
        ws[ref]?.v;

      if (
        val === undefined ||
        val === null
      ) {
        continue;
      }

      max =
        Math.max(
          max,
          String(
            val
          ).length +
          2
        );
    }

    widths.push({
      wch:
        Math.min(
          max,
          40
        )
    });
  }

  ws['!cols'] =
    widths;
}


/* =========================================================
   EXPORTAR XLSX COMPLETO
   ========================================================= */

function exportarGestionCoordinadoresExcel(){
  try{
    if (
      typeof XLSX ===
      'undefined'
    ) {
      alert(
        'No está disponible la librería XLSX.'
      );

      return;
    }

    evaluarAlertas();

    const wb =
      XLSX.utils.book_new();

    // ===================================================
    // 1) COORDINADORES
    //
    // ESTA ES LA HOJA DE IDA/VUELTA.
    // ===================================================

    const rowsCoords =
      construirFilasExcelCoordinadores();

    const wsCoords =
      XLSX.utils.json_to_sheet(
        rowsCoords,
        {
          header: [
            'ID_COORDINADOR',
            'NOMBRE',
            'RUT',
            'FECHA_NACIMIENTO',
            'TELEFONO',
            'CORREO',
            'DATOS_PARA_TRANSFERIR',
            'DESTINOS',
            'DISPONIBILIDAD',
            'ACTIVO',
            'NOTAS',
            'GRUPOS_DE_VIAJE',
            'VIAJES_ASIGNADOS'
          ]
        }
      );

    prepararHojaExcel(
      wsCoords
    );

    XLSX.utils.book_append_sheet(
      wb,
      wsCoords,
      'COORDINADORES'
    );


    // ===================================================
    // 2) PLANIFICACIÓN
    // ===================================================

    const rowsPlan =
      construirFilasExcelPlanificacion();

    const wsPlan =
      XLSX.utils.json_to_sheet(
        rowsPlan
      );

    prepararHojaExcel(
      wsPlan
    );

    XLSX.utils.book_append_sheet(
      wb,
      wsPlan,
      'PLANIFICACION'
    );


    // ===================================================
    // 3) VIAJES
    // ===================================================

    const rowsViajes =
      construirFilasExcelViajes();

    const wsViajes =
      XLSX.utils.json_to_sheet(
        rowsViajes
      );

    prepararHojaExcel(
      wsViajes
    );

    XLSX.utils.book_append_sheet(
      wb,
      wsViajes,
      'VIAJES'
    );


    // ===================================================
    // 4) RESUMEN
    // ===================================================

    const rowsResumen =
      construirFilasExcelResumen();

    const wsResumen =
      XLSX.utils.json_to_sheet(
        rowsResumen
      );

    prepararHojaExcel(
      wsResumen,
      {
        freeze:
          false,

        autofilter:
          false
      }
    );

    wsResumen['!cols'] = [
      {
        wch:
          42
      },
      {
        wch:
          16
      }
    ];

    XLSX.utils.book_append_sheet(
      wb,
      wsResumen,
      'RESUMEN'
    );


    // ===================================================
    // DESCARGAR
    // ===================================================

    const fecha =
      new Intl.DateTimeFormat(
        'en-CA',
        {
          timeZone:
            'America/Santiago'
        }
      ).format(
        new Date()
      );

    const nombre =
      `gestion-coordinadores-${ANO_COORDINADORES}-${fecha}.xlsx`;

    XLSX.writeFile(
      wb,
      nombre
    );

    L(
      'Excel coordinadores exportado:',
      {
        nombre,
        coordinadores:
          rowsCoords.length,

        sets:
          rowsPlan.length,

        viajes:
          rowsViajes.length
      }
    );

  }catch(err){
    E(
      'exportarGestionCoordinadoresExcel error:',
      err
    );

    alert(
      'No se pudo generar el Excel. Revisa la consola.'
    );
  }
}
/* =========================================================
   Carga por Excel (coordinadores)
   ========================================================= */
function handleExcel(evt){
  const file =
    evt.target.files?.[0];

  if (!file) {
    return;
  }

  const reader =
    new FileReader();


  reader.onload =
    e => {
      try{
        const wb =
          XLSX.read(
            e.target.result,
            {
              type:
                'array',

              cellDates:
                false
            }
          );


        // =================================================
        // HOJA A IMPORTAR
        //
        // Si viene del exportador nuevo usamos
        // COORDINADORES.
        //
        // Para Excels antiguos mantenemos compatibilidad
        // tomando la primera hoja.
        // =================================================

        const sheetName =
          wb.SheetNames.find(
            n =>
              norm(n) ===
              'coordinadores'
          ) ||
          wb.SheetNames[0];


        if (!sheetName) {
          throw new Error(
            'El archivo no contiene hojas.'
          );
        }


        const ws =
          wb.Sheets[
            sheetName
          ];


        const rows =
          XLSX.utils.sheet_to_json(
            ws,
            {
              defval:
                '',

              raw:
                false,

              blankrows:
                false
            }
          );


        // =================================================
        // ÍNDICES ACTUALES
        //
        // PRIORIDAD:
        //
        // 1. ID
        // 2. RUT
        // 3. NOMBRE
        // =================================================

        const byId =
          new Map(
            COORDS
              .filter(
                c =>
                  c.id
              )
              .map(
                c => [
                  String(
                    c.id
                  ),
                  c
                ]
              )
          );


        const byRut =
          new Map(
            COORDS
              .filter(
                c =>
                  c.rut
              )
              .map(
                c => [
                  normalizarRutExcel(
                    c.rut
                  ),
                  c
                ]
              )
          );


        const byName =
          new Map(
            COORDS
              .filter(
                c =>
                  c.nombre
              )
              .map(
                c => [
                  norm(
                    c.nombre
                  ),
                  c
                ]
              )
          );


        let actualizados =
          0;

        let nuevos =
          0;

        let omitidos =
          0;


        L(
          'Excel coordinadores:',
          {
            hoja:
              sheetName,

            filas:
              rows.length
          }
        );


        for (
          const r
          of rows
        ) {
          // ===============================================
          // IDENTIFICADORES
          // ===============================================

          const idExcel =
            excelTexto(
              getCampoExcel(
                r,
                [
                  'ID_COORDINADOR',
                  'ID COORDINADOR',
                  'idCoordinador',
                  'id'
                ]
              )
            );


          const nombre =
            excelTexto(
              getCampoExcel(
                r,
                [
                  'NOMBRE',
                  'Nombre',
                  'nombre'
                ]
              )
            );


          if (!nombre) {
            omitidos++;
            continue;
          }


          const rut =
            normalizarRutExcel(
              getCampoExcel(
                r,
                [
                  'RUT',
                  'rut'
                ]
              )
            );


          // ===============================================
          // DATOS
          // ===============================================

          const fechaNacimientoRaw =
            getCampoExcel(
              r,
              [
                'FECHA_NACIMIENTO',
                'FECHA NACIMIENTO',
                'Fecha Nacimiento',
                'Fecha_nacimiento',
                'fechaNacimiento'
              ]
            );


          const fechaNacimiento =
            asISO(
              fechaNacimientoRaw
            ) ||
            (
              /^\d{4}-\d{2}-\d{2}$/.test(
                excelTexto(
                  fechaNacimientoRaw
                )
              )
                ? excelTexto(
                    fechaNacimientoRaw
                  )
                : null
            );


          const telefono =
            excelTexto(
              getCampoExcel(
                r,
                [
                  'TELEFONO',
                  'TELÉFONO',
                  'Telefono',
                  'Teléfono',
                  'telefono',
                  'tel',
                  'Tel'
                ]
              )
            );


          const correo =
            excelTexto(
              getCampoExcel(
                r,
                [
                  'CORREO',
                  'Correo',
                  'correo',
                  'EMAIL',
                  'Email',
                  'email'
                ]
              )
            )
              .toLowerCase();


          const transfer =
            excelTexto(
              getCampoExcel(
                r,
                [
                  'DATOS_PARA_TRANSFERIR',
                  'DATOS PARA TRANSFERIR',
                  'Datos para transferir',
                  'datosTransferir',
                  'datos_para_transferir'
                ]
              )
            );


          const destinosCell =
            excelTexto(
              getCampoExcel(
                r,
                [
                  'DESTINOS',
                  'Destinos',
                  'destinos'
                ]
              )
            );


          const destinos =
            cleanDestinos(
              destinosCell
                .split(
                  /[,;\n]+/
                )
            );


          const disponibilidadCell =
            getCampoExcel(
              r,
              [
                'DISPONIBILIDAD',
                'Disponibilidad',
                'disponibilidad'
              ]
            );


          const disponibilidad =
            disponibilidadDesdeExcel(
              disponibilidadCell
            );


          const activoRaw =
            getCampoExcel(
              r,
              [
                'ACTIVO',
                'Activo',
                'activo'
              ]
            );


          const notas =
            excelTexto(
              getCampoExcel(
                r,
                [
                  'NOTAS',
                  'Notas',
                  'notas'
                ]
              )
            );


          // ===============================================
          // ENCONTRAR REGISTRO
          // ===============================================

          let c =
            (
              idExcel &&
              byId.get(
                idExcel
              )
            ) ||
            (
              rut &&
              byRut.get(
                rut
              )
            ) ||
            byName.get(
              norm(
                nombre
              )
            ) ||
            null;


          // ===============================================
          // ACTUALIZAR EXISTENTE
          // ===============================================

          if (c) {
            c.nombre =
              nombre;

            c.rut =
              rut;

            c.telefono =
              telefono;

            c.correo =
              correo;

            c.fechaNacimiento =
              fechaNacimiento;

            c.datosTransferir =
              transfer;

            // IMPORTANTE:
            //
            // Como este nuevo Excel es realmente
            // ida/vuelta, el valor de la celda manda.
            //
            // Si DESTINOS está vacío:
            // queda [] = apto para todos.
            c.destinos =
              destinos;

            c.disponibilidad =
              disponibilidad;

            c.activo =
              booleanDesdeExcel(
                activoRaw,
                c.activo !== false
              );

            c.notas =
              notas;


            actualizados++;


          // ===============================================
          // NUEVO COORDINADOR
          // ===============================================

          } else {
            c = {
              id:
                null,

              nombre,

              rut,

              fechaNacimiento,

              datosTransferir:
                transfer,

              telefono,

              correo,

              destinos,

              disponibilidad,

              activo:
                booleanDesdeExcel(
                  activoRaw,
                  true
                ),

              notas,

              _isNew:
                true
            };


            COORDS.unshift(
              c
            );


            nuevos++;
          }


          // ===============================================
          // ACTUALIZAR ÍNDICES
          // ===============================================

          if (c.id) {
            byId.set(
              String(
                c.id
              ),
              c
            );
          }


          if (c.rut) {
            byRut.set(
              normalizarRutExcel(
                c.rut
              ),
              c
            );
          }


          if (c.nombre) {
            byName.set(
              norm(
                c.nombre
              ),
              c
            );
          }
        }


        // =================================================
        // REFRESCAR PANTALLA
        //
        // NO GUARDAMOS TODAVÍA EN FIRESTORE.
        //
        // El usuario revisa y luego usa:
        // "Guardar coordinadores".
        // =================================================

        renderCoordsTable();

        setTimeout(
          initPickers,
          10
        );


        alert(
          `Excel cargado correctamente.\n\n` +
          `Actualizados: ${actualizados}\n` +
          `Nuevos: ${nuevos}\n` +
          `Filas omitidas: ${omitidos}\n\n` +
          `Revisa los datos y luego presiona "Guardar coordinadores".`
        );


        L(
          'handleExcel resultado:',
          {
            actualizados,
            nuevos,
            omitidos
          }
        );


      }catch(err){
        E(
          'handleExcel error:',
          err
        );


        alert(
          'No se pudo leer el Excel.\n\n' +
          'Puedes cargar el mismo archivo descargado desde Gestión Coordinadores ' +
          'o un Excel antiguo que tenga al menos la columna NOMBRE.'
        );


      }finally{
        evt.target.value =
          '';
      }
    };


  // =====================================================
  // CAMBIAMOS DE binary A ArrayBuffer
  // =====================================================

  reader.readAsArrayBuffer(
    file
  );
}

/* =========================================================
   Boot
   ========================================================= */
async function __bootCoordinadores() {
  RT_COORD.montar();

  SETS = [];

  try {
    await loadCoordinadores();
    await loadGrupos();
    await loadHorasViajes();
    await loadHotelAssignments();

    populateFilterOptions();

    await loadSets();

    render();

  } catch (error) {
    console.error(
      '[coordinadores] Error de carga',
      error
    );

    if (elMsg) {
      elMsg.textContent = error.message;
    }

    document
      .getElementById('btn-guardar')
      ?.setAttribute('disabled', '');

    throw error;
  }

  document
    .getElementById('btn-guardar')
    ?.removeAttribute('disabled');
}

// 🔁 Ejecuta el boot siempre (con o sin DOMContentLoaded)
if (document.readyState === 'loading'){
  window.addEventListener('DOMContentLoaded', __bootCoordinadores, { once:true });
} else {
  // El DOM ya está listo: corre inmediatamente
  __bootCoordinadores();
}


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
