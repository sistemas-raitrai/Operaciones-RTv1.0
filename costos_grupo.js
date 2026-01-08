// costos_grupo.js
// RT · Costos por Grupo (estilo estadisticas + revisado por línea tipo revision_docs)
//
// ✅ Lee grupos (colección "grupos") y su itinerario
// ✅ Cruza actividades con Servicios/{DESTINO}/Listado (y si destino es mixto, carga ambos listados)
// ✅ Calcula qty/total (con overrides)
// ✅ Revisión por línea: se guarda en ruta independiente:
//    grupos/{gid}/costosRevision/v1/items/{rowId}
// ✅ Para DESMARCAR "Revisado" pide PIN (configurable)
// ✅ Exporta XLS con líneas filtradas
//
// Importante:
// - Este módulo NO modifica el doc del grupo ni el servicio.
// - Todo lo de revisión/overrides/notas vive en su colección separada.

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, orderBy,
  doc, getDoc, setDoc,
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* =========================
   CONFIG
========================= */

// Ruta de revisión por grupo
const REV_DOC_ID = 'v1'; // puedes versionar esto si mañana cambias cálculo
const REV_PIN_DEFAULT = '0000'; // 👈 cambia esto (o define window.RT_PIN_DESMARCAR)

/* =========================
   STATE
========================= */
const state = {
  user: null,

  // caches
  grupos: [],                 // [{id, numeroNegocio, nombreGrupo, destino, fechaInicio, itinerario}]
  serviciosByDestino: new Map(), // destino -> Map(servicioId -> data)
  revisionByGid: new Map(),      // gid -> Map(rowId -> revisionData)

  // ui
  filtros: {
    q: '',
    gid: '',
    destino: 'TODOS',
    ano: 'TODOS',
    proveedor: 'TODOS',
    soloNoRevisado: 'NO',
  },

  // computed
  rowsAll: [],     // todas las líneas construidas (sin filtros)
  rowsView: [],    // filtradas
  dirty: new Map() // rowId -> payload a guardar
};

/* =========================
   DOM
========================= */
const $ = (id) => document.getElementById(id);

const els = {
  q: $('q'),
  fGrupo: $('fGrupo'),
  fDestino: $('fDestino'),
  fAno: $('fAno'),
  fProveedor: $('fProveedor'),
  fSoloNoRevisado: $('fSoloNoRevisado'),

  btnAplicar: $('btnAplicar'),
  btnLimpiar: $('btnLimpiar'),
  btnGuardar: $('btnGuardar'),
  btnExportar: $('btnExportar'),

  status: $('status'),
  tbody: $('tbody'),

  kLineas: $('kLineas'),
  kLineasHint: $('kLineasHint'),
  kTotal: $('kTotal'),
  kRevisados: $('kRevisados'),
  kSinMatch: $('kSinMatch'),
  kProv: $('kProv'),
};

/* =========================
   HELPERS
========================= */
function setStatus(msg='') {
  els.status.textContent = msg || '';
}

function escapeHtml(s='') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normId(s='') {
  // normaliza a formato docId estilo "DISCO_BR"
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9]+/g,'_')
    .replace(/^_+|_+$/g,'');
}

function parseAnoFromISO(iso='') {
  // iso: YYYY-MM-DD
  const m = /^(\d{4})-/.exec(iso || '');
  return m ? m[1] : '';
}

function destinosParaGrupo(destino='') {
  const d = String(destino || '').toUpperCase();

  // caso mixto (ajusta aquí si tu texto real cambia)
  const isBar = d.includes('BARILOCHE');
  const isSur = d.includes('SUR');

  if (isBar && isSur) return ['BARILOCHE', 'SUR DE CHILE'];
  if (isBar) return ['BARILOCHE'];
  if (isSur) return ['SUR DE CHILE'];
  if (d.includes('BRASIL')) return ['BRASIL'];
  if (d.includes('NORTE')) return ['NORTE DE CHILE'];

  // fallback: intenta usar literal
  return [destino];
}

function unidadToQty(unidad, item, grupo) {
  const u = String(unidad || '').toUpperCase();

  const est = Number(item?.estudiantes ?? item?.paxEstudiantes ?? 0) || 0;
  const adu = Number(item?.adultos ?? item?.paxAdultos ?? 0) || 0;
  const pax = (est + adu) || Number(item?.pax ?? 0) || Number(grupo?.paxTotal ?? 0) || 0;

  if (u.includes('PERSONA') || u.includes('PAX')) return pax || 0;
  if (u.includes('GRUPO')) return 1;
  if (u.includes('BUS')) return Number(item?.buses ?? 1) || 1;

  // default: si no sabemos, tratamos como por grupo
  return 1;
}

