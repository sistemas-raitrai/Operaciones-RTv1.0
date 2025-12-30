// revision_docs.js
// Revisión de boletas / comprobantes / constancias + comprobantes de gastos
// Muestra muchos grupos a la vez (filtrado por destino, coord, fechas, texto).

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, getDocs, doc, getDoc, setDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ====================== STATE ====================== */
const state = {
  user: null,
  filtros: {
    destino: '',
    coord: '',
    fechaDesde: null, // ms
    fechaHasta: null, // ms
    texto: ''
  },
  caches: {
    grupos: new Map(),    // gid -> {numero, nombre, destino, coordEmail, ...}
    coords: new Set(),
    destinos: new Set()
  },
  docs: []               // lista plana de documentos a mostrar en la tabla
};

/* ====================== UTILS ====================== */
const norm = (s='') =>
  s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();

const coalesce = (...xs) =>
  xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

const parseMonto = (any) => {
  if (any == null) return 0;
  if (typeof any === 'number' && isFinite(any)) return Math.round(any);
  const n = parseInt(String(any).replace(/[^\d-]/g,''),10);
  return isFinite(n) ? n : 0;
};

const moneyCLP = n =>
  (isFinite(+n)
    ? (+n).toLocaleString('es-CL',{ style:'currency', currency:'CLP', maximumFractionDigits:0 })
    : '—');

const moneyBy = (n, curr='CLP') =>
  (isFinite(+n)
    ? (+n).toLocaleString('es-CL',{ style:'currency', currency:curr, maximumFractionDigits:2 })
    : '—');

function _toMs(v){
  if (v == null) return 0;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v); return isFinite(t) ? t : 0;
  }
  if (typeof v === 'object') {
    if ('seconds' in v) return v.seconds*1000 + Math.floor((v.nanoseconds||0)/1e6);
    const t = Date.parse(v); return isFinite(t) ? t : 0;
  }
  return 0;
}
function pickFechaMs(raw){
  const cands = [
    raw.fecha, raw.fechaPago, raw.fechaAbono,
    raw.createdAt, raw.created, raw.ts, raw.at, raw.timestamp, raw.time
  ];
  for (const c of cands){
    const ms = _toMs(c);
    if (ms) return ms;
  }
  return 0;
}
function fmtDDMMYYYY(ms){
  if (!ms) return '';
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/* ====================== CATALOGOS (GRUPOS) ====================== */
async function preloadGruposDocs() {
  state.caches.grupos.clear();
  state.caches.coords.clear();
  state.caches.destinos.clear();

  const snap = await getDocs(collection(db,'grupos'));

  const dlCoords   = document.getElementById('dl-coords-docs');
  const dlDestinos = document.getElementById('dl-destinos-docs');
  if (dlCoords)   dlCoords.innerHTML   = '';
  if (dlDestinos) dlDestinos.innerHTML = '';

  snap.forEach(d => {
    const x   = d.data() || {};
    const gid = d.id;

    const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
    const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);
    const coordEmail = coalesce(
      x.coordinadorEmail, x.coordinador?.email, x.coordinador,
      x.coord, x.responsable, x.owner, ''
    ).toLowerCase();
    const destino = coalesce(x.destino, x.lugar, '').toUpperCase().trim();

    const gInfo = {
      gid,
      numero,
      nombre,
      coordEmail,
      destino,
      // por si los quieres más adelante:
      fechaInicio: x.fechaInicio || x.fechaInicioViaje || null,
      fechaFin:    x.fechaFin    || x.fechaFinViaje    || null
    };

    state.caches.grupos.set(gid, gInfo);
    if (coordEmail) state.caches.coords.add(coordEmail);
    if (destino)    state.caches.destinos.add(destino);
  });

  // llenar datalists
  if (dlCoords) {
    Array.from(state.caches.coords).sort().forEach(email => {
      const opt = document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlCoords.appendChild(opt);
    });
  }

  if (dlDestinos) {
    Array.from(state.caches.destinos).sort().forEach(dest => {
      const opt = document.createElement('option');
      opt.value = dest;
      opt.label = dest;
      dlDestinos.appendChild(opt);
    });
  }
}

