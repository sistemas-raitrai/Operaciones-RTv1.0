/* Revisión financiera — Rendición por Coord/Grupo con revisiones cruzadas
   - Carga en blanco: solo trae datos al elegir Coord o Grupo + Tipo y tocar "Aplicar"
   - Columnas: TIPO, GRUPO, COORDINADOR, ASUNTO, MONTO, MONEDA, REV.1, REV.2, REV.PAGO, ESTADO
   - Comentarios en rechazos y "!" para verlos
   - Rev.1/Rev.2/Rev.Pago exigen usuarios distintos (revisión cruzada)
*/

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, query, where, limit,
  doc, updateDoc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

const state = {
  paging: { loading: false },
  rawItems: [],
  filtros: { estado:'', tipo:'', coord:'', grupo:'' }, // tipo: '', 'gasto', 'abono', 'all'
  loadedFor: { key:'' }, // para evitar recargas iguales
  caches: {
    grupos: new Map(),          // gid -> doc
    coords: [],                 // emails para datalist
    groupById: new Map(),       // gid -> {numero,nombre,coordEmail}
    groupsByCoord: new Map(),   // coordEmail -> Set(gid)
  },
};

/* ===== Ordenamiento (con flechas en THs con data-sort-key) ===== */
const sortState = { key: '', dir: 'asc' }; // dir: 'asc' | 'desc'

function getSortValue(item, key) {
  switch (key) {
    case 'tipo':     return item.tipo || '';
    case 'grupo':    return item.grupoId || '';
    case 'coord':    return item.coordinador || '';
    case 'asunto':   return item.asunto || '';
    case 'monto':    return Number(item.monto) || 0;
    case 'moneda':   return item.moneda || '';
    case 'rev1':     return item.rev1 || '';
    case 'rev2':     return item.rev2 || '';
    case 'revpago':  return item.revPago || '';
    case 'estado':   return item.estado || '';
    default:         return '';
  }
}

function sortItems(list) {
  if (!sortState.key) return list.slice();
  const dir = sortState.dir === 'asc' ? 1 : -1;
  return list.slice().sort((a, b) => {
    const va = getSortValue(a, sortState.key);
    const vb = getSortValue(b, sortState.key);
    if (typeof va === 'number' && typeof vb === 'number') {
      return (va - vb) * dir;
    }
    return String(va).localeCompare(String(vb), 'es', { numeric: true, sensitivity: 'base' }) * dir;
  });
}

function applySortHeaderUI() {
  document.querySelectorAll('#tblFinanzas thead th.sortable').forEach(th => {
    th.classList.remove('asc', 'desc');
    if (th.dataset.sortKey === sortState.key) th.classList.add(sortState.dir);
  });
}