function fmtMoney(n) {
  const x = Number(n || 0);
  // no forzamos CLP, es genérico; el usuario decide por moneda.
  return x.toLocaleString('es-CL', { maximumFractionDigits: 0 });
}

function buildRowId(gid, fechaISO, servicioId, idx=0) {
  // estable: gid + fecha + servicioId + idx (por si repites servicio el mismo día)
  return `${gid}__${fechaISO}__${servicioId || 'SIN_SERVICIO'}__${idx}`;
}

function getRevPin() {
  return String(window.RT_PIN_DESMARCAR || REV_PIN_DEFAULT);
}

/* =========================
   LOADERS
========================= */

async function loadGrupos() {
  // Si necesitas ordenar por algún campo, cámbialo aquí.
  const snap = await getDocs(collection(db, 'grupos'));
  const out = [];
  snap.forEach(d => {
    const x = d.data() || {};
    out.push({
      id: d.id,
      numeroNegocio: x.numeroNegocio || '',
      nombreGrupo: x.nombreGrupo || x.nombre || '',
      destino: x.destino || '',
      fechaInicio: x.fechaInicio || x.fechaDeViaje || x.inicioViaje || '', // fallback
      itinerario: x.itinerario || {}, // esperado: { "YYYY-MM-DD": [ {actividad, servicioId?, hora, estudiantes, adultos, ...}, ... ] }
      paxTotal: x.paxTotal || x.cantidadgrupo || x.cantidadGrupo || 0
    });
  });
  state.grupos = out;
}

async function loadServiciosForDestino(destino) {
  const key = String(destino || '').toUpperCase();
  if (state.serviciosByDestino.has(key)) return state.serviciosByDestino.get(key);

  // Firestore: Servicios/{DESTINO}/Listado/{servicioId}
  // En tu screenshot: Servicios > BARILOCHE > Listado > docs
  const colRef = collection(db, 'Servicios', key, 'Listado');
  const snap = await getDocs(colRef);

  const map = new Map();
  snap.forEach(d => map.set(d.id, d.data() || {}));

  state.serviciosByDestino.set(key, map);
  return map;
}

async function loadRevisionForGid(gid) {
  if (!gid) return new Map();
  if (state.revisionByGid.has(gid)) return state.revisionByGid.get(gid);

  const itemsCol = collection(db, 'grupos', gid, 'costosRevision', REV_DOC_ID, 'items');
  const snap = await getDocs(itemsCol);

  const map = new Map();
  snap.forEach(d => map.set(d.id, d.data() || {}));

  state.revisionByGid.set(gid, map);
  return map;
}

/* =========================
   BUILD ROWS (core)
========================= */

async function buildRows() {
  const rows = [];

  // armamos por grupo
  for (const g of state.grupos) {
    const destinos = destinosParaGrupo(g.destino);

    // index de servicios combinados (si es mixto, junta ambos)
    const servicesMerged = new Map();
    for (const d of destinos) {
      const m = await loadServiciosForDestino(d);
      for (const [sid, sdata] of m.entries()) {
        if (!servicesMerged.has(sid)) servicesMerged.set(sid, { ...sdata, _destinoCatalogo: String(d).toUpperCase() });
      }
    }

    // carga revisión de este grupo (se guarda independiente)
    const revMap = await loadRevisionForGid(g.id);

    // it: {fechaISO: [items]}
    const it = g.itinerario || {};
    const fechas = Object.keys(it).sort();

    for (const fechaISO of fechas) {
      const items = Array.isArray(it[fechaISO]) ? it[fechaISO] : [];

      items.forEach((item, idx) => {
        // intentos de servicioId:
        const servicioId =
          (item?.servicioId && String(item.servicioId)) ||
          (item?.servicio && String(item.servicio)) ||
          normId(item?.actividad || item?.nombre || item?.descripcion || '');

        const sData = servicesMerged.get(servicioId) || null;

        // base pricing
        const unidad = sData?.unidadCobro || sData?.unidad || 'POR_GRUPO';
        const moneda = sData?.moneda || '—';
        const precioBase = Number(sData?.precioBase ?? sData?.precio ?? 0) || 0;

        const qtyCalc = unidadToQty(unidad, item, g);
        const totalCalc = (precioBase || 0) * (qtyCalc || 0);

        const rowId = buildRowId(g.id, fechaISO, servicioId || 'SIN_SERVICIO', idx);

        const rev = revMap.get(rowId) || {};

       rows.push({
          rowId,
          gid: g.id,
          numeroNegocio: g.numeroNegocio,
          grupo: g.nombreGrupo,
          destinoGrupo: g.destino,
          fechaISO,
          servicioId: servicioId || '',
          servicioNombre: sData?.nombre || (servicioId ? servicioId.replaceAll('_',' ') : (item?.actividad || '')),
          proveedor: sData?.proveedor || sData?.proveedorId || '—',
          unidad,
          moneda,
          // calculado
          precioBase,
          qtyCalc,
          totalCalc,
          // revisión/overrides
          revisado: !!rev.revisado,
          qtyOverride: (rev.qtyOverride ?? ''),
          precioOverride: (rev.precioOverride ?? ''),
          nota: (rev.nota ?? ''),
          // estado
          hasMatch: !!sData,
          catalogoDestino: sData?._destinoCatalogo || '—',
        });
      });
    }
  }

  state.rowsAll = rows;
}