/* ====================== GASTO → ITEM (solo lo que necesitamos) ====================== */
function gastoToDocItem(grupoInfo, raw, coordFromPath) {
  const brutoMonto = coalesce(
    raw.monto, raw.montoCLP, raw.neto, raw.importe,
    raw.valor, raw.total, raw.totalCLP, raw.monto_str, 0
  );
  const monto   = parseMonto(brutoMonto);
  const moneda  = (raw.moneda || raw.currency || 'CLP').toString().toUpperCase();

  const fechaMs  = pickFechaMs(raw);
  const fechaTxt = fechaMs ? fmtDDMMYYYY(fechaMs) : '';

  const asunto = coalesce(raw.asunto, raw.detalle, raw.descripcion, raw.concepto, raw.motivo, '');
  const imgUrl = coalesce(
    raw.imgUrl,
    raw.imageUrl,
    raw.imagenUrl,
    raw.comprobanteUrl,
    ''
  );

  // flags de revisión (nuevo namespace, para no confundir con rendición financiera)
  const rev = raw.revisionDocs || {};
  const revisadoOk = !!rev.ok;
  const revisadoBy = rev.by || '';
  const revisadoAt = rev.at ? _toMs(rev.at) : 0;

  return {
    tipoDoc: 'GASTO',
    gastoId: raw.id || raw._id || '',
    grupoId: grupoInfo.gid,
    numeroGrupo: grupoInfo.numero,
    nombreGrupo: grupoInfo.nombre,
    destino: grupoInfo.destino,
    coordEmail: coordFromPath || grupoInfo.coordEmail || '',
    fechaMs,
    fechaTxt,
    moneda,
    monto,
    asunto,
    url: imgUrl,
    revisadoOk,
    revisadoBy,
    revisadoAt
  };
}

/* ====================== CARGA DE DOCUMENTOS ====================== */

/**
 * Construye documentos de nivel grupo (boleta / comp CLP / constancia USD)
 * usando grupos/{gid}/finanzas/summary
 */
async function loadDocsSummaryForGroups(gids) {
  const out = [];

  for (const gid of gids) {
    const gInfo = state.caches.grupos.get(gid);
    if (!gInfo) continue;

    let summary = null;
    try {
      const ref  = doc(db,'grupos',gid,'finanzas','summary');
      const snap = await getDoc(ref);
      summary = snap.exists() ? (snap.data() || {}) : null;
    } catch (e) {
      console.warn('[DOCS] load summary', gid, e);
    }

    const docsOk = (summary && summary.docsOk) || {};
    const boletaUrl = coalesce(
      summary?.boleta?.url,
      summary?.boletaUrl,
      ''
    );
    const compUrl = coalesce(
      summary?.transfer?.comprobanteUrl,
      summary?.transferenciaCLP?.url,
      summary?.comprobanteCLP?.url,
      summary?.comprobante?.url,
      summary?.transfer?.url,
      summary?.transferencia?.url,
      summary?.transferenciaCLPUrl,
      summary?.comprobanteUrl,
      ''
    );
    const transfUrl = coalesce(
      summary?.cashUsd?.comprobanteUrl,
      summary?.transferenciaCoord?.url,
      summary?.constanciaUSD?.url,
      summary?.constancia?.url,
      summary?.transferenciaCoordUrl,
      summary?.constanciaUrl,
      ''
    );

    const base = {
      grupoId: gid,
      numeroGrupo: gInfo.numero,
      nombreGrupo: gInfo.nombre,
      destino: gInfo.destino,
      coordEmail: gInfo.coordEmail || '',
      fechaMs: 0,
      fechaTxt: '',
      moneda: 'CLP',
      monto: 0
    };

    // Boleta (si existe url o si docsOk.boleta está marcado)
    if (boletaUrl || docsOk.boleta) {
      out.push({
        ...base,
        tipoDoc: 'BOLETA',
        gastoId: null,
        url: boletaUrl,
        revisadoOk: !!docsOk.boleta,
        revisadoBy: docsOk.by || '',
        revisadoAt: docsOk.at ? _toMs(docsOk.at) : 0
      });
    }

    // Comprobante CLP
    if (compUrl || docsOk.comprobante) {
      out.push({
        ...base,
        tipoDoc: 'COMP_CLP',
        gastoId: null,
        url: compUrl,
        revisadoOk: !!docsOk.comprobante,
        revisadoBy: docsOk.by || '',
        revisadoAt: docsOk.at ? _toMs(docsOk.at) : 0
      });
    }

    // Constancia USD / transferencia coord
    if (transfUrl || docsOk.transferencia) {
      out.push({
        ...base,
        tipoDoc: 'CONST_USD',
        gastoId: null,
        url: transfUrl,
        revisadoOk: !!docsOk.transferencia,
        revisadoBy: docsOk.by || '',
        revisadoAt: docsOk.at ? _toMs(docsOk.at) : 0
      });
    }
  }

  return out;
}