/* ===== Utils ===== */
const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';
function parseMonto(any) {
  if (any == null) return 0;
  if (typeof any === 'number' && isFinite(any)) return +any;
  const onlyNum = String(any).replace(/[^\d.-]/g,'');
  const n = parseFloat(onlyNum);
  return isFinite(n) ? n : 0;
}
const moneyCL = n => (isFinite(+n)
  ? (+n).toLocaleString('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0})
  : '—');

function deriveEstado(x) {
  // si revPago aprobado => "cerrada"
  const rp = (x.revPago || '').toString().toLowerCase();
  if (rp === 'aprobado') return 'cerrada';
  const s = (x.estado || '').toString().toLowerCase();
  if (s) return s;
  const r1 = (x.rev1 || '').toString().toLowerCase();
  const r2 = (x.rev2 || '').toString().toLowerCase();
  if (r1 === 'rechazado' || r2 === 'rechazado') return 'rechazado';
  if (r1 === 'aprobado'  && r2 === 'aprobado')  return 'aprobado';
  return 'pendiente';
}

/* ===== Normalizador de docs a fila ===== */
function toItem(grupoId, gInfo, x, hintedTipo) {
  const brutoMonto = coalesce(x.monto, x.montoCLP, x.neto, x.importe, x.valor, x.total, x.totalCLP, x.monto_str, 0);
  const monto = parseMonto(brutoMonto);

  let tipo = (x.tipo || x.type || hintedTipo || '').toString().toLowerCase().trim();
  if (!tipo) tipo = (monto < 0 ? 'abono' : 'gasto');
  if (tipo !== 'abono' && tipo !== 'gasto' && monto !== 0) tipo = (monto < 0 ? 'abono' : 'gasto');

  const moneda = (x.moneda || x.currency || 'CLP').toString().toUpperCase();

  const rev1Obj   = x.revision1 || x.rev1 || {};
  const rev2Obj   = x.revision2 || x.rev2 || {};
  const pagoObj   = x.revPago || x.pago || x.revisionPago || {};

  const rev1  = (rev1Obj.estado || '').toString().toLowerCase();
  const rev2  = (rev2Obj.estado || '').toString().toLowerCase();
  const revPago = (pagoObj.estado || '').toString().toLowerCase();

  const rev1By   = (rev1Obj.user || x.rev1By || '') || '';
  const rev2By   = (rev2Obj.user || x.rev2By || '') || '';
  const revPagoBy= (pagoObj.user || x.revPagoBy || x.pagoBy || '') || '';

  const r1Comment = (rev1Obj.comentario || '') || '';
  const r2Comment = (rev2Obj.comentario || '') || '';
  const rpComment = (pagoObj.comentario || '') || '';

  // Coordinador preferente del grupo
  const coord = coalesce(
    gInfo?.coordEmail,
    x.coordinadorEmail, x.coordinador, x.coord, x.responsable, x.owner, x.usuario, x.user, ''
  ).toString().toLowerCase();

  const asunto = coalesce(x.asunto, x.detalle, x.descripcion, x.concepto, x.motivo, '');

  const coordPath = x.coordPath || '';

  const item = {
    id: x.id || x._id || '',
    grupoId,
    nombreGrupo: gInfo?.nombre || '',
    numeroNegocio: gInfo?.numero || grupoId,
    coordinador: coord,
    tipo, asunto, monto, moneda,
    rev1, rev2, revPago,
    rev1By, rev2By, revPagoBy,
    r1Comment, r2Comment, rpComment,
    estado: 'pendiente',
    coordPath,
    __from: x.__from || ''
  };
  item.estado = deriveEstado(item);
  return item;
}

/* ===== Catálogos + índices (para datalists y filtros) ===== */
async function preloadCatalogs() {
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
      x.coordinadorEmail,
      x.coordinador?.email,
      x.coordinador,
      x.coord,
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

  if (dlG) {
    dlG.innerHTML = '';
    for (const [gid, info] of state.caches.groupById.entries()) {
      const opt = document.createElement('option');
      opt.value = gid;
      opt.label = `${info.numero} — ${info.nombre}`;
      dlG.appendChild(opt);
    }
  }
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

/* ===== CARGA SELECTIVA (solo con filtros) ===== */
// Gastos: por grupo con collectionGroup+where; por coord con subcolección directa
async function loadGastosForFilter({ coordEmail='', grupoId='' }) {
  const pushGasto = (grupoId, coordId, d) => {
    const x = d.data() || {};
    const gInfo0 = state.caches.groupById.get(grupoId);
    const gInfo = gInfo0 || { numero: grupoId, nombre: '', coordEmail: coordId };
    const enriched = { id: d.id, ...x, coordinador: coordId, coordPath: coordId, __from: 'cg:gastos' };
    state.rawItems.push(toItem(grupoId, { ...gInfo, coordEmail: gInfo.coordEmail || coordId }, enriched, 'gasto'));
  };

  // Si hay grupo definido: usar collectionGroup con where('grupoId'=='gid')
  if (grupoId) {
    const qy = query(collectionGroup(db, 'gastos'), where('grupoId','==', grupoId), limit(2000));
    const snap = await getDocs(qy);
    snap.forEach(s => {
      const coordId = s.ref.parent.parent?.id || ''; // id de coord en path
      pushGasto(grupoId, coordId, s);
    });
    return;
  }

  // Si no hay grupo pero sí coordinador: leer subcolección directa
  if (coordEmail) {
    const col = collection(db, 'coordinadores', coordEmail, 'gastos');
    const snap = await getDocs(col);
    snap.forEach(s => {
      const x = s.data() || {};
      const gid = coalesce(x.grupoId, x.grupo_id, x.gid, x.idGrupo, x.grupo, x.id_grupo, '');
      if (!gid) return;
      pushGasto(gid, coordEmail, s);
    });
  }
}

// Abonos/Pagos: por grupo (subcolección directa); por coord (recorrer grupos del coord)
async function loadAbonosForFilter({ coordEmail='', grupoId='' }) {
  const pushAbono = (gid, d) => {
    const x = d.data() || {};
    const gInfo = state.caches.groupById.get(gid) || { numero: gid, nombre: '', coordEmail: '' };
    const enriched = { id: d.id, ...x, __from: 'cg:finanzas_abonos' };
    state.rawItems.push(toItem(gid, gInfo, enriched, 'abono'));
  };

  if (grupoId) {
    const col = collection(db, 'grupos', grupoId, 'finanzas_abonos');
    const snap = await getDocs(col);
    snap.forEach(s => pushAbono(grupoId, s));
    return;
  }

  if (coordEmail) {
    const set = state.caches.groupsByCoord.get(coordEmail);
    const gids = set ? [...set] : [];
    for (const gid of gids) {
      const col = collection(db, 'grupos', gid, 'finanzas_abonos');
      const snap = await getDocs(col);
      snap.forEach(s => pushAbono(gid, s));
    }
  }
}

/* ===== Filtros en memoria ===== */
function applyFilters(items) {
  const f = state.filtros;
  const byEstado = f.estado;
  const byTipo   = f.tipo;               // 'gasto', 'abono', 'all' o ''
  const byCoord  = norm(f.coord);
  const byGrupo  = norm(f.grupo);

  // limitar grupos si hay coord
  let allowedGroups = null;
  if (byCoord) {
    const exactCoord = [...state.caches.groupsByCoord.keys()].find(k => norm(k) === byCoord);
    const key = exactCoord ?? byCoord;
    const set = state.caches.groupsByCoord.get(key);
    if (set) allowedGroups = new Set(set);
  }

  return items.filter(x => {
    if (byTipo && byTipo !== 'all' && x.tipo !== byTipo) return false;

    if (byEstado === 'pagables') {
      const pagable = (x.estado === 'aprobado') && (x.revPago !== 'aprobado');
      if (!pagable) return false;
    } else if (byEstado && byEstado !== 'all' && x.estado !== byEstado) {
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
  const hasBoth = (gastos !== 0 && abonos !== 0);
  return { gastos, abonos, neto, hasBoth };
}

function getMovRef(item) {
  if (item.tipo === 'gasto') {
    const coord = item.coordPath || item.coordinador;
    return doc(db, 'coordinadores', coord, 'gastos', item.id);
  }
  return doc(db, 'grupos', item.grupoId, 'finanzas_abonos', item.id);
}

/* ===== Reglas de revisión cruzada + comentarios ===== */
function enforceCrossReview(which, item, userEmail, nuevoEstado) {
  const u = userEmail.toLowerCase();

  // si es acción "pendiente" no exigimos cruces
  if (nuevoEstado === 'pendiente') return { ok:true };

  // Para aprobar/rechazar, no puede ser el mismo que el otro
  if (which === 'revision1') {
    if (item.rev2By && item.rev2By.toLowerCase() === u) {
      return { ok:false, msg:'REV.2 ya fue hecho por este usuario. Debe ser distinto.' };
    }
    if (item.revPagoBy && item.revPagoBy.toLowerCase() === u) {
      return { ok:false, msg:'REV. PAGO ya fue hecho por este usuario. Debe ser distinto.' };
    }
  } else if (which === 'revision2') {
    if (item.rev1By && item.rev1By.toLowerCase() === u) {
      return { ok:false, msg:'REV.1 ya fue hecho por este usuario. Debe ser distinto.' };
    }
    if (item.revPagoBy && item.revPagoBy.toLowerCase() === u) {
      return { ok:false, msg:'REV. PAGO ya fue hecho por este usuario. Debe ser distinto.' };
    }
  } else if (which === 'revPago') {
    if (item.rev1By && item.rev1By.toLowerCase() === u) {
      return { ok:false, msg:'REV.1 ya fue hecho por este usuario. Debe ser distinto.' };
    }
    if (item.rev2By && item.rev2By.toLowerCase() === u) {
      return { ok:false, msg:'REV.2 ya fue hecho por este usuario. Debe ser distinto.' };
    }
  }
  return { ok:true };
}

function nextEstado(cur) {
  const c = (cur || 'pendiente').toLowerCase();
  if (c === 'pendiente') return 'aprobado';
  if (c === 'aprobado')  return 'rechazado';
  return 'pendiente';
}

// Guardar revisión (rev1, rev2 o revPago) con comentario opcional en RECHAZADO
async function updateRevision(item, which /* 'revision1'|'revision2'|'revPago' */, nuevoEstado) {
  const user = (auth.currentUser?.email || '').toLowerCase();
  const ref = getMovRef(item);

  // Revisión cruzada (usuarios distintos)
  const chk = enforceCrossReview(which, item, user, nuevoEstado);
  if (!chk.ok) { alert(chk.msg); return false; }

  // Comentario si rechazo
  let comentario = '';
  if (nuevoEstado === 'rechazado') {
    comentario = prompt('Motivo del rechazo (se mostrará con el icono "!"):', '') || '';
    if (!comentario.trim()) {
      alert('Debes ingresar un comentario para rechazar.');
      return false;
    }
  }

  try {
    const payload = {};
    payload[`${which}.estado`] = nuevoEstado;
    payload[`${which}.user`] = user;
    payload[`${which}.at`] = Date.now();
    if (nuevoEstado === 'rechazado') payload[`${which}.comentario`] = comentario;

    await updateDoc(ref, payload);

    // Leer back (sanity)
    const snap = await getDoc(ref);
    const data = snap.data() || {};

    const r1 = data.revision1 || {};
    const r2 = data.revision2 || {};
    const rp = data.revPago || data.pago || data.revisionPago || {};

    item.rev1 = (r1.estado || '').toLowerCase();
    item.rev2 = (r2.estado || '').toLowerCase();
    item.revPago = (rp.estado || '').toLowerCase();

    item.rev1By = (r1.user || '') || '';
    item.rev2By = (r2.user || '') || '';
    item.revPagoBy = (rp.user || '') || '';

    item.r1Comment = (r1.comentario || '') || '';
    item.r2Comment = (r2.comentario || '') || '';
    item.rpComment = (rp.comentario || '') || '';

    item.estado = deriveEstado(item);
    return true;
  } catch (e) {
    console.error('[FINZ] updateRevision ERROR', e);
    alert('No se pudo guardar la revisión.');
    return false;
  }
}

/* ===== Render ===== */
function renderTable() {
  const tbody = document.querySelector('#tblFinanzas tbody');
  const resumen = document.getElementById('resumen');
  const pagInfo = document.getElementById('pagInfo');
  const totalesEl = document.getElementById('totales');

  const filtered = applyFilters(state.rawItems);
  const data = sortItems(filtered);

  // Totales
  const totals = calcTotals(data);
  if (totalesEl) {
    const parts = [];
    parts.push(`GASTOS: ${moneyCL(totals.gastos)}`);
    parts.push(`ABONOS: ${moneyCL(totals.abonos)}`);
    if (totals.hasBoth) parts.push(`SALDO: ${moneyCL(totals.neto)}`);
    totalesEl.textContent = parts.join(' · ');
  }

  tbody.innerHTML = '';
  if (!data.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.innerHTML = '<div class="muted">SIN MOVIMIENTOS PARA ESTE CRITERIO.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();

    data.forEach(x => {
      const tr = document.createElement('tr');

      const tdTipo = document.createElement('td');
      tdTipo.textContent = (x.tipo || '—').toUpperCase();

      const tdGrupo = document.createElement('td');
      tdGrupo.innerHTML = `
        <div class="mono">${x.grupoId}</div>
        <span class="small">${(x.numeroNegocio ? x.numeroNegocio + ' · ' : '')}${(x.nombreGrupo || '')}</span>`;

      const tdCoord = document.createElement('td');
      tdCoord.innerHTML = `<span>${(x.coordinador || '—').toLowerCase()}</span>`;

      const tdAsunto = document.createElement('td');
      tdAsunto.textContent = (x.asunto && String(x.asunto).trim()) ? String(x.asunto) : '—';

      const tdMonto = document.createElement('td');
      tdMonto.innerHTML = `<span class="mono">${moneyCL(x.monto)}</span>`;

      const tdMoneda = document.createElement('td');
      tdMoneda.textContent = (x.moneda || '—').toUpperCase();

      // celda revisión genérica
      function makeRevCell(item, which /* 'revision1'|'revision2'|'revPago' */) {
        const td = document.createElement('td');
        const wrap = document.createElement('div');
        wrap.className = 'rev-cell';

        const btn = document.createElement('button');
        btn.className = 'revbtn';
        btn.type = 'button';

        const who = document.createElement('span');
        who.className = 'small';

        const bang = document.createElement('span'); // icono !
        bang.textContent = ' ! ';
        bang.style.cssText = 'font-weight:900;cursor:pointer;display:none';

        function curEstado() {
          if (which === 'revision1') return item.rev1 || 'pendiente';
          if (which === 'revision2') return item.rev2 || 'pendiente';
          return item.revPago || 'pendiente';
        }
        function curUser() {
          if (which === 'revision1') return item.rev1By || '';
          if (which === 'revision2') return item.rev2By || '';
          return item.revPagoBy || '';
        }
        function curComment() {
          if (which === 'revision1') return item.r1Comment || '';
          if (which === 'revision2') return item.r2Comment || '';
          return item.rpComment || '';
        }

        function applyUI() {
          const est = curEstado();
          if (est === 'aprobado') {
            btn.textContent = '✓';
            btn.dataset.state = 'aprobado';
          } else if (est === 'rechazado') {
            btn.textContent = '✗';
            btn.dataset.state = 'rechazado';
          } else {
            btn.textContent = '—';
            btn.dataset.state = 'pendiente';
          }
          const by = curUser();
          who.textContent = by ? by.toUpperCase() : '';
          const c = curComment();
          bang.style.display = (est === 'rechazado' && c) ? 'inline-block' : 'none';
        }

        btn.addEventListener('click', async () => {
          const actual = curEstado();
          const nuevo = nextEstado(actual);
          const ok = await updateRevision(item, which, nuevo);
          if (ok) {
            applyUI();
            tdEstado.innerHTML = `<span class="badge ${item.estado}">${item.estado.toUpperCase()}</span>`;
          }
        });

        bang.addEventListener('click', () => {
          const c = curComment();
          alert(c ? c.toString().toUpperCase() : 'SIN COMENTARIO.');
        });

        wrap.append(btn, who, bang);
        td.appendChild(wrap);
        applyUI();
        return td;
      }

      const tdR1 = makeRevCell(x, 'revision1');
      const tdR2 = makeRevCell(x, 'revision2');
      const tdRP = makeRevCell(x, 'revPago'); // para ambos tipos

      const tdEstado = document.createElement('td');
      tdEstado.innerHTML = `<span class="badge ${x.estado}">${x.estado.toUpperCase()}</span>`;

      tr.append(tdTipo, tdGrupo, tdCoord, tdAsunto, tdMonto, tdMoneda, tdR1, tdR2, tdRP, tdEstado);
      frag.appendChild(tr);
    });

    tbody.appendChild(frag);
  }

  const totalLoaded = state.rawItems.length;
  resumen.textContent = `MOSTRANDO ${data.length} / TOTAL ${totalLoaded}`;
  pagInfo.textContent = state.paging.loading ? 'CARGANDO…' : 'LISTO.';

  applySortHeaderUI();
}

/* ===== Sincronía de datalist grupo ↔ coord ===== */
function refreshGroupDatalist(limitToCoord='') {
  const dlG = document.getElementById('dl-grupos');
  if (!dlG) return;
  dlG.innerHTML = '';

  let ids = [...state.caches.groupById.keys()];
  if (limitToCoord) {
    const set = state.caches.groupsByCoord.get(limitToCoord);
    ids = set ? [...set] : [];
  }
  for (const gid of ids) {
    const info = state.caches.groupById.get(gid);
    const opt = document.createElement('option');
    opt.value = gid;
    opt.label = `${info.numero} — ${info.nombre}`;
    dlG.appendChild(opt);
  }
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

  // Tipo (obligatorio para cargar)
  document.getElementById('filtroTipo').onchange = (e) => {
    const v = (e.target.value || '').toLowerCase();
    state.filtros.tipo = (v === 'pagos') ? 'abono' : (v === 'gastos' ? 'gasto' : (v === '' ? '' : (v === 'todos' ? 'all' : v)));
    renderTable();
  };

  // Coordinador: limita datalist de grupos
  const inputCoord = document.getElementById('filtroCoord');
  inputCoord.oninput = (e) => {
    const val = (e.target.value || '').toLowerCase().trim();
    state.filtros.coord = val;
    const exactKey = [...state.caches.groupsByCoord.keys()].find(k => norm(k) === norm(val));
    refreshGroupDatalist(exactKey || '');
  };

  // Grupo
  const inputGrupo = document.getElementById('filtroGrupo');
  inputGrupo.oninput = (e) => {
    state.filtros.grupo = e.target.value || '';
  };

  // Aplicar: CARGA SELECTIVA
  document.getElementById('btnAplicar').onclick = async () => {
    const tipo = state.filtros.tipo;     // 'gasto'|'abono'|'all'
    const coord = (state.filtros.coord || '').trim();
    const grupo = (state.filtros.grupo || '').trim();

    if (!tipo) { alert('ELIGE TIPO: GASTOS, PAGOS O TODOS.'); return; }
    if (!coord && !grupo) { alert('DEBES ELEGIR COORDINADOR O GRUPO.'); return; }

    const key = `${tipo}|${coord}|${grupo}`;
    if (state.loadedFor.key === key) { renderTable(); return; }

    state.rawItems = [];
    state.paging.loading = true;
    renderTable();

    try {
      // Normalizamos: coord exacto si existe
      let coordExact = '';
      if (coord) {
        coordExact = [...state.caches.groupsByCoord.keys()].find(k => norm(k) === norm(coord)) || coord;
      }
      // Cargas según tipo
      if (tipo === 'gasto' || tipo === 'all') {
        await loadGastosForFilter({ coordEmail: coordExact, grupoId: grupo });
      }
      if (tipo === 'abono' || tipo === 'all') {
        await loadAbonosForFilter({ coordEmail: coordExact, grupoId: grupo });
      }

      state.loadedFor.key = key;
    } catch (e) {
      console.warn('[FINZ] aplicar filtros', e);
    } finally {
      state.paging.loading = false;
      renderTable();
    }
  };

  // Recargar catálogos (no datos)
  document.getElementById('btnRecargar').onclick = async () => {
    state.loadedFor.key = '';
    await preloadCatalogs();
    refreshGroupDatalist('');
    renderTable();
  };

  // “Cargar más” (sin paginación en esta versión)
  document.getElementById('btnMas').onclick = () => renderTable();

  // Encabezados para ordenar
  const head = document.querySelector('#tblFinanzas thead');
  head?.querySelectorAll('th[data-sort-key]').forEach(th => {
    th.classList.add('sortable');
    th.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (!key) return;
      if (sortState.key === key) sortState.dir = (sortState.dir === 'asc' ? 'desc' : 'asc');
      else { sortState.key = key; sortState.dir = 'asc'; }
      renderTable();
    });
  });
}

/* ===== Arranque ===== */
async function boot() {
  try {
    await preloadCatalogs(); // Solo catálogos (coordinadores/grupos)
    renderTable();           // Arranca en blanco
  } catch (e) {
    console.error('BOOT catalogs', e);
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { location = 'login.html'; return; }
  try {
    document.querySelector('#btn-logout')?.addEventListener('click', () =>
      signOut(auth).then(() => location = 'login.html')
    );
  } catch (_) {}
  wireUI();
  await boot(); // NO cargamos movimientos hasta “Aplicar”
});

/* ===== Debug ===== */
window.__finz = {
  state,
  list(){ return state.rawItems.slice(0,20); }
};