/* =========================
   FILTERS + KPIs
========================= */

function applyFilters() {
  const q = (state.filtros.q || '').toLowerCase().trim();

  const gid = state.filtros.gid || '';
  const dest = state.filtros.destino || 'TODOS';
  const ano = state.filtros.ano || 'TODOS';
  const prov = state.filtros.proveedor || 'TODOS';
  const soloNoRev = state.filtros.soloNoRevisado || 'NO';

  let rows = [...state.rowsAll];

  if (gid) rows = rows.filter(r => r.gid === gid);

  if (dest !== 'TODOS') {
    rows = rows.filter(r => String(r.destinoGrupo || '').toUpperCase() === String(dest).toUpperCase());
  }

  if (ano !== 'TODOS') {
    rows = rows.filter(r => parseAnoFromISO(r.fechaISO) === String(ano));
  }

  if (prov !== 'TODOS') {
    rows = rows.filter(r => String(r.proveedor || '').toUpperCase() === String(prov).toUpperCase());
  }

  if (soloNoRev === 'SI') {
    rows = rows.filter(r => !r.revisado);
  }

  if (q) {
    rows = rows.filter(r => {
      const blob = [
        r.gid, r.numeroNegocio, r.grupo, r.destinoGrupo, r.fechaISO,
        r.servicioId, r.servicioNombre, r.proveedor, r.unidad, r.moneda
      ].join(' ').toLowerCase();
      return blob.includes(q);
    });
  }

  state.rowsView = rows;
  render();
}

/* =========================
   RENDER
========================= */

function calcRowNumbers(r) {
  const precio = (r.precioOverride !== '' && r.precioOverride != null)
    ? Number(r.precioOverride || 0)
    : Number(r.precioBase || 0);

  const qty = (r.qtyOverride !== '' && r.qtyOverride != null)
    ? Number(r.qtyOverride || 0)
    : Number(r.qtyCalc || 0);

  const total = (precio || 0) * (qty || 0);

  return { precio, qty, total };
}

function renderKPIs() {
  const rows = state.rowsView;

  els.kLineas.textContent = String(rows.length);
  els.kLineasHint.textContent = state.filtros.gid ? `Grupo: ${state.filtros.gid}` : '—';

  const revisados = rows.filter(r => r.revisado).length;
  els.kRevisados.textContent = String(revisados);

  const sinMatch = rows.filter(r => !r.hasMatch).length;
  els.kSinMatch.textContent = String(sinMatch);

  const provSet = new Set(rows.map(r => r.proveedor).filter(Boolean));
  els.kProv.textContent = String(provSet.size);

  // total por moneda
  const byMon = new Map();
  for (const r of rows) {
    const { total } = calcRowNumbers(r);
    const m = r.moneda || '—';
    byMon.set(m, (byMon.get(m) || 0) + (total || 0));
  }
  const parts = [...byMon.entries()].map(([m, v]) => `${m}: ${fmtMoney(v)}`);
  els.kTotal.textContent = parts.length ? parts.join(' · ') : '0';
}

function rowEstadoBadge(r) {
  if (!r.hasMatch) return `<span class="cs-badge bad">SIN SERVICIO</span>`;
  if (r.revisado) return `<span class="cs-badge ok">REVISADO</span>`;
  return `<span class="cs-badge warn">PENDIENTE</span>`;
}

