/* Revisión financiera (robusta)
   Lee movimientos de gastos/abonos en múltiples esquemas:
   - grupos/{gid}/finanzas/{doc}/(movs|movimientos|gastos|abonos)/*
   - grupos/{gid}/finanzas/{doc} con arrays (items|movs|movimientos|gastos|abonos)
   - Fallback: collectionGroup('gastos') y collectionGroup('abonos')
   Ignora finanzas/summary (cierre).
*/

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, doc, getDoc, getDocs, query,
  where, orderBy, limit, startAfter
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// ------------------------- Estado -------------------------
const state = {
  paging: { lastDoc: null, loading: false, reachedEnd: false },
  rawItems: [],
  filtros: { estado:'', tipo:'', coord:'', grupo:'' },
  caches: { grupos: new Map(), coords: [] },
};

// ------------------------- Utils --------------------------
const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const money = n => (isFinite(+n) ? (+n).toLocaleString('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}) : '—');
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

// Deriva estado desde revisiones si no hay campo explícito
function deriveEstado(x) {
  const s = (x.estado || '').toString().toLowerCase();
  if (s) return s;
  const r1 = (x.rev1 || '').toString().toLowerCase();
  const r2 = (x.rev2 || '').toString().toLowerCase();
  if (r1 === 'rechazado' || r2 === 'rechazado') return 'rechazado';
  if (r1 === 'aprobado'  && r2 === 'aprobado')  return 'aprobado';
  return 'pendiente';
}

function toItem(grupoId, gDoc, x, hintedTipo='') {
  const brutoMonto = coalesce(x.monto, x.importe, x.valor, x.total, 0);
  const monto = Number(brutoMonto) || 0;

  // Si viene “abono” con monto positivo, lo mantenemos como abono.
  // Si no hay tipo, asumimos: monto >= 0 → gasto; monto < 0 → abono.
  let tipo = (x.tipo || x.type || hintedTipo || '').toString().toLowerCase();
  if (!tipo) tipo = (monto < 0 ? 'abono' : 'gasto');

  const rev1  = (x.revision1?.estado || x.rev1?.estado || x.rev1 || '').toString().toLowerCase();
  const rev2  = (x.revision2?.estado || x.rev2?.estado || x.rev2 || '').toString().toLowerCase();
  const pago  = (x.pago?.estado || x.pago || '').toString().toLowerCase();

  const coord = (x.coordinadorEmail || x.coordinador || gDoc?.coordinadorEmail || gDoc?.coordinador?.email || '').toString().toLowerCase();
  const nombreGrupo   = coalesce(gDoc?.nombreGrupo, gDoc?.aliasGrupo, '');
  const numeroNegocio = coalesce(gDoc?.numeroNegocio, gDoc?.numNegocio, gDoc?.idNegocio, grupoId);

  return {
    id: x.id || x._id || '',
    grupoId,
    nombreGrupo,
    numeroNegocio,
    coordinador: coord,
    tipo, monto,
    rev1, rev2,
    estado: deriveEstado({ estado:x.estado, rev1, rev2 }),
    pago,
    __from: x.__from || ''  // pista de origen para debug
  };
}

// --------------------- Autocompletados --------------------
async function preloadCatalogs() {
  try {
    // Grupos
    const dlG = document.getElementById('dl-grupos');
    if (dlG) {
      dlG.innerHTML = '';
      const snap = await getDocs(collection(db, 'grupos'));
      snap.forEach(d => {
        const x = d.data() || {};
        state.caches.grupos.set(d.id, x);
        const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, d.id);
        const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, d.id);
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.label = `${numero} — ${nombre}`;
        dlG.appendChild(opt);
      });
    }
    // Coordinadores
    const dlC = document.getElementById('dl-coords');
    if (dlC) {
      dlC.innerHTML = '';
      const snap = await getDocs(collection(db, 'coordinadores'));
      const seen = new Set();
      snap.forEach(d => {
        const x = d.data() || {};
        const email = (coalesce(x.email, x.correo, x.mail, '')).toLowerCase();
        const nombre = coalesce(x.nombre, x.Nombre, x.coordinador, '');
        if (!email || seen.has(email)) return;
        seen.add(email);
        const opt = document.createElement('option');
        opt.value = email;
        opt.label = `${nombre ? (nombre.toUpperCase() + ' — ') : ''}${email}`;
        dlC.appendChild(opt);
        state.caches.coords.push(email);
      });
    }
  } catch (e) {
    console.warn('preloadCatalogs()', e);
  }
}

