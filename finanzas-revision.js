/* =========================================================
   Revisión financiera (colección real: grupos/{gid}/finanzas)
   ---------------------------------------------------------
   - Detecta y usa collectionGroup('finanzas')
   - Busca movimientos en subcolecciones: 'movs' | 'movimientos'
   - Fallback: items planos en el doc 'finanzas' (si existiera)
   - Dos revisiones, estado y flag pagable.
   - Filtros básicos + paginación.
========================================================= */

import { app, db } from './firebase-init.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  collection, collectionGroup, doc, getDoc, getDocs, updateDoc,
  query, where, orderBy, limit, startAfter, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

/* ---------------------- Hooks DOM (ajusta IDs si difieren) ---------------------- */
const $selTipo   = document.getElementById('sel-tipo')        // <select> {all,gasto,abono}
                  || document.querySelector('select[data-role="tipo"]');
const $iCoord    = document.getElementById('coord-input')     // <input> coordinador@...
                  || document.querySelector('input[data-role="coord"]');
const $iGrupo    = document.getElementById('grupo-input')     // <input> id o nombre de grupo
                  || document.querySelector('input[data-role="grupo"]');
const $selEstado = document.getElementById('sel-estado')      // <select> {all,pendiente,aprobado,rechazado,pagables}
                  || document.querySelector('select[data-role="estado"]');

const $btnAplicar= document.getElementById('btn-aplicar')     // Botón aplicar filtros
                  || document.querySelector('[data-role="aplicar"]');
const $btnMas    = document.getElementById('btn-mas')         // Cargar más
                  || document.querySelector('[data-role="mas"]');

const $tbody     = document.querySelector('#tabla-movs tbody')// cuerpo de la tabla
                  || document.querySelector('table tbody');

const $metaInfo  = document.getElementById('meta-info')       // cajita “Mostrando N…”
                  || document.querySelector('[data-role="meta"]');

/* ---------------------- Estado de la página ---------------------- */
const auth = getAuth(app);
const PAGE  = 60;                     // tamaño de página
let lastCursor = null;                // para paginación de finanzas (collectionGroup)
let CACHE_GROUPS = new Map();         // gid -> meta grupo (numeroNegocio, nombre, destino, coordinadores[])
let LIST = [];                        // movimientos a mostrar

/* ---------------------- Utilidades pequeñas ---------------------- */
const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().trim();

function money(n){ const x = Number(n||0); return x.toLocaleString('es-CL'); }
function dt(d){ try{ return (d?.toDate?.() || (d?.seconds? new Date(d.seconds*1000) : new Date(d))).toLocaleDateString('es-CL'); }catch{ return ''; } }

/* -------------------------------------------------------------
   1) Carga índice de grupos (on-demand por cada finanzas doc)
   ------------------------------------------------------------- */
async function getGrupoMeta(gid){
  if (CACHE_GROUPS.has(gid)) return CACHE_GROUPS.get(gid);
  try{
    const s = await getDoc(doc(db,'grupos', gid));
    if (!s.exists()) { CACHE_GROUPS.set(gid, null); return null; }
    const g = s.data()||{};
    // coordinadores: reúne posibles fuentes
    const coords = new Set();
    const push = e => { if (e) coords.add(String(e).toLowerCase()); };
    push(g?.coordinadorEmail);
    if (g?.coordinador?.email) push(g.coordinador.email);
    (Array.isArray(g?.coordinadoresEmails)?g.coordinadoresEmails:[]).forEach(push);
    if (g?.coordinadoresEmailsObj) Object.keys(g.coordinadoresEmailsObj).forEach(push);
    (Array.isArray(g?.coordinadores)?g.coordinadores:[]).forEach(x=>{
      if (x?.email) push(x.email); else if (typeof x==='string' && x.includes('@')) push(x);
    });

    const meta = {
      id: s.id,
      numeroNegocio: String(g.numeroNegocio || g.numNegocio || g.idNegocio || s.id || ''),
      nombreGrupo: (g.nombreGrupo || g.aliasGrupo || '').toString(),
      destino: (g.destino || '').toString(),
      coordinadores: [...coords]
    };
    CACHE_GROUPS.set(gid, meta);
    return meta;
  }catch(e){ console.warn('getGrupoMeta', gid, e); CACHE_GROUPS.set(gid, null); return null; }
}