/**
 * Carga los gastos con imagen (comprobante) para los grupos indicados
 * usando collectionGroup('gastos') y filtrando por grupoId.
 */
async function loadDocsGastosForGroups(gids) {
  const out = [];
  if (!gids.length) return out;

  const gidSet = new Set(gids);

  try {
    const snap = await getDocs(collectionGroup(db,'gastos'));
    snap.forEach(docSnap => {
      const raw = docSnap.data() || {};

      const gid = coalesce(
        raw.grupoId, raw.grupo_id, raw.gid, raw.idGrupo,
        raw.grupo, raw.id_grupo,
        (raw.numeroNegocio && raw.identificador)
          ? `${raw.numeroNegocio}-${raw.identificador}` : ''
      );
      if (!gid || !gidSet.has(gid)) return;

      // si no tiene imagen, no nos interesa para esta pantalla
      const hasImg = coalesce(
        raw.imgUrl,
        raw.imageUrl,
        raw.imagenUrl,
        raw.comprobanteUrl,
        ''
      );
      if (!hasImg) return;

      const coordFromPath = (docSnap.ref.parent.parent?.id || '').toLowerCase();
      const gInfo = state.caches.grupos.get(gid);
      if (!gInfo) return;

      const item = gastoToDocItem(gInfo, { id: docSnap.id, ...raw }, coordFromPath);
      out.push(item);
    });
  } catch (e) {
    console.warn('[DOCS] load gastos docs', e);
  }

  return out;
}

/**
 * Aplica filtros a los grupos y luego carga:
 *  - docs de summary (boleta/comp/constancia)
 *  - docs de gastos con imagen
 */
async function loadDocsForCurrentFilters() {
  state.docs = [];

  const destinoFilter = state.filtros.destino ? state.filtros.destino.toUpperCase().trim() : '';
  const coordFilter   = state.filtros.coord ? state.filtros.coord.toLowerCase().trim() : '';
  const textoFilter   = norm(state.filtros.texto || '');

  const fechaDesde = state.filtros.fechaDesde;
  const fechaHasta = state.filtros.fechaHasta;

  // 1) obtener lista de grupos que pasan filtros por destino/coord
  const filteredGids = [];
  for (const [gid, gInfo] of state.caches.grupos.entries()) {
    if (destinoFilter && gInfo.destino !== destinoFilter) continue;
    if (coordFilter && (gInfo.coordEmail || '').toLowerCase() !== coordFilter) continue;

    // filtro textual a nivel grupo (nombre, numero, destino)
    const blobGrupo = norm(`${gInfo.numero} ${gInfo.nombre} ${gInfo.destino} ${gInfo.coordEmail}`);
    if (textoFilter && !blobGrupo.includes(textoFilter)) continue;

    filteredGids.push(gid);
  }

  if (!filteredGids.length) {
    state.docs = [];
    renderDocsTable();
    return;
  }

  // 2) cargar docs de summary + docs de gastos
  const [docsSummary, docsGastos] = await Promise.all([
    loadDocsSummaryForGroups(filteredGids),
    loadDocsGastosForGroups(filteredGids)
  ]);

  let docsAll = [...docsSummary, ...docsGastos];

  // 3) filtros de fecha / texto a nivel documento
  docsAll = docsAll.filter(doc => {
    // fecha (si viene de gasto). Los docs summary tienen fechaMs 0 => entran igual.
    if (fechaDesde && doc.fechaMs && doc.fechaMs < fechaDesde) return false;
    if (fechaHasta && doc.fechaMs && doc.fechaMs > fechaHasta) return false;

    if (textoFilter) {
      const blob = norm(
        `${doc.numeroGrupo} ${doc.nombreGrupo} ${doc.destino} ${doc.coordEmail} ${doc.tipoDoc} ${doc.asunto || ''}`
      );
      if (!blob.includes(textoFilter)) return false;
    }

    return true;
  });

  // ordenar por fecha (gastos primero por fecha; los de summary al final)
  docsAll.sort((a,b) => (a.fechaMs || 0) - (b.fechaMs || 0));

  state.docs = docsAll;
  renderDocsTable();
}