// ------------------ Carga de Finanzas ---------------------
async function fetchFinancePage(initial=false) {
  if (state.paging.loading || state.paging.reachedEnd) return;
  state.paging.loading = true;

  try {
    // Trae “contenedores” de finanzas por grupos
    let qFs = query(collectionGroup(db, 'finanzas'), limit(40));
    if (!initial && state.paging.lastDoc) qFs = query(collectionGroup(db, 'finanzas'), startAfter(state.paging.lastDoc), limit(40));

    const snap = await getDocs(qFs);
    if (!snap.size) {
      state.paging.reachedEnd = true;
      // Fallback extremo: si no llegó nada aún, intenta CG gastos/abonos sueltos
      if (!state.rawItems.length) await fallbackScanGastosAbonosCG();
      renderTable(); return;
    }

    for (const d of snap.docs) {
      state.paging.lastDoc = d;
      const fid = d.id;
      const parent = d.ref.parent;         // /grupos/{gid}/finanzas
      const grupoRef = parent.parent;      // /grupos/{gid}
      const grupoId = grupoRef.id;

      // cache de grupo
      let gDoc = state.caches.grupos.get(grupoId);
      if (!gDoc) {
        const g = await getDoc(grupoRef).catch(()=>null);
        gDoc = g?.exists() ? g.data() : {};
        state.caches.grupos.set(grupoId, gDoc);
      }

      // omite summary
      if (fid.toLowerCase() === 'summary') continue;

      const fin = d.data() || {};

      // ARRAYS DENTRO DEL DOC
      const arrNames = ['items', 'movs', 'movimientos', 'gastos', 'abonos'];
      for (const key of arrNames) {
        const arr = fin?.[key];
        if (Array.isArray(arr)) {
          arr.forEach((x, i) => {
            if (!x || typeof x !== 'object') return;
            state.rawItems.push(toItem(grupoId, gDoc, { ...x, id: `${fid}#${key}[${i}]`, __from:`docArray:${key}` }, key));
          });
        }
      }

      // SUBCOLECCIONES
      for (const sub of ['movs', 'movimientos', 'gastos', 'abonos']) {
        try {
          const sc = collection(db, 'grupos', grupoId, 'finanzas', fid, sub);
          const ds = await getDocs(sc);
          ds.forEach(s => {
            const x = s.data() || {};
            state.rawItems.push(toItem(grupoId, gDoc, { id:s.id, ...x, __from:`subcol:${sub}` }, sub));
          });
        } catch (_) { /* ignore */ }
      }
    }

    // Si igualmente no encontramos nada, intenta fallback con collectionGroup('gastos'/'abonos')
    if (!state.rawItems.length) await fallbackScanGastosAbonosCG();

    renderTable();
  } catch (e) {
    console.error('fetchFinancePage()', e);
    // intenta fallback si todo falló
    if (!state.rawItems.length) await fallbackScanGastosAbonosCG();
    renderTable();
  } finally {
    state.paging.loading = false;
  }
}

// Fallback: busca subcolecciones globales “gastos” y “abonos”
async function fallbackScanGastosAbonosCG() {
  try {
    console.warn('[FINZ] Fallback: collectionGroup(gastos|abonos)');
    for (const sub of ['gastos', 'abonos']) {
      const cg = await getDocs(query(collectionGroup(db, sub), limit(100)));
      cg.forEach(d => {
        // path esperado: grupos/{gid}/finanzas/{doc}/{sub}/{id}
        try {
          const subcol = d.ref.parent;              // …/{sub}
          const finDoc = subcol.parent;             // …/finanzas/{doc}
          const finCol = finDoc.parent;             // …/finanzas
          const grpDoc = finCol.parent;             // grupos/{gid}
          const grupoId = grpDoc.id;

          const gDoc = state.caches.grupos.get(grupoId);
          const x = d.data() || {};
          state.rawItems.push(toItem(grupoId, gDoc || {}, { id:d.id, ...x, __from:`CG:${sub}` }, sub));
        } catch(e) {
          // Si no tiene esa estructura, lo ignoramos
        }
      });
    }
  } catch (e) {
    console.warn('fallbackScanGastosAbonosCG()', e);
  }
}

