// revision_docs.js
// Revisión de boletas / comprobantes / constancias + comprobantes de gastos
// Muestra muchos grupos a la vez (filtrado por destino, coord(s), grupos(s), tipo(s), texto).
// + Columna "Rendición" = OK cuando docsOk.boleta está marcado (boleta SII revisada).
// + Persistencia real en Firestore (summary.docsOk y coordinadores/{coord}/gastos/{gasto}.revisionDocs).
// + Modal visor de documentos (imagen/pdf/lo que sea embebible).

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
    destino: '',            // string (1)
    coords: new Set(),      // multi
    grupos: new Set(),      // multi (gids)
    tipos: new Set(),       // multi (BOLETA/COMP_CLP/CONST_USD/GASTO)
    texto: ''
  },
  caches: {
    grupos: new Map(),      // gid -> {gid,numero,nombre,destino,coordEmail,...}
    coords: [],             // emails
    destinos: [],           // strings
  },
  docs: [],                 // lista plana de documentos a mostrar en tabla
  rendicionOkByGid: new Map(), // gid -> boolean (docsOk.boleta)
  pending: new Map()        // key -> {docItem, checked} para "Guardar cambios"
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

function isImageUrl(url=''){
  const u = String(url).toLowerCase();
  return u.includes('.png') || u.includes('.jpg') || u.includes('.jpeg') || u.includes('.webp') || u.includes('image');
}
function isPdfUrl(url=''){
  const u = String(url).toLowerCase();
  return u.includes('.pdf') || u.includes('application/pdf');
}

/* ====================== UI HELPERS (MULTISELECT) ====================== */
function setMultiLabel(el, selectedCount, emptyText='Seleccionar…') {
  if (!el) return;
  el.textContent = selectedCount ? `${selectedCount} seleccionado(s)` : emptyText;
}

function renderMultiList({
  container,
  searchInput,
  items,
  getKey,
  getLabel,
  selectedSet,
  onChange,
  btnAll,
  btnNone
}) {
  if (!container) return;

  const draw = () => {
    const q = norm(searchInput?.value || '');
    container.innerHTML = '';
    const frag = document.createDocumentFragment();

    items.forEach(it => {
      const key = getKey(it);
      const label = getLabel(it);
      const blob = norm(label);

      if (q && !blob.includes(q)) return;

      const row = document.createElement('label');
      row.className = 'opt';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = selectedSet.has(key);
      chk.addEventListener('change', () => {
        if (chk.checked) selectedSet.add(key);
        else selectedSet.delete(key);
        onChange?.();
      });

      const txt = document.createElement('div');
      txt.innerHTML = `<div><strong>${label}</strong></div>`;

      row.append(chk, txt);
      frag.appendChild(row);
    });

    container.appendChild(frag);
  };

  searchInput?.addEventListener('input', draw);

  btnAll?.addEventListener('click', () => {
    items.forEach(it => selectedSet.add(getKey(it)));
    onChange?.();
    draw();
  });

  btnNone?.addEventListener('click', () => {
    selectedSet.clear();
    onChange?.();
    draw();
  });

  draw();
}

