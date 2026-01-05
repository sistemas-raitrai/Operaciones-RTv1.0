// revision_docs.js
// Revisión de documentos (tabla sin link, links solo en exportación)

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection, getDocs, collectionGroup,
  doc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ====================== STATE ====================== */
const state = {
  user: null,
  filtros: { coord: '', grupo: '', grupoNombre: '' },
  caches: {
    grupos: new Map(),         // gid -> info
    coords: [],                // emails coordinadores
    groupsByCoord: new Map(),  // coordEmail -> Set(gid)
  },
  docs: [],      // listado final para tabla/export
  summary: null, // grupos/{gid}/finanzas/summary (solo cuando hay gid)
};

/* ====================== UTILS ====================== */
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

const escapeHtml = (str='') =>
  String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');

const parseMonto = (any) => {
  if (any == null) return 0;
  if (typeof any === 'number' && isFinite(any)) return Math.round(any);
  const n = parseInt(String(any).replace(/[^\d-]/g,''),10);
  return isFinite(n) ? n : 0;
};

const moneyBy = (n, curr='CLP') =>
  (isFinite(+n)
    ? (+n).toLocaleString('es-CL',{ style:'currency', currency:curr, maximumFractionDigits:(curr==='CLP'?0:2) })
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

/* ====================== COORD HINT HELPERS (igual espíritu rendiciones) ====================== */
function splitNameParts(s='') {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}
function slugFromParts(parts=[]) {
  return (parts || []).filter(Boolean).join('-');
}
function aliasPrimeroTercero(s='') {
  const p = splitNameParts(s);
  if (p.length >= 3) return `${p[0]}-${p[2]}`;
  if (p.length >= 2) return `${p[0]}-${p[1]}`;
  return p[0] || '';
}
function normCoordId(s='') {
  const p = splitNameParts(s);
  return slugFromParts(p);
}
function coordCandidates({ coordFromPath = '', rawCoord = '' } = {}) {
  const cand = new Set();
  const pathNorm = normCoordId(coordFromPath);
  if (pathNorm) cand.add(pathNorm);
  if (pathNorm) cand.add(aliasPrimeroTercero(pathNorm));
  const rawNorm = normCoordId(rawCoord);
  if (rawNorm) cand.add(rawNorm);
  if (rawCoord) cand.add(aliasPrimeroTercero(rawCoord));
  return [...cand].filter(Boolean);
}
function buildCoordHintSlug(s='') {
  const str = String(s || '').trim().toLowerCase();
  if (!str) return '';
  const local = str.includes('@') ? str.split('@')[0] : str; // "loreto.leiva"
  const cleaned = local.replace(/[._]+/g, ' ');              // "loreto leiva"
  return normCoordId(cleaned);                               // "loreto-leiva"
}

/* ====================== CATALOGOS: grupos + datalists ====================== */
async function preloadCatalogs() {
  state.caches.grupos.clear();
  state.caches.coords.length = 0;
  state.caches.groupsByCoord.clear();

  const snap = await getDocs(collection(db,'grupos'));

  const dlG = document.getElementById('dl-grupos');
  const dlN = document.getElementById('dl-grupos-nombre');
  const dlC = document.getElementById('dl-coords');

  if (dlG) dlG.innerHTML = '';
  if (dlN) dlN.innerHTML = '';
  if (dlC) dlC.innerHTML = '';

  snap.forEach(d => {
    const x = d.data() || {};
    const gid = d.id;

    const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
    const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);

    const coordEmail = coalesce(
      x.coordinadorEmail, x.coordinador?.email, x.coordinador,
      x.coord, x.responsable, x.owner, ''
    ).toLowerCase();

    const destino = coalesce(x.destino, x.lugar, '');
    const programa = coalesce(x.programa, x.plan, '');

    const cantidadGrupo = Number(
      x.cantidadGrupo ??
      x.paxTotal ??
      x.pax ??
      x.pax_total ??
      0
    );

    state.caches.grupos.set(gid, { gid, numero, nombre, coordEmail, destino, programa, cantidadGrupo });

    if (coordEmail) {
      if (!state.caches.groupsByCoord.has(coordEmail)) state.caches.groupsByCoord.set(coordEmail, new Set());
      state.caches.groupsByCoord.get(coordEmail).add(gid);
      if (!state.caches.coords.includes(coordEmail)) state.caches.coords.push(coordEmail);
    }

    if (dlG) {
      const opt = document.createElement('option');
      opt.value = gid;
      opt.label = `${numero} — ${nombre}`;
      dlG.appendChild(opt);
    }
    if (dlN) {
      const optN = document.createElement('option');
      optN.value = nombre;
      optN.label = `${numero} — ${nombre}`;
      dlN.appendChild(optN);
    }
  });

  if (dlC) {
    for (const email of state.caches.coords) {
      const opt = document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlC.appendChild(opt);
    }
  }
}

