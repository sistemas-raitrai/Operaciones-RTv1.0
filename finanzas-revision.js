/* Revisión financiera — carga rápida (collectionGroup) */
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, query, where, limit
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

const state = {
  paging: { loading: false },
  rawItems: [],
  filtros: { estado:'', tipo:'', coord:'', grupo:'' },
  caches: {
    grupos: new Map(),          // gid -> doc
    coords: [],                 // emails/nombres para datalist
    groupById: new Map(),       // gid -> {numero,nombre,coordEmail}
    groupsByCoord: new Map(),   // coordEmail/name -> Set(gid)
  },
};

/* ===== Utilidades ===== */
const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';
function parseMontoCLP(any) {
  if (any == null) return 0;
  if (typeof any === 'number' && isFinite(any)) return Math.trunc(any);
  const onlyDigits = String(any).replace(/[^\d-]/g,'');
  const n = parseInt(onlyDigits, 10);
  return isFinite(n) ? n : 0;
}
const money = n => (isFinite(+n)
  ? (+n).toLocaleString('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0})
  : '—');

function deriveEstado(x) {
  const s = (x.estado || '').toString().toLowerCase();
  if (s) return s;
  const r1 = (x.rev1 || '').toString().toLowerCase();
  const r2 = (x.rev2 || '').toString().toLowerCase();
  if (r1 === 'rechazado' || r2 === 'rechazado') return 'rechazado';
  if (r1 === 'aprobado'  && r2 === 'aprobado')  return 'aprobado';
  return 'pendiente';
}

/* ===== Normalizador ===== */
function toItem(grupoId, gInfo, x, hintedTipo) {
  const brutoMonto = coalesce(x.monto, x.montoCLP, x.neto, x.importe, x.valor, x.total, x.totalCLP, x.monto_str, 0);
  const monto = parseMontoCLP(brutoMonto);

  let tipo = (x.tipo || x.type || hintedTipo || '').toString().toLowerCase().trim();
  if (!tipo) tipo = (monto < 0 ? 'abono' : 'gasto');
  if (tipo !== 'abono' && tipo !== 'gasto' && monto !== 0) tipo = (monto < 0 ? 'abono' : 'gasto');

  const rev1  = (x.revision1?.estado || x.rev1?.estado || x.rev1 || '').toString().toLowerCase();
  const rev2  = (x.revision2?.estado || x.rev2?.estado || x.rev2 || '').toString().toLowerCase();
  const pago  = (x.pago?.estado || x.pago || '').toString().toLowerCase();

  // Preferir SIEMPRE el coordinador del grupo (gInfo.coordEmail);
  // si no existe, usar posibles alias del documento
  const coord = coalesce(
    gInfo?.coordEmail,                  // ← prioridad: coordinador del grupo
    x.coordinadorEmail, x.coordinador,  // alias frecuentes en el doc
    x.coord, x.responsable, x.owner, x.usuario, x.user,
    ''
  ).toString().toLowerCase();

  return {
    id: x.id || x._id || '',
    grupoId,
    nombreGrupo: gInfo?.nombre || '',
    numeroNegocio: gInfo?.numero || grupoId,
    coordinador: coord,
    tipo, monto,
    rev1, rev2,
    estado: deriveEstado({ estado:x.estado, rev1, rev2 }),
    pago,
    __from: x.__from || ''
  };
}

/* ===== Catálogos + índices ===== */
async function preloadCatalogs() {
  // Grupos
  const gs = await getDocs(collection(db, 'grupos'));
  const dlG = document.getElementById('dl-grupos');
  const dlC = document.getElementById('dl-coords');
  state.caches.groupsByCoord.clear();
  state.caches.groupById.clear();
  state.caches.coords.length = 0;

  gs.forEach(d => {
    const x = d.data() || {};
    state.caches.grupos.set(d.id, x);
    const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, d.id);
    const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, d.id);
    const coordEmail = coalesce(
      x.coordinadorEmail,         // email directo
      x.coordinador?.email,       // email dentro de objeto
      x.coordinador,              // a veces guardan el slug/string del coord
      x.coord,                    // otros alias comunes
      x.responsable,
      x.owner,
      ''
    );

    state.caches.groupById.set(d.id, { numero, nombre, coordEmail });

    if (coordEmail) {
      if (!state.caches.groupsByCoord.has(coordEmail)) state.caches.groupsByCoord.set(coordEmail, new Set());
      state.caches.groupsByCoord.get(coordEmail).add(d.id);
      if (!state.caches.coords.includes(coordEmail)) state.caches.coords.push(coordEmail);
    }
  });

  // Datalist grupos (todos al inicio)
  if (dlG) {
    dlG.innerHTML = '';
    for (const [gid, info] of state.caches.groupById.entries()) {
      const opt = document.createElement('option');
      opt.value = gid;
      opt.label = `${info.numero} — ${info.nombre}`;
      dlG.appendChild(opt);
    }
  }
  // Datalist coordinadores
  if (dlC) {
    dlC.innerHTML = '';
    for (const email of state.caches.coords) {
      const opt = document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlC.appendChild(opt);
    }
  }
}

