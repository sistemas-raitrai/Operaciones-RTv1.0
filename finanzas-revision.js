/* Revisión financiera (robusta multiesquema)
   Lee movimientos en: grupos/{gid}/finanzas/*
   - Subcolecciones: movs | movimientos
   - Arrays: items | movs | movimientos dentro del doc
   Ignora: finanzas/summary (se usa solo para cierre)
*/

import { app, db } from './firebase-init.js';
import {
  getAuth, onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection, collectionGroup, doc, getDoc, getDocs, query,
  where, orderBy, limit, startAfter
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// ——— Estado local ———
const state = {
  paging: { pageSize: 50, lastDoc: null, loading: false, reachedEnd: false },
  rawItems: [], // items crudos normalizados
  filtros: { estado:'', tipo:'', coord:'', grupo:'' },
  caches: { grupos: new Map(), coords: [] },
};

// ——— Helpers ———
const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const money = (n) => {
  const v = Number(n || 0);
  return isFinite(v) ? v.toLocaleString('es-CL', { style:'currency', currency:'CLP', maximumFractionDigits:0 }) : '—';
};
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

// Derivar estado a partir de dos revisiones si no hay estado explícito
function deriveEstado(x) {
  const s = (x.estado || '').toString().toLowerCase();
  if (s) return s;
  const r1 = (x.rev1 || '').toString().toLowerCase();
  const r2 = (x.rev2 || '').toString().toLowerCase();
  if (r1 === 'rechazado' || r2 === 'rechazado') return 'rechazado';
  if (r1 === 'aprobado'  && r2 === 'aprobado')  return 'aprobado';
  return 'pendiente';
}

function toItem(grupoId, gDoc, x) {
  // Normalización tolerante
  const tipo = (x.tipo || x.type || '').toString().toLowerCase() || (Number(x.monto || x.importe || x.valor || 0) >= 0 ? 'gasto' : 'abono');
  const monto = Number(coalesce(x.monto, x.importe, x.valor, 0));
  const rev1  = (x.revision1?.estado || x.rev1?.estado || x.rev1 || '').toString().toLowerCase();
  const rev2  = (x.revision2?.estado || x.rev2?.estado || x.rev2 || '').toString().toLowerCase();
  const pago  = (x.pago?.estado || x.pago || '').toString().toLowerCase();
  const coord = (x.coordinadorEmail || x.coordinador || gDoc?.coordinadorEmail || gDoc?.coordinador?.email || '').toString().toLowerCase();

  const nombreGrupo = coalesce(gDoc?.nombreGrupo, gDoc?.aliasGrupo, '');
  const numeroNegocio = coalesce(gDoc?.numeroNegocio, gDoc?.numNegocio, gDoc?.idNegocio, grupoId);

  return {
    id: x.id || x._id || '',
    grupoId,
    nombreGrupo,
    numeroNegocio,
    coordinador: coord,
    tipo,
    monto,
    rev1,
    rev2,
    estado: deriveEstado({ estado:x.estado, rev1, rev2 }),
    pago,
  };
}

// ——— Carga catálogos para autocompletado ———
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
        opt.value = `${d.id}`;
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

// ——— Lectura robusta de movimientos ———
async function fetchFinancePage(initial=false) {
  if (state.paging.loading || state.paging.reachedEnd) return;
  state.paging.loading = true;

  try {
    const baseQ = collectionGroup(db, 'finanzas');
    // Traemos en orden por __name__ (sin índice complejo) y paginamos por lotes de contenedores
    let qFs = query(baseQ, limit(50));
    if (!initial && state.paging.lastDoc) {
      qFs = query(baseQ, startAfter(state.paging.lastDoc), limit(50));
    }
    const snap = await getDocs(qFs);
    if (!snap.size) {
      state.paging.reachedEnd = true;
      renderTable();
      return;
    }

    // Para cada doc de finanzas (excepto summary) buscamos subcolecciones y arrays
    for (const d of snap.docs) {
      state.paging.lastDoc = d; // cursor
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

      // omitir summary explícitamente
      if (fid.toLowerCase() === 'summary') {
        // (si necesitas, podrías leer flags de cierre aquí)
        continue;
      }

      const fin = d.data() || {};

      // 1) Arrays dentro del doc
      const arraysInDoc = []
        .concat(Array.isArray(fin.items) ? fin.items : [])
        .concat(Array.isArray(fin.movs) ? fin.movs : [])
        .concat(Array.isArray(fin.movimientos) ? fin.movimientos : []);

      arraysInDoc.forEach((x, i) => {
        if (x && typeof x === 'object') state.rawItems.push(toItem(grupoId, gDoc, { ...x, id: `${fid}#${i}` }));
      });

      // 2) Subcolecciones: movs / movimientos
      for (const sub of ['movs', 'movimientos']) {
        try {
          const sc = collection(db, 'grupos', grupoId, 'finanzas', fid, sub);
          const ds = await getDocs(sc);
          ds.forEach(s => {
            const x = s.data() || {};
            state.rawItems.push(toItem(grupoId, gDoc, { id:s.id, ...x }));
          });
        } catch (_) { /* ignore */ }
      }
    }

    renderTable();
  } catch (e) {
    console.error('fetchFinancePage()', e);
    renderTable(); // al menos refresca vacía con resumen
  } finally {
    state.paging.loading = false;
  }
}

// ——— Filtros y render ———
function applyFilters(items) {
  const f = state.filtros;
  const byEstado = f.estado;
  const byTipo   = f.tipo;
  const byCoord  = norm(f.coord);
  const byGrupo  = norm(f.grupo);

  return items.filter(x => {
    if (byTipo && x.tipo !== byTipo) return false;

    const e = x.estado;
    if (byEstado === 'pagables') {
      const pagable = (e === 'aprobado') && (x.pago !== 'pagado');
      if (!pagable) return false;
    } else if (byEstado && e !== byEstado) {
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

      tr.appendChild(tdTipo);
      tr.appendChild(tdGrupo);
      tr.appendChild(tdCoord);
      tr.appendChild(tdMonto);
      tr.appendChild(tdR1);
      tr.appendChild(tdR2);
      tr.appendChild(tdEstado);
      tr.appendChild(tdPago);

      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  resumen.textContent = `Mostrando ${filtered.length} / cargados ${state.rawItems.length}`;
  pagInfo.textContent = state.paging.reachedEnd
    ? 'Sin más páginas.'
    : (state.paging.loading ? 'Cargando…' : 'Listo.');
}

// ——— UI ———
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

  // Tipo, coord, grupo
  document.getElementById('filtroTipo').onchange = (e) => { state.filtros.tipo = e.target.value || ''; renderTable(); };
  document.getElementById('filtroCoord').oninput = (e) => { state.filtros.coord = e.target.value || ''; };
  document.getElementById('filtroGrupo').oninput = (e) => { state.filtros.grupo = e.target.value || ''; };

  document.getElementById('btnAplicar').onclick = () => renderTable();

  document.getElementById('btnRecargar').onclick = async () => {
    state.paging = { pageSize: 50, lastDoc: null, loading: false, reachedEnd: false };
    state.rawItems = [];
    await fetchFinancePage(true);
  };

  document.getElementById('btnMas').onclick = async () => {
    await fetchFinancePage(false);
  };
}

// ——— Consola de diagnóstico ———
window.__finz = {
  async probeSub(kind) {
    try {
      if (kind === 'finanzas') {
        const snap = await getDocs(query(collectionGroup(db, 'finanzas'), limit(1)));
        return { ok: snap.size > 0, size: snap.size };
      }
      if (kind === 'movs' || kind === 'movimientos') {
        // muestreo: toma 3 contenedores y verifica subcolección
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
      sample: state.rawItems.slice(0, 5)
    };
  }
};

// ——— Arranque ———
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location = 'login.html';
    return;
  }
  try {
    document.querySelector('#btn-logout')?.addEventListener('click', () =>
      signOut(auth).then(() => location = 'login.html')
    );
  } catch (_) {}

  wireUI();
  await preloadCatalogs();
  await fetchFinancePage(true);
});