/* ====================== DATA: summary para gid ====================== */
async function loadSummaryForGroup(gid) {
  state.summary = null;
  if (!gid) return;
  try {
    const ref = doc(db,'grupos',gid,'finanzas','summary');
    const snap = await getDoc(ref);
    state.summary = snap.exists() ? (snap.data() || {}) : null;
  } catch (e) {
    console.warn('[DOCS] loadSummaryForGroup', e);
  }
}

/* ====================== DATA: construir docs desde gastos + summary ====================== */
function tipoLabel(tipo='') {
  const t = (tipo || '').toUpperCase();
  if (t === 'GASTO') return 'Gasto (comprobante)';
  if (t === 'BOLETA') return 'Boleta / SII';
  if (t === 'COMP_CLP') return 'Comprobante transf. CLP';
  if (t === 'CONST_USD') return 'Constancia USD / transf. coord';
  return tipo || 'Documento';
}

function makeDocItemBase({ gid, gInfo }) {
  return {
    grupoId: gid,
    numeroGrupo: gInfo?.numero || gid,
    nombreGrupo: gInfo?.nombre || '',
    destino: gInfo?.destino || '',
    coordEmail: gInfo?.coordEmail || '',
    programa: gInfo?.programa || '',
    fechaMs: 0,
    fechaTxt: '',
    tipoDoc: '',
    detalle: '',
    monto: 0,
    moneda: 'CLP',
    rendicionOk: false,      // del gasto (si aplica)
    montoAprobadoOk: false,  // ✅ "monto aprobado" (no “gasto aprobado”)
    url: '',                 // 🔴 link real: solo se exporta / visor interno
  };
}

// Lee collectionGroup('gastos') y arma items doc tipo GASTO (si tienen imgUrl)
async function fetchDocsFromGastos({ coordHint = '', grupoId = '' } = {}) {
  const out = [];

  let hint = buildCoordHintSlug(coordHint);
  const hintParts = hint.split('-').filter(Boolean);
  if (hintParts.length < 2) hint = grupoId ? '' : hint; // con grupo => no filtra por coord

  const snap = await getDocs(collectionGroup(db,'gastos'));
  snap.forEach(docSnap => {
    const raw = docSnap.data() || {};

    const gid = coalesce(
      raw.grupoId, raw.grupo_id, raw.gid, raw.idGrupo,
      raw.grupo, raw.id_grupo,
      (raw.numeroNegocio && raw.identificador) ? `${raw.numeroNegocio}-${raw.identificador}` : ''
    );
    if (!gid) return;
    if (grupoId && gid !== grupoId) return;

    const coordFromPath = (docSnap.ref.parent.parent?.id || '').toLowerCase();

    if (hint) {
      const rawCoord = coalesce(raw.coordinador, raw.coordinadorNombre, raw.coordNombre, '');
      const cands = coordCandidates({ coordFromPath, rawCoord });
      const hintAlias = aliasPrimeroTercero(hint);
      const ok = cands.includes(hint) || (hintAlias && cands.includes(hintAlias));
      if (!ok) return;
    }

    const gInfo = state.caches.grupos.get(gid) || { numero: gid, nombre: '', coordEmail: coordFromPath, destino:'', programa:'' };

    const imgUrl = coalesce(raw.imgUrl, raw.imageUrl, raw.imagenUrl, raw.comprobanteUrl, '');

    // Si no hay doc, este gasto no aporta a revisión de docs (para esta pantalla)
    if (!imgUrl) return;

    const item = makeDocItemBase({ gid, gInfo });

    const fechaMs = pickFechaMs(raw);
    item.fechaMs = fechaMs;
    item.fechaTxt = fechaMs ? fmtDDMMYYYY(fechaMs) : '—';

    item.tipoDoc = 'GASTO';

    item.detalle = coalesce(raw.asunto, raw.detalle, raw.descripcion, raw.concepto, raw.motivo, '');
    item.monto = parseMonto(coalesce(raw.montoAprobado, raw.monto, raw.total, raw.valor, 0));
    item.moneda = (coalesce(raw.moneda, raw.currency, 'CLP') || 'CLP').toString().toUpperCase();

    // ✅ rendición OK (checkbox)
    const rend = raw.rendicion || {};
    item.rendicionOk = (typeof raw.rendicionOk === 'boolean') ? !!raw.rendicionOk : !!rend.ok;

    // ✅ “Monto aprobado” (no gasto aprobado)
    // Regla: si existe raw.montoAprobado (no null/undefined) => ok
    const ma = coalesce(raw.montoAprobado, raw.aprobado, raw.monto_aprobado, null);
    item.montoAprobadoOk = (ma !== null);

    item.url = imgUrl;

    out.push(item);
  });

  return out;
}

