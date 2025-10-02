/* Revisión financiera – escaneo extendido */
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, collectionGroup, doc, getDoc, getDocs, query,
  where, orderBy, limit, startAfter
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

const state = {
  paging: { lastDoc: null, loading: false, reachedEnd: false },
  rawItems: [],
  filtros: { estado:'', tipo:'', coord:'', grupo:'' },
  caches: { grupos: new Map(), coords: [] },
};

const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const money = n => (isFinite(+n) ? (+n).toLocaleString('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}) : '—');
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';

// ---- RUTAS POSIBLES ----
const DIRECT_SUBS = ['gastos','abonos','movs','movimientos'];          // grupos/{gid}/...
const FIN_SUBS    = ['gastos','abonos','movs','movimientos'];          // grupos/{gid}/finanzas/{doc}/...
const ROOT_CANDS  = ['gastos','abonos','movs','movimientos'];          // colecciones raíz

// 👇 NUEVO: subcolecciones reales que mostró tu consola
const ALT_FIN_SUBS = ['finanzas_abonos','finanzas_gastos','finanzas_movs','finanzas_movimientos'];

// Movs bajo coordinadores/{coord}/gastos
const COORD_SUBS = ['gastos']; // si más adelante guardas 'abonos' aquí, agrégalo

// campo de grupo que puede venir en el doc de coordinadores/gastos
function pickGrupoIdFromMov(x) {
  return coalesce(
    x.grupoId, x.grupo_id, x.gid, x.idGrupo, x.grupo, x.id_grupo, ''
  );
}

function inferTipoFromPath(pathLike=''){
  const s = String(pathLike).toLowerCase();
  if (s.includes('abono')) return 'abono';
  if (s.includes('gasto')) return 'gasto';
  return '';
}

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
    __from: x.__from || ''
  };
}