function render() {
  renderKPIs();

  const rows = state.rowsView;
  if (!rows.length) {
    els.tbody.innerHTML = `<tr><td colspan="14" class="cs-empty">Sin resultados.</td></tr>`;
    els.btnGuardar.disabled = state.dirty.size === 0;
    return;
  }

  els.tbody.innerHTML = rows.map(r => {
    const { precio, qty, total } = calcRowNumbers(r);

    const dirty = state.dirty.has(r.rowId);
    const trClass = dirty ? 'cs-row-dirty' : '';

    return `
      <tr data-rowid="${escapeHtml(r.rowId)}" class="${trClass}">
        <td class="cs-mono cs-dim">${escapeHtml(r.rowId.split('__').slice(-1)[0])}</td>
        <td class="cs-mono">${escapeHtml(r.gid)}</td>
        <td title="${escapeHtml(r.grupo)}">${escapeHtml(r.grupo || '—')}</td>
        <td class="cs-mono">${escapeHtml(r.fechaISO)}</td>

        <td>
          <div style="font-weight:900">${escapeHtml(r.servicioNombre || '—')}</div>
          <div class="cs-dim cs-mono" style="font-size:.82rem">
            ${escapeHtml(r.servicioId || 'SIN_ID')}
            <span class="cs-dim"> · cat:</span> ${escapeHtml(r.catalogoDestino || '—')}
          </div>
        </td>

        <td>${escapeHtml(r.proveedor || '—')}</td>
        <td class="cs-mono">${escapeHtml(r.unidad || '—')}</td>

        <td class="cs-right">
          <input class="cell-input num" data-field="precioOverride"
            value="${escapeHtml(r.precioOverride ?? '')}"
            placeholder="${escapeHtml(String(r.precioBase || 0))}" />
          <div class="cs-dim cs-mono" style="font-size:.78rem;margin-top:4px">
            base: ${escapeHtml(String(r.precioBase || 0))}
          </div>
        </td>

        <td class="cs-right">
          <input class="cell-input num" data-field="qtyOverride"
            value="${escapeHtml(r.qtyOverride ?? '')}"
            placeholder="${escapeHtml(String(r.qtyCalc || 0))}" />
          <div class="cs-dim cs-mono" style="font-size:.78rem;margin-top:4px">
            calc: ${escapeHtml(String(r.qtyCalc || 0))}
          </div>
        </td>

        <td class="cs-right cs-mono" data-total="${total || 0}">
          ${escapeHtml(fmtMoney(total || 0))}
        </td>

        <td class="cs-right cs-mono">${escapeHtml(r.moneda || '—')}</td>

        <td>
          <input type="checkbox" class="chk" data-field="revisado" ${r.revisado ? 'checked' : ''} />
        </td>

        <td>${rowEstadoBadge(r)}</td>

        <td>
          <input class="cell-input" data-field="nota"
            value="${escapeHtml(r.nota ?? '')}"
            placeholder="..." />
        </td>
      </tr>
    `;
  }).join('');

  els.btnGuardar.disabled = state.dirty.size === 0;
}

/* =========================
   DIRTY / SAVE (revision)
========================= */

function markDirty(rowId, patch) {
  // merge patch con lo que ya está marcado
  const curr = state.dirty.get(rowId) || {};
  state.dirty.set(rowId, { ...curr, ...patch });
  els.btnGuardar.disabled = state.dirty.size === 0;

  // marca visualmente la fila
  const tr = els.tbody.querySelector(`tr[data-rowid="${CSS.escape(rowId)}"]`);
  if (tr) tr.classList.add('cs-row-dirty');
}

function findRow(rowId) {
  return state.rowsAll.find(r => r.rowId === rowId);
}