/* -------------------------------------------------------------
   2) Leer movimientos desde un doc "finanzas" concreto
      Ruta base: grupos/{gid}/finanzas
      - subcolección principal: movs
      - backward-compat: movimientos
      - fallback "plano": campos/array en el propio doc (si existiera)
   ------------------------------------------------------------- */
async function loadMovsFromFinanzasDoc(finRef){
  const gid = finRef.parent.parent.id;

  // 2.a) subcolección MOVS (preferida)
  const out = [];

  async function pull(pathName){
    try{
      const coll = collection(finRef, pathName);
      const snap = await getDocs(coll);
      snap.forEach(d=>{
        const x = d.data()||{};
        out.push({
          _id: d.id,
          gid,
          finPath: `${finRef.path}/${pathName}/${d.id}`,
          tipo: (x.tipo || x.kind || '').toString().toUpperCase(), // GASTO|ABONO
          coordinador: (x.coordinador || x.coordinadorEmail || '').toString().toLowerCase(),
          concepto: (x.concepto || x.detalle || x.descripcion || '').toString(),
          monto: Number(x.monto || x.importe || x.valor || 0),
          fecha: x.fecha || x.createdAt || x.ts || null,
          rev1: x.rev1 || { ok:false, by:'', at:null },
          rev2: x.rev2 || { ok:false, by:'', at:null },
          estado: (x.estado || '').toString().toUpperCase(), // PENDIENTE|APROBADO|RECHAZADO
          pagable: !!x.pagable
        });
      });
    }catch(_){ /* si no existe, seguimos */ }
  }

  await pull('movs');         // principal
  if (!out.length) await pull('movimientos'); // legacy

  // 2.b) fallback “plano en doc finanzas” (poco común, pero por si acaso)
  if (!out.length){
    try{
      const snap = await getDoc(finRef);
      if (snap.exists()){
        const x = snap.data()||{};
        const arr = Array.isArray(x.items) ? x.items :
                    Array.isArray(x.movs)  ? x.movs  :
                    Array.isArray(x.movimientos) ? x.movimientos : [];
        arr.forEach((m, i)=>{
          out.push({
            _id: `flat_${i}`,
            gid,
            finPath: `${finRef.path}#flat#${i}`,
            tipo: (m.tipo || '').toString().toUpperCase(),
            coordinador: (m.coordinador || '').toString().toLowerCase(),
            concepto: (m.concepto || m.descripcion || '').toString(),
            monto: Number(m.monto || 0),
            fecha: m.fecha || null,
            rev1: m.rev1 || { ok:false, by:'', at:null },
            rev2: m.rev2 || { ok:false, by:'', at:null },
            estado: (m.estado || '').toString().toUpperCase(),
            pagable: !!m.pagable
          });
        });
      }
    }catch(_){}
  }

  return out;
}

/* -------------------------------------------------------------
   3) Primera página desde collectionGroup('finanzas')
   ------------------------------------------------------------- */
async function fetchFirstPage(){
  LIST = [];
  lastCursor = null;

  // verifica que EXISTEN docs finanzas
  const probe = await getDocs(query(collectionGroup(db,'finanzas'), limit(1)));
  if (probe.empty) throw new Error('No se encontró colección de finanzas con datos.');

  await fetchMore(); // carga la primera tanda
}

async function fetchMore(){
  // Traemos páginas de *docs finanzas*; por cada doc, pedimos sus movimientos.
  let qBase = query(collectionGroup(db,'finanzas'), orderBy('__name__'), limit(20));
  if (lastCursor) qBase = query(collectionGroup(db,'finanzas'), orderBy('__name__'), startAfter(lastCursor), limit(20));

  const snap = await getDocs(qBase);
  if (snap.empty) return;

  const jobs = [];
  snap.forEach(finDoc => {
    jobs.push(loadMovsFromFinanzasDoc(finDoc.ref));
  });

  // Movimientos por doc finanzas
  const chunks = await Promise.all(jobs);
  const flat = chunks.flat();

  // Adjunta meta grupo (ligado por gid)
  const metaJobs = new Map();
  for (const m of flat){
    if (!metaJobs.has(m.gid)) metaJobs.set(m.gid, getGrupoMeta(m.gid));
  }
  const metas = await Promise.all([...metaJobs.values()]);
  // metas ya se cachean dentro de getGrupoMeta

  // Enriquecer cada mov con meta de grupo
  flat.forEach(m => {
    const meta = CACHE_GROUPS.get(m.gid) || {};
    m.numeroNegocio = meta.numeroNegocio || '';
    m.nombreGrupo   = meta.nombreGrupo   || '';
    m.destino       = meta.destino       || '';
    m.coordinadores = meta.coordinadores || [];
  });

  LIST.push(...flat);

  // cursor para siguiente página
  lastCursor = snap.docs[snap.docs.length-1];
  renderTable(); // re-pinta
}

