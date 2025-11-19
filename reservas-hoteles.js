// reservas-hoteles.js — Hotel → Grupo → Día (almuerzo/cena)
// Importes Firebase
import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, getDoc, setDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

// =============== Estado global ===============
let HOTELES = [];          // docs de 'hoteles'
let ASIGNS  = [];          // docs de 'hotelAssignments'
let GRUPOS  = [];          // docs de 'grupos' (con itinerario)
let AGG     = new Map();   // hotelId -> { hotel, grupos: Map(grupoId -> {info, dias, totAlm, totCen}), totAlm, totCen }
let INDEX_OCUP = new Map();// grupoId -> Map(fechaISO -> { hotelId, asg })
let INDEX_ITIN = new Map();// grupoId -> Map(fechaISO -> { text, almCount, cenCount })

let DT = null;             // DataTable principal

// =============== Encabezado + Login ===============
(async function mountHeader(){
  try {
    const r = await fetch('encabezado.html');
    const html = await r.text();
    document.getElementById('encabezado').innerHTML = html;
  } catch(e) { console.warn('No pude cargar encabezado.html', e); }
})();

const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if (!user) { location.href = 'login.html'; return; }
  init();
});
document.body.addEventListener('click', (e)=>{
  if (e.target?.id === 'logoutBtn') signOut(auth);
});

// =============== Helpers ===============
const toISO = (x) => {
  if (!x) return '';
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  const d = new Date(x);
  return isNaN(d) ? '' : d.toISOString().slice(0,10);
};
const fmt = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
};
// === Helpers fecha MAYÚS ===
const MES_ABR = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
const fmtDiaMayus = (iso) => {
  if (!iso) return '';
  const [y,m,d] = iso.split('-');
  const di = String(parseInt(d,10));
  const mi = MES_ABR[(parseInt(m,10)-1) || 0] || '';
  return `➡️ Fecha ${di} DE ${mi}`;
};

// === Ordenación A→Z (soporta español y números) ===
const COLL = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
const cmpAZ = (a, b) => COLL.compare(String(a ?? ''), String(b ?? ''));

// Nombre visible para ordenar (prioriza alias)
const nombreVisibleGrupo = (g) => (g?.alias || g?.nombreGrupo || '').trim();

// Etiqueta estándar de grupo para listas/correos
const etiquetaGrupo = (g) => {
  return `(${g.numeroNegocio || ''}) ${g.identificador ? g.identificador + ' – ' : ''}${(g.alias || g.nombreGrupo || '').trim()}`;
};

// ===== Buscador avanzado (coma = OR, punto = AND) =====
// Ejemplos:
//  - "ipanema"                         -> contiene "ipanema" en hotel/destino/ciudad o en algún grupo
//  - "ipanema.pendiente"               -> (AND) ipanema y estado PENDIENTE
//  - "ipanema,enviada"                 -> (OR) ipanema  O  estado ENVIADA
//  - "noches:3" o "n:3"                -> algún grupo con 3 noches (también sirve sólo "3")
function parseSearch(raw){
  const s = norm(raw || '');
  if (!s) return [];
  return s.split(',')                         // OR por coma
          .map(cl => cl.trim())
          .filter(Boolean)
          .map(cl => cl.split('.')            // AND por punto
                       .map(t => t.trim())
                       .filter(Boolean));
}

function matchesHotelRec({rec, nombre, destino, ciudad}, clauses, year){
  if (!clauses.length) return true;

  const estHotel = norm(estadoHotelParaAnio(rec.hotel, year) || '');
  const hotelBlob = norm(`${nombre} ${destino} ${ciudad}`);

  const gruposArr  = [...rec.grupos.values()];
  const groupBlobs = gruposArr.map(g => ({
    g,
    blob: norm(`${g.numeroNegocio||''} ${(g.identificador||'')} ${(g.alias||g.nombreGrupo||'')}`)
  }));

  // evalúa un término contra hotel y grupos
  function termMatches(term){
    if (!term) return true;

    // noches:NN o n:NN
    const m1 = term.match(/^noches?:(\d{1,3})$/);
    const m2 = term.match(/^n:(\d{1,3})$/);
    if (m1 || m2){
      const n = parseInt((m1 ? m1[1] : m2[1]), 10);
      return gruposArr.some(x => Number(x.noches||0) === n);
    }

    // estado del hotel (filtrado por año)
    if (term === 'pendiente' || term === 'enviada'){
      return estHotel === term.toUpperCase();
    }

    // número simple: lo interpreto como noches exactas de algún grupo
    if (/^\d+$/.test(term)){
      const n = Number(term);
      if (gruposArr.some(x => Number(x.noches||0) === n)) return true;
    }

    // coincidencia por texto
    if (hotelBlob.includes(term)) return true;
    return groupBlobs.some(({blob}) => blob.includes(term));
  }

  // OR entre cláusulas; AND dentro de cada cláusula
  return clauses.some(andTerms => andTerms.every(termMatches));
}

// === Estado del botón por hotel y año seleccionado ===
// Prioridad: ENVIADA > PENDIENTE > (vacío = "Reservar")
function estadoHotelParaAnio(hotelDoc, year){
  const map = hotelDoc?.reservasAlimentos || {};
  let hasPend = false;
  for (const [fecha, info] of Object.entries(map)) {
    if (year && !String(fecha).startsWith(year + '-')) continue;
    const st = String(info?.estado || '').toUpperCase();
    if (st === 'ENVIADA') return 'ENVIADA';
    if (st === 'PENDIENTE') hasPend = true;
  }
  return hasPend ? 'PENDIENTE' : '';
}

// sumar días a un ISO (YYYY-MM-DD)
function addDaysISO(iso, add){
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + (add||0));
  return d.toISOString().slice(0,10);
}

// Construye el bloque "DETALLE POR DÍA" usando rec.porDia
function buildBloqueDia(rec){
  const entries = (rec?.porDia instanceof Map)
    ? [...rec.porDia.entries()]
    : Object.entries(rec?.porDia || {});
  entries.sort((a,b)=> a[0].localeCompare(b[0]));

  let out = '';
  for (const [fecha, listRaw] of entries){
    const list = Array.isArray(listRaw)
      ? listRaw
      : (listRaw instanceof Map ? [...listRaw.values()] : []);
    const almList = list.filter(it => Number(it.alm) > 0);
    const cenList = list.filter(it => Number(it.cen) > 0);
    if (!almList.length && !cenList.length) continue;

    out += `${fmtDiaMayus(fecha)}:\n`;
    if (almList.length){
      out += `- ALMUERZO:\n`;
      almList.forEach((it, idx) => {
        const etiqueta = `(${it.numeroNegocio || ''}) ${it.identificador ? it.identificador+' – ' : ''}${(it.alias || it.nombreGrupo || '').trim()}`;
        out += `       ${idx+1}) ${etiqueta} (${Number(it.pax||0)} PAX)\n`;
      });
    }
    if (cenList.length){
      out += `- CENA:\n`;
      cenList.forEach((it, idx) => {
        const etiqueta = `(${it.numeroNegocio || ''}) ${it.identificador ? it.identificador+' – ' : ''}${(it.alias || it.nombreGrupo || '').trim()}`;
        out += `       ${idx+1}) ${etiqueta} (${Number(it.pax||0)} PAX)\n`;
      });
    }
    out += `\n`;
  }
  return out.trimEnd();
}