// ---------- catálogos mínimos ----------
async function preloadCatalogs() {
  try {
    const snap = await getDocs(collection(db, 'grupos'));
    snap.forEach(d => state.caches.grupos.set(d.id, d.data() || {}));
    const dlG = document.getElementById('dl-grupos');
    if (dlG) {
      dlG.innerHTML = '';
      state.caches.grupos.forEach((x, id) => {
        const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, id);
        const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, id);
        const opt = document.createElement('option');
        opt.value = id;
        opt.label = `${numero} — ${nombre}`;
        dlG.appendChild(opt);
      });
    }
    const dlC = document.getElementById('dl-coords');
    if (dlC) {
      dlC.innerHTML = '';
      const cs = await getDocs(collection(db, 'coordinadores'));
      const seen = new Set();
      cs.forEach(d => {
        const x = d.data() || {};
        const email = (coalesce(x.email, x.correo, x.mail, '')).toLowerCase();
        if (!email || seen.has(email)) return;
        seen.add(email);
        const nombre = coalesce(x.nombre, x.Nombre, x.coordinador, '');
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

// ---------- colecta por grupo ----------
async function collectFromGroup(grupoId) {
  const gDoc = state.caches.grupos.get(grupoId) || {};
  const before = state.rawItems.length;

  // 1) Directo: grupos/{gid}/(gastos|abonos|movs|movimientos)
  for (const sub of DIRECT_SUBS) {
    try {
      const ds = await getDocs(collection(db, 'grupos', grupoId, sub));
      ds.forEach(d => {
        const x = d.data() || {};
        state.rawItems.push(
          toItem(grupoId, gDoc, { id:d.id, ...x, __from:`groupSub:${sub}` }, sub)
        );
      });
    } catch(_) {}
  }

  // 1.b) 👈 NUEVO: grupos/{gid}/(finanzas_abonos|finanzas_gastos|...)
  for (const sub of ALT_FIN_SUBS) {
    try {
      const ds = await getDocs(collection(db, 'grupos', grupoId, sub));
      ds.forEach(d => {
        const x = d.data() || {};
        state.rawItems.push(
          toItem(
            grupoId,
            gDoc,
            { id:d.id, ...x, __from:`groupSub:${sub}` },
            inferTipoFromPath(sub) // fuerza tipo según nombre de subcolección
          )
        );
      });
    } catch(_) {}
  }

  // 2) Estructura finanzas: grupos/{gid}/finanzas/{doc}/(sub)
  try {
    const fs = await getDocs(collection(db, 'grupos', grupoId, 'finanzas'));
    for (const f of fs.docs) {
      if (f.id.toLowerCase() === 'summary') continue;
      const fin = f.data() || {};

      // arrays dentro del doc: items/movs/movimientos/gastos/abonos
      for (const key of ['items','movs','movimientos','gastos','abonos']) {
        const arr = fin?.[key];
        if (Array.isArray(arr)) {
          arr.forEach((x, i) => {
            if (!x || typeof x !== 'object') return;
            state.rawItems.push(
              toItem(grupoId, gDoc, { ...x, id:`${f.id}#${key}[${i}]`, __from:`docArray:${key}` }, key)
            );
          });
        }
      }

      // subcolecciones bajo finanzas/{doc}
      for (const sub of FIN_SUBS) {
        try {
          const ds = await getDocs(collection(db, 'grupos', grupoId, 'finanzas', f.id, sub));
          ds.forEach(d => {
            const x = d.data() || {};
            state.rawItems.push(
              toItem(grupoId, gDoc, { id:d.id, ...x, __from:`finSub:${sub}` }, sub)
            );
          });
        } catch(_) {}
      }
    }
  } catch(_) {}

  // 3) Colecciones raíz (si las hubiera) filtradas por grupoId
  for (const root of ROOT_CANDS) {
    try {
      const qs = await getDocs(query(collection(db, root), where('grupoId','==', grupoId), limit(200)));
      qs.forEach(d => {
        const x = d.data() || {};
        state.rawItems.push(
          toItem(grupoId, gDoc, { id:d.id, ...x, __from:`root:${root}` }, root)
        );
      });
    } catch(_) {}
  }

  return state.rawItems.length - before;
}

// ---------- colecta por coordinador ----------
async function collectFromCoordinadores() {
  const before = state.rawItems.length;

  // Si hay filtro por coordinador, úsalo para reducir lecturas
  const filterCoord = norm(state.filtros.coord || '');

  try {
    const cs = await getDocs(collection(db, 'coordinadores'));
    for (const c of cs.docs) {
      const coordId = (c.id || '').toString();         // suele ser el nombre
      const coordNorm = norm(coordId);

      if (filterCoord && !coordNorm.includes(filterCoord)) {
        // si filtraste por coord y este no coincide, sáltalo
        continue;
      }

      for (const sub of COORD_SUBS) {
        try {
          const path = collection(db, 'coordinadores', coordId, sub);
          const ds = await getDocs(path);
          ds.forEach(d => {
            const x = d.data() || {};

            // grupoId viene dentro del doc de gasto de coord
            const grupoId = pickGrupoIdFromMov(x);
            if (!grupoId) return; // sin grupo no podemos cruzar

            const gDoc = state.caches.grupos.get(grupoId) || {};
            // enriquecemos el item con la info de coordinador tomada del path
            const enriched = { id: d.id, ...x, coordinador: coordId, __from: `coord:${sub}` };

            state.rawItems.push(
              toItem(grupoId, gDoc, enriched, inferTipoFromPath(sub) || 'gasto')
            );
          });
        } catch (e) {
          console.warn('[FINZ] COORD_SUBS', coordId, sub, e);
        }
      }
    }
  } catch (e) {
    console.warn('[FINZ] coordinadores (root)', e);
  }

  return state.rawItems.length - before;
}

// ---------- carga principal ----------
async function fetchFinance(initial=false) {
  if (state.paging.loading) return;
  state.paging.loading = true;
  try {
    // Si el usuario escribió un grupo específico, priorízalo
    const qg = (state.filtros.grupo || '').trim();
    const onlyThisGroupId = state.caches.grupos.has(qg) ? qg : null;

    if (onlyThisGroupId) {
      await collectFromGroup(onlyThisGroupId);
    } else {
      // Recorre TODOS los grupos (con límite prudente)
      const gs = await getDocs(query(collection(db,'grupos'), limit(300)));
      for (const d of gs.docs) {
        await collectFromGroup(d.id);
      }
    }

    // Extra: si aún no hay nada, prueba una pasada rápida por collectionGroup('finanzas') y sus subcols
    if (!state.rawItems.length) {
      try {
        const snap = await getDocs(query(collectionGroup(db,'finanzas'), limit(30)));
        for (const f of snap.docs) {
          if (f.id.toLowerCase() === 'summary') continue;
          const gid = f.ref.parent.parent.id;
          // subcolecciones típicas
          for (const sub of FIN_SUBS) {
            const ds = await getDocs(collection(db,'grupos',gid,'finanzas',f.id,sub));
            ds.forEach(d => state.rawItems.push(
              toItem(gid, state.caches.grupos.get(gid)||{}, { id:d.id, ...(d.data()||{}), __from:`CGfin:${sub}` }, sub)
            ));
          }
        }
      } catch(_) {}
    }
    
    // …tras colectar por grupos y/o fallback collectionGroup…
    await collectFromCoordinadores();
    
    renderTable();
  } finally {
    state.paging.loading = false;
    console.log('%c[FINZ] total items:', 'color:#0a0', state.rawItems.length);
  }
}

// ---------- filtros + render ----------
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

function dedupeItems(items) {
  const seen = new Map();
  for (const i of items) {
    // clave razonable: grupo + id (si hay) + tipo + monto
    const key = [i.grupoId || '', i.id || '', i.tipo || '', i.monto ?? ''].join('|');
    if (!seen.has(key)) seen.set(key, i);
  }
  return [...seen.values()];
}

function renderTable() {
  const tbody = document.querySelector('#tblFinanzas tbody');
  const resumen = document.getElementById('resumen');
  const pagInfo = document.getElementById('pagInfo');

  const base = dedupeItems(state.rawItems);
  const filtered = applyFilters(base);

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
      const coordTxt = (x.coordinador && x.coordinador.trim())
        ? x.coordinador.toLowerCase()
        : '—';
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

  resumen.textContent = `Mostrando ${filtered.length} / cargados ${state.rawItems.length}`;
  pagInfo.textContent = state.paging.loading ? 'Cargando…' : 'Listo.';
}

// ---------- UI ----------
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

  document.getElementById('filtroTipo').onchange = (e) => { state.filtros.tipo = e.target.value || ''; renderTable(); };
  document.getElementById('filtroCoord').oninput = (e) => { state.filtros.coord = e.target.value || ''; };
  document.getElementById('filtroGrupo').oninput = (e) => { state.filtros.grupo = e.target.value || ''; };

  document.getElementById('btnAplicar').onclick = () => renderTable();

  document.getElementById('btnRecargar').onclick = async () => {
    state.rawItems = [];
    await fetchFinance();
  };

  document.getElementById('btnMas').onclick = async () => {
    // en esta versión la carga es “todo de una”, así que solo re-render
    renderTable();
  };
}

// ---------- helpers debug en consola ----------
window.__finz = {
  async scan() {
    const out = [];
    const gs = await getDocs(collection(db,'grupos'));
    for (const d of gs.docs) {
      const gid = d.id;
      // directos
      for (const sub of DIRECT_SUBS) {
        const ds = await getDocs(query(collection(db,'grupos',gid,sub), limit(1)));
        if (ds.size) out.push({ where:`grupos/${gid}/${sub}`, count:ds.size });
      }
      // finanzas
      const fs = await getDocs(collection(db,'grupos',gid,'finanzas'));
      for (const f of fs.docs) {
        if (f.id.toLowerCase()==='summary') continue;
        for (const sub of FIN_SUBS) {
          const ds = await getDocs(query(collection(db,'grupos',gid,'finanzas',f.id,sub), limit(1)));
          if (ds.size) out.push({ where:`grupos/${gid}/finanzas/${f.id}/${sub}`, count:ds.size });
        }
      }
    }
    // raíz
    for (const root of ROOT_CANDS) {
      try {
        const ds = await getDocs(query(collection(db,root), limit(1)));
        if (ds.size) out.push({ where:`/${root} (root)`, note:'existe' });
      } catch(_) {}
    }
    console.table(out);
    return out;
  },
  list() { return { loaded: state.rawItems.length, sample: state.rawItems.slice(0, 10) }; }
};

// ---------- arranque ----------
onAuthStateChanged(auth, async (user) => {
  if (!user) { location = 'login.html'; return; }
  try {
    document.querySelector('#btn-logout')?.addEventListener('click', () =>
      signOut(auth).then(() => location = 'login.html')
    );
  } catch (_) {}

  wireUI();
  await preloadCatalogs();
  await fetchFinance();

  if (!state.rawItems.length) {
    console.warn('[FINZ] No salió nada. Ejecuta en consola:', '__finz.scan()');
  }
});