/* -------------------------------------------------------------
   4) Filtros + Render
   ------------------------------------------------------------- */
function passFilters(m){
  // tipo
  const t = ($selTipo?.value || 'all').toLowerCase();
  if (t !== 'all'){
    if (t === 'gasto'  && m.tipo !== 'GASTO') return false;
    if (t === 'abono'  && m.tipo !== 'ABONO') return false;
  }
  // coordinador (texto libre: filtra por inclusión en lista de correos del grupo o campo m.coordinador)
  const qCoord = norm($iCoord?.value || '');
  if (qCoord){
    const pool = [m.coordinador, ...(m.coordinadores||[])].map(norm).join(' ');
    if (!pool.includes(qCoord)) return false;
  }
  // grupo: busca en id, número y nombre
  const qG = norm($iGrupo?.value || '');
  if (qG){
    const pool = norm([m.gid, m.numeroNegocio, m.nombreGrupo].join(' '));
    if (!pool.includes(qG)) return false;
  }
  // estado
  const e = ($selEstado?.value || 'all').toLowerCase();
  if (e !== 'all'){
    if (e === 'pagables'){
      const ok = (m.rev1?.ok === true && m.rev2?.ok === true && m.estado === 'APROBADO');
      if (!ok) return false;
    } else if (e === 'pendiente' || e === 'aprobado' || e === 'rechazado'){
      if ((m.estado || '').toLowerCase() !== e) return false;
    }
  }
  return true;
}

function renderTable(){
  if (!$tbody) return;
  $tbody.innerHTML = '';

  const rows = LIST.filter(passFilters);
  rows.sort((a,b)=>{
    // Primero por estado (pendientes arriba), luego por fecha desc, luego por monto desc
    const rank = s => (s==='PENDIENTE'?0 : s==='RECHAZADO'?2 : 1);
    const r = rank(a.estado) - rank(b.estado);
    if (r !== 0) return r;
    const ta = (a.fecha?.seconds ? a.fecha.seconds : (a.fecha ? +new Date(a.fecha) : 0));
    const tb = (b.fecha?.seconds ? b.fecha.seconds : (b.fecha ? +new Date(b.fecha) : 0));
    if (tb !== ta) return tb - ta;
    return (b.monto||0) - (a.monto||0);
  });

  for (const m of rows){
    const tr = document.createElement('tr');

    const pagable = (m.rev1?.ok && m.rev2?.ok && m.estado === 'APROBADO');

    tr.innerHTML = `
      <td>${m.tipo || ''}</td>
      <td>${m.numeroNegocio || ''}</td>
      <td>${m.nombreGrupo || ''}</td>
      <td>${m.destino || ''}</td>
      <td>${m.concepto || ''}</td>
      <td class="num">$ ${money(m.monto)}</td>
      <td>${dt(m.fecha) || ''}</td>
      <td>${m.coordinador || ''}</td>

      <td>
        <label class="rev">
          <input type="checkbox" data-rev="1" ${m.rev1?.ok?'checked':''}>
          <span>${m.rev1?.by ? m.rev1.by : 'Rev. 1'}</span>
        </label>
      </td>
      <td>
        <label class="rev">
          <input type="checkbox" data-rev="2" ${m.rev2?.ok?'checked':''}>
          <span>${m.rev2?.by ? m.rev2.by : 'Rev. 2'}</span>
        </label>
      </td>

      <td>
        <select data-estado>
          <option value="PENDIENTE" ${m.estado==='PENDIENTE'?'selected':''}>PENDIENTE</option>
          <option value="APROBADO"  ${m.estado==='APROBADO'?'selected':''}>APROBADO</option>
          <option value="RECHAZADO" ${m.estado==='RECHAZADO'?'selected':''}>RECHAZADO</option>
        </select>
      </td>

      <td class="${pagable?'ok':''}">${pagable ? 'PAGABLE' : ''}</td>
    `;

    // Handlers de las 3 cosas editables
    tr.querySelector('input[data-rev="1"]').addEventListener('change', () => saveRev(m, 1, tr));
    tr.querySelector('input[data-rev="2"]').addEventListener('change', () => saveRev(m, 2, tr));
    tr.querySelector('select[data-estado"]').addEventListener('change', (ev) => saveEstado(m, ev.target.value, tr));

    $tbody.appendChild(tr);
  }

  if ($metaInfo){
    $metaInfo.textContent = `Mostrando ${rows.length} movimientos (de ${LIST.length} cargados).`;
  }
}