function* eachDateISO(startISO, endISOExcl){
  let d = new Date(startISO + 'T00:00:00');
  const end = new Date(endISOExcl + 'T00:00:00');
  for (; d < end; d.setDate(d.getDate()+1)) {
    yield d.toISOString().slice(0,10);
  }
}

// Devuelve la fecha anterior en ISO (YYYY-MM-DD)
function prevDateISO(iso){
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0,10);
}

// Rango de estadía (noche mínima y máxima) del grupo en un hotel.
// Incluye además el día de CHECK-OUT (último día aunque no haya noche).
function stayRangeForGrupoHotel(grupoId, hotelId){
  // Noches ocupadas por ese grupo
  const occ = INDEX_OCUP.get(grupoId) || new Map();
  let min = null, max = null;
  for (const [iso, info] of occ.entries()){
    if (info?.hotelId !== hotelId) continue;
    if (!min || iso < min) min = iso;
    if (!max || iso > max) max = iso;
  }

  // Fallback: si no encontrara noches (caso extremo), usar días con comidas ya detectados
  if (!min || !max){
    const recH = AGG.get(hotelId);
    const g = recH?.grupos?.get(grupoId);
    const keys = g ? [...g.dias.keys()].sort() : [];
    if (keys.length){
      min = min || keys[0];
      max = max || keys[keys.length - 1];
    }
  }

  if (!min || !max) return null;

  // El día de check-out es el día siguiente a la última noche
  const checkout = addDaysISO(max, 1);
  return { start:min, end:max, checkout };
}

// Empareja "noches sin cena" con "días con almuerzo sin cena" dentro del hotel
function listReemplazos(grupo, hotelId){
  const gid   = grupo.grupoId || grupo.id;
  const range = stayRangeForGrupoHotel(gid, hotelId);
  if (!range) return [];

  // 1) Noches sin cena: desde la 1ª noche hasta la ÚLTIMA NOCHE (excluye checkout)
  const missingCen = [];
  let iso = range.start;
  while (true){
    const d = grupo.dias.get(iso) || { alm:0, cen:0 };
    if (Number(d.cen) === 0) missingCen.push(iso);
    if (iso === range.end) break;           // solo noches
    iso = addDaysISO(iso, 1);
  }

  // 2) Días con ALMUERZO pero sin CENA: desde la 1ª noche hasta CHECK-OUT (INCLUYE checkout)
  const lunchesOnly = [];
  iso = range.start;
  while (true){
    const d = grupo.dias.get(iso) || { alm:0, cen:0 };
    if (Number(d.alm) === 1 && Number(d.cen) === 0) lunchesOnly.push(iso);
    if (iso === range.checkout) break;      // incluye check-out
    iso = addDaysISO(iso, 1);
  }

  // 3) Emparejar: primero "mismo día", si no hay, la noche sin cena más temprana libre
  const pairs = [];
  const usados = new Set();

  for (const L of lunchesOnly){
    // a) mismo día
    let M = missingCen.find(md => !usados.has(md) && md === L);
    // b) si no, la primera noche sin cena disponible
    if (!M) M = missingCen.find(md => !usados.has(md));
    if (!M) break;

    usados.add(M);
    pairs.push({ miss: M, lunch: L });
  }

  return pairs;
}

