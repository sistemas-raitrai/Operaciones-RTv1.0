// ✅ revision_docs.js (COMPLETO)
// Revisión de boletas / comprobantes / constancias + comprobantes de gastos
// ✅ Rendición: OK si docsOk.boleta
// ✅ Gasto aprobado:
//    - Si tipoDoc === 'GASTO' => OK si montoAprobado > 0; si =0 => "Rechazado" (rojo)
//    - Si NO es GASTO => se mantiene regla por summary (gastosGrabados<=costoTotal y >0)
// ✅ Guardar cambios persiste:
//    - Checkbox Revisado => AHORA se guarda en ruta propia: grupos/{gid}/finanzas/docsRevision/{docId}
//      (Nada que ver con el gasto)
//    - Select Documento Fiscal (summary en docsFiscal.*, gasto se mantiene en el doc del gasto)
// ✅ Para DESMARCAR revisado => pide contraseña
// ✅ Documento Fiscal NO se puede cambiar si Revisado está marcado
// ✅ Exportación Excel (xlsx) con HIPERVÍNCULO en la columna URL

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
    coords: new Set(),
    grupos: new Set(),
    tipos: new Set(),
    gastoAprobado: '',
    texto: ''
  },
  caches: {
    grupos: new Map(),   // gid -> info
    coords: [],
    destinos: [],
  },
  docs: [],

  // Maps por grupo (summary)
  rendicionOkByGid: new Map(),
  gastoAprobadoByGid: new Map(),

  // ✅ Revisiones cargadas desde grupos/{gid}/finanzas/docsRevision/{docId}
  // key = docKey(docItem)  -> { ok, by, at }
  revByDocKey: new Map(),

  // Pendientes a guardar (revisado + fiscal)
  pending: new Map() // key -> { docItem, checked?, fiscal? }
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
  const u0 = String(url || '').trim();
  if (!u0) return false;
  const u = u0.toLowerCase();

  if (u.includes('contenttype=image/')) return true;
  if (u.includes('alt=media') && (u.includes('image') || u.includes('png') || u.includes('jpg') || u.includes('jpeg') || u.includes('webp'))) return true;

  const clean = u.split('#')[0].split('?')[0];
  if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(clean)) return true;

  try {
    const decoded = decodeURIComponent(clean);
    if (/\.(png|jpe?g|webp|gif|bmp|svg)$/.test(decoded)) return true;
  } catch (e) {}

  return false;
}

function isPdfUrl(url=''){
  const u0 = String(url || '').trim();
  if (!u0) return false;
  const u = u0.toLowerCase();
  const clean = u.split('#')[0].split('?')[0];
  if (clean.endsWith('.pdf')) return true;
  if (u.includes('application/pdf') || u.includes('contenttype=application/pdf')) return true;
  return false;
}

// ✅ display coord: sacar guiones y MAYÚSCULAS
function coordDisplay(email=''){
  const s = (email || '').toString().replace(/-/g,' ').toUpperCase();
  return s || '—';
}

/* ====================== (P4) UNLOCK DESMARCAR ====================== */
const UNLOCK_PASSWORD = 'Patricia';

function askUnlockOrCancel(){
  const inpass = prompt('Contraseña para DESMARCAR y desbloquear:');
  if (inpass === null) return false;              // cancel
  return String(inpass).trim() === UNLOCK_PASSWORD;
}

/* ======================
   DOCUMENTO FISCAL (VALORES)
   ====================== */
const FISCAL_ES = 'ES_BOLETA';
const FISCAL_NO = 'NO_ES_BOLETA';

function fiscalLabel(v){
  if (v === FISCAL_ES) return 'Es Boleta';
  if (v === FISCAL_NO) return 'No es Boleta';
  return '(Sin definir)';
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

  const TIPOS = [
    { key: 'BOLETA',    label: 'BOLETA (SII)' },
    { key: 'COMP_CLP',  label: 'COMP. CLP (Transferencia)' },
    { key: 'CONST_USD', label: 'CONST. USD (Efectivo/Transf. coord)' },
    { key: 'GASTO',     label: 'GASTO (Comprobante)' }
  ];

  renderMultiList({
    container: document.getElementById('coordsList'),
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
    container: document.getElementById('gruposList'),
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
    container: document.getElementById('tiposList'),
    searchInput: document.getElementById('searchTipos'),
    items: TIPOS,
    getKey: (t) => t.key,
    getLabel: (t) => t.label,
    selectedSet: state.filtros.tipos,
    onChange: () => setMultiLabel(document.getElementById('multiTiposLabel'), state.filtros.tipos.size),
    btnAll: document.getElementById('btnTiposAll'),
    btnNone: document.getElementById('btnTiposNone')
  });

  setMultiLabel(document.getElementById('multiCoordsLabel'), state.filtros.coords.size);
  setMultiLabel(document.getElementById('multiGruposLabel'), state.filtros.grupos.size);
  setMultiLabel(document.getElementById('multiTiposLabel'), state.filtros.tipos.size);
}

/* ======================
   KEY UNIFICADA (para pending + rev map)
   ====================== */