// Construye docs "administrativos" desde summary (para un gid)
function buildDocsFromSummary(gid, gInfo, summary, docsOk) {
  const out = [];

  const base = (tipoDoc, detalle, url, extra = {}) => {
    const it = makeDocItemBase({ gid, gInfo });
    it.tipoDoc = tipoDoc;
    it.detalle = detalle || '';
    it.url = url || '';
    it.rendicionOk = !!extra.rendicionOk;
    it.montoAprobadoOk = !!extra.montoAprobadoOk;
    it.moneda = extra.moneda || 'CLP';
    it.monto = Number(extra.monto || 0) || 0;
    it.fechaTxt = '—';
    return it;
  };

  // Boleta / SII
  const boletaUrl = coalesce(summary.boleta?.url, summary.boletaUrl, '');
  out.push(base('BOLETA', 'Boleta / documento SII', boletaUrl, {}));

  // Comprobante transferencia CLP
  const compUrl = coalesce(
    summary.transfer?.comprobanteUrl,          // NUEVO real
    summary.transferenciaCLP?.url,
    summary.comprobanteCLP?.url,
    summary.comprobante?.url,
    summary.transfer?.url,
    summary.transferencia?.url,
    summary.transferenciaCLPUrl,
    summary.comprobanteUrl,
    ''
  );
  out.push(base('COMP_CLP', 'Comprobante transferencia CLP', compUrl, {}));

  // Constancia USD / transf coord
  const transfUrl = coalesce(
    summary.cashUsd?.comprobanteUrl,           // NUEVO real
    summary.transferenciaCoord?.url,
    summary.constanciaUSD?.url,
    summary.constancia?.url,
    summary.transferenciaCoordUrl,
    summary.constanciaUrl,
    ''
  );
  out.push(base('CONST_USD', 'Constancia efectivo USD / transferencia coordinador', transfUrl, {}));

  // Marcar “pendiente/ok” (visual) lo dejamos para chips; aquí solo entregamos items
  return out;
}