// -------------------- Filtrar & Render --------------------
function applyFilters(items) {
  const f = state.filtros;
  const byEstado = f.estado;
  const byTipo   = f.tipo;
  const byCoord  = norm(f.coord);
  const byGrupo  = norm(f.grupo);

  return items.filter(x => {
    if (byTipo && x.tipo !== byTipo) return false;

    if (byEstado === 'pagables') {
      const pagable = (x.estado === 'aprobado') && (x.pago !== 'pagado');
      if (!pagable) return false;
    } else if (byEstado && x.estado !== byEstado) {
      return false;
    }

    if (byCoord && !norm(x.coordinador).includes(byCoord)) return false;

    if (byGrupo) {
      const blob = norm([x.grupoId, x.nombreGrupo, x.numeroNegocio].join(' '));
      if (!blob.includes(byGrupo)) return false;
    }
    return true;
  });
}

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
      tdCoord.textContent = (x.coordinador || '').toLowerCase();

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

  resumen.textContent = `Mostrando ${filtered.length} / cargados ${state.rawItems.length}`;
  pagInfo.textContent = state.paging.reachedEnd
    ? 'Sin más páginas.'
    : (state.paging.loading ? 'Cargando…' : 'Listo.');
}

// --------------------------- UI ---------------------------
function wireUI() {
  // Tabs estado
  const tabs = document.getElementById('stateTabs');
  tabs.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-estado]');
    if (!btn) return;
    tabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filtros.estado = btn.getAttribute('data-estado') || '';
    renderTable();
  });

  document.getElementById('filtroTipo').onchange = (e) => { state.filtros.tipo = e.target.value || ''; renderTable(); };
  document.getElementById('filtroCoord').oninput = (e) => { state.filtros.coord = e.target.value || ''; };
  document.getElementById('filtroGrupo').oninput = (e) => { state.filtros.grupo = e.target.value || ''; };

  document.getElementById('btnAplicar').onclick = () => renderTable();

  document.getElementById('btnRecargar').onclick = async () => {
    state.paging = { lastDoc: null, loading: false, reachedEnd: false };
    state.rawItems = [];
    await fetchFinancePage(true);
  };

  document.getElementById('btnMas').onclick = async () => {
    await fetchFinancePage(false);
  };
}

// -------------------- Consola debug -----------------------
window.__finz = {
  async probeSub(kind) {
    try {
      if (kind === 'finanzas') {
        const snap = await getDocs(query(collectionGroup(db, 'finanzas'), limit(1)));
        return { ok: snap.size > 0, size: snap.size };
      }
      if (['movs','movimientos','gastos','abonos'].includes(kind)) {
        const cs = await getDocs(query(collectionGroup(db, 'finanzas'), limit(3)));
        for (const d of cs.docs) {
          const gid = d.ref.parent.parent.id;
          const col = collection(db, 'grupos', gid, 'finanzas', d.id, kind);
          const ss = await getDocs(query(col, limit(1)));
          if (ss.size) return { ok:true, where:`grupos/${gid}/finanzas/${d.id}/${kind}` };
        }
        return { ok:false };
      }
      return { ok:false, error:'kind desconocido' };
    } catch (e) {
      return { ok:false, error: e?.message || String(e) };
    }
  },
  list() {
    return {
      loaded: state.rawItems.length,
      sample: state.rawItems.slice(0, 10)
    };
  }
};

// ------------------------- Arranque -----------------------
onAuthStateChanged(auth, async (user) => {
  if (!user) { location = 'login.html'; return; }
  try {
    document.querySelector('#btn-logout')?.addEventListener('click', () =>
      signOut(auth).then(() => location = 'login.html')
    );
  } catch (_) {}

  wireUI();
  await preloadCatalogs();
  await fetchFinancePage(true);

  // pista en consola
  console.log('%c[FINZ] Cargados:', 'color:#0a0', state.rawItems.length);
  if (!state.rawItems.length) {
    console.warn('[FINZ] No se encontraron movimientos. Usa:', 
      "await __finz.probeSub('gastos') / 'abonos' / 'movs' / 'movimientos'");
  }
});
