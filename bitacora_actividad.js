// bitacora_actividad.js
// Ver bitácora POR ACTIVIDAD, en TODOS los grupos que tengan esa actividad
// Estructura: grupos/{gid}/bitacora/{actividadId}/{YYYY-MM-DD}/{entradaId}

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc, query, where
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ====================== STATE ====================== */
const state = {
  user: null,
  filtros: {
    destino: '',
    coord: '',
    grupo: '',
    actividad: '',
    desde: '',
    hasta: '',
    buscar: ''
  },
  caches: {
    grupos: new Map(),         // gid -> info
    coords: [],
    destinos: [],
    groupsByCoord: new Map(),  // coordEmail -> Set(gid)
  },
  actividadesSet: new Set(),
  rows: [],
  meta: { gruposConsiderados: 0, dias: 0 }
};

/* ====================== HELPERS ====================== */
const escapeHtml = (str='') =>
  String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');

const coalesce = (...xs) =>
  xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

const norm = (s='') =>
  String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

function toISODate(d){
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateInput(v){
  // input type="date" -> "YYYY-MM-DD"
  if (!v) return null;
  const d = new Date(v + 'T00:00:00');
  return isNaN(d) ? null : d;
}

function daysBetweenInclusive(fromISO, toISO){
  const a = parseDateInput(fromISO);
  const b = parseDateInput(toISO);
  if (!a || !b) return [];
  const out = [];
  const cur = new Date(a.getTime());
  while (cur <= b) {
    out.push(toISODate(cur));
    cur.setDate(cur.getDate()+1);
  }
  return out;
}

function pickTsMs(raw){
  // tolerante: raw.ts puede ser number / string / timestamp-like
  if (!raw) return 0;
  const v = raw.ts ?? raw.createdAt ?? raw.at ?? raw.time ?? null;
  if (v == null) return 0;

  if (typeof v === 'number' && isFinite(v)) {
    return v > 1e12 ? v : v * 1000;
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isFinite(t) ? t : 0;
  }
  if (typeof v === 'object' && v) {
    // Firestore Timestamp
    if (typeof v.toDate === 'function') {
      try { return v.toDate().getTime(); } catch(_) {}
    }
    if ('seconds' in v) return v.seconds*1000 + Math.floor((v.nanoseconds||0)/1e6);
  }
  return 0;
}

function fmtHoraFromDocId(id=''){
  // tus docs parecen ser "19:24:01.338"
  return id || '—';
}

/* ====================== CATALOGOS ====================== */
async function preloadCatalogs(){
  state.caches.grupos.clear();
  state.caches.coords.length = 0;
  state.caches.destinos.length = 0;
  state.caches.groupsByCoord.clear();

  const dlG = document.getElementById('dl-grupos');
  const dlC = document.getElementById('dl-coords');
  const dlD = document.getElementById('dl-destinos');
  if (dlG) dlG.innerHTML = '';
  if (dlC) dlC.innerHTML = '';
  if (dlD) dlD.innerHTML = '';

  const snap = await getDocs(collection(db,'grupos'));
  snap.forEach(d => {
    const x = d.data() || {};
    const gid = d.id;

    const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
    const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);

    const coordEmail = coalesce(
      x.coordinadorEmail, x.coordinador?.email, x.coordinador,
      x.coord, x.responsable, x.owner, ''
    ).toLowerCase();

    const destino = coalesce(x.destino, x.lugar, '').toString();

    const info = {
      gid, numero, nombre,
      coordEmail,
      destino,
      programa: coalesce(x.programa, x.plan, ''),
      cantidadGrupo: Number(x.cantidadGrupo ?? x.paxTotal ?? x.pax ?? 0) || 0,
      fechaInicio: x.fechaInicio || x.fechaInicioViaje || null,
      fechaFin: x.fechaFin || x.fechaFinViaje || null
    };

    state.caches.grupos.set(gid, info);

    // datalist grupos
    if (dlG) {
      const opt = document.createElement('option');
      opt.value = gid;
      opt.label = `${numero} — ${nombre}`;
      dlG.appendChild(opt);
    }

    // coords
    if (coordEmail) {
      if (!state.caches.groupsByCoord.has(coordEmail)) {
        state.caches.groupsByCoord.set(coordEmail, new Set());
      }
      state.caches.groupsByCoord.get(coordEmail).add(gid);
      if (!state.caches.coords.includes(coordEmail)) state.caches.coords.push(coordEmail);
    }

    // destinos
    if (destino) {
      const dnorm = destino.trim();
      if (dnorm && !state.caches.destinos.includes(dnorm)) state.caches.destinos.push(dnorm);
    }
  });

  // coords datalist
  if (dlC) {
    state.caches.coords.sort().forEach(email => {
      const opt = document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlC.appendChild(opt);
    });
  }

  // destinos datalist
  if (dlD) {
    state.caches.destinos.sort().forEach(dest => {
      const opt = document.createElement('option');
      opt.value = dest;
      opt.label = dest;
      dlD.appendChild(opt);
    });
  }
}