/* ====================== CATALOGOS (GRUPOS) ====================== */
async function preloadGruposDocs() {
  state.caches.grupos.clear();
  state.caches.coords.length = 0;
  state.caches.destinos.length = 0;

  const coordsSet = new Set();
  const destinosSet = new Set();

  const snap = await getDocs(collection(db,'grupos'));

  const dlDestinos = document.getElementById('dl-destinos-docs');
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
      fechaInicio: x.fechaInicio || x.fechaInicioViaje || null,
      fechaFin:    x.fechaFin    || x.fechaFinViaje    || null
    };

    state.caches.grupos.set(gid, gInfo);
    if (coordEmail) coordsSet.add(coordEmail);
    if (destino) destinosSet.add(destino);
  });

  state.caches.coords = Array.from(coordsSet).sort();
  state.caches.destinos = Array.from(destinosSet).sort();

  if (dlDestinos) {
    state.caches.destinos.forEach(dest => {
      const opt = document.createElement('option');
      opt.value = dest;
      opt.label = dest;
      dlDestinos.appendChild(opt);
    });
  }

  // Tipos fijos
  const TIPOS = [
    { key: 'BOLETA',   label: 'BOLETA (SII)' },
    { key: 'COMP_CLP', label: 'COMP. CLP (Transferencia)' },
    { key: 'CONST_USD',label: 'CONST. USD (Efectivo/Transf. coord)' },
    { key: 'GASTO',    label: 'GASTO (Comprobante)' }
  ];

  // Render multiselects
  const coordsList = document.getElementById('coordsList');
  const gruposList = document.getElementById('gruposList');
  const tiposList  = document.getElementById('tiposList');

  renderMultiList({
    container: coordsList,
    searchInput: document.getElementById('searchCoords'),
    items: state.caches.coords,
    getKey: (email) => email,
    getLabel: (email) => email,
    selectedSet: state.filtros.coords,
    onChange: () => setMultiLabel(document.getElementById('multiCoordsLabel'), state.filtros.coords.size),
    btnAll: document.getElementById('btnCoordsAll'),
    btnNone: document.getElementById('btnCoordsNone')
  });

  const gruposArr = Array.from(state.caches.grupos.values())
    .sort((a,b) => String(a.numero).localeCompare(String(b.numero)));

  renderMultiList({
    container: gruposList,
    searchInput: document.getElementById('searchGrupos'),
    items: gruposArr,
    getKey: (g) => g.gid,
    getLabel: (g) => `${g.numero} — ${g.nombre}`,
    selectedSet: state.filtros.grupos,
    onChange: () => setMultiLabel(document.getElementById('multiGruposLabel'), state.filtros.grupos.size),
    btnAll: document.getElementById('btnGruposAll'),
    btnNone: document.getElementById('btnGruposNone')
  });

  renderMultiList({
    container: tiposList,
    searchInput: document.getElementById('searchTipos'),
    items: TIPOS,
    getKey: (t) => t.key,
    getLabel: (t) => t.label,
    selectedSet: state.filtros.tipos,
    onChange: () => setMultiLabel(document.getElementById('multiTiposLabel'), state.filtros.tipos.size),
    btnAll: document.getElementById('btnTiposAll'),
    btnNone: document.getElementById('btnTiposNone')
  });

  // Labels iniciales
  setMultiLabel(document.getElementById('multiCoordsLabel'), state.filtros.coords.size);
  setMultiLabel(document.getElementById('multiGruposLabel'), state.filtros.grupos.size);
  setMultiLabel(document.getElementById('multiTiposLabel'), state.filtros.tipos.size);
}