/* ====================== LOAD: principal ====================== */
async function loadData() {
  state.docs = [];
  state.summary = null;

  let gid = state.filtros.grupo || '';
  const coord = (state.filtros.coord || '').toLowerCase();
  const nombreGrupo = (state.filtros.grupoNombre || '').trim();

  // si no hay gid pero hay nombre, resolverlo
  if (!gid && nombreGrupo) {
    for (const [id, info] of state.caches.grupos.entries()) {
      if (info.nombre === nombreGrupo || `${info.numero} — ${info.nombre}` === nombreGrupo) {
        gid = id;
        state.filtros.grupo = id;
        break;
      }
    }
  }

  if (!gid && !coord) return;

  const gInfo = gid ? state.caches.grupos.get(gid) : null;
  const coordHint = coord || (gInfo?.coordEmail || '');

  // 1) Gastos con comprobante
  const docsGastos = await fetchDocsFromGastos({ coordHint, grupoId: gid });

  // 2) Summary docs (solo si hay gid)
  if (gid) await loadSummaryForGroup(gid);

  const summary = state.summary || {};
  const docsOk = (summary && summary.docsOk) || {};

  let docsSummary = [];
  if (gid && gInfo) {
    docsSummary = buildDocsFromSummary(gid, gInfo, summary, docsOk);
  }

  // Merge + orden
  const merged = [...docsGastos, ...docsSummary]
    .filter(Boolean)
    .sort((a,b)=>(a.fechaMs||0)-(b.fechaMs||0));

  state.docs = merged;
}

/* ====================== VIEWER: visor interno ====================== */
function openViewer({ title, sub, url }) {
  const modal = document.getElementById('viewerModal');
  const t = document.getElementById('viewerTitle');
  const s = document.getElementById('viewerSub');
  const f = document.getElementById('viewerFrame');

  if (!modal || !f) return;

  if (t) t.textContent = title || 'Documento';
  if (s) s.textContent = sub || '—';

  // Visor: embed directo
  f.src = url || '';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden','false');
}
function closeViewer() {
  const modal = document.getElementById('viewerModal');
  const f = document.getElementById('viewerFrame');
  if (f) f.src = '';
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden','true');
  }
}

/* ====================== RENDER: chips resumen ====================== */
function renderChips() {
  const el = document.getElementById('chipsResumen');
  if (!el) return;

  const total = state.docs.length;
  const conUrl = state.docs.filter(d => !!d.url).length;

  // rendición ok: para gastos, cuenta rendicionOk true
  const gastos = state.docs.filter(d => d.tipoDoc === 'GASTO');
  const rendOk = gastos.filter(d => d.rendicionOk).length;

  // monto aprobado ok (gastos con montoAprobado set)
  const montoAprobOk = gastos.filter(d => d.montoAprobadoOk).length;

  // summary docs: boleta/comp/const
  const summaryDocs = state.docs.filter(d => d.tipoDoc !== 'GASTO');
  const summaryConUrl = summaryDocs.filter(d => !!d.url).length;

  el.innerHTML = `
    <div class="chip"><span class="dot ${total?'ok':'warn'}"></span><strong>${total}</strong> <span class="muted">docs listados</span></div>
    <div class="chip"><span class="dot ${conUrl? 'ok':'warn'}"></span><strong>${conUrl}</strong> <span class="muted">con archivo</span></div>
    <div class="chip"><span class="dot ${gastos.length? 'ok':'warn'}"></span><strong>${gastos.length}</strong> <span class="muted">gastos con comprobante</span></div>
    <div class="chip"><span class="dot ${rendOk===gastos.length && gastos.length?'ok':'warn'}"></span><strong>${rendOk}/${gastos.length}</strong> <span class="muted">rendición OK</span></div>
    <div class="chip"><span class="dot ${montoAprobOk===gastos.length && gastos.length?'ok':'warn'}"></span><strong>${montoAprobOk}/${gastos.length}</strong> <span class="muted">monto aprobado</span></div>
    <div class="chip"><span class="dot ${summaryConUrl===summaryDocs.length && summaryDocs.length?'ok':'warn'}"></span><strong>${summaryConUrl}/${summaryDocs.length}</strong> <span class="muted">docs summary con archivo</span></div>
  `;
}