/* ===== Carga rápida con collectionGroup ===== */

// Gastos: coordinadores/{coord}/gastos/*
async function loadGastosCG() {
  const qy = query(collectionGroup(db, 'gastos'), limit(2000)); // ajusta si necesitas más
  const snap = await getDocs(qy);
  snap.forEach(docSnap => {
    const x = docSnap.data() || {};
    const coordId = docSnap.ref.parent.parent?.id || ''; // coordinador del path
    const grupoId = coalesce(x.grupoId, x.grupo_id, x.gid, x.idGrupo, x.grupo, x.id_grupo, '');
    if (!grupoId) return;

    // Si el grupo no tiene coordinador en el catálogo, aprenderlo desde el gasto
    const gInfo0 = state.caches.groupById.get(grupoId);
    if (gInfo0 && !gInfo0.coordEmail && coordId) {
      gInfo0.coordEmail = coordId;
      // también actualizamos el índice inverso groupsByCoord para los filtros vinculados
      if (!state.caches.groupsByCoord.has(coordId)) {
        state.caches.groupsByCoord.set(coordId, new Set());
      }
      state.caches.groupsByCoord.get(coordId).add(grupoId);
    }

    const gInfo = state.caches.groupById.get(grupoId) || { numero: grupoId, nombre: '', coordEmail: coordId };
    const enriched = { id: docSnap.id, ...x, coordinador: coordId, __from: 'cg:gastos' };
    state.rawItems.push(toItem(grupoId, { ...gInfo, coordEmail: gInfo.coordEmail || coordId }, enriched, 'gasto'));
  });
}

// Abonos: grupos/{gid}/finanzas_abonos/*
async function loadAbonosCG() {
  const qy = query(collectionGroup(db, 'finanzas_abonos'), limit(2000));
  const snap = await getDocs(qy);
  snap.forEach(docSnap => {
    const x = docSnap.data() || {};
    const gid = docSnap.ref.parent.parent?.id || ''; // grupo del path
    if (!gid) return;

    const gInfo = state.caches.groupById.get(gid) || { numero: gid, nombre: '', coordEmail: '' };
    const enriched = { id: docSnap.id, ...x, __from: 'cg:finanzas_abonos' };
    state.rawItems.push(toItem(gid, gInfo, enriched, 'abono'));
  });
}

/* ===== Filtros ===== */
function applyFilters(items) {
  const f = state.filtros;
  const byEstado = f.estado;
  const byTipo   = f.tipo;
  const byCoord  = norm(f.coord);
  const byGrupo  = norm(f.grupo);

  // Si hay coordinador, limitamos grupos válidos
  let allowedGroups = null;
  if (byCoord) {
    // matches por includes (permite nombre o email)
    // tomamos clave exacta si existe
    const exactCoord = [...state.caches.groupsByCoord.keys()].find(k => norm(k) === byCoord);
    const key = exactCoord ?? byCoord;
    const set = state.caches.groupsByCoord.get(key);
    if (set) allowedGroups = new Set(set);
  }

  return items.filter(x => {
    if (byTipo && x.tipo !== byTipo) return false;

    if (byEstado === 'pagables') {
      const pagable = (x.estado === 'aprobado') && (x.pago !== 'pagado');
      if (!pagable) return false;
    } else if (byEstado && x.estado !== byEstado) {
      return false;
    }

    if (byCoord && !norm(x.coordinador).includes(byCoord)) return false;

    if (allowedGroups && !allowedGroups.has(x.grupoId)) return false;

    if (byGrupo) {
      const blob = norm([x.grupoId, x.nombreGrupo, x.numeroNegocio].join(' '));
      if (!blob.includes(byGrupo)) return false;
    }
    return true;
  });
}