/* ====================== NORMALIZADORES ====================== */
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
  const imgUrl = coalesce(raw.imgUrl, raw.imageUrl, raw.imagenUrl, raw.comprobanteUrl, '');

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
async function loadDocsSummaryForGroups(gids) {
  const out = [];
  state.rendicionOkByGid.clear();

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

    // 👇 Rendición (boleta SII revisada)
    const rendOk = !!docsOk.boleta;
    state.rendicionOkByGid.set(gid, rendOk);

    const boletaUrl = coalesce(summary?.boleta?.url, summary?.boletaUrl, '');
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

    // Solo agregamos si existe URL o si está marcado como revisado
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

      const img = coalesce(raw.imgUrl, raw.imageUrl, raw.imagenUrl, raw.comprobanteUrl, '');
      if (!img) return;

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

function getFilteredGids() {
  const destinoFilter = state.filtros.destino ? state.filtros.destino.toUpperCase().trim() : '';
  const textoFilter   = norm(state.filtros.texto || '');

  // Si el usuario seleccionó grupos, partimos desde esos
  const baseGids = state.filtros.grupos.size
    ? Array.from(state.filtros.grupos)
    : Array.from(state.caches.grupos.keys());

  const out = [];
  for (const gid of baseGids) {
    const gInfo = state.caches.grupos.get(gid);
    if (!gInfo) continue;

    if (destinoFilter && gInfo.destino !== destinoFilter) continue;

    // Coordinadores multi (si hay seleccionados)
    if (state.filtros.coords.size) {
      const c = (gInfo.coordEmail || '').toLowerCase();
      if (!state.filtros.coords.has(c)) continue;
    }

    // Texto libre a nivel grupo
    if (textoFilter) {
      const blob = norm(`${gInfo.numero} ${gInfo.nombre} ${gInfo.destino} ${gInfo.coordEmail}`);
      if (!blob.includes(textoFilter)) continue;
    }

    out.push(gid);
  }

  return out;
}

async function loadDocsForCurrentFilters() {
  state.docs = [];
  state.pending.clear();
  refreshPendingUI();

  const filteredGids = getFilteredGids();

  if (!filteredGids.length) {
    state.docs = [];
    renderDocsTable();
    return;
  }

  const [docsSummary, docsGastos] = await Promise.all([
    loadDocsSummaryForGroups(filteredGids),
    loadDocsGastosForGroups(filteredGids)
  ]);

  let docsAll = [...docsSummary, ...docsGastos];

  // Filtro por tipo (multi)
  if (state.filtros.tipos.size) {
    docsAll = docsAll.filter(d => state.filtros.tipos.has(d.tipoDoc));
  }

  // Texto libre a nivel documento (incluye asunto)
  const textoFilter = norm(state.filtros.texto || '');
  if (textoFilter) {
    docsAll = docsAll.filter(d => {
      const blob = norm(
        `${d.numeroGrupo} ${d.nombreGrupo} ${d.destino} ${d.coordEmail} ${d.tipoDoc} ${d.asunto || ''}`
      );
      return blob.includes(textoFilter);
    });
  }

  // Orden: primero gastos con fecha, después summary (fechaMs 0)
  docsAll.sort((a,b) => (a.fechaMs || 0) - (b.fechaMs || 0));

  state.docs = docsAll;
  renderDocsTable();
}

/* ====================== GUARDAR REVISIÓN (Firestore) ====================== */
function docKey(docItem){
  // key estable para pending map
  if (docItem.tipoDoc === 'GASTO') return `GASTO:${docItem.grupoId}:${docItem.coordEmail}:${docItem.gastoId}`;
  return `${docItem.tipoDoc}:${docItem.grupoId}`;
}

async function updateRevisionForDoc(docItem, checked) {
  const email = (auth.currentUser?.email || '').toLowerCase();
  const now   = Date.now();

  // 1) Docs summary (BOLETA / COMP_CLP / CONST_USD)
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

    if (docItem.tipoDoc === 'BOLETA')    patch['docsOk.boleta'] = !!checked;
    if (docItem.tipoDoc === 'COMP_CLP')  patch['docsOk.comprobante'] = !!checked;
    if (docItem.tipoDoc === 'CONST_USD') patch['docsOk.transferencia'] = !!checked;

    try {
      await setDoc(ref, patch, { merge:true });
      docItem.revisadoOk = !!checked;
      docItem.revisadoBy = email;
      docItem.revisadoAt = now;

      // 👇 si es BOLETA, esto afecta la columna "Rendición"
      if (docItem.tipoDoc === 'BOLETA') {
        state.rendicionOkByGid.set(gid, !!checked);
      }

      return true;
    } catch (e) {
      console.error('[DOCS] updateRevisionForDoc summary', e);
      alert('No se pudo guardar la revisión del documento de grupo.');
      return false;
    }
  }

  // 2) Docs de gasto
  if (docItem.tipoDoc === 'GASTO') {
    const coord = docItem.coordEmail;
    const gastoId = docItem.gastoId;
    if (!coord || !gastoId) return false;

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

/* ====================== PENDIENTES (botón Guardar) ====================== */
function refreshPendingUI(){
  const n = state.pending.size;
  const el = document.getElementById('infoPendientes');
  const btn = document.getElementById('btnGuardarPendientes');
  if (!el || !btn) return;

  if (!n) {
    el.style.display = 'none';
    btn.style.display = 'none';
    return;
  }
  el.style.display = 'inline-block';
  el.textContent = `Cambios pendientes: ${n}`;
  btn.style.display = 'inline-block';
}

async function flushPending(){
  if (!state.pending.size) return;

  const entries = Array.from(state.pending.values());
  let okCount = 0;

  for (const it of entries) {
    const ok = await updateRevisionForDoc(it.docItem, it.checked);
    if (ok) okCount++;
  }

  state.pending.clear();
  refreshPendingUI();

  // refresca la tabla para que "Rendición" se actualice visualmente
  renderDocsTable();

  alert(`Guardado: ${okCount}/${entries.length} cambios.`);
}

/* ====================== MODAL VISOR ====================== */
function openViewer({ title, sub, url }) {
  const modal = document.getElementById('viewerModal');
  const body  = document.getElementById('viewerBody');
  const h1    = document.getElementById('viewerTitle');
  const h2    = document.getElementById('viewerSub');
  const openTab = document.getElementById('viewerOpenTab');

  if (!modal || !body || !h1 || !h2 || !openTab) return;

  h1.textContent = title || 'Documento';
  h2.textContent = sub || '';
  openTab.href = url || '#';

  body.innerHTML = '';

  if (!url) {
    body.innerHTML = `<div style="padding:14px;color:#6b7280;">Sin URL.</div>`;
  } else if (isImageUrl(url)) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = title || 'Documento';
    body.appendChild(img);
  } else {
    const iframe = document.createElement('iframe');
    iframe.src = url;
    body.appendChild(iframe);
  }

  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeViewer() {
  const modal = document.getElementById('viewerModal');
  const body  = document.getElementById('viewerBody');
  if (!modal || !body) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  body.innerHTML = '';
}

/* ====================== RENDER TABLA ====================== */
function tipoLabel(tipo) {
  if (tipo === 'COMP_CLP') return 'COMP. CLP';
  if (tipo === 'CONST_USD') return 'CONST. USD';
  if (tipo === 'GASTO') return 'GASTO (comprobante)';
  return tipo;
}

function renderDocsTable() {
  const tbody  = document.querySelector('#tblDocs tbody');
  const infoEl = document.getElementById('infoDocs');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!state.docs.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
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
    const tdRend    = document.createElement('td');
    const tdMon     = document.createElement('td');
    const tdMonto   = document.createElement('td');
    const tdArchivo = document.createElement('td');
    const tdChk     = document.createElement('td');

    tdFecha.textContent = docItem.fechaTxt || '—';
    tdGrupo.textContent = `${docItem.numeroGrupo || ''} — ${docItem.nombreGrupo || ''}`;
    tdDest.textContent  = docItem.destino || '—';
    tdCoord.textContent = docItem.coordEmail || '—';

    tdTipo.innerHTML = `<span class="tag">${tipoLabel(docItem.tipoDoc)}</span>`;

    // Rendición = docsOk.boleta por gid
    const rendOk = !!state.rendicionOkByGid.get(docItem.grupoId);
    tdRend.innerHTML = rendOk
      ? `<span class="tag ok">OK</span>`
      : `<span class="tag pending">—</span>`;

    tdMon.textContent = docItem.moneda || '—';

    if (docItem.monto && docItem.moneda === 'USD') tdMonto.textContent = moneyBy(docItem.monto, 'USD');
    else if (docItem.monto) tdMonto.textContent = moneyCLP(docItem.monto);
    else tdMonto.textContent = '—';

    // Archivo (con visor modal)
    if (docItem.url) {
      const a = document.createElement('span');
      a.className = 'link';
      a.textContent = 'VER';
      a.title = 'Abrir visor';
      a.addEventListener('click', () => {
        const t = `${tipoLabel(docItem.tipoDoc)} — ${docItem.numeroGrupo} — ${docItem.nombreGrupo}`;
        const s = `${docItem.destino} · ${docItem.coordEmail || '—'} ${docItem.asunto ? '· ' + docItem.asunto : ''}`;
        openViewer({ title: t, sub: s, url: docItem.url });
      });
      tdArchivo.appendChild(a);

      // hint de asunto si viene de gasto
      if (docItem.asunto) {
        const small = document.createElement('div');
        small.className = 'muted';
        small.style.fontSize = '12px';
        small.style.marginTop = '4px';
        small.textContent = docItem.asunto;
        tdArchivo.appendChild(small);
      }
    } else {
      tdArchivo.textContent = '—';
    }

    // Checkbox (modo seguro: queda en "pendientes" y también intenta guardar al tiro)
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'chk';
    chk.checked = !!docItem.revisadoOk;
    chk.title = 'Marcar como revisado';

    chk.addEventListener('change', async (e) => {
      const nuevo = !!e.target.checked;

      // 1) dejamos pendiente (por si falla o el user quiere "Guardar cambios")
      const key = docKey(docItem);
      state.pending.set(key, { docItem, checked: nuevo });
      refreshPendingUI();

      // 2) autosave inmediato (para asegurar persistencia sin depender del botón)
      const ok = await updateRevisionForDoc(docItem, nuevo);
      if (!ok) {
        // revertir UI y mantener pending (para reintentar)
        e.target.checked = !nuevo;
        return;
      }

      // si guardó ok, lo saco de pending
      state.pending.delete(key);
      refreshPendingUI();

      // refresca celda rendición si cambió boleta
      renderDocsTable();
    });

    tdChk.appendChild(chk);

    tr.append(tdFecha, tdGrupo, tdDest, tdCoord, tdTipo, tdRend, tdMon, tdMonto, tdArchivo, tdChk);
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);

  if (infoEl) infoEl.textContent = `Mostrando ${state.docs.length} documentos.`;
}

/* ====================== WIRING UI ====================== */
function wireUI() {
  // Header común
  const btnHome = document.getElementById('btn-home');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnBack = document.getElementById('btn-back');

  btnHome?.addEventListener('click', () => {
    // Home del sistema (según tu estándar)
    location.href = 'https://sistemas-raitrai.github.io/Operaciones-RTv1.0';
  });
  btnRefresh?.addEventListener('click', () => location.reload());
  btnBack?.addEventListener('click', () => history.back());

  // logout
  document.querySelector('#btn-logout')
    ?.addEventListener('click', () =>
      signOut(auth).then(() => location.href = 'login.html'));

  // modal
  document.getElementById('viewerClose')?.addEventListener('click', closeViewer);
  document.getElementById('viewerModal')?.addEventListener('click', (e) => {
    if (e.target?.id === 'viewerModal') closeViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeViewer();
  });

  // filtros simples
  const inpDestino = document.getElementById('filtroDestinoDocs');
  const inpTexto   = document.getElementById('filtroTextoDocs');

  inpDestino?.addEventListener('input', e => {
    state.filtros.destino = (e.target.value || '').toUpperCase().trim();
  });
  inpTexto?.addEventListener('input', e => {
    state.filtros.texto = e.target.value || '';
  });

  // cerrar details al click afuera (mejor UX)
  document.addEventListener('click', (e) => {
    const inside = e.target.closest?.('details.multi');
    if (inside) return;
    document.querySelectorAll('details.multi[open]').forEach(d => d.removeAttribute('open'));
  });

  // botones
  const btnCargar = document.getElementById('btnCargarDocs');
  const btnLimpiar = document.getElementById('btnLimpiarDocs');
  const btnGuardarPend = document.getElementById('btnGuardarPendientes');
  const infoEl = document.getElementById('infoDocs');

  btnCargar?.addEventListener('click', async () => {
    if (infoEl) infoEl.textContent = 'Cargando documentos…';
    await loadDocsForCurrentFilters();
    if (infoEl) infoEl.textContent = `Mostrando ${state.docs.length} documentos.`;
  });

  btnLimpiar?.addEventListener('click', () => {
    state.filtros.destino = '';
    state.filtros.texto = '';
    state.filtros.coords.clear();
    state.filtros.grupos.clear();
    state.filtros.tipos.clear();

    if (inpDestino) inpDestino.value = '';
    if (inpTexto) inpTexto.value = '';

    // refrescar labels
    setMultiLabel(document.getElementById('multiCoordsLabel'), 0);
    setMultiLabel(document.getElementById('multiGruposLabel'), 0);
    setMultiLabel(document.getElementById('multiTiposLabel'), 0);

    state.docs = [];
    state.pending.clear();
    refreshPendingUI();
    renderDocsTable();

    if (infoEl) infoEl.textContent = 'Filtros limpios.';
  });

  btnGuardarPend?.addEventListener('click', flushPending);
}

/* ====================== ARRANQUE ====================== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  state.user = user;

  // email header
  const userEmail = document.getElementById('userEmail');
  if (userEmail) userEmail.textContent = user.email || '—';

  await preloadGruposDocs();
  wireUI();
  renderDocsTable();
});