/* ====================== RENDER: tabla (✅ sin links) ====================== */
function renderTabla() {
  const tbody = document.querySelector('#tblDocs tbody');
  if (!tbody) return;

  const rows = state.docs.slice();

  tbody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.innerHTML = '<div class="muted">Sin datos. Usa Cargar.</div>';
    tr.appendChild(td);
    tbody.appendChild(tr);
    renderChips();
    return;
  }

  const frag = document.createDocumentFragment();

  rows.forEach(d => {
    const tr = document.createElement('tr');

    const tdFecha = document.createElement('td');
    tdFecha.textContent = d.fechaTxt || '—';

    const tdGrupo = document.createElement('td');
    tdGrupo.innerHTML = `<div><strong>${escapeHtml(d.numeroGrupo || '')}</strong></div><div class="small">${escapeHtml(d.nombreGrupo || '')}</div>`;

    const tdDest = document.createElement('td');
    tdDest.textContent = d.destino || '—';

    const tdCoord = document.createElement('td');
    tdCoord.textContent = d.coordEmail || '—';

    const tdTipo = document.createElement('td');
    tdTipo.textContent = tipoLabel(d.tipoDoc);

    const tdDet = document.createElement('td');
    tdDet.textContent = d.detalle || '—';

    const tdMonto = document.createElement('td');
    tdMonto.className = 'right mono';
    tdMonto.textContent = d.monto ? moneyBy(d.monto, d.moneda || 'CLP') : '—';

    // ✅ Doc (NO link): solo “VER” botón para visor interno, o “—”
    const tdDoc = document.createElement('td');
    tdDoc.className = 'center';
    if (d.url) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'VER';
      btn.className = 'btn-ver-doc';
      btn.title = 'Ver documento (visor interno)';
      btn.addEventListener('click', () => {
        const title = `${tipoLabel(d.tipoDoc)} — ${d.numeroGrupo} — ${d.nombreGrupo}`;
        const sub = `${d.destino} · ${d.coordEmail || '—'}${d.detalle ? ' · ' + d.detalle : ''}`;
        openViewer({ title, sub, url: d.url });
      });
      tdDoc.appendChild(btn);
    } else {
      tdDoc.textContent = '—';
      tdDoc.classList.add('muted');
    }

    // Rendición OK (solo aplica a GASTO)
    const tdRend = document.createElement('td');
    tdRend.className = 'center';
    if (d.tipoDoc === 'GASTO') {
      tdRend.innerHTML = d.rendicionOk
        ? `<span class="okBadge">✓</span>`
        : `<span class="warnBadge">—</span>`;
    } else {
      tdRend.innerHTML = `<span class="muted">—</span>`;
    }

    // ✅ Monto aprobado (no “gasto aprobado”)
    const tdAprob = document.createElement('td');
    tdAprob.className = 'center';
    if (d.tipoDoc === 'GASTO') {
      tdAprob.innerHTML = d.montoAprobadoOk
        ? `<span class="okBadge">✓</span>`
        : `<span class="warnBadge">—</span>`;
    } else {
      tdAprob.innerHTML = `<span class="muted">—</span>`;
    }

    tr.append(tdFecha, tdGrupo, tdDest, tdCoord, tdTipo, tdDet, tdMonto, tdDoc, tdRend, tdAprob);
    frag.appendChild(tr);
  });

  tbody.appendChild(frag);
  renderChips();
}