/* ====================== SELECCIÓN DE GRUPOS OBJETIVO ====================== */
function pickTargetGroups(){
  const destino = norm(state.filtros.destino);
  const coord = norm(state.filtros.coord);
  const gid = (state.filtros.grupo || '').trim();

  // 1) si el usuario puso un grupo específico, mandamos solo ese
  if (gid) {
    return state.caches.grupos.has(gid) ? [gid] : [];
  }

  // 2) si hay coord, partimos desde sus grupos
  let candidates = [];
  if (coord && state.caches.groupsByCoord.has(coord)) {
    candidates = [...state.caches.groupsByCoord.get(coord)];
  } else {
    candidates = [...state.caches.grupos.keys()];
  }

  // 3) si hay destino, filtramos por destino
  if (destino) {
    candidates = candidates.filter(id => {
      const g = state.caches.grupos.get(id);
      return norm(g?.destino || '') === destino;
    });
  }

  return candidates;
}

/* ====================== CARGAR ACTIVIDADES (SUGERENCIAS) ====================== */
async function cargarActividadesSugeridas(){
  const dlA = document.getElementById('dl-actividades');
  if (dlA) dlA.innerHTML = '';
  state.actividadesSet.clear();

  const pagInfo = document.getElementById('pagInfo');
  const actividadInput = document.getElementById('filtroActividad');

  const grupos = pickTargetGroups();
  if (!grupos.length) {
    if (pagInfo) pagInfo.textContent = 'No hay grupos para cargar actividades con esos filtros.';
    return;
  }

  // Para no reventar, muestreamos hasta 35 grupos (normalmente basta para sacar el catálogo)
  const sample = grupos.slice(0, 35);

  if (pagInfo) pagInfo.textContent = `Cargando actividades desde ${sample.length} grupos…`;

  for (const gid of sample) {
    try {
      const ref = collection(db, 'grupos', gid, 'bitacora');
      const snap = await getDocs(ref);
      snap.forEach(d => state.actividadesSet.add(d.id));
    } catch (e) {
      console.warn('[BIT] cargarActividadesSugeridas', gid, e);
    }
  }

  const list = [...state.actividadesSet].sort();
  if (dlA) {
    list.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.label = id;
      dlA.appendChild(opt);
    });
  }

  if (pagInfo) pagInfo.textContent = `Actividades sugeridas: ${list.length}.`;
  if (actividadInput && !actividadInput.value && list.length) {
    // no autopongo nada, solo dejo list listo
  }
}