/* ====================== GUARDAR REVISIÓN ====================== */

async function updateRevisionForDoc(docItem, checked) {
  const email = (auth.currentUser?.email || '').toLowerCase();
  const now   = Date.now();

  // 1) Documentos de resumen (BOLETA / COMP_CLP / CONST_USD)
  if (docItem.tipoDoc === 'BOLETA' ||
      docItem.tipoDoc === 'COMP_CLP' ||
      docItem.tipoDoc === 'CONST_USD') {

    const gid = docItem.grupoId;
    if (!gid) return false;

    const ref = doc(db,'grupos',gid,'finanzas','summary');

    const patch = {
      'docsOk.by': email,
      'docsOk.at': now
    };

    if (docItem.tipoDoc === 'BOLETA') {
      patch['docsOk.boleta'] = !!checked;
    }
    if (docItem.tipoDoc === 'COMP_CLP') {
      patch['docsOk.comprobante'] = !!checked;
    }
    if (docItem.tipoDoc === 'CONST_USD') {
      patch['docsOk.transferencia'] = !!checked;
    }

    try {
      await setDoc(ref, patch, { merge:true });
      docItem.revisadoOk = !!checked;
      docItem.revisadoBy = email;
      docItem.revisadoAt = now;
      return true;
    } catch (e) {
      console.error('[DOCS] updateRevisionForDoc summary', e);
      alert('No se pudo guardar la revisión del documento de grupo.');
      return false;
    }
  }

  // 2) Documentos de gasto individual (tipoDoc === 'GASTO')
  if (docItem.tipoDoc === 'GASTO') {
    const gid   = docItem.grupoId;
    const coord = docItem.coordEmail;
    const gastoId = docItem.gastoId;
    if (!gid || !coord || !gastoId) return false;

    try {
      const ref = doc(db,'coordinadores',coord,'gastos',gastoId);
      await updateDoc(ref, {
        'revisionDocs.ok': !!checked,
        'revisionDocs.by': email,
        'revisionDocs.at': now
      });
      docItem.revisadoOk = !!checked;
      docItem.revisadoBy = email;
      docItem.revisadoAt = now;
      return true;
    } catch (e) {
      console.error('[DOCS] updateRevisionForDoc gasto', e);
      alert('No se pudo guardar la revisión del comprobante de gasto.');
      return false;
    }
  }

  return false;
}

/* ====================== RENDER TABLA ====================== */

function renderDocsTable() {
  const tbody  = document.querySelector('#tblDocs tbody');
  const infoEl = document.getElementById('infoDocs');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!state.docs.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 9;
    td.innerHTML = '<div class="muted">Sin documentos para los filtros seleccionados.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
    if (infoEl) infoEl.textContent = '0 documentos.';
    return;
  }

  const frag = document.createDocumentFragment();

  state.docs.forEach(docItem => {
    const tr = document.createElement('tr');

    const tdFecha   = document.createElement('td');
    const tdGrupo   = document.createElement('td');
    const tdDest    = document.createElement('td');
    const tdCoord   = document.createElement('td');
    const tdTipo    = document.createElement('td');
    const tdMon     = document.createElement('td');
    const tdMonto   = document.createElement('td');
    const tdArchivo = document.createElement('td');
    const tdChk     = document.createElement('td');

    tdFecha.textContent = docItem.fechaTxt || '—';
    tdGrupo.textContent = `${docItem.numeroGrupo || ''} — ${docItem.nombreGrupo || ''}`;
    tdDest.textContent  = docItem.destino || '—';
    tdCoord.textContent = docItem.coordEmail || '—';

    let tipoLabel = docItem.tipoDoc;
    if (tipoLabel === 'COMP_CLP') tipoLabel = 'COMP. CLP';
    if (tipoLabel === 'CONST_USD') tipoLabel = 'CONST. USD';
    if (tipoLabel === 'GASTO') tipoLabel = 'GASTO (comprobante)';
    tdTipo.textContent = tipoLabel;

    tdMon.textContent = docItem.moneda || '—';
    if (docItem.monto && docItem.moneda === 'USD') {
      tdMonto.textContent = moneyBy(docItem.monto, 'USD');
    } else if (docItem.monto) {
      tdMonto.textContent = moneyCLP(docItem.monto);
    } else {
      tdMonto.textContent = '—';
    }

    if (docItem.url) {
      const a = document.createElement('a');
      a.href = docItem.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'VER';
      tdArchivo.appendChild(a);
    } else {
      tdArchivo.textContent = '—';
    }

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!docItem.revisadoOk;
    chk.title = 'Marcar como revisado';

    chk.addEventListener('change', async (e) => {
      const nuevo = !!e.target.checked;
      const ok = await updateRevisionForDoc(docItem, nuevo);
      if (!ok) {
        e.target.checked = !nuevo;
      }
    });

    tdChk.appendChild(chk);

    tr.append(tdFecha, tdGrupo, tdDest, tdCoord, tdTipo, tdMon, tdMonto, tdArchivo, tdChk);
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);

  if (infoEl) infoEl.textContent = `Mostrando ${state.docs.length} documentos.`;
}