/* ====================== EXPORT: XLSX (link SOLO aquí) ====================== */
function exportXLSX() {
  if (!window.XLSX) { alert('No está cargada la librería XLSX.'); return; }
  if (!state.docs.length) { alert('No hay datos para exportar.'); return; }

  const rows = state.docs.map(d => ({
    fecha: d.fechaTxt || '',
    numeroGrupo: d.numeroGrupo || '',
    nombreGrupo: d.nombreGrupo || '',
    destino: d.destino || '',
    coordinador: d.coordEmail || '',
    tipo: tipoLabel(d.tipoDoc),
    detalle: d.detalle || '',
    monto: d.monto || 0,
    moneda: d.moneda || 'CLP',
    rendicionOk: (d.tipoDoc === 'GASTO') ? (d.rendicionOk ? 'OK' : 'NO') : '',
    montoAprobado: (d.tipoDoc === 'GASTO') ? (d.montoAprobadoOk ? 'OK' : 'NO') : '',

    // ✅ SOLO EN EXPORTACIÓN:
    documentoUrl: d.url || ''
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'RevisionDocs');

  const gid = state.filtros.grupo || '';
  const fname = gid ? `RevisionDocs_${gid}.xlsx` : `RevisionDocs_${Date.now()}.xlsx`;

  XLSX.writeFile(wb, fname);
}

/* ====================== EXPORT: DOC (Word-friendly, link SOLO aquí) ====================== */
function exportDOC() {
  if (!state.docs.length) { alert('No hay datos para exportar.'); return; }

  const title = 'REVISIÓN DE DOCUMENTOS — RT';
  const subtitle = `Exportado: ${new Date().toLocaleString('es-CL')}`;

  const filas = state.docs.map(d => `
    <tr>
      <td>${escapeHtml(d.fechaTxt || '—')}</td>
      <td>${escapeHtml(d.numeroGrupo || '')}<br/><span style="color:#666;font-size:10pt;">${escapeHtml(d.nombreGrupo || '')}</span></td>
      <td>${escapeHtml(d.destino || '—')}</td>
      <td>${escapeHtml(d.coordEmail || '—')}</td>
      <td>${escapeHtml(tipoLabel(d.tipoDoc))}</td>
      <td>${escapeHtml(d.detalle || '—')}</td>
      <td style="text-align:right;white-space:nowrap;">${escapeHtml(d.monto ? moneyBy(d.monto, d.moneda || 'CLP') : '—')}</td>
      <td>${d.url ? `<a href="${escapeHtml(d.url)}">${escapeHtml(d.url)}</a>` : '—'}</td>
      <td style="text-align:center;">${d.tipoDoc==='GASTO' ? (d.rendicionOk ? 'OK' : '—') : '—'}</td>
      <td style="text-align:center;">${d.tipoDoc==='GASTO' ? (d.montoAprobadoOk ? 'OK' : '—') : '—'}</td>
    </tr>
  `).join('');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
</head>
<body style="font-family:Calibri,Arial,sans-serif;">
  <h2 style="margin:0;">${title}</h2>
  <div style="color:#666;font-size:10pt;margin:6px 0 14px;">${subtitle}</div>

  <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%;font-size:10.5pt;">
    <thead style="background:#f2f2f2;">
      <tr>
        <th>Fecha</th>
        <th>Grupo</th>
        <th>Destino</th>
        <th>Coordinador</th>
        <th>Tipo</th>
        <th>Detalle</th>
        <th>Monto</th>
        <th>documentoUrl (solo export)</th>
        <th>Rendición</th>
        <th>Monto aprobado</th>
      </tr>
    </thead>
    <tbody>${filas}</tbody>
  </table>
</body>
</html>`;

  const blob = new Blob([html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (state.filtros.grupo ? `RevisionDocs_${state.filtros.grupo}.doc` : `RevisionDocs_${Date.now()}.doc`);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ====================== UI wiring (filtros) ====================== */
function wireUI() {
  // nav
  document.getElementById('btn-home')?.addEventListener('click', () => {
    location.href = 'index.html';
  });
  document.getElementById('btn-reload')?.addEventListener('click', () => {
    location.reload();
  });

  // logout
  document.getElementById('btn-logout')?.addEventListener('click', () => {
    signOut(auth).then(() => location.href = 'login.html');
  });

  // viewer
  document.getElementById('viewerClose')?.addEventListener('click', closeViewer);
  document.getElementById('viewerModal')?.addEventListener('click', (e) => {
    if (e.target?.id === 'viewerModal') closeViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeViewer();
  });

  // filtros
  const inputCoord = document.getElementById('filtroCoord');
  const inputGrupo = document.getElementById('filtroGrupo');
  const inputNombre = document.getElementById('filtroNombreGrupo');

  // helper: reconstruir datalists según coord
  function rebuildGroupDatalists(coordVal = '') {
    const dlG = document.getElementById('dl-grupos');
    const dlN = document.getElementById('dl-grupos-nombre');
    if (dlG) dlG.innerHTML = '';
    if (dlN) dlN.innerHTML = '';

    const addOpt = (gid, info) => {
      if (!info) return;
      if (dlG) {
        const opt = document.createElement('option');
        opt.value = gid;
        opt.label = `${info.numero} — ${info.nombre}`;
        dlG.appendChild(opt);
      }
      if (dlN) {
        const optN = document.createElement('option');
        optN.value = info.nombre;
        optN.label = `${info.numero} — ${info.nombre}`;
        dlN.appendChild(optN);
      }
    };

    if (coordVal && state.caches.groupsByCoord.has(coordVal)) {
      for (const gid of state.caches.groupsByCoord.get(coordVal)) {
        addOpt(gid, state.caches.grupos.get(gid));
      }
    } else {
      for (const [gid, info] of state.caches.grupos.entries()) addOpt(gid, info);
    }
  }

  inputCoord?.addEventListener('input', (e) => {
    const val = (e.target.value || '').toLowerCase().trim();
    state.filtros.coord = val;

    rebuildGroupDatalists(val);

    // si el grupo actual no corresponde al coord, limpiar
    if (state.filtros.grupo) {
      const info = state.caches.grupos.get(state.filtros.grupo);
      const coordGrupo = (info?.coordEmail || '').toLowerCase();
      if (val && coordGrupo && coordGrupo !== val) {
        state.filtros.grupo = '';
        state.filtros.grupoNombre = '';
        if (inputGrupo) inputGrupo.value = '';
        if (inputNombre) inputNombre.value = '';
      }
    }
  });

  inputGrupo?.addEventListener('input', (e) => {
    const gid = e.target.value || '';
    state.filtros.grupo = gid;

    const info = gid ? state.caches.grupos.get(gid) : null;
    if (!info) return;

    // set nombre
    if (inputNombre) inputNombre.value = info.nombre;
    state.filtros.grupoNombre = info.nombre;

    // set coord
    const coordEmail = (info.coordEmail || '').toLowerCase();
    if (inputCoord) inputCoord.value = coordEmail;
    state.filtros.coord = coordEmail;

    rebuildGroupDatalists(coordEmail);
  });

  inputNombre?.addEventListener('input', (e) => {
    const val = (e.target.value || '').trim();
    state.filtros.grupoNombre = val;
    if (!val) return;

    for (const [gid, info] of state.caches.grupos.entries()) {
      if (info.nombre === val || `${info.numero} — ${info.nombre}` === val) {
        state.filtros.grupo = gid;
        if (inputGrupo) inputGrupo.value = gid;

        const coordEmail = (info.coordEmail || '').toLowerCase();
        if (inputCoord) inputCoord.value = coordEmail;
        state.filtros.coord = coordEmail;

        rebuildGroupDatalists(coordEmail);
        break;
      }
    }
  });

  // cargar
  document.getElementById('btnCargar')?.addEventListener('click', async () => {
    const pagInfo = document.getElementById('pagInfo');
    if (!state.filtros.grupo && !state.filtros.coord) {
      alert('Selecciona al menos un grupo o un coordinador.');
      return;
    }
    if (pagInfo) pagInfo.textContent = 'Cargando…';
    await loadData();
    renderTabla();
    if (pagInfo) pagInfo.textContent = `Listo. (${state.docs.length} registros)`;
  });

  // limpiar
  document.getElementById('btnLimpiar')?.addEventListener('click', () => {
    state.filtros.coord = '';
    state.filtros.grupo = '';
    state.filtros.grupoNombre = '';
    state.docs = [];
    state.summary = null;

    if (inputCoord) inputCoord.value = '';
    if (inputGrupo) inputGrupo.value = '';
    if (inputNombre) inputNombre.value = '';

    rebuildGroupDatalists('');
    renderTabla();

    const pagInfo = document.getElementById('pagInfo');
    if (pagInfo) pagInfo.textContent = 'Filtros limpios.';
  });

  // export
  document.getElementById('btnExportXLS')?.addEventListener('click', exportXLSX);
  document.getElementById('btnExportDOC')?.addEventListener('click', exportDOC);

  // init datalists
  rebuildGroupDatalists((state.filtros.coord || '').toLowerCase());
}

/* ====================== BOOT ====================== */
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = 'login.html'; return; }
  state.user = user;

  await preloadCatalogs();
  wireUI();
  renderTabla(); // vacío inicial
});
