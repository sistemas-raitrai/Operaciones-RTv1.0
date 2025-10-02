/* Revisión financiera — carga rápida (collectionGroup) */
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, query, where, limit,
  doc, updateDoc
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

  // fuente y asunto (usa alias comunes)
  const from = (x.__from || '').toString();
  const asunto = coalesce(
    x.asunto, x.detalle, x.descripcion, x.concepto, x.motivo, ''
  );
  
  // quién revisó (si ya viene del doc)
  const rev1By = coalesce(x.revision1?.user, x.rev1By, '');
  const rev2By = coalesce(x.revision2?.user, x.rev2By, '');
  
  // coordPath: ID del coordinador que define el path del gasto
  // (lo seteamos en loadGastosCG; en abonos queda vacío)
  const coordPath = x.coordPath || '';

  return {
    id: x.id || x._id || '',
    grupoId,
    nombreGrupo: gInfo?.nombre || '',
    numeroNegocio: gInfo?.numero || grupoId,
    coordinador: coord,
    tipo, asunto, monto,
    rev1, rev2,
    estado: deriveEstado({ estado:x.estado, rev1, rev2 }),
    pago,
    rev1By, rev2By,
    coordPath,
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
    const enriched = {
      id: docSnap.id,
      ...x,
      coordinador: coordId,   // quien gastó (del path)
      coordPath: coordId,     // ← para poder escribir en coordinadores/{coord}/gastos/{id}
      __from: 'cg:gastos'
    };
    state.rawItems.push(
      toItem(grupoId, { ...gInfo, coordEmail: gInfo.coordEmail || coordId }, enriched, 'gasto')
    );
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

function calcTotals(list) {
  let gastos = 0, abonos = 0;
  for (const x of list) {
    if (x?.tipo === 'gasto') gastos += Number(x.monto) || 0;
    else if (x?.tipo === 'abono') abonos += Number(x.monto) || 0;
  }
  const neto = abonos - gastos;
  const hasBoth = (gastos > 0 && abonos > 0);
  return { gastos, abonos, neto, hasBoth };
}

function getMovRef(item) {
  if (item.tipo === 'gasto') {
    const coord = item.coordPath || item.coordinador; // coord del path
    return doc(db, 'coordinadores', coord, 'gastos', item.id);
  }
  // abono
  return doc(db, 'grupos', item.grupoId, 'finanzas_abonos', item.id);
}

async function updateRevision(item, which /*1|2*/, nuevoEstado /* 'pendiente' | 'aprobado' | 'rechazado' */) {
  const user = (auth.currentUser?.email || '').toLowerCase();
  const ref = getMovRef(item);
  const revKey = which === 1 ? 'revision1' : 'revision2';

  await updateDoc(ref, {
    [`${revKey}.estado`]: nuevoEstado,
    [`${revKey}.user`]: user,
    [`${revKey}.at`]: Date.now()
  });

  if (which === 1) {
    item.rev1 = nuevoEstado;
    item.rev1By = user;
  } else {
    item.rev2 = nuevoEstado;
    item.rev2By = user;
  }
  item.estado = deriveEstado({ rev1: item.rev1, rev2: item.rev2 });
}

function nextEstado(cur) {
  const c = (cur || 'pendiente').toLowerCase();
  if (c === 'pendiente') return 'aprobado';
  if (c === 'aprobado')  return 'rechazado';
  return 'pendiente';
}

/* ===== Render ===== */
function renderTable() {
  const tbody = document.querySelector('#tblFinanzas tbody');
  const resumen = document.getElementById('resumen');
  const pagInfo = document.getElementById('pagInfo');

  const filtered = applyFilters(state.rawItems);

  // Totales del conjunto filtrado
  const totals = calcTotals(filtered);
  const totalesEl = document.getElementById('totales');
  if (totalesEl) {
    const parts = [];
    parts.push(`Gastos: ${money(totals.gastos)}`);
    parts.push(`Abonos: ${money(totals.abonos)}`);
    if (totals.hasBoth) parts.push(`Saldo: ${money(totals.neto)}`); // solo si hay ambos
    totalesEl.textContent = parts.join(' · ');
  }

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

      const tdAsunto = document.createElement('td');
      tdAsunto.textContent = (x.asunto && String(x.asunto).trim()) ? String(x.asunto) : '—';

      const tdMonto = document.createElement('td');
      tdMonto.innerHTML = `<span class="mono">${money(x.monto)}</span>`;

      // util: crea celda de revisión tri-estado
      function makeRevCell(item, which) {
        const td = document.createElement('td');
        
        // contenedor para alinear icono + correo en una sola línea
        const wrap = document.createElement('div');
        wrap.className = 'rev-cell';
        
        const btn = document.createElement('button');
        btn.className = 'revbtn';
        btn.type = 'button';
        
        const who = document.createElement('span');
        who.className = 'small'; // el CSS de .rev-cell .small la pone inline

        function applyUI() {
          const cur = (which === 1 ? item.rev1 : item.rev2) || 'pendiente';
          // símbolo y color por estado
          if (cur === 'aprobado') {
            btn.textContent = '✓';
            btn.dataset.state = 'aprobado';
          } else if (cur === 'rechazado') {
            btn.textContent = '✗';
            btn.dataset.state = 'rechazado';
          } else {
            btn.textContent = '—';
            btn.dataset.state = 'pendiente';
          }
          const by = which === 1 ? item.rev1By : item.rev2By;
          who.textContent = by ? by.toUpperCase() : '';
        }
      
        btn.addEventListener('click', async () => {
          const cur = (which === 1 ? item.rev1 : item.rev2) || 'pendiente';
          const nuevo = nextEstado(cur);
          try {
            await updateRevision(item, which, nuevo);
            applyUI();
            tdEstado.innerHTML = `<span class="badge ${item.estado}">${item.estado.toUpperCase()}</span>`;
          } catch (e) {
            console.warn('updateRevision failed', e);
          }
        });
      
        wrap.append(btn, who);
        td.appendChild(wrap);
        applyUI();
        return td;
      }

      // ESTADO (derivado)
      const tdEstado = document.createElement('td');
      tdEstado.innerHTML = `<span class="badge ${x.estado}">${x.estado.toUpperCase()}</span>`;

      // ← crea las celdas tri-estado para las revisiones
      const tdR1 = makeRevCell(x, 1);
      const tdR2 = makeRevCell(x, 2);

      
      // Append final (sin "Pago")
      tr.append(tdTipo, tdGrupo, tdCoord, tdAsunto, tdMonto, tdR1, tdR2, tdEstado);
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

  // Coordinador: al escribir, limitamos el datalist de grupos; al aplicar, filtramos
  const inputCoord = document.getElementById('filtroCoord');
  inputCoord.oninput = (e) => {
    const val = (e.target.value || '').toLowerCase().trim();
    state.filtros.coord = val;
    // buscar clave exacta para limitar datalist
    const exactKey = [...state.caches.groupsByCoord.keys()].find(k => norm(k) === norm(val));
    // si hay coordinador → limitar; si está vacío → mostrar todos
    refreshGroupDatalist(exactKey || '');
  };
  
  // Grupo: al escribir/seleccionar, SOLO ajusta el filtro de grupo (no autocompleta coord)
  const inputGrupo = document.getElementById('filtroGrupo');
  inputGrupo.oninput = (e) => {
    state.filtros.grupo = e.target.value || '';
    // NO tocar el coordinador ni el datalist aquí
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