/* ===== Render ===== */
function renderTable() {
  const tbody = document.querySelector('#tblFinanzas tbody');
  const resumen = document.getElementById('resumen');
  const pagInfo = document.getElementById('pagInfo');

  const filtered = applyFilters(state.rawItems);

  tbody.innerHTML = '';
  if (!filtered.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.innerHTML = '<div class="muted">Sin movimientos para este criterio.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();
    filtered.forEach(x => {
      const tr = document.createElement('tr');

      const tdTipo = document.createElement('td');
      tdTipo.textContent = (x.tipo || '—').toUpperCase();

      const tdGrupo = document.createElement('td');
      tdGrupo.innerHTML = `
        <div class="mono">${x.grupoId}</div>
        <span class="small">${(x.numeroNegocio ? x.numeroNegocio + ' · ' : '')}${(x.nombreGrupo || '')}</span>`;

      const tdCoord = document.createElement('td');
      const coordTxt = (x.coordinador && x.coordinador.trim()) ? x.coordinador.toLowerCase() : '—';
      tdCoord.innerHTML = `<span class="${coordTxt==='—' ? 'muted' : ''}">${coordTxt}</span>`;

      const tdMonto = document.createElement('td');
      tdMonto.innerHTML = `<span class="mono">${money(x.monto)}</span>`;

      const tdR1 = document.createElement('td');
      tdR1.innerHTML = `<span class="badge ${x.rev1 || 'pendiente'}">${(x.rev1 || 'pendiente').toUpperCase()}</span>`;

      const tdR2 = document.createElement('td');
      tdR2.innerHTML = `<span class="badge ${x.rev2 || 'pendiente'}">${(x.rev2 || 'pendiente').toUpperCase()}</span>`;

      const tdEstado = document.createElement('td');
      tdEstado.innerHTML = `<span class="badge ${x.estado}">${x.estado.toUpperCase()}</span>`;

      const tdPago = document.createElement('td');
      tdPago.textContent = (x.pago || '—').toUpperCase();

      tr.append(tdTipo, tdGrupo, tdCoord, tdMonto, tdR1, tdR2, tdEstado, tdPago);
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  resumen.textContent = `Mostrando ${filtered.length} / total ${state.rawItems.length}`;
  pagInfo.textContent = state.paging.loading ? 'Cargando…' : 'Listo.';
}

/* ===== Sincronía de filtros coord ↔ grupo ===== */
function refreshGroupDatalist(limitToCoord='') {
  const dlG = document.getElementById('dl-grupos');
  if (!dlG) return;
  dlG.innerHTML = '';

  let ids = [...state.caches.groupById.keys()];
  if (limitToCoord) {
    const set = state.caches.groupsByCoord.get(limitToCoord);
    if (set) ids = [...set];
    else ids = []; // sin grupos para ese coord
  }
  for (const gid of ids) {
    const info = state.caches.groupById.get(gid);
    const opt = document.createElement('option');
    opt.value = gid;
    opt.label = `${info.numero} — ${info.nombre}`;
    dlG.appendChild(opt);
  }
}

function resolveGroupId(text='') {
  const t = norm(text);
  if (!t) return '';
  if (state.caches.groupById.has(text)) return text; // id exacto
  for (const [gid, info] of state.caches.groupById.entries()) {
    const blob = norm([gid, info.numero, info.nombre].join(' '));
    if (blob.includes(t)) return gid;
  }
  return '';
}

/* ===== UI ===== */
function wireUI() {
  const tabs = document.getElementById('stateTabs');
  tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-estado]');
    if (!btn) return;
    tabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filtros.estado = btn.getAttribute('data-estado') || '';
    renderTable();
  });

  // Tipo
  document.getElementById('filtroTipo').onchange = (e) => {
    state.filtros.tipo = e.target.value || '';
    renderTable();
  };

  // Coordinador: al escribir, limitamos grupos; al aplicar, filtramos
  const inputCoord = document.getElementById('filtroCoord');
  inputCoord.oninput = (e) => {
    const val = (e.target.value || '').toLowerCase().trim();
    state.filtros.coord = val;
    // buscar clave exacta para limitar datalist
    const exactKey = [...state.caches.groupsByCoord.keys()].find(k => norm(k) === norm(val));
    refreshGroupDatalist(exactKey || '');
  };

  // Grupo: al escribir/seleccionar, autocompleta coordinador
  const inputGrupo = document.getElementById('filtroGrupo');
  inputGrupo.oninput = (e) => {
    const gid = resolveGroupId(e.target.value || '');
    state.filtros.grupo = e.target.value || '';
    if (gid) {
      const info = state.caches.groupById.get(gid);
      if (info?.coordEmail) {
        inputCoord.value = info.coordEmail;
        state.filtros.coord = info.coordEmail.toLowerCase();
        refreshGroupDatalist(info.coordEmail);
      }
    }
  };

  document.getElementById('btnAplicar').onclick = () => renderTable();
  document.getElementById('btnRecargar').onclick = async () => {
    state.rawItems = [];
    state.paging.loading = true;
    renderTable();
    await fetchFinance(); // recarga completa
  };
  document.getElementById('btnMas').onclick = () => renderTable(); // sin paginación por ahora
}

/* ===== Carga principal ===== */
async function fetchFinance() {
  if (state.paging.loading) return;
  state.paging.loading = true;
  renderTable();

  try {
    await preloadCatalogs();

    // Carga en paralelo
    await Promise.all([
      (async ()=>{ await loadGastosCG(); renderTable(); })(),
      (async ()=>{ await loadAbonosCG(); renderTable(); })(),
    ]);

    renderTable();
  } catch (e) {
    console.warn('[FINZ] fetchFinance()', e);
  } finally {
    state.paging.loading = false;
    renderTable();
    console.log('%c[FINZ] total items:', 'color:#0a0', state.rawItems.length);
  }
}

/* ===== Debug helpers ===== */
window.__finz = {
  list() { return { loaded: state.rawItems.length, sample: state.rawItems.slice(0, 10) }; },
  state: state,
};

/* ===== Arranque ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) { location = 'login.html'; return; }
  try {
    document.querySelector('#btn-logout')?.addEventListener('click', () =>
      signOut(auth).then(() => location = 'login.html')
    );
  } catch (_) {}

  wireUI();
  await fetchFinance();
});