function docKey(docItem){
  if (docItem.tipoDoc === 'GASTO') return `GASTO:${docItem.grupoId}:${docItem.coordEmail}:${docItem.gastoId}`;
  return `${docItem.tipoDoc}:${docItem.grupoId}`;
}

/* ======================
   docsRevision docId (ruta independiente)
   ====================== */
function revisionDocIdForItem(docItem){
  if (docItem.tipoDoc === 'GASTO') {
    const coord = (docItem.coordEmail || '').toLowerCase();
    const gastoId = docItem.gastoId || '';
    return `GASTO__${coord}__${gastoId}`;
  }
  // BOLETA | COMP_CLP | CONST_USD
  return docItem.tipoDoc;
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

  const montoAprobado = parseMonto(coalesce(raw.montoAprobado, raw.aprobado, raw.monto_aprobado, 0));

  // ✅ Documento fiscal del gasto (se mantiene aquí)
  const docFiscal = coalesce(raw.documentoFiscal, raw.docFiscal, raw.fiscal, '');

  // ✅ Revisado del gasto se toma desde state.revByDocKey (ruta independiente),
  //    NO desde raw.revisionDocs (legacy). Igual dejamos fallback si no existe.
  const legacyRev = raw.revisionDocs || {};
  const legacyOk = !!legacyRev.ok;
  const legacyBy = legacyRev.by || '';
  const legacyAt = legacyRev.at ? _toMs(legacyRev.at) : 0;

  const base = {
    tipoDoc: 'GASTO',
    gastoId: raw.id || raw._id || '',
    grupoId: grupoInfo.gid,
    numeroGrupo: grupoInfo.numero,
    nombreGrupo: grupoInfo.nombre,
    destino: grupoInfo.destino,
    coordEmail: (coordFromPath || grupoInfo.coordEmail || '').toLowerCase(),
    fechaMs,
    fechaTxt,
    moneda,
    monto,
    montoAprobado,
    asunto,
    url: imgUrl,

    documentoFiscal: docFiscal,

    revisadoOk: false,
    revisadoBy: '',
    revisadoAt: 0
  };

  const k = docKey(base);
  const rev = state.revByDocKey.get(k);

  if (rev) {
    base.revisadoOk = !!rev.ok;
    base.revisadoBy = rev.by || '';
    base.revisadoAt = _toMs(rev.at || 0);
  } else {
    // fallback legacy si no hay registro en docsRevision
    base.revisadoOk = legacyOk;
    base.revisadoBy = legacyBy;
    base.revisadoAt = legacyAt;
  }

  return base;
}

/* ======================
   CÁLCULO: GASTO APROBADO (summary)
   ====================== */
function computeGastoAprobado(summary = {}) {
  const gastosGrabados = parseMonto(coalesce(
    summary?.gastosGrabados,
    summary?.gastosGrabadosCLP,
    summary?.gastosTotal,
    summary?.gastosTotalCLP,
    summary?.totalGastos,
    summary?.totales?.gastos,
    summary?.gastos?.total,
    summary?.gastos?.totalCLP,
    summary?.gastos?.clp,
    summary?.gastosCLP,
    0
  ));

  const costoTotal = parseMonto(coalesce(
    summary?.costoTotal,
    summary?.costoTotalCLP,
    summary?.totalCosto,
    summary?.totales?.costoTotal,
    summary?.presupuestoTotal,
    summary?.presupuesto?.total,
    summary?.presupuesto?.costoTotal,
    summary?.costos?.total,
    summary?.costo?.total,
    summary?.presupuesto,
    0
  ));

  return (gastosGrabados > 0) && (costoTotal > 0) && (gastosGrabados <= costoTotal);
}

/* ======================
   ✅ GASTO APROBADO por FILA (regla final)
   ====================== */
function aprobStateForRow(docItem){
  if (!docItem) return { ok:false, label:'—', cls:'pending' };

  if (docItem.tipoDoc === 'GASTO') {
    const ma = Number(docItem.montoAprobado || 0);
    if (ma > 0) return { ok:true, label:'OK', cls:'ok' };
    return { ok:false, label:'Rechazado', cls:'bad' };
  }

  const ok = !!state.gastoAprobadoByGid.get(docItem.grupoId);
  return ok ? { ok:true, label:'OK', cls:'ok' } : { ok:false, label:'—', cls:'pending' };
}

function isAprobOkForRow(docItem){
  return aprobStateForRow(docItem).ok;
}

/* ======================
   DOC FISCAL: KEY según tipo (summary)
   ====================== */
function fiscalKeyForTipo(tipoDoc){
  if (tipoDoc === 'BOLETA') return 'boleta';
  if (tipoDoc === 'COMP_CLP') return 'comprobante';
  if (tipoDoc === 'CONST_USD') return 'transferencia';
  return '';
}