async function saveDirty() {
  if (!state.dirty.size) return;

  setStatus('Guardando...');
  let ok = 0, fail = 0;

  // agrupamos por gid
  const byGid = new Map();
  for (const [rowId, patch] of state.dirty.entries()) {
    const row = findRow(rowId);
    if (!row) continue;
    if (!byGid.has(row.gid)) byGid.set(row.gid, []);
    byGid.get(row.gid).push({ rowId, patch, row });
  }

  for (const [gid, items] of byGid.entries()) {
    for (const { rowId, patch, row } of items) {
      try {
        const ref = doc(db, 'grupos', gid, 'costosRevision', REV_DOC_ID, 'items', rowId);

        // payload minimal, auditable
        const payload = {
          ...patch,
          updatedAt: new Date().toISOString(),
          updatedBy: state.user?.email || 'unknown',
          // opcional: info base de la línea (para auditoría)
          _meta: {
            fechaISO: row.fechaISO,
            servicioId: row.servicioId || '',
            servicioNombre: row.servicioNombre || '',
            proveedor: row.proveedor || '',
            moneda: row.moneda || '',
            unidad: row.unidad || '',
          }
        };

        await setDoc(ref, payload, { merge: true });
        ok++;

        // aplica al estado local (rowsAll + rowsView)
        const applyLocal = (arr) => {
          const i = arr.findIndex(r => r.rowId === rowId);
          if (i >= 0) {
            if ('revisado' in patch) arr[i].revisado = !!patch.revisado;
            if ('qtyOverride' in patch) arr[i].qtyOverride = patch.qtyOverride;
            if ('precioOverride' in patch) arr[i].precioOverride = patch.precioOverride;
            if ('nota' in patch) arr[i].nota = patch.nota;
          }
        };
        applyLocal(state.rowsAll);
        applyLocal(state.rowsView);

        // update cache revision map
        const revMap = await loadRevisionForGid(gid);
        revMap.set(rowId, { ...(revMap.get(rowId) || {}), ...patch });

      } catch (e) {
        console.error('save fail', gid, rowId, e);
        fail++;
      }
    }
  }

  // limpia dirty + re-render
  state.dirty.clear();
  render();
  setStatus(`Listo. Guardados: ${ok}${fail ? ` · Fallidos: ${fail}` : ''}`);
}

/* =========================
   EVENTS
========================= */

function bindTableEvents() {
  els.tbody.addEventListener('input', (ev) => {
    const tr = ev.target.closest('tr[data-rowid]');
    if (!tr) return;

    const rowId = tr.getAttribute('data-rowid');
    const field = ev.target.getAttribute('data-field');
    if (!field) return;

    // inputs num: dejamos vacío si lo borran (significa "usar calc/base")
    if (field === 'qtyOverride' || field === 'precioOverride') {
      const raw = String(ev.target.value || '').trim();
      const clean = raw === '' ? '' : String(Number(raw.replace(',', '.')) || 0);
      markDirty(rowId, { [field]: clean });
      return;
    }

    if (field === 'nota') {
      markDirty(rowId, { nota: String(ev.target.value || '') });
      return;
    }
  });

  els.tbody.addEventListener('change', async (ev) => {
    const tr = ev.target.closest('tr[data-rowid]');
    if (!tr) return;

    const rowId = tr.getAttribute('data-rowid');
    const field = ev.target.getAttribute('data-field');
    if (field !== 'revisado') return;

    const checked = !!ev.target.checked;
    const row = findRow(rowId);

    // si intenta DESMARCAR, pedimos pin
    if (!checked && row?.revisado) {
      const pin = prompt('PIN para desmarcar "Revisado":');
      if (String(pin || '') !== getRevPin()) {
        alert('PIN incorrecto.');
        ev.target.checked = true; // vuelve a checked
        return;
      }
    }

    markDirty(rowId, { revisado: checked });
  });
}

/* =========================
   EXPORT XLS
========================= */