const stripAccents = s => (s||'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const norm = s => stripAccents(String(s||'').toLowerCase().trim());

// ====== Años disponibles desde los días detectados (rec.porDia) ======
function populateFiltroAno(){
  const sel = document.getElementById('filtroAno');
  if (!sel) return;
  const years = new Set();

  for (const [, rec] of AGG.entries()){
    const porDia = rec.porDia || new Map();
    // porDia puede ser Object o Map
    if (porDia instanceof Map){
      for (const iso of porDia.keys()){
        if (iso && /^\d{4}-/.test(iso)) years.add(iso.slice(0,4));
      }
    } else {
      for (const iso of Object.keys(porDia || {})){
        if (iso && /^\d{4}-/.test(iso)) years.add(iso.slice(0,4));
      }
    }
  }

  const current = sel.value;
  sel.innerHTML = `<option value="">TODOS</option>` +
    Array.from(years).sort().map(y => `<option value="${y}">${y}</option>`).join('');

  // si existía selección previa, la conservamos
  if ([...years].includes(current)) sel.value = current;
}

// === Totales robustos por grupo (funciona con g.dias ó con g.totAlm/totCen) ===
function sumGrupoDesdeDias(g){
  const vals = g?.dias instanceof Map ? [...g.dias.values()]
             : Array.isArray(g?.dias) ? g.dias
             : Object.values(g?.dias || {});
  return {
    alm: vals.reduce((s,d)=> s + Number(d?.alm || 0), 0),
    cen: vals.reduce((s,d)=> s + Number(d?.cen || 0), 0),
  };
}

function totalesDeGrupo(g){
  // si hay días, SIEMPRE sumar desde g.dias
  const hasDias =
    (g?.dias instanceof Map   && g.dias.size > 0) ||
    (Array.isArray(g?.dias)   && g.dias.length > 0) ||
    (g?.dias && typeof g.dias === 'object' && Object.keys(g.dias).length > 0);

  if (hasDias) return sumGrupoDesdeDias(g);

  // fallback: usar totAlm/totCen si no hay días disponibles
  return { alm: Number(g?.totAlm || 0), cen: Number(g?.totCen || 0) };
}


// Filtra un 'rec' (entrada de AGG por hotel) solo al año indicado
function recForYear(rec, year){
  if (!year) return rec;

  const porDia = rec.porDia || new Map();

  const byDay = (porDia instanceof Map)
    ? [...porDia.entries()].filter(([iso]) => String(iso).startsWith(year + '-'))
    : Object.entries(porDia || {}).filter(([iso]) => String(iso).startsWith(year + '-'));

  const grupos = new Map();
  let totAlm = 0, totCen = 0;

  for (const [, list] of byDay){
    (list || []).forEach(it => {
      const gid = it.grupoId || it.gid || it.grupo || '';
      const g = grupos.get(gid) || {
        grupoId: gid,
        numeroNegocio: it.numeroNegocio || '',
        nombreGrupo: it.nombreGrupo || it.name || '',
        identificador: it.identificador || '',
        totAlm: 0,
        totCen: 0
      };
      g.totAlm += Number(it.alm || 0);
      g.totCen += Number(it.cen || 0);
      grupos.set(gid, g);

      totAlm += Number(it.alm || 0);
      totCen += Number(it.cen || 0);
    });
  }

  const filteredPorDia = new Map(byDay.map(([iso, list]) => [iso, list]));
  return { hotel: rec.hotel, grupos, totAlm, totCen, porDia: filteredPorDia };
}


// regex robustas (ajustadas)
const NEG = /(no incluye|por cuenta|libre|sin\s+(almuerzo|cena))/i;

// Solo aceptamos "almuerzo" o "cena" (sin 'lunch')
const R_ALM = /\b(almuerzo|alm\.)\b/i;
const R_CEN = /\b(cena|cen\.)\b/i;

const R_HOT = /\bhotel\b/i;                 // token "hotel" (por compat, puede quedar)
const R_BOX = /\bbox\s*lunch\b/i;            // excluir "box lunch"
const R_EN_HOTEL = /\ben\s+hotel\b/i;        // "en hotel ..." no cuenta como pensión

// Acepta "CENA HOTEL", "ALMUERZO - HOTEL", "CENA: HOTEL" (adyacentes)
const R_COMIDA_HOTEL_ADY = /\b(almuerzo|cena)\s*(?:-|:)?\s*hotel\b/i;

const isAlmuerzoHotel = (s) =>
  R_ALM.test(s) && R_COMIDA_HOTEL_ADY.test(s) && !R_BOX.test(s) && !NEG.test(s);

const isCenaHotel = (s) =>
  R_CEN.test(s) && R_COMIDA_HOTEL_ADY.test(s) && !R_BOX.test(s) && !NEG.test(s);


// ✔︎ helper visual
const tick = v => (v ? '✓' : '—');

// ✔︎ calcula estado/alertas según pensión y noches
function calcEstadoGrupo(pension, noches, almDias, cenDias, diasMap){
  const pen = (pension || '').toLowerCase();
  const total = almDias + cenDias;

  // desgloses por día (para media pensión)
  let zeroDays = 0, doubleDays = 0;
  if (diasMap && diasMap.size){
    for (const d of diasMap.values()){
      const s = Number(d.alm||0) + Number(d.cen||0);
      if (s === 0) zeroDays++;
      if (s > 1)   doubleDays++;
    }
  }

  let ok = true;
  const notes = [];
  if (pen === 'completa'){
    if (almDias !== noches) { ok = false; notes.push(`almuerzos ${almDias}/${noches}`); }
    if (cenDias !== noches) { ok = false; notes.push(`cenas ${cenDias}/${noches}`); }
  } else if (pen === 'media'){
    if (total !== noches)   { ok = false; notes.push(`total servicios ${total}/${noches}`); }
    if (zeroDays > 0)       { ok = false; notes.push(`${zeroDays} día(s) sin servicio`); }
    if (doubleDays > 0)     { ok = false; notes.push(`${doubleDays} día(s) con 2 servicios`); }
  } else {
    // sin dato: no exigimos, pero lo mostramos
    notes.push('pensión sin dato');
  }
  return { ok, label: ok ? 'OK' : 'Revisar', detail: notes.join('; ') };
}

// --- helpers de timestamp para ordenar por "el último guardado" ---
function toMillis(x){
  if (!x) return 0;
  if (typeof x === 'number') return x;
  if (typeof x === 'string') { const t = Date.parse(x); return isNaN(t) ? 0 : t; }
  // Firestore Timestamp u objeto con toDate()
  if (typeof x.toDate === 'function') return +x.toDate();
  if (x.seconds !== undefined) return x.seconds * 1000 + Math.floor((x.nanoseconds||0)/1e6);
  if (x instanceof Date) return +x;
  return 0;
}
const savedAtOf = (asg) =>
  Math.max(
    toMillis(asg?.updatedAt),
    toMillis(asg?.createdAt),
    toMillis(asg?.changedAt) // por si usas otro campo
  );


// =============== Carga base ===============
async function loadAll(){
  const [snapH, snapA, snapG] = await Promise.all([
    getDocs(collection(db,'hoteles')),
    getDocs(collection(db,'hotelAssignments')),
    getDocs(collection(db,'grupos'))
  ]);
  HOTELES = snapH.docs.map(d=>({ id:d.id, ...d.data() }));
  ASIGNS  = snapA.docs.map(d=>({ id:d.id, ...d.data() }));
  GRUPOS  = snapG.docs.map(d=>({ id:d.id, ...d.data() }));
}

// =============== Index ocupación por día (checkIn ≤ D < checkOut)
// Regla: si dos asignaciones tocan el MISMO día, gana la más reciente (por timestamp)
function buildIndexOcup(){
  INDEX_OCUP = new Map();

  for (const a of ASIGNS) {
    const gid = a?.grupoId, hid = a?.hotelId;
    const ci  = toISO(a?.checkIn), co = toISO(a?.checkOut);
    if (!gid || !hid || !ci || !co) continue;

    // ignora canceladas/anuladas si usas estos flags/campos
    const estado = String(a.estado || a.status || '').toLowerCase();
    const anulado = !!a.anulado || !!a.cancelado;
    if (anulado || estado === 'anulado' || estado === 'cancelado') continue;

    const byDate = INDEX_OCUP.get(gid) || new Map();
    const stamp  = savedAtOf(a);

    for (const d of eachDateISO(ci, co)) {
      const prev = byDate.get(d);
      if (!prev) {
        byDate.set(d, { hotelId: hid, asg: a, conflict: false, _ts: stamp });
      } else {
        const prevTs = prev._ts || 0;
        let winner = prev;
        if (stamp > prevTs) {
          winner = { hotelId: hid, asg: a, _ts: stamp };
        } else if (stamp === prevTs) {
          // desempate estable por id
          const prevId = String(prev.asg?.id || prev.asg?.__id || '');
          const curId  = String(a.id || a.__id || '');
          if (curId > prevId) winner = { hotelId: hid, asg: a, _ts: stamp };
        }
        byDate.set(d, { ...winner, conflict: true });
      }
    }
    INDEX_OCUP.set(gid, byDate);
  }
}

// ===== Helpers para ordenar por hora y render seguro =====
const escHTML = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const toMinHM = (v) => {
  if (!v) return 1e9; // sin hora => al final
  const m = String(v).match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return 1e9;
  return (parseInt(m[1],10)*60) + parseInt(m[2],10);
};
const startMinOf = (it) =>
  Math.min(toMinHM(it?.horaInicio), toMinHM(it?.hora), toMinHM(it?.inicio), toMinHM(it?.desde));
const endMinOf = (it) =>
  Math.min(toMinHM(it?.horaFin), toMinHM(it?.fin), toMinHM(it?.hasta));

const cmpItin = (a,b) =>
  (startMinOf(a) - startMinOf(b)) ||
  (endMinOf(a)   - endMinOf(b))   ||
  String(a?.actividad||a?.texto||'').localeCompare(String(b?.actividad||b?.texto||''));

const fmtHM = (v) => {
  const m = String(v||'').match(/(\d{1,2})[:.](\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : '';
};
const labelOf = (it) => {
  const h = fmtHM(it?.horaInicio || it?.hora || it?.inicio);
  const raw = escHTML(it?.actividad || it?.texto || '');
  return `${h ? `[${h}] ` : ''}${raw}`;
};

// Palabras clave
const R_CHECKOUT = /(check\s*[- ]?out|salida\s+del?\s+hotel|checkout)/i;

function buildIndexItin(){
  INDEX_ITIN = new Map();

  for (const g of GRUPOS) {
    const idx = new Map();
    const itin = g.itinerario || {};

    for (const [fecha, arr] of Object.entries(itin)) {
      const items = Array.isArray(arr) ? arr.slice() : [];
      items.sort(cmpItin);

      let almC = 0, cenC = 0;
      const plain = [];
      const html  = [];
      const meals = [];         // [{kind:'alm'|'cen', tmin:Number, label:String}]
      let chkMin  = 1e9;        // minuto del primer "check-out" del día (si hay)

      for (const it of items) {
        const s = norm(it?.actividad || it?.texto || '');
        if (!s) continue;

        // detectar check-out
        if (R_CHECKOUT.test(s)) {
          const t = startMinOf(it);
          if (t < chkMin) chkMin = t;
        }

        // detección comidas de hotel
        const hasAlm = isAlmuerzoHotel(s);
        const hasCen = isCenaHotel(s);

        if (hasAlm) { almC++; meals.push({ kind:'alm', tmin:startMinOf(it), label: labelOf(it) }); }
        if (hasCen) { cenC++; meals.push({ kind:'cen', tmin:startMinOf(it), label: labelOf(it) }); }

        const label = labelOf(it);
        plain.push(label);
        if (hasAlm || hasCen) html.push(`<span class="pill-blue">${label}</span>`); else html.push(label);
      }

      idx.set(toISO(fecha), {
        text: plain.join(' | '),       // texto plano (compat)
        textoHtml: html.join(' | '),   // HTML con destacados en azul
        meals,                         // comidas con hora
        checkOutMin: chkMin,           // 1e9 si no hay check-out ese día
        almCount: almC,
        cenCount: cenC
      });
    }

    INDEX_ITIN.set(g.id, idx);
  }
}

function rebuildAgg(includeCoord = true, includeCond = true) {
  AGG = new Map();

  const paxFromAsg = (asg) => {
    const a = Number(asg?.adultosTotal ?? asg?.adultostotal ?? 0);
    const e = Number(asg?.estudiantesTotal ?? asg?.estudiantestotal ?? 0);
    const c = includeCoord ? Number(asg?.coordinadores ?? 0) : 0;
    const d = includeCond  ? Number(asg?.conductores   ?? 0) : 0;
    return a + e + c + d;
  };

  const hotelDoc = (hid) => HOTELES.find(h => h.id === hid) || { id: hid, nombre: '(Hotel)', destino: '', ciudad: '' };

  for (const g of GRUPOS) {
    const byDate = INDEX_OCUP.get(g.id) || new Map(); // noches por fecha
    const itIdx  = INDEX_ITIN.get(g.id) || new Map(); // itinerario por fecha (ordenado)

    // 1) Registrar noches por hotel
    for (const [fecha, occ] of byDate.entries()) {
      const hid = occ?.hotelId; if (!hid) continue;

      const byHotel = AGG.get(hid) || {
        hotel: hotelDoc(hid),
        grupos: new Map(),
        porDia: new Map(), // luego lo pasamos a Array para el correo
        totAlm: 0,
        totCen: 0
      };

      const gInfo = byHotel.grupos.get(g.id) || {
        grupoId: g.id,
        numeroNegocio: g.numeroNegocio || g.id,
        nombreGrupo:   g.nombreGrupo   || '',
        alias:         g.alias || g.aliasGrupo || '',
        identificador: g.identificador || '',
        dias: new Map(),     // fecha -> { alm, cen, texto, textoHtml, flags }
        almDias: 0,
        cenDias: 0,
        noches:  0,
        paxGrupo: 0
      };

      gInfo.noches += 1;
      const paxRef = paxFromAsg(occ.asg);
      if (paxRef > gInfo.paxGrupo) gInfo.paxGrupo = paxRef;

      byHotel.grupos.set(g.id, gInfo);
      AGG.set(hid, byHotel);
    }

    // 2) Asignar cada comida al hotel correcto (según reglas de check-out)
    const dates = new Set([...byDate.keys(), ...itIdx.keys()]);
    const sortedDates = [...dates].sort();

    for (const fecha of sortedDates) {
      const recIt = itIdx.get(fecha) || { meals: [], checkOutMin: 1e9, text: '', textoHtml: '' };
      const Hs    = byDate.get(fecha)?.hotelId || '';                 // hotel de la noche "fecha"
      const Hp    = byDate.get(prevDateISO(fecha))?.hotelId || '';    // hotel de la noche anterior
      const asgS  = byDate.get(fecha)?.asg || null;
      const asgP  = byDate.get(prevDateISO(fecha))?.asg || null;

      if (!recIt.meals || recIt.meals.length === 0) continue;

      const cut = recIt.checkOutMin ?? 1e9;

      for (const m of recIt.meals) {
        let targetH = '';
        if (isFinite(cut) && cut !== 1e9) {
          // con check-out
          targetH = (m.tmin <= cut) ? (Hp || Hs) : (Hs || Hp);
        } else {
          // sin check-out
          targetH = Hs || Hp;
        }
        if (!targetH) continue;

        const paxRef = (targetH === Hs) ? paxFromAsg(asgS) : paxFromAsg(asgP);

        // estructuras
        const byHotel = AGG.get(targetH) || {
          hotel: hotelDoc(targetH),
          grupos: new Map(),
          porDia: new Map(),
          totAlm: 0,
          totCen: 0
        };

        const gInfo = byHotel.grupos.get(g.id) || {
          grupoId: g.id,
          numeroNegocio: g.numeroNegocio || g.id,
          nombreGrupo:   g.nombreGrupo   || '',
          alias:         g.alias || g.aliasGrupo || '',
          identificador: g.identificador || '',
          dias: new Map(),
          almDias: 0,
          cenDias: 0,
          noches:  0,
          paxGrupo: 0
        };
        if (paxRef > gInfo.paxGrupo) gInfo.paxGrupo = paxRef;

        // marcar día
        const d = gInfo.dias.get(fecha) || { alm:0, cen:0, texto:'', textoHtml:'', flags:[] };
        let incAlm = 0, incCen = 0;
        
        if (m.kind === 'alm') {
          if (!d.alm) { d.alm = 1; incAlm = 1; } // solo si pasa 0→1
        }
        if (m.kind === 'cen') {
          if (!d.cen) { d.cen = 1; incCen = 1; } // solo si pasa 0→1
        }
        
        // Texto (una vez)
        if (!d.texto)     d.texto     = recIt.text || '';
        if (!d.textoHtml) d.textoHtml = recIt.textoHtml || '';
        gInfo.dias.set(fecha, d);
        
        // Acumulados del hotel (Σ de días, no de ocurrencias)
        byHotel.totAlm += incAlm;
        byHotel.totCen += incCen;
        
        // Índice por fecha para el correo (merge por grupo, sin duplicar)
        let mapList = byHotel.porDia.get(fecha);
        if (!(mapList instanceof Map)) mapList = new Map();
        
        let row = mapList.get(g.id);
        if (!row) {
          row = {
            grupoId: g.id,
            numeroNegocio: g.numeroNegocio || '',
            nombreGrupo:   g.nombreGrupo   || '',
            alias:         g.alias || g.aliasGrupo || '',
            identificador: g.identificador || '',
            alm: 0, cen: 0, pax: paxRef
          };
        }
        // solo marcar si pasó de 0→1 en este día
        if (incAlm === 1) row.alm = 1;
        if (incCen === 1) row.cen = 1;
        row.pax = paxRef;
        
        mapList.set(g.id, row);
        byHotel.porDia.set(fecha, mapList);
        
        // asegurar que el objeto quede persistido en los mapas
        byHotel.grupos.set(g.id, gInfo);
        AGG.set(targetH, byHotel);
        } // ← cierra for (const m of recIt.meals)
        } // ← cierra for (const fecha of sortedDates)

    // 3) Recalcular Σ almDias / cenDias por grupo
    for (const [, rec] of AGG.entries()) {
      const gi = rec.grupos.get(g.id);
      if (!gi) continue;
      let a = 0, c = 0;
      for (const v of gi.dias.values()) {
        a += Number(!!v.alm);
        c += Number(!!v.cen);
      }
      gi.almDias = a;
      gi.cenDias = c;
      rec.grupos.set(g.id, gi);
    }
  }

  // 3.bis) Recalcular Σ por hotel desde los días (fuente única, evita dobles)
  for (const [, rec] of AGG.entries()) {
    let A = 0, C = 0;
    for (const g of rec.grupos.values()) {
      const diasIt = (g.dias instanceof Map) ? g.dias.values() : Object.values(g.dias || {});
      for (const d of diasIt) {
        A += Number(!!d.alm);
        C += Number(!!d.cen);
      }
    }
    rec.totAlm = A;
    rec.totCen = C;
  }


  // 4) Normalizar porDia (Map→Array) para el correo
  for (const [, rec] of AGG.entries()) {
    for (const [iso, mapList] of rec.porDia.entries()) {
      if (mapList instanceof Map) rec.porDia.set(iso, [...mapList.values()]);
    }
  }
}

// Elimina grupos duplicados de hoteles sin nombre ("(HOTEL)") cuando ese grupo ya
// existe en un hotel real.
function dedupeGruposSinHotel(){
  // 1) marcar todos los grupos que aparecen en hoteles reales
  const gruposEnReales = new Set();
  for (const [, rec] of AGG.entries()){
    const nombre = String(rec?.hotel?.nombre || '');
    const esReal = nombre && !/^\(hotel\)$/i.test(nombre);
    if (esReal){
      for (const gid of rec.grupos.keys()) gruposEnReales.add(gid);
    }
  }

  // 2) podar los hoteles "fantasma"
  for (const [hid, rec] of [...AGG.entries()]){
    const nombre = String(rec?.hotel?.nombre || '');
    const esFantasma = !nombre || /^\(hotel\)$/i.test(nombre);
    if (!esFantasma) continue;

    for (const gid of [...rec.grupos.keys()]){
      if (gruposEnReales.has(gid)) rec.grupos.delete(gid);
    }
    if (rec.grupos.size === 0) AGG.delete(hid);
  }
}


// =============== Render tabla principal ===============
function renderTable(){
  const destinos = new Set();

  // Filtros actuales
  const filDest = document.getElementById('filtroDestino').value || '';
  const filHot  = document.getElementById('filtroHotel').value || '';
  const filAno  = document.getElementById('filtroAno').value   || '';
  const busc    = norm(document.getElementById('buscador').value || '');

  // Opciones de selects (una sola vez por sesión)
  for (const h of HOTELES) destinos.add(h.destino || '');
  const elDes = document.getElementById('filtroDestino');
  const elHot = document.getElementById('filtroHotel');
  if (elDes && elDes.options.length === 1) {
    [...destinos].sort((a,b)=> cmpAZ(a,b)).forEach(d => elDes.appendChild(new Option(d || '(sin)', d)));
  }
  if (elHot && elHot.options.length === 1) {
    HOTELES.slice()
      .sort((a,b)=> cmpAZ(a.nombre||a.id, b.nombre||b.id))
      .forEach(h => elHot.appendChild(new Option(h.nombre || h.id, h.id)));
  }

  // 1) Filtrar y preparar lista de hoteles renderizables
  const list = [];
  const rawQuery = document.getElementById('buscador').value || '';
  const clauses  = parseSearch(rawQuery);
  for (const [hotelId, recRaw] of AGG.entries()) {
    const rec = filAno ? recForYear(recRaw, filAno) : recRaw;   // aplica filtro por año
    const h = rec.hotel || {};
    const name = h.nombre || hotelId;
    const destino = h.destino || '';
    const ciudad  = h.ciudad  || '';

    if (filDest && destino !== filDest) continue;
    if (filHot  && hotelId !== filHot)  continue;

    const searchBlob = norm(`${name} ${destino} ${ciudad} ${[...rec.grupos.values()].map(g=>g.nombreGrupo).join(' ')}`);
    // Buscador avanzado (coma = OR, punto = AND)
    if (clauses.length && !matchesHotelRec(
          { rec, nombre: name, destino, ciudad }, 
          clauses, 
          filAno
        )) {
      continue;
}


    // si por año no hay datos, escondemos el hotel
    if (filAno && (rec.totAlm + rec.totCen === 0)) continue;

    list.push({
      hotelId,
      rec,
      nombre: name,
      destino,
      ciudad,
      totAlm: rec.totAlm,
      totCen: rec.totCen,
      gruposCount: rec.grupos.size
    });
  }

  // 2) Orden A→Z por Destino y luego por Nombre
  list.sort((A,B) => cmpAZ(A.destino, B.destino) || cmpAZ(A.nombre, B.nombre));

  // 3) Render con separadores por Destino
  const rows = [];
  let curDest = '__INIT__';
  for (const it of list) {
    if (it.destino !== curDest) {
      curDest = it.destino;
      rows.push(`
        <tr class="tr-destino">
          <td>DESTINO: ${curDest || '(sin destino)'}</td>
          <td></td><td></td><td></td><td></td><td></td><td></td>
        </tr>
      `);
    }
  
    // === NUEVO: decidir estado del botón según reservasAlimentos del hotel (y filtro de año) ===
    const est = estadoHotelParaAnio(it.rec.hotel, filAno);
    const btnTxt = est || 'Reservar';
    const btnCls = est === 'ENVIADA' ? 'btn btn-enviada'
                 : est === 'PENDIENTE' ? 'btn btn-pendiente'
                 : 'btn';
  
    rows.push(`
      <tr data-hotel="${it.hotelId}">
        <td><span class="badge">${it.nombre}</span></td>
        <td>${it.destino}</td>
        <td>${it.ciudad}</td>
        <td>${it.totAlm}</td>
        <td>${it.totCen}</td>
        <td>${it.gruposCount}</td>
        <td>
          <button class="btn" data-act="ver" data-hotel="${it.hotelId}">Ver grupos</button>
          <button class="${btnCls}" data-act="reservar" data-hotel="${it.hotelId}">${btnTxt}</button>
        </td>
      </tr>
    `);
   }


  // Pintar tbody
  const tbody = document.querySelector('#tablaHoteles tbody');
  tbody.innerHTML = rows.join('') || `
    <tr class="tr-empty">
      <td class="muted">No hay datos para los filtros actuales.</td>
      <td></td><td></td><td></td><td></td><td></td><td></td>
    </tr>`;


  // (Re)inicializar DataTable
  if (DT && $.fn.DataTable.isDataTable('#tablaHoteles')) {
    DT.destroy();
  }
  DT = $('#tablaHoteles').DataTable({
    paging:false, searching:false, info:false,
    fixedHeader:{ header:true, headerOffset:90 },
    order:[] // dejamos el orden por DOM (ya agrupado y ordenado)
  });

  // Delegación de eventos sobre el tbody (sin cambios)
  const $tbody = $('#tablaHoteles tbody');
  $tbody.off('click', 'button[data-act="ver"]');
  $tbody.on('click', 'button[data-act="ver"]', function(){
    const hid = this.dataset.hotel;
    const recRaw = AGG.get(hid);
    if (!recRaw) return;
    const rec = filAno ? recForYear(recRaw, filAno) : recRaw;
    const row = DT.row($(this).closest('tr'));
    if (row.child.isShown()) {
      row.child.hide();
      this.textContent = 'Ver grupos';
    } else {
      const htmlDetalle = (typeof renderSubtablaHotel === 'function')
        ? renderSubtablaHotel(rec)
        : `<div style="padding:6px 0">Sin renderer de subtabla.</div>`;
      row.child(`<div style="padding:6px 0">${htmlDetalle}</div>`).show();
      this.textContent = 'Ocultar';
    }
  });

  $tbody.off('click', 'button[data-act="reservar"]');
  $tbody.on('click', 'button[data-act="reservar"]', function(){
    abrirModalHotel(this.dataset.hotel);
  });
}

// Subtabla: lista de grupos del hotel con Σ almuerzos/cenas
function renderSubtablaHotel(rec){
  const hid = rec?.hotel?.id || '';
  const pension = (rec?.hotel?.pension || '').toLowerCase();  // 'media' | 'completa' | ''

  // Orden A→Z por etiqueta visible
  const arr = [...rec.grupos.values()]
    .sort((a, b) => cmpAZ(nombreVisibleGrupo(a), nombreVisibleGrupo(b)));

  // filas
  const rows = arr.map(g => {
    const label = etiquetaGrupo(g);
    const estado = calcEstadoGrupo(pension, g.noches, g.almDias, g.cenDias, g.dias);
    return `
      <tr>
        <td>${label}</td>
        <td style="text-align:center">${g.noches}</td>
        <td style="text-transform:capitalize">${pension || '(sin dato)'}</td>
        <td style="text-align:center">${g.almDias}</td>
        <td style="text-align:center">${g.cenDias}</td>
        <td style="text-align:center">${g.paxGrupo}</td>
        <td>${estado.ok ? '✔️ OK' : ('⚠️ ' + estado.detail)}</td>
        <td><button class="btn btn-mini" data-act="detalle-grupo" data-gid="${g.grupoId}" data-hid="${hid}">Detalle</button></td>
      </tr>
    `;
  }).join('');

  // totales
  const totNoches = arr.reduce((s,g)=> s + Number(g.noches||0), 0);
  const totAlm    = arr.reduce((s,g)=> s + Number(g.almDias||0), 0);
  const totCen    = arr.reduce((s,g)=> s + Number(g.cenDias||0), 0);

  let tfoot = '';
  if (pension === 'completa') {
    const expA = totNoches, expC = totNoches;
    const dA   = totAlm - expA;
    const dC   = totCen - expC;
    tfoot = `
      <tr class="tr-total">
        <td><b>Totales hotel</b></td>
        <td style="text-align:center">${totNoches}</td>
        <td>completa</td>
        <td style="text-align:center"><b>${totAlm}</b> / ${expA}</td>
        <td style="text-align:center"><b>${totCen}</b> / ${expC}</td>
        <td></td>
        <td colspan="2">Δ Alm: ${dA>0?`+${dA}`:dA}, Δ Cenas: ${dC>0?`+${dC}`:dC}</td>
      </tr>`;
  } else {
    const expT = totNoches;
    const actT = totAlm + totCen;
    const dT   = actT - expT;
    const tag  = dT === 0 ? 'OK' : (dT > 0 ? `sobran ${dT}` : `faltan ${-dT}`);
    tfoot = `
      <tr class="tr-total">
        <td><b>Totales hotel</b></td>
        <td style="text-align:center">${totNoches}</td>
        <td>${pension || 'media'}</td>
        <td style="text-align:center"><b>${totAlm}</b></td>
        <td style="text-align:center"><b>${totCen}</b></td>
        <td></td>
        <td colspan="2">${tag} (esp. ${expT})</td>
      </tr>`;
  }

  // wire "Detalle"
  setTimeout(()=>{
    document.querySelectorAll('button[data-act="detalle-grupo"]').forEach(b=>{
      b.onclick = ()=> abrirModalGrupo(b.dataset.hid, b.dataset.gid);
    });
  },0);

  return `
    <table class="subtabla">
      <thead>
        <tr>
          <th>Grupo</th>
          <th>Noches</th>
          <th>Pensión</th>
          <th>Σ Almuerzos</th>
          <th>Σ Cenas</th>
          <th>PAX</th>
          <th>Estado</th>
          <th>Detalle</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="8" class="muted">Sin grupos.</td></tr>`}</tbody>
      <tfoot>${tfoot}</tfoot>
    </table>
  `;
}

// =============== MODAL: Detalle Grupo (día a día) ===============
// =============== MODAL: Detalle Grupo (día a día) ===============
function abrirModalGrupo(hotelId, grupoId){
  const recH = AGG.get(hotelId);
  if (!recH) return;
  const g = recH.grupos.get(grupoId);
  if (!g) return;

  document.getElementById('mg-title').textContent =
    `Detalle — ${recH.hotel.nombre} — (${g.numeroNegocio}) ${g.nombreGrupo}`;

  // Calcula rango: desde la 1ª noche en el hotel hasta el DÍA DE CHECK-OUT (inclusive)
  const range = stayRangeForGrupoHotel(grupoId, hotelId);
  const itIdx = INDEX_ITIN.get(grupoId) || new Map();

  let rows = '';

  if (range){
    // Recorre TODOS los días desde start hasta checkout (INCLUSIVE),
    // mostrará "— —" cuando no haya consumo.
    let iso = range.start;
    while (true){
      // Datos del día (si no existe, crea uno vacío)
      const d = g.dias.get(iso) || { alm:0, cen:0, texto:'', textoHtml:'', flags:[] };

      // Si no había texto guardado para ese día, intenta mostrar el itinerario del día
      if (!d.texto && !d.textoHtml){
        const it = itIdx.get(iso);
        if (it){
          d.texto     = it.text || '';
          d.textoHtml = it.textoHtml || d.text || '';
        }
      }

      rows += `
        <tr>
          <td>${fmt(iso)}</td>
          <td style="text-align:center">${tick(d.alm)}</td>
          <td style="text-align:center">${tick(d.cen)}</td>
          <td style="text-align:center">${g.paxGrupo}</td>
          <td>${d.textoHtml || escHTML(d.texto || '')}</td>
          <td>${(d.flags || []).join(', ')}</td>
        </tr>
      `;

      if (iso === range.checkout) break;           // incluimos el día de check-out
      iso = addDaysISO(iso, 1);
    }
  } else {
    // Fallback: comportamiento anterior (solo días con registro)
    rows = [...g.dias.entries()].sort((a,b)=> a[0].localeCompare(b[0]))
      .map(([fecha, d]) => `
        <tr>
          <td>${fmt(fecha)}</td>
          <td style="text-align:center">${tick(d.alm)}</td>
          <td style="text-align:center">${tick(d.cen)}</td>
          <td style="text-align:center">${g.paxGrupo}</td>
          <td>${d.textoHtml || escHTML(d.texto || '')}</td>
          <td>${(d.flags || []).join(', ')}</td>
        </tr>
      `).join('');
  }

  document.querySelector('#mg-tabla tbody').innerHTML =
    rows || `<tr><td colspan="6" class="muted">Sin datos para este grupo.</td></tr>`;

  // open
  document.getElementById('modalGrupoBackdrop').style.display = 'block';
  document.getElementById('modalGrupo').style.display = 'block';
}

document.getElementById('mg-close').onclick = closeModalGrupo;
document.getElementById('mg-ok').onclick    = closeModalGrupo;
function closeModalGrupo(){
  document.getElementById('modalGrupoBackdrop').style.display = 'none';
  document.getElementById('modalGrupo').style.display = 'none';
}

// =============== MODAL: Hotel (Reservar) ===============
async function abrirModalHotel(hotelId){
  const recBase = AGG.get(hotelId);
  if (!recBase) return;

  const h = recBase.hotel || {};
  const paraDefault = h.contactoCorreo || h.contacto || '';

  // respetar filtro de AÑO para el cuerpo del correo
  const filAno = (document.getElementById('filtroAno')?.value || '').trim();
  const rec = filAno ? recForYear(recBase, filAno) : recBase;

  // resumen por grupo (solo grupos con consumo)
  const gruposOrden = [...rec.grupos.values()]
    .map(g => ({ g, tot: totalesDeGrupo(g) }))
    .filter(x => (x.tot.alm + x.tot.cen) > 0)
    .sort((a,b)=> (a.g.numeroNegocio+' '+(a.g.alias||a.g.nombreGrupo||'')).localeCompare(b.g.numeroNegocio+' '+(b.g.alias||b.g.nombreGrupo||'')));

  const totalAlmHotel = gruposOrden.reduce((s,x)=> s + x.tot.alm, 0);
  const totalCenHotel = gruposOrden.reduce((s,x)=> s + x.tot.cen, 0);
  const totalServ     = totalAlmHotel + totalCenHotel;

  // esperado vs plan (para saldo)
  const pen = (h.pension || '').toLowerCase();
  const sumNoches = [...rec.grupos.values()].reduce((s,g)=> s + Number(g.noches||0), 0);
  let diffServicios = 0;
  if (pen === 'completa'){
    diffServicios = (totalAlmHotel - sumNoches) + (totalCenHotel - sumNoches);
  } else {
    diffServicios = totalServ - sumNoches; // media o sin dato
  }

  // ===== NUEVO FORMATO DE CUERPO =====
  let cuerpo = `Estimado/a:\n\n`;
  cuerpo += `RESERVA DE ALIMENTACIÓN PARA ${String(h.nombre||'(HOTEL)').toUpperCase()}.\n\n`;

  // 1) DETALLE POR DÍA (primero)
  const bloqueDia = buildBloqueDia(rec);
  if (bloqueDia) {
    cuerpo += `DETALLE POR DÍA:\n${bloqueDia.toUpperCase()}\n\n`;
  } else {
    cuerpo += `DETALLE POR DÍA:\n( SIN REGISTROS )\n\n`;
  }

  // 2) RESUMEN
  cuerpo += `===================================================\n`;
  cuerpo += `RESUMEN\n`;
  cuerpo += `===================================================\n\n`;

  // 2.a) TOTALES POR GRUPO (sin reemplazos ni alertas)
  cuerpo += `TOTALES POR GRUPO:\n`;
  for (const {g, tot} of gruposOrden) {
    const etiqueta = `(${g.numeroNegocio}) ${g.identificador ? g.identificador+' – ' : ''}${(g.alias || g.nombreGrupo || '').trim()}`;
    const alm = Number(tot.alm||0), cen = Number(tot.cen||0);
    const totalG = alm + cen;
    cuerpo += `- ${etiqueta} — ALM: ${alm} | CEN: ${cen} / (TOTAL = ${totalG})COMIDAS\n`;
  }

  // 3) TOTALES FINALES (al final, sin “saldo” ni “alertas”)
  cuerpo += `\nTOTAL DE COMIDAS= ${totalServ}\n`;
  // cuerpo += `- ALMUERZOS: ${totalAlmHotel}\n`;
  // cuerpo += `- CENAS: ${totalCenHotel}\n`;


  // seteo de campos + datasets
  document.getElementById('mh-title').textContent = `Reservar — ${h.nombre || hotelId}`;
  document.getElementById('mh-para').value   = paraDefault || 'CORREO@HOTEL.COM';
  document.getElementById('mh-asunto').value = `Reserva alimentación — ${h.nombre || hotelId}`;
  document.getElementById('mh-cuerpo').value = cuerpo;

  document.getElementById('mh-guardarPend').dataset.hid = hotelId;
  document.getElementById('mh-enviar').dataset.hid = hotelId;

  // abrir modal
  document.getElementById('modalHotelBackdrop').style.display = 'block';
  document.getElementById('modalHotel').style.display = 'block';
}

// ==== CIERRE MODAL HOTEL (faltaba) ====
function closeModalHotel(){
  const bd = document.getElementById('modalHotelBackdrop');
  const md = document.getElementById('modalHotel');
  if (bd) bd.style.display = 'none';
  if (md) md.style.display = 'none';
}

// Wire de cierre (botón, backdrop y tecla ESC)
const btnCloseHotel = document.getElementById('mh-close');
if (btnCloseHotel) btnCloseHotel.onclick = closeModalHotel;

const bdHotel = document.getElementById('modalHotelBackdrop');
if (bdHotel) bdHotel.onclick = closeModalHotel;

document.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape') closeModalHotel();
});

// Guardar PENDIENTE (marca por cada fecha con consumo > 0)
document.getElementById('mh-guardarPend').onclick = async (e)=>{
  try {
    const hid = e.currentTarget.dataset.hid;
    const rec = AGG.get(hid);
    if (!rec) return;

    const cuerpo = document.getElementById('mh-cuerpo').value;
    // armar payload por fecha: Σ almuerzos y Σ cenas del hotel en esa fecha
    const perDate = new Map();
    for (const g of rec.grupos.values()) {
      for (const [fecha, d] of g.dias.entries()) {
        const acc = perDate.get(fecha) || { alm:0, cen:0 };
        acc.alm += d.alm; acc.cen += d.cen;
        perDate.set(fecha, acc);
      }
    }
    const patch = {};
    for (const [fecha, t] of perDate.entries()) {
      if ((t.alm + t.cen) > 0) patch[`reservasAlimentos.${fecha}`] =
        { estado:'PENDIENTE', cuerpo, totAlmuerzos: t.alm, totCenas: t.cen };
    }
    if (Object.keys(patch).length) await updateDoc(doc(db,'hoteles', hid), patch);

    // === NUEVO: cache + repaint ===
    const hotelIdx = HOTELES.findIndex(h => h.id === hid);
    if (hotelIdx >= 0) {
      const current = { ...(HOTELES[hotelIdx].reservasAlimentos || {}) };
      for (const [fecha, t] of perDate.entries()) {
        if ((t.alm + t.cen) > 0) {
          current[fecha] = { estado:'PENDIENTE', cuerpo, totAlmuerzos:t.alm, totCenas:t.cen };
        }
      }
      HOTELES[hotelIdx].reservasAlimentos = current;
      
      // también sincronizamos el hotel dentro de AGG para reflejar el estado inmediato
      const aggRec = AGG.get(hid);
      if (aggRec) aggRec.hotel.reservasAlimentos = current;
    }
    recalcAndPaint();

    closeModalHotel();
    alert('Guardado como PENDIENTE.');
  } catch(err) {
    console.error(err); alert('No se pudo guardar PENDIENTE.');
  }
};

// Enviar (abre Gmail + marca ENVIADA por cada fecha con consumo > 0)
document.getElementById('mh-enviar').onclick = async (e)=>{
  const hid = e.currentTarget.dataset.hid;
  const rec = AGG.get(hid);
  if (!rec) return;

  const para   = document.getElementById('mh-para').value.trim();
  const asunto = document.getElementById('mh-asunto').value.trim();
  const cuerpo = document.getElementById('mh-cuerpo').value;

  // Gmail compose (como contador.js)
  const base = 'https://mail.google.com/mail/u/0/?view=cm&fs=1';
  const params = `to=${encodeURIComponent(para)}&su=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
  window.open(`${base}&${params}`, '_blank');

  try {
    // actualizar estado ENVIADA por fecha
    const perDate = new Map();
    for (const g of rec.grupos.values()) {
      for (const [fecha, d] of g.dias.entries()) {
        const acc = perDate.get(fecha) || { alm:0, cen:0 };
        acc.alm += d.alm; acc.cen += d.cen;
        perDate.set(fecha, acc);
      }
    }
    const patch = {};
    for (const [fecha, t] of perDate.entries()) {
      if ((t.alm + t.cen) > 0) patch[`reservasAlimentos.${fecha}`] =
        { estado:'ENVIADA', cuerpo, totAlmuerzos: t.alm, totCenas: t.cen };
    }
    if (Object.keys(patch).length) await updateDoc(doc(db,'hoteles', hid), patch);

    // === NUEVO: cache + repaint ===
    const hotelIdx = HOTELES.findIndex(h => h.id === hid);
    if (hotelIdx >= 0) {
      const current = { ...(HOTELES[hotelIdx].reservasAlimentos || {}) };
      for (const [fecha, t] of perDate.entries()) {
        if ((t.alm + t.cen) > 0) {
          current[fecha] = { estado:'ENVIADA', cuerpo, totAlmuerzos:t.alm, totCenas:t.cen };
        }
      }
      HOTELES[hotelIdx].reservasAlimentos = current;
      
      // también sincronizamos el hotel dentro de AGG para reflejar el estado inmediato
      const aggRec = AGG.get(hid);
      if (aggRec) aggRec.hotel.reservasAlimentos = current;
    }
    recalcAndPaint();
    
    closeModalHotel();
  } catch(err) {
    console.error(err); alert('No se pudo marcar ENVIADA.');
  }
};

// Carga SheetJS en caliente si no está disponible
async function ensureXLSX(){
  if (window.XLSX) return window.XLSX;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.19.3/dist/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar XLSX'));
    document.head.appendChild(s);
  });
  return window.XLSX;
}