/* -------------------------------------------------------------
   5) Guardados (rev1, rev2, estado)
   ------------------------------------------------------------- */
async function saveRev(m, which, tr){
  try{
    const chk = tr.querySelector(`input[data-rev="${which}"]`);
    const ok  = !!chk.checked;
    const payload = {};
    payload[`rev${which}`] = { ok, by: auth.currentUser?.email || '', at: serverTimestamp() };

    await updateDoc(docFromFinPath(m.finPath), payload);

    // espejo en memoria
    m[`rev${which}`] = { ok, by: auth.currentUser?.email || '', at: new Date() };

    // recalcula Pagable inmediato
    const pagable = (m.rev1?.ok && m.rev2?.ok && m.estado === 'APROBADO');
    tr.querySelector('td:last-child').textContent = pagable ? 'PAGABLE' : '';
    tr.querySelector('td:last-child').className   = pagable ? 'ok' : '';
  }catch(e){
    console.error('saveRev', e);
    alert('No se pudo actualizar la revisión.');
    // revertir UI
    tr.querySelector(`input[data-rev="${which}"]`).checked = !tr.querySelector(`input[data-rev="${which}"]`).checked;
  }
}

async function saveEstado(m, nuevo, tr){
  try{
    await updateDoc(docFromFinPath(m.finPath), { estado:nuevo });
    m.estado = nuevo;
    const pagable = (m.rev1?.ok && m.rev2?.ok && m.estado === 'APROBADO');
    tr.querySelector('td:last-child').textContent = pagable ? 'PAGABLE' : '';
    tr.querySelector('td:last-child').className   = pagable ? 'ok' : '';
  }catch(e){
    console.error('saveEstado', e);
    alert('No se pudo actualizar el estado.');
    // UI ya cambió; recarga fila
    renderTable();
  }
}

/* -------------------------------------------------------------
   6) Helpers de path → DocumentReference
   ------------------------------------------------------------- */
function docFromFinPath(path){
  // ejemplos:
  //   grupos/{gid}/finanzas/movs/{mid}
  //   grupos/{gid}/finanzas/movimientos/{mid}
  //   grupos/{gid}/finanzas#flat#i   (no editable)
  const p = String(path||'');
  if (p.includes('#flat#')) throw new Error('Este movimiento es “plano” y no editable.');
  // reconstruye ref a partir de la ruta
  const seg = p.split('/').filter(Boolean);
  // seg: ['grupos', gid, 'finanzas', 'movs', mid]
  return doc(db, ...seg);
}

/* -------------------------------------------------------------
   7) Arranque + UI
   ------------------------------------------------------------- */
function wireUI(){
  $btnAplicar && $btnAplicar.addEventListener('click', () => renderTable());
  [$selTipo, $iCoord, $iGrupo, $selEstado].forEach(n=>{
    n && n.addEventListener('change', () => renderTable());
    n && n.addEventListener('input',  () => renderTable());
  });
  $btnMas && $btnMas.addEventListener('click', async () => {
    await fetchMore();
  });
}

onAuthStateChanged(auth, async (user) => {
  if (!user){ location.href = 'login.html'; return; }
  try{
    wireUI();
    await fetchFirstPage();   // ← clave: usa collectionGroup('finanzas')
  }catch(e){
    console.error('Error cargando revisión financiera:', e);
    alert('Error: ' + (e?.message || e));
  }
});

/* -------------------------------------------------------------
   8) Debug helpers (consola)
   ------------------------------------------------------------- */
window.__finz = {
  list: () => LIST,
  groupsCache: () => CACHE_GROUPS,
  probeRoot: async (name) => {
    const s = await getDocs(query(collection(db, name), limit(1)));
    return { name, ok: !s.empty };
  },
  probeSub: async (name) => {
    const s = await getDocs(query(collectionGroup(db, name), limit(1)));
    return { name, ok: !s.empty };
  }
};