function exportXLS() {
  const rows = state.rowsView;

  const out = rows.map(r => {
    const { precio, qty, total } = calcRowNumbers(r);
    return {
      rowId: r.rowId,
      gid: r.gid,
      numeroNegocio: r.numeroNegocio,
      grupo: r.grupo,
      destino: r.destinoGrupo,
      fecha: r.fechaISO,
      servicioId: r.servicioId,
      servicio: r.servicioNombre,
      proveedor: r.proveedor,
      unidad: r.unidad,
      moneda: r.moneda,
      precio: precio,
      qty: qty,
      total: total,
      revisado: r.revisado ? 'SI' : 'NO',
      nota: r.nota || ''
    };
  });

  const ws = XLSX.utils.json_to_sheet(out);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Costos');

  const fname = `RT_Costos_${state.filtros.gid || 'FILTRADO'}_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, fname);
}

/* =========================
   UI POPULATE FILTERS
========================= */

function populateSelect(sel, options, { includeTodos=true, todosLabel='TODOS' } = {}) {
  const prev = sel.value;
  sel.innerHTML = '';

  if (includeTodos) {
    const op = document.createElement('option');
    op.value = 'TODOS';
    op.textContent = todosLabel;
    sel.appendChild(op);
  }

  for (const { value, label } of options) {
    const op = document.createElement('option');
    op.value = value;
    op.textContent = label;
    sel.appendChild(op);
  }

  // intenta mantener selección previa
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function refreshFilterOptionsFromRows() {
  // destinos: desde grupos
  const destinos = [...new Set(state.grupos.map(g => g.destino).filter(Boolean))]
    .sort((a,b)=>String(a).localeCompare(String(b)));

  populateSelect(els.fDestino, destinos.map(d => ({ value:d, label:d })), { includeTodos:true });

  // grupos: label con numeroNegocio + nombre
  populateSelect(els.fGrupo,
    state.grupos
      .slice()
      .sort((a,b)=>String(a.nombreGrupo).localeCompare(String(b.nombreGrupo)))
      .map(g => ({
        value: g.id,
        label: `(${g.numeroNegocio || g.id}) ${g.nombreGrupo || '—'}`
      })),
    { includeTodos:false }
  );

  // año: desde rowsAll por fecha
  const anos = [...new Set(state.rowsAll.map(r => parseAnoFromISO(r.fechaISO)).filter(Boolean))].sort();
  populateSelect(els.fAno, anos.map(a => ({ value:a, label:a })), { includeTodos:true });

  // proveedor: desde rowsAll
  const provs = [...new Set(state.rowsAll.map(r => r.proveedor).filter(p => p && p !== '—'))]
    .sort((a,b)=>String(a).localeCompare(String(b)));
  populateSelect(els.fProveedor, provs.map(p => ({ value:p, label:p })), { includeTodos:true });
}

/* =========================
   INIT
========================= */

function bindTopEvents() {
  els.btnAplicar.addEventListener('click', () => {
    state.filtros.q = els.q.value || '';
    state.filtros.gid = els.fGrupo.value || '';
    state.filtros.destino = els.fDestino.value || 'TODOS';
    state.filtros.ano = els.fAno.value || 'TODOS';
    state.filtros.proveedor = els.fProveedor.value || 'TODOS';
    state.filtros.soloNoRevisado = els.fSoloNoRevisado.value || 'NO';
    applyFilters();
    setStatus('Filtros aplicados.');
  });

  els.btnLimpiar.addEventListener('click', () => {
    els.q.value = '';
    els.fDestino.value = 'TODOS';
    els.fAno.value = 'TODOS';
    els.fProveedor.value = 'TODOS';
    els.fSoloNoRevisado.value = 'NO';
    // grupo lo dejamos vacío (si quieres resetear, pon el primero)
    state.filtros = {
      q: '',
      gid: els.fGrupo.value || '',
      destino: 'TODOS',
      ano: 'TODOS',
      proveedor: 'TODOS',
      soloNoRevisado: 'NO',
    };
    applyFilters();
    setStatus('Filtros limpiados.');
  });

  els.btnGuardar.addEventListener('click', saveDirty);
  els.btnExportar.addEventListener('click', exportXLS);

  // auto-aplicar al cambiar grupo (para que sea fluido)
  els.fGrupo.addEventListener('change', () => {
    state.filtros.gid = els.fGrupo.value || '';
    applyFilters();
  });
}

async function boot() {
  setStatus('Inicializando...');

  await loadGrupos();
  setStatus(`Grupos cargados: ${state.grupos.length}. Preparando...`);

  // construye todas las líneas cruzando servicios
  await buildRows();

  // poblar filtros y render
  refreshFilterOptionsFromRows();

  // valor por defecto: si hay año actual en opciones, selecciónalo
  const y = String(new Date().getFullYear());
  if ([...els.fAno.options].some(o => o.value === y)) els.fAno.value = y;

  // bind events
  bindTopEvents();
  bindTableEvents();

  // aplica filtros iniciales
  state.filtros.gid = els.fGrupo.value || '';
  state.filtros.q = '';
  state.filtros.destino = 'TODOS';
  state.filtros.ano = els.fAno.value || 'TODOS';
  state.filtros.proveedor = 'TODOS';
  state.filtros.soloNoRevisado = 'NO';
  applyFilters();

  setStatus('Listo.');
}

onAuthStateChanged(auth, async (user) => {
  state.user = user || null;

  // Si tu script.js ya redirige cuando no hay usuario, esto igual queda ok.
  if (!user) {
    setStatus('Debes iniciar sesión.');
    return;
  }

  try {
    await boot();
  } catch (e) {
    console.error(e);
    setStatus('Error cargando datos (ver consola).');
  }
});