/* ====================== WIRING UI ====================== */

function wireUI() {
  // logout si tienes botón (opcional)
  try {
    document.querySelector('#btn-logout')
      ?.addEventListener('click', () =>
        signOut(auth).then(() => location.href = 'login.html'));
  } catch (_) {}

  const inpDestino    = document.getElementById('filtroDestinoDocs');
  const inpCoord      = document.getElementById('filtroCoordDocs');
  const inpFechaDesde = document.getElementById('filtroFechaDesdeDocs');
  const inpFechaHasta = document.getElementById('filtroFechaHastaDocs');
  const inpTexto      = document.getElementById('filtroTextoDocs');

  if (inpDestino) {
    inpDestino.addEventListener('input', e => {
      state.filtros.destino = (e.target.value || '').toUpperCase().trim();
    });
  }
  if (inpCoord) {
    inpCoord.addEventListener('input', e => {
      state.filtros.coord = (e.target.value || '').toLowerCase().trim();
    });
  }
  if (inpTexto) {
    inpTexto.addEventListener('input', e => {
      state.filtros.texto = e.target.value || '';
    });
  }
  if (inpFechaDesde) {
    inpFechaDesde.addEventListener('change', e => {
      const v = e.target.value;
      state.filtros.fechaDesde = v ? Date.parse(v + 'T00:00:00') : null;
    });
  }
  if (inpFechaHasta) {
    inpFechaHasta.addEventListener('change', e => {
      const v = e.target.value;
      state.filtros.fechaHasta = v ? Date.parse(v + 'T23:59:59') : null;
    });
  }

  const btnCargar = document.getElementById('btnCargarDocs');
  const btnLimpiar = document.getElementById('btnLimpiarDocs');
  const infoEl = document.getElementById('infoDocs');

  if (btnCargar) {
    btnCargar.addEventListener('click', async () => {
      if (infoEl) infoEl.textContent = 'Cargando documentos…';
      await loadDocsForCurrentFilters();
      if (infoEl) infoEl.textContent = `Mostrando ${state.docs.length} documentos.`;
    });
  }

  if (btnLimpiar) {
    btnLimpiar.addEventListener('click', () => {
      state.filtros = {
        destino: '',
        coord: '',
        fechaDesde: null,
        fechaHasta: null,
        texto: ''
      };

      if (inpDestino)    inpDestino.value = '';
      if (inpCoord)      inpCoord.value = '';
      if (inpFechaDesde) inpFechaDesde.value = '';
      if (inpFechaHasta) inpFechaHasta.value = '';
      if (inpTexto)      inpTexto.value = '';

      state.docs = [];
      renderDocsTable();
      if (infoEl) infoEl.textContent = 'Filtros limpios.';
    });
  }
}

/* ====================== ARRANQUE ====================== */

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  state.user = user;
  await preloadGruposDocs();
  wireUI();
  renderDocsTable();
});