// =============== Export a Excel ===============
document.getElementById('btnExportExcel').onclick = exportExcel;
async function exportExcel(){
  const XLSX = await ensureXLSX();

  // Hoja 1: Detalle día a día
  const detalle = [];
  for (const [hid, rec] of AGG.entries()) {
    for (const g of rec.grupos.values()) {
      for (const [fecha, d] of g.dias.entries()) {
        detalle.push({
          Hotel: rec.hotel.nombre || hid,
          Destino: rec.hotel.destino || '',
          Ciudad: rec.hotel.ciudad || '',
          Grupo: g.numeroNegocio,
          NombreGrupo: g.nombreGrupo,
          Fecha: fecha,
          Almuerzo: d.alm,
          Cena: d.cen,
          PaxGrupo: g.paxGrupo,
          Texto: (d.texto || '').slice(0,300),
          Flags: (d.flags||[]).join(', ')
        });
      }
    }
  }

  // Hoja 2: Totales por grupo en hotel
  const totGrupo = [];
  for (const [hid, rec] of AGG.entries()) {
    for (const g of rec.grupos.values()) {
      totGrupo.push({
        Hotel: rec.hotel.nombre || hid,
        Destino: rec.hotel.destino || '',
        Ciudad: rec.hotel.ciudad || '',
        Grupo: g.numeroNegocio,
        NombreGrupo: g.nombreGrupo,
        Noches: g.noches || 0,
        'Σ Almuerzos': g.almDias || 0,
        'Σ Cenas': g.cenDias || 0,
        PAX: g.paxGrupo || 0
      });
    }
  }

  // Hoja 3: Totales por hotel
  const totHotel = [];
  for (const [hid, rec] of AGG.entries()) {
    totHotel.push({
      Hotel: rec.hotel.nombre || hid,
      Destino: rec.hotel.destino || '',
      Ciudad: rec.hotel.ciudad || '',
      'Σ Almuerzos': rec.totAlm,
      'Σ Cenas': rec.totCen,
      Grupos: rec.grupos.size
    });
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalle),  'Detalle_dias');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totGrupo), 'Totales_grupo');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totHotel), 'Totales_hotel');
  XLSX.writeFile(wb, `reservas_hoteles_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// =============== Eventos UI ===============
document.getElementById('btnRecalcular').addEventListener('click', recalcAndPaint);
document.getElementById('filtroDestino').addEventListener('change', renderTable);
document.getElementById('filtroHotel').addEventListener('change', renderTable);
document.getElementById('filtroAno').addEventListener('change', renderTable);
document.getElementById('buscador').addEventListener('input', renderTable);

// Estos SÍ cambian el cómputo => recalcular
document.getElementById('chkCoord').addEventListener('change', recalcAndPaint);
document.getElementById('chkCond').addEventListener('change', recalcAndPaint);

// =============== Init ===============
async function init(){
  await loadAll();
  buildIndexOcup();
  buildIndexItin();

  // forzar estado inicial desmarcado ANTES de calcular
  const chkC = document.getElementById('chkCoord');
  const chkD = document.getElementById('chkCond');
  if (chkC) chkC.checked = false;
  if (chkD) chkD.checked = false;

  recalcAndPaint();

  // cerrar modales al click en backdrop
  document.getElementById('modalHotelBackdrop').onclick = closeModalHotel;
  document.getElementById('modalGrupoBackdrop').onclick = closeModalGrupo;
}


function recalcAndPaint(){
  const incC = document.getElementById('chkCoord').checked;
  const incD = document.getElementById('chkCond').checked;
  rebuildAgg(incC, incD);
  dedupeGruposSinHotel();
  populateFiltroAno();
  renderTable();
}