/* ====================== LECTURA BITÁCORA POR ACTIVIDAD ====================== */
async function loadBitacoraByActividad(){
  state.rows = [];
  state.meta = { gruposConsiderados: 0, dias: 0 };

  const actividadId = (state.filtros.actividad || '').trim();
  if (!actividadId) {
    alert('Debes indicar una Actividad.');
    return;
  }

  const desde = state.filtros.desde;
  const hasta = state.filtros.hasta;

  const days = daysBetweenInclusive(desde, hasta);
  if (!days.length) {
    alert('Debes indicar un rango de fechas válido (Desde / Hasta).');
    return;
  }

  const grupos = pickTargetGroups();
  if (!grupos.length) {
    alert('No hay grupos que coincidan con esos filtros (destino/coord/grupo).');
    return;
  }

  state.meta.gruposConsiderados = grupos.length;
  state.meta.dias = days.length;

  const pagInfo = document.getElementById('pagInfo');
  if (pagInfo) pagInfo.textContent = `Buscando “${actividadId}” en ${grupos.length} grupos · ${days.length} días…`;

  // Recorrido principal
  // Nota: Esto es intensivo: grupos * días (pero normalmente acotado por destino + rango)
  let done = 0;
  const total = grupos.length * days.length;

  for (const gid of grupos) {
    const gInfo = state.caches.grupos.get(gid) || { gid, numero: gid, nombre: gid };

    for (const dayISO of days) {
      done++;
      if (pagInfo && (done % 20 === 0 || done === total)) {
        pagInfo.textContent = `Consultando… (${done}/${total})`;
      }

      try {
        const ref = collection(db, 'grupos', gid, 'bitacora', actividadId, dayISO);
        const snap = await getDocs(ref);

        snap.forEach(d => {
          const raw = d.data() || {};
          state.rows.push({
            gid,
            grupoLabel: `${gInfo.numero || gid} — ${gInfo.nombre || ''}`.trim(),
            actividadId,
            fechaISO: dayISO,
            horaId: d.id,
            texto: coalesce(raw.texto, raw.msg, raw.comentario, ''),
            byEmail: coalesce(raw.byEmail, raw.email, raw.autor, raw.by, ''),
            byUid: coalesce(raw.byUid, raw.uid, ''),
            tsMs: pickTsMs(raw) || 0
          });
        });
      } catch (e) {
        // si la colección del día no existe, Firestore simplemente devuelve vacío (normal).
        // igual capturamos por si hay permisos o algo raro.
        // console.warn('[BIT] load', gid, actividadId, dayISO, e);
      }
    }
  }

  // Orden: por fecha + hora (desc), y fallback tsMs
  state.rows.sort((a,b) => {
    const fa = `${a.fechaISO} ${a.horaId}`;
    const fb = `${b.fechaISO} ${b.horaId}`;
    if (fa < fb) return 1;
    if (fa > fb) return -1;
    return (b.tsMs||0) - (a.tsMs||0);
  });

  if (pagInfo) pagInfo.textContent = `Listo: ${state.rows.length} entradas.`;
}

/* ====================== RENDER TABLA ====================== */
function renderTabla(){
  const tbody = document.querySelector('#tblBitacora tbody');
  const resumen = document.getElementById('resumenTabla');
  const kpiG = document.getElementById('kpiGrupos');
  const kpiD = document.getElementById('kpiDias');
  const kpiE = document.getElementById('kpiEntradas');

  if (kpiG) kpiG.textContent = state.meta.gruposConsiderados ? String(state.meta.gruposConsiderados) : '—';
  if (kpiD) kpiD.textContent = state.meta.dias ? String(state.meta.dias) : '—';

  const q = norm(state.filtros.buscar);
  const rows = q
    ? state.rows.filter(r => norm(r.texto).includes(q) || norm(r.grupoLabel).includes(q) || norm(r.byEmail).includes(q))
    : state.rows;

  if (kpiE) kpiE.textContent = String(rows.length);

  if (!tbody) return;
  tbody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.innerHTML = `<div class="muted">Sin resultados para ese criterio.</div>`;
    tr.appendChild(td);
    tbody.appendChild(tr);
    if (resumen) resumen.textContent = 'Sin resultados.';
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const tr = document.createElement('tr');

    const tdFecha = document.createElement('td');
    tdFecha.className = 'nowrap mono';
    tdFecha.textContent = r.fechaISO || '—';

    const tdHora = document.createElement('td');
    tdHora.className = 'nowrap mono';
    tdHora.textContent = fmtHoraFromDocId(r.horaId);

    const tdGrupo = document.createElement('td');
    tdGrupo.innerHTML = `<span class="pill">${escapeHtml(r.grupoLabel || r.gid)}</span>`;

    const tdAct = document.createElement('td');
    tdAct.className = 'nowrap mono';
    tdAct.textContent = r.actividadId || '—';

    const tdTexto = document.createElement('td');
    tdTexto.className = 'wraptext';
    tdTexto.textContent = r.texto || '—';

    const tdAutor = document.createElement('td');
    tdAutor.className = 'nowrap';
    tdAutor.textContent = r.byEmail || '—';

    tr.append(tdFecha, tdHora, tdGrupo, tdAct, tdTexto, tdAutor);
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);
  if (resumen) resumen.textContent = `Mostrando ${rows.length} entradas.`;
}