/* ====================== CARGA DE DOCUMENTOS (SUMMARY) ====================== */
function getSummaryDocUrls(summary = {}){
  const docs = summary?.docs || summary?.documentos || {};
  const urls = summary?.urls || summary?.docUrls || summary?.docsUrls || {};

  const boletaUrl = coalesce(
    summary?.boletaUrl, docs?.boletaUrl, urls?.boleta,
    summary?.docsOk?.boletaUrl, summary?.docsOk?.boleta,
    summary?.boleta, docs?.boleta, urls?.boletaUrl
  );

  const compUrl = coalesce(
    summary?.comprobanteUrl, docs?.comprobanteUrl, urls?.comprobante,
    summary?.docsOk?.comprobanteUrl, summary?.docsOk?.comprobante,
    summary?.comprobante, docs?.comprobante, urls?.comprobanteUrl
  );

  const transfUrl = coalesce(
    summary?.transferenciaUrl, docs?.transferenciaUrl, urls?.transferencia,
    summary?.docsOk?.transferenciaUrl, summary?.docsOk?.transferencia,
    summary?.transferencia, docs?.transferencia, urls?.transferenciaUrl
  );

  return { boletaUrl, compUrl, transfUrl };
}

/* ======================
   CARGA DE REVISIONES (ruta independiente)
   grupos/{gid}/finanzas/docsRevision/{docId}
   ====================== */
async function loadRevisionsForGid(gid){
  try {
    // ✅ Ruta correcta:
    // grupos/{gid}/finanzas (doc) / docsRevision (subcol) / {docId}
    const finDoc = doc(db,'grupos',gid,'finanzas');
    const revCol = collection(finDoc,'docsRevision');
    const revSnap = await getDocs(revCol);

    revSnap.forEach(s => {
      const d = s.data() || {};
      const docId = s.id;

      // 1) Tipos simples
      if (docId === 'BOLETA' || docId === 'COMP_CLP' || docId === 'CONST_USD') {
        const k = `${docId}:${gid}`;
        state.revByDocKey.set(k, {
          ok: !!d.ok,
          by: d.by || '',
          at: d.at || 0
        });
        return;
      }

      // 2) Gastos: "GASTO__{coord}__{gastoId}"
      if (docId.startsWith('GASTO__')) {
        const coord = (d.coordEmail || '').toLowerCase() || (docId.split('__')[1] || '').toLowerCase();
        const gastoId = d.gastoId || (docId.split('__')[2] || '');
        if (!coord || !gastoId) return;

        const k = `GASTO:${gid}:${coord}:${gastoId}`;
        state.revByDocKey.set(k, {
          ok: !!d.ok,
          by: d.by || '',
          at: d.at || 0
        });
      }
    });

  } catch (e) {
    console.warn('[DOCS] load revisions for gid', gid, e);
  }
}


async function loadDocsSummaryForGroups(gids) {
  const out = [];
  state.rendicionOkByGid.clear();
  state.gastoAprobadoByGid.clear();
  state.revByDocKey.clear();

  for (const gid of gids) {
    const gInfo = state.caches.grupos.get(gid);
    if (!gInfo) continue;

    // ✅ 1) cargar revisiones independientes (incluye BOLETA/COMP/CONST + gastos)
    await loadRevisionsForGid(gid);

    // ✅ 2) cargar summary normal
    let summary = null;
    try {
      const ref  = doc(db,'grupos',gid,'finanzas','summary');
      const snap = await getDoc(ref);
      summary = snap.exists() ? (snap.data() || {}) : null;

      // ✅ (FALLBACK) Revisiones de GASTOS guardadas dentro del summary
      // Ruta: summary.docsRevGastos.{coord__gastoId} = { ok, by, at }
      try {
        const map = (summary && summary.docsRevGastos) ? summary.docsRevGastos : {};
        if (map && typeof map === 'object') {
          Object.entries(map).forEach(([k, v]) => {
            // k esperado: "coord@email.com__GASTOID"
            const parts = String(k).split('__');
            const coord = (parts[0] || '').toLowerCase();
            const gastoId = (parts[1] || '');
            if (!coord || !gastoId) return;
      
            const key = `GASTO:${gid}:${coord}:${gastoId}`;
            const obj = (v && typeof v === 'object') ? v : {};
            state.revByDocKey.set(key, {
              ok: !!obj.ok,
              by: obj.by || '',
              at: obj.at || 0
            });
          });
        }
      } catch (e) {
        console.warn('[DOCS] summary.docsRevGastos parse', gid, e);
      }

    } catch (e) {
      console.warn('[DOCS] load summary', gid, e);
    }

    const docsOk     = (summary && summary.docsOk) || {};        // Rendición (mantener)
    const docsFiscal = (summary && summary.docsFiscal) || {};    // Documento fiscal en summary

    // Rendición OK por grupo (regla original)
    state.rendicionOkByGid.set(gid, !!docsOk.boleta);

    // Gasto aprobado por grupo (solo para NO-GASTO)
    state.gastoAprobadoByGid.set(gid, computeGastoAprobado(summary || {}));

    const { boletaUrl, compUrl, transfUrl } = getSummaryDocUrls(summary || {});

    const base = {
      grupoId: gid,
      numeroGrupo: gInfo.numero,
      nombreGrupo: gInfo.nombre,
      destino: gInfo.destino,
      coordEmail: (gInfo.coordEmail || '').toLowerCase(),
      fechaMs: 0,
      fechaTxt: '',
      moneda: 'CLP',
      monto: 0,
      montoAprobado: 0,
      asunto: '',
      url: ''
    };

    // helpers para tomar revisado desde state.revByDocKey (ruta independiente)
    const getRevFor = (tipoDoc) => {
      const k = `${tipoDoc}:${gid}`;
      const rev = state.revByDocKey.get(k);
      if (rev) return { ok:!!rev.ok, by:rev.by||'', at:_toMs(rev.at||0) };

      // fallback legacy si existe (por si aún no crean docsRevision)
      const legacy = (summary && summary.docsRev) || {};
      const legacyBy = coalesce(summary?.docsRevBy, legacy?.by, '');
      const legacyAt = _toMs(coalesce(summary?.docsRevAt, legacy?.at, 0));
      const legacyOk =
        tipoDoc === 'BOLETA' ? !!legacy.boleta :
        tipoDoc === 'COMP_CLP' ? !!legacy.comprobante :
        tipoDoc === 'CONST_USD' ? !!legacy.transferencia :
        false;

      return { ok: legacyOk, by: legacyBy, at: legacyAt };
    };

    // BOLETA
    if (boletaUrl || docsOk.boleta) {
      const rev = getRevFor('BOLETA');
      out.push({
        ...base,
        tipoDoc: 'BOLETA',
        gastoId: null,
        url: boletaUrl,

        revisadoOk: rev.ok,
        revisadoBy: rev.by,
        revisadoAt: rev.at,

        documentoFiscal: coalesce(docsFiscal.boleta, '')
      });
    }

    // COMP_CLP
    if (compUrl || docsOk.comprobante) {
      const rev = getRevFor('COMP_CLP');
      out.push({
        ...base,
        tipoDoc: 'COMP_CLP',
        gastoId: null,
        url: compUrl,

        revisadoOk: rev.ok,
        revisadoBy: rev.by,
        revisadoAt: rev.at,

        documentoFiscal: coalesce(docsFiscal.comprobante, '')
      });
    }

    // CONST_USD
    if (transfUrl || docsOk.transferencia) {
      const rev = getRevFor('CONST_USD');
      out.push({
        ...base,
        tipoDoc: 'CONST_USD',
        gastoId: null,
        url: transfUrl,

        revisadoOk: rev.ok,
        revisadoBy: rev.by,
        revisadoAt: rev.at,

        documentoFiscal: coalesce(docsFiscal.transferencia, '')
      });
    }
  }

  return out;
}