/* ====================== UI WIRING ====================== */
function setDefaultDates(){
  // default: últimos 14 días (incluye hoy)
  const hoy = new Date();
  const desde = new Date(hoy.getTime());
  desde.setDate(desde.getDate() - 13);

  const inpD = document.getElementById('filtroDesde');
  const inpH = document.getElementById('filtroHasta');

  if (inpD && !inpD.value) inpD.value = toISODate(desde);
  if (inpH && !inpH.value) inpH.value = toISODate(hoy);

  state.filtros.desde = inpD?.value || '';
  state.filtros.hasta = inpH?.value || '';
}

function wireUI(){
  // header botones
  document.getElementById('btn-home')?.addEventListener('click', () => {
    location.href = 'https://sistemas-raitrai.github.io/Operaciones-RTv1.0';
  });
  document.getElementById('btn-refresh')?.addEventListener('click', () => location.reload());
  document.getElementById('btn-back')?.addEventListener('click', () => history.back());
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    signOut(auth).then(() => location.href = 'login.html');
  });

  // inputs -> state
  const bind = (id, key, transform = (v)=>v) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      state.filtros[key] = transform(el.value);
    });
    state.filtros[key] = transform(el.value);
  };

  bind('filtroDestino', 'destino', v => v);
  bind('filtroCoord', 'coord', v => v.toLowerCase().trim());
  bind('filtroGrupo', 'grupo', v => v.trim());
  bind('filtroActividad', 'actividad', v => v.trim());
  bind('filtroDesde', 'desde', v => v);
  bind('filtroHasta', 'hasta', v => v);
  bind('buscarTexto', 'buscar', v => v);

  // buscar texto en vivo
  document.getElementById('buscarTexto')?.addEventListener('input', () => renderTabla());

  // cargar actividades
  document.getElementById('btnCargarActividades')?.addEventListener('click', async () => {
    // asegura fechas default si están vacías (para muestreo consistente)
    if (!state.filtros.desde || !state.filtros.hasta) setDefaultDates();
    await cargarActividadesSugeridas();
  });

  // cargar bitácora
  document.getElementById('btnCargar')?.addEventListener('click', async () => {
    const pagInfo = document.getElementById('pagInfo');
    if (pagInfo) pagInfo.textContent = 'Cargando…';

    await loadBitacoraByActividad();
    renderTabla();
  });

  // limpiar
  document.getElementById('btnLimpiar')?.addEventListener('click', () => {
    state.filtros.destino = '';
    state.filtros.coord = '';
    state.filtros.grupo = '';
    state.filtros.actividad = '';
    state.filtros.buscar = '';

    const ids = ['filtroDestino','filtroCoord','filtroGrupo','filtroActividad','buscarTexto'];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    // No limpio fechas (las dejo por defecto, útil para no “romper” la lógica)
    state.rows = [];
    state.meta = { gruposConsiderados: 0, dias: 0 };

    const pagInfo = document.getElementById('pagInfo');
    if (pagInfo) pagInfo.textContent = 'Filtros limpios.';

    renderTabla();
  });
}

/* ====================== ARRANQUE ====================== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  state.user = user;

  await preloadCatalogs();
  wireUI();
  setDefaultDates();
  renderTabla();
});