/* ====================== CARGA DE DOCUMENTOS (GASTOS) ====================== */
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

/* ====================== FILTROS ====================== */
function getFilteredGids() {
  const destinoFilter = state.filtros.destino ? state.filtros.destino.toUpperCase().trim() : '';
  const textoFilter   = norm(state.filtros.texto || '');

  const baseGids = state.filtros.grupos.size
    ? Array.from(state.filtros.grupos)
    : Array.from(state.caches.grupos.keys());

  const out = [];
  for (const gid of baseGids) {
    const gInfo = state.caches.grupos.get(gid);
    if (!gInfo) continue;

    if (destinoFilter && gInfo.destino !== destinoFilter) continue;

    if (state.filtros.coords.size) {
      const c = (gInfo.coordEmail || '').toLowerCase();
      if (!state.filtros.coords.has(c)) continue;
    }

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

  // ✅ IMPORTANTE: primero Summary (porque llena revByDocKey), después Gastos.
  const docsSummary = await loadDocsSummaryForGroups(filteredGids);
  const docsGastos  = await loadDocsGastosForGroups(filteredGids);

  let docsAll = [...docsSummary, ...docsGastos];

  if (state.filtros.tipos.size) {
    docsAll = docsAll.filter(d => state.filtros.tipos.has(d.tipoDoc));
  }

  // ✅ Filtro Gasto aprobado (por FILA)
  if (state.filtros.gastoAprobado === 'OK') {
    docsAll = docsAll.filter(d => isAprobOkForRow(d));
  }
  if (state.filtros.gastoAprobado === 'NO') {
    docsAll = docsAll.filter(d => !isAprobOkForRow(d));
  }

  const textoFilter = norm(state.filtros.texto || '');
  if (textoFilter) {
    docsAll = docsAll.filter(d => {
      const blob = norm(
        `${d.numeroGrupo} ${d.nombreGrupo} ${d.destino} ${d.coordEmail} ${d.tipoDoc} ${d.asunto || ''}`
      );
      return blob.includes(textoFilter);
    });
  }

  docsAll.sort((a,b) => (a.fechaMs || 0) - (b.fechaMs || 0));

  state.docs = docsAll;
  renderDocsTable();
}

/* ======================
   PENDING helpers
   ====================== */
function markPending(docItem, patch){
  const key = docKey(docItem);
  const prev = state.pending.get(key) || { docItem };
  state.pending.set(key, { ...prev, ...patch, docItem });
  refreshPendingUI();
}

/* ======================
   FIRESTORE: guardar revisado (ruta independiente)
   grupos/{gid}/finanzas/docsRevision/{docId}
   ====================== */
async function updateRevisionForDoc(docItem, checked) {
  const email = (auth.currentUser?.email || '').toLowerCase();
  const now   = Date.now();

  const gid = docItem.grupoId;
  if (!gid) return false;

  // 1) Intento A: guardar en subcolección nueva (ideal)
  const docId = revisionDocIdForItem(docItem);
  const finDoc = doc(db,'grupos',gid,'finanzas');
  const refA   = doc(finDoc,'docsRevision',docId);

  const payloadA = {
    ok: !!checked,
    by: email,
    at: now,
    tipoDoc: docItem.tipoDoc
  };
  if (docItem.tipoDoc === 'GASTO') {
    payloadA.gastoId = docItem.gastoId || '';
    payloadA.coordEmail = (docItem.coordEmail || '').toLowerCase();
    payloadA.url = docItem.url || '';
  }

  try {
    await setDoc(refA, payloadA, { merge:true });

    // memoria local
    const k = docKey(docItem);
    state.revByDocKey.set(k, { ok: !!checked, by: email, at: now });

    docItem.revisadoOk = !!checked;
    docItem.revisadoBy = email;
    docItem.revisadoAt = now;

    return true;
  } catch (e) {
    console.warn('[DOCS] docsRevision write failed, fallback to summary', e?.code || e);
    // seguimos al fallback
  }

  // 2) Intento B (FALLBACK): guardar dentro de summary (casi seguro permitido por tus rules)
  const refB = doc(db,'grupos',gid,'finanzas','summary');

  // a) Summary docs: usar docsRev.* como antes
  if (docItem.tipoDoc === 'BOLETA' || docItem.tipoDoc === 'COMP_CLP' || docItem.tipoDoc === 'CONST_USD') {
    const patch = {
      docsRevBy: email,
      docsRevAt: now
    };
    if (docItem.tipoDoc === 'BOLETA')    patch['docsRev.boleta'] = !!checked;
    if (docItem.tipoDoc === 'COMP_CLP')  patch['docsRev.comprobante'] = !!checked;
    if (docItem.tipoDoc === 'CONST_USD') patch['docsRev.transferencia'] = !!checked;

    try {
      await setDoc(refB, patch, { merge:true });

      const k = docKey(docItem);
      state.revByDocKey.set(k, { ok: !!checked, by: email, at: now });

      docItem.revisadoOk = !!checked;
      docItem.revisadoBy = email;
      docItem.revisadoAt = now;

      return true;
    } catch (e2) {
      console.error('[DOCS] fallback summary docsRev failed', e2);
      alert('No se pudo guardar la revisión del documento (summary).');
      return false;
    }
  }

  // b) Gasto: guardar en summary.docsRevGastos.{coord__gastoId}.{ok,by,at}
  if (docItem.tipoDoc === 'GASTO') {
    const coord = (docItem.coordEmail || '').toLowerCase();
    const gastoId = docItem.gastoId || '';
    if (!coord || !gastoId) return false;

    const mapKey = `${coord}__${gastoId}`;
    const patch = {};
    patch[`docsRevGastos.${mapKey}.ok`] = !!checked;
    patch[`docsRevGastos.${mapKey}.by`] = email;
    patch[`docsRevGastos.${mapKey}.at`] = now;

    try {
      await setDoc(refB, patch, { merge:true });

      const k = docKey(docItem);
      state.revByDocKey.set(k, { ok: !!checked, by: email, at: now });

      docItem.revisadoOk = !!checked;
      docItem.revisadoBy = email;
      docItem.revisadoAt = now;

      return true;
    } catch (e2) {
      console.error('[DOCS] fallback summary docsRevGastos failed', e2);
      alert('No se pudo guardar la revisión del gasto (summary).');
      return false;
    }
  }

  return false;
}

/* ======================
   FIRESTORE: guardar Documento Fiscal (summary + gasto)
   ====================== */
async function updateFiscalForDoc(docItem, fiscalValue) {
  const email = (auth.currentUser?.email || '').toLowerCase();
  const now   = Date.now();

  const v = (fiscalValue || '').toString();
  if (v && v !== FISCAL_ES && v !== FISCAL_NO) return false;

  // Regla: si está revisado, no debería llegar aquí (UI bloquea)
  if (docItem.revisadoOk) return false;

  // Summary docs -> docsFiscal
  if (docItem.tipoDoc === 'BOLETA' ||
      docItem.tipoDoc === 'COMP_CLP' ||
      docItem.tipoDoc === 'CONST_USD') {

    const gid = docItem.grupoId;
    if (!gid) return false;

    const k = fiscalKeyForTipo(docItem.tipoDoc);
    if (!k) return false;

    const ref = doc(db,'grupos',gid,'finanzas','summary');

    const patch = {};
    patch[`docsFiscal.${k}`] = v;
    patch[`docsFiscalBy`] = email;
    patch[`docsFiscalAt`] = now;

    try {
      await setDoc(ref, patch, { merge:true });
      docItem.documentoFiscal = v;
      return true;
    } catch (e) {
      console.error('[DOCS] updateFiscalForDoc summary', e);
      alert('No se pudo guardar Documento Fiscal en el documento del grupo.');
      return false;
    }
  }

  // Gastos -> se mantiene en el doc del gasto (solo fiscal, NO revisado)
  if (docItem.tipoDoc === 'GASTO') {
    const coord = (docItem.coordEmail || '').toLowerCase();
    const gastoId = docItem.gastoId;
    if (!coord || !gastoId) return false;

    try {
      const ref = doc(db,'coordinadores',coord,'gastos',gastoId);
      await updateDoc(ref, {
        'documentoFiscal': v,
        'documentoFiscalBy': email,
        'documentoFiscalAt': now
      });
      docItem.documentoFiscal = v;
      return true;
    } catch (e) {
      console.error('[DOCS] updateFiscalForDoc gasto', e);
      alert('No se pudo guardar Documento Fiscal en el gasto.');
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

  btn.style.display = 'inline-block';
  btn.disabled = (n === 0);

  if (!n) {
    el.style.display = 'none';
    return;
  }

  el.style.display = 'inline-block';
  el.textContent = `Cambios pendientes: ${n}`;
}

async function flushPending(){
  if (!state.pending.size) return;

  const btn = document.getElementById('btnGuardarPendientes');
  const info = document.getElementById('infoDocs');

  const prevText = info?.textContent || '';
  if (btn) btn.disabled = true;
  if (info) info.textContent = `Guardando ${state.pending.size} cambio(s)…`;

  const entries = Array.from(state.pending.entries());
  let okCount = 0;
  let failCount = 0;

  for (const [key, it] of entries) {
    const docItem = it.docItem;
    let okLocal = true;

    try {
      // 1) revisado
      if (Object.prototype.hasOwnProperty.call(it, 'checked')) {
        const ok = await updateRevisionForDoc(docItem, it.checked);
        okLocal = okLocal && ok;
      }

      // 2) fiscal
      if (Object.prototype.hasOwnProperty.call(it, 'fiscal')) {
        const ok = await updateFiscalForDoc(docItem, it.fiscal);
        okLocal = okLocal && ok;
      }
    } catch (e) {
      console.error('[DOCS] flushPending error', key, e);
      okLocal = false;
    }

    if (okLocal) {
      okCount++;
      state.pending.delete(key);
    } else {
      failCount++;
    }
  }

  refreshPendingUI();
  renderDocsTable();

  if (info) info.textContent = prevText;

  if (failCount === 0) {
    alert(`✅ Guardado OK: ${okCount}/${okCount}`);
  } else {
    alert(`⚠️ Guardado parcial: ${okCount}/${okCount + failCount}\nQuedaron ${failCount} pendiente(s) para reintentar.`);
  }

  if (btn) btn.disabled = (state.pending.size === 0);
}

/* ====================== MODAL VISOR ====================== */
function openViewer({ title, sub, url }) {
  const modal   = document.getElementById('viewerModal');
  const body    = document.getElementById('viewerBody');
  const h1      = document.getElementById('viewerTitle');
  const h2      = document.getElementById('viewerSub');
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
    img.style.maxWidth = '100%';
    img.style.maxHeight = '100%';
    img.style.objectFit = 'contain';
    img.style.background = '#fff';
    body.appendChild(img);
  } else {
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.style.background = '#fff';
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
    td.colSpan = 11;
    td.innerHTML = '<div class="muted">Sin documentos para los filtros seleccionados.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
    if (infoEl) infoEl.textContent = '';
    refreshPendingUI();
    return;
  }

  const frag = document.createDocumentFragment();

  state.docs.forEach(docItem => {
    const tr = document.createElement('tr');

    const tdGrupo   = document.createElement('td'); tdGrupo.className = 'col-grupo';
    const tdDest    = document.createElement('td'); tdDest.className = 'col-dest';
    const tdCoord   = document.createElement('td'); tdCoord.className = 'col-coord';
    const tdTipo    = document.createElement('td'); tdTipo.className = 'col-tipo';
    const tdRend    = document.createElement('td'); tdRend.className = 'col-rend';
    const tdAprob   = document.createElement('td'); tdAprob.className = 'col-aprob';
    const tdMon     = document.createElement('td'); tdMon.className = 'col-mon';
    const tdMonto   = document.createElement('td'); tdMonto.className = 'col-monto';
    const tdArchivo = document.createElement('td'); tdArchivo.className = 'col-arch';
    const tdFiscal  = document.createElement('td'); tdFiscal.className = 'col-fiscal';
    const tdChk     = document.createElement('td'); tdChk.className = 'col-rev';

    tdGrupo.title = `${docItem.numeroGrupo || ''} — ${docItem.nombreGrupo || ''}`.trim();
    tdGrupo.textContent = `${docItem.numeroGrupo || ''} — ${docItem.nombreGrupo || ''}`.trim();
    tdDest.textContent  = docItem.destino || '—';

    tdCoord.textContent = coordDisplay(docItem.coordEmail || '');
    tdTipo.innerHTML = `<span class="tag">${tipoLabel(docItem.tipoDoc)}</span>`;

    const rendOk = !!state.rendicionOkByGid.get(docItem.grupoId);
    tdRend.innerHTML = rendOk ? `<span class="tag ok">OK</span>` : `<span class="tag pending">—</span>`;

    const aprob = aprobStateForRow(docItem);
    tdAprob.innerHTML = `<span class="tag ${aprob.cls}">${aprob.label}</span>`;

    tdMon.textContent = docItem.moneda || '—';

    if (docItem.monto && docItem.moneda === 'USD') tdMonto.textContent = moneyBy(docItem.monto, 'USD');
    else if (docItem.monto) tdMonto.textContent = moneyCLP(docItem.monto);
    else tdMonto.textContent = '—';

    // Archivo: VER
    if (docItem.url) {
      const ver = document.createElement('span');
      ver.className = 'link';
      ver.textContent = 'VER';
      ver.title = 'Abrir visor';
      ver.addEventListener('click', () => {
        const t = `${tipoLabel(docItem.tipoDoc)} — ${docItem.numeroGrupo} — ${docItem.nombreGrupo}`;
        const extraAprob = (docItem.tipoDoc === 'GASTO' && Number(docItem.montoAprobado || 0) > 0)
          ? ` · APROBADO: ${moneyCLP(docItem.montoAprobado)}`
          : (docItem.tipoDoc === 'GASTO' ? ' · RECHAZADO' : '');
        const s = `${docItem.destino} · ${coordDisplay(docItem.coordEmail || '—')}${docItem.asunto ? ' · ' + docItem.asunto : ''}${extraAprob}`;
        openViewer({ title: t, sub: s, url: docItem.url });
      });

      tdArchivo.appendChild(ver);

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

    // Documento Fiscal (bloqueado si Revisado=true)
    const sel = document.createElement('select');
    sel.className = 'sel-fiscal';
    sel.innerHTML = `
      <option value="">(Sin definir)</option>
      <option value="${FISCAL_ES}">Es Boleta</option>
      <option value="${FISCAL_NO}">No es Boleta</option>
    `;
    sel.value = (docItem.documentoFiscal || '').toString();

    const pend = state.pending.get(docKey(docItem)) || null;
    const pendingChecked = pend && Object.prototype.hasOwnProperty.call(pend,'checked') ? !!pend.checked : null;
    sel.disabled = !!docItem.revisadoOk || pendingChecked === true;
    sel.title = sel.disabled
      ? 'Bloqueado: primero debes DESMARCAR “Revisado” (pide contraseña).'
      : 'Selecciona el tipo de documento fiscal.';

    sel.addEventListener('change', (e) => {
      if (docItem.revisadoOk) {
        e.target.value = (docItem.documentoFiscal || '').toString();
        return;
      }
      const v = e.target.value || '';
      docItem.documentoFiscal = v;
      markPending(docItem, { fiscal: v });
    });
    tdFiscal.appendChild(sel);

    // Revisado (ruta independiente + password al desmarcar)
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'chk';
    chk.checked = !!docItem.revisadoOk;
    chk.title = 'Marcar como revisado';

    chk.addEventListener('change', (e) => {
      const was = !!docItem.revisadoOk;
      const nuevo = !!e.target.checked;

      // Si intenta DESMARCAR, pedir contraseña
      if (was === true && nuevo === false) {
        const ok = askUnlockOrCancel();
        if (!ok) {
          // revertir UI
          chk.checked = true;
          docItem.revisadoOk = true;
          sel.disabled = true;
          sel.title = 'Bloqueado: primero debes DESMARCAR “Revisado” (pide contraseña).';
          return;
        }
      }

      docItem.revisadoOk = nuevo;
      markPending(docItem, { checked: nuevo });

      // lock/unlock del select según estado
      sel.disabled = nuevo;
      sel.title = nuevo
        ? 'Bloqueado: primero debes DESMARCAR “Revisado” (pide contraseña).'
        : 'Selecciona el tipo de documento fiscal.';
    });

    tdChk.appendChild(chk);

    tr.append(tdGrupo, tdDest, tdCoord, tdTipo, tdRend, tdAprob, tdMon, tdMonto, tdArchivo, tdFiscal, tdChk);
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);

  if (infoEl) infoEl.textContent = `Mostrando ${state.docs.length} documentos.`;
  refreshPendingUI();
}

/* ====================== EXPORT EXCEL (XLSX) ====================== */
function buildExportRows(){
  return state.docs.map(d => {
    const rendOk  = !!state.rendicionOkByGid.get(d.grupoId);
    const aprob   = aprobStateForRow(d);

    const montoTxt =
      d.monto
        ? (d.moneda === 'USD' ? moneyBy(d.monto, 'USD') : moneyCLP(d.monto))
        : '';

    const montoAprobTxt =
      d.tipoDoc === 'GASTO'
        ? moneyCLP(parseMonto(d.montoAprobado || 0))
        : '';

    return {
      GRUPO: `${d.numeroGrupo || ''} — ${d.nombreGrupo || ''}`.trim(),
      DESTINO: d.destino || '',
      COORDINADOR: coordDisplay(d.coordEmail || ''),
      TIPO: tipoLabel(d.tipoDoc),
      RENDICION: rendOk ? 'OK' : '',
      GASTO_APROBADO: aprob.label === 'OK' ? 'OK' : (aprob.label === 'Rechazado' ? 'Rechazado' : ''),
      MONEDA: d.moneda || '',
      MONTO: montoTxt,
      MONTO_APROBADO: montoAprobTxt,
      DOCUMENTO_FISCAL: fiscalLabel(d.documentoFiscal || ''),
      ASUNTO: d.asunto || '',
      URL: d.url || '',
      REVISADO: d.revisadoOk ? 'SI' : 'NO'
    };
  });
}

function exportDocsExcel(){
  const rows = buildExportRows();
  if (!rows.length) {
    alert('No hay datos para exportar.');
    return;
  }

  const XLSX = window.XLSX;
  if (!XLSX) {
    alert('No se encontró la librería XLSX. Revisa que el <script> esté cargando.');
    return;
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, { skipHeader:false });

  ws['!freeze'] = { xSplit: 0, ySplit: 1 };

  ws['!cols'] = [
    { wch: 32 }, // GRUPO
    { wch: 14 }, // DESTINO
    { wch: 28 }, // COORDINADOR
    { wch: 18 }, // TIPO
    { wch: 10 }, // RENDICION
    { wch: 14 }, // GASTO_APROBADO
    { wch: 8  }, // MONEDA
    { wch: 16 }, // MONTO
    { wch: 18 }, // MONTO_APROBADO
    { wch: 16 }, // DOCUMENTO_FISCAL
    { wch: 40 }, // ASUNTO
    { wch: 60 }, // URL
    { wch: 10 }, // REVISADO
  ];

  // ✅ HIPERVÍNCULO para URL
  const headerKeys = Object.keys(rows[0]);
  const urlColIndex0 = headerKeys.indexOf('URL');
  if (urlColIndex0 >= 0) {
    const urlColLetter = XLSX.utils.encode_col(urlColIndex0);
    for (let r = 0; r < rows.length; r++) {
      const addr = `${urlColLetter}${r + 2}`;
      const url = rows[r].URL;
      if (!url) continue;

      ws[addr] = ws[addr] || { t:'s', v: url };
      ws[addr].l = { Target: url, Tooltip: url };
      ws[addr].s = ws[addr].s || {};
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, 'RevisionDocs');

  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  XLSX.writeFile(wb, `revision_documentos_${stamp}.xlsx`);
}

/* ====================== WIRING UI ====================== */
function wireUI() {
  document.getElementById('btn-home')?.addEventListener('click', () => {
    location.href = 'https://sistemas-raitrai.github.io/Operaciones-RTv1.0';
  });
  document.getElementById('btn-refresh')?.addEventListener('click', () => location.reload());
  document.getElementById('btn-back')?.addEventListener('click', () => history.back());

  document.querySelector('#btn-logout')
    ?.addEventListener('click', () =>
      signOut(auth).then(() => location.href = 'login.html'));

  document.getElementById('viewerClose')?.addEventListener('click', closeViewer);
  document.getElementById('viewerModal')?.addEventListener('click', (e) => {
    if (e.target?.id === 'viewerModal') closeViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeViewer();
  });

  const inpDestino = document.getElementById('filtroDestinoDocs');
  const inpTexto   = document.getElementById('filtroTextoDocs');
  const selAprob   = document.getElementById('filtroGastoAprobado');

  inpDestino?.addEventListener('input', e => {
    state.filtros.destino = (e.target.value || '').toUpperCase().trim();
  });
  inpTexto?.addEventListener('input', e => {
    state.filtros.texto = e.target.value || '';
  });
  selAprob?.addEventListener('change', e => {
    state.filtros.gastoAprobado = e.target.value || '';
  });

  document.addEventListener('click', (e) => {
    const inside = e.target.closest?.('details.multi');
    if (inside) return;
    document.querySelectorAll('details.multi[open]').forEach(d => d.removeAttribute('open'));
  });

  const btnCargar = document.getElementById('btnCargarDocs');
  const btnLimpiar = document.getElementById('btnLimpiarDocs');
  const btnExport = document.getElementById('btnExportDocs');
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
    state.filtros.gastoAprobado = '';
    state.filtros.coords.clear();
    state.filtros.grupos.clear();
    state.filtros.tipos.clear();

    if (inpDestino) inpDestino.value = '';
    if (inpTexto) inpTexto.value = '';
    if (selAprob) selAprob.value = '';

    setMultiLabel(document.getElementById('multiCoordsLabel'), 0);
    setMultiLabel(document.getElementById('multiGruposLabel'), 0);
    setMultiLabel(document.getElementById('multiTiposLabel'), 0);

    state.docs = [];
    state.pending.clear();
    refreshPendingUI();
    renderDocsTable();

    if (infoEl) infoEl.textContent = 'Filtros limpios.';
  });

  btnExport?.addEventListener('click', exportDocsExcel);

  btnGuardarPend?.addEventListener('click', async () => {
    await flushPending();
    // ✅ recargar desde Firestore para reflejar revisiones reales (docsRevision) y docsFiscal reales
    const infoEl2 = document.getElementById('infoDocs');
    if (infoEl2) infoEl2.textContent = 'Actualizando…';
    await loadDocsForCurrentFilters();
    if (infoEl2) infoEl2.textContent = `Mostrando ${state.docs.length} documentos.`;
  });

  refreshPendingUI();
}

/* ====================== ARRANQUE ====================== */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  state.user = user;

  const userEmail = document.getElementById('userEmail');
  if (userEmail) userEmail.textContent = user.email || '—';

  await preloadGruposDocs();
  wireUI();
  renderDocsTable();
});
