/* Revisión financiera — sin collectionGroup, carga bajo demanda */
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, query, where, doc, updateDoc, getDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

/* ================== STATE ================== */
const state = {
  userEmail: '',
  rawItems: [],
  filtros: { estado:'', tipo:'', coord:'', grupo:'' }, // tipo: 'gastos' | 'pagos' | 'todos'
  caches: {
    groupById: new Map(),       // gid -> { numero, nombre, coordEmail }
    groupsByCoord: new Map(),   // coordEmail -> Set(gid)
    coords: []                  // datalist
  },
  paging: { loading:false }
};

/* ================== UTILS ================== */
const norm = (s='') => s.toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const coalesce = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '') ?? '';
function parseMonto(any) {
  if (any == null) return 0;
  if (typeof any === 'number' && isFinite(any)) return any;
  const m = String(any).replace(/[^\d.-]/g,'');
  const n = parseFloat(m);
  return isFinite(n) ? n : 0;
}
const money = (n, cur='CLP') =>
  isFinite(+n) ? (+n).toLocaleString('es-CL', { style:'currency', currency:cur, maximumFractionDigits:(cur==='CLP'?0:2) }) : '—';

function deriveEstado(x){
  const s = (x.estado||'').toLowerCase();
  if (s) return s;
  const r1 = (x.rev1||'').toLowerCase();
  const r2 = (x.rev2||'').toLowerCase();
  if (r1 === 'rechazado' || r2 === 'rechazado') return 'rechazado';
  if (r1 === 'aprobado'  && r2 === 'aprobado')  return 'aprobado';
  return 'pendiente';
}

/* ================== NORMALIZADOR ================== */
function toItem(grupoId, gInfo, x, hintedTipo){
  const bruto = coalesce(x.monto, x.montoCLP, x.neto, x.importe, x.valor, x.total, x.totalCLP, x.monto_str, 0);
  const monto = parseMonto(bruto);
  const moneda = (x.moneda || x.currency || (x.montoCLP!=null?'CLP':'CLP')).toString().toUpperCase();

  // tipo normalizado
  let tipo = (x.tipo || x.type || hintedTipo || '').toString().toLowerCase();
  if (tipo === 'abono') tipo = 'pago';      // renombramos a PAGO
  if (tipo !== 'gasto' && tipo !== 'pago') tipo = (monto < 0 ? 'pago' : 'gasto');

  const rev1 = (x.revision1?.estado || x.rev1?.estado || x.rev1 || '').toString().toLowerCase();
  const rev2 = (x.revision2?.estado || x.rev2?.estado || x.rev2 || '').toString().toLowerCase();
  const revPago = (x.revPago?.estado || x.pago?.estado || x.rev_pago || '').toString().toLowerCase();

  const rev1By = coalesce(x.revision1?.user, x.rev1By, '');
  const rev2By = coalesce(x.revision2?.user, x.rev2By, '');
  const revPagoBy = coalesce(x.revPago?.user, x.pago?.user, '');

  const coordEmail = (gInfo?.coordEmail || x.coordinador || x.coordinadorEmail || '').toString().toLowerCase();
  const asunto = coalesce(x.asunto, x.detalle, x.descripcion, x.concepto, x.motivo, '');

  return {
    // básicos
    id: x.id || x._id || '',
    __from: x.__from || '',
    grupoId,
    numeroNegocio: gInfo?.numero || grupoId,
    nombreGrupo: gInfo?.nombre || '',
    coordinador: coordEmail,

    // columnas
    tipo, asunto, monto, moneda,
    rev1, rev2, revPago,
    rev1By, rev2By, revPagoBy,

    // estado derivado + cierre
    estado: deriveEstado({ estado:x.estado, rev1, rev2 }),
    cerrado: (revPago === 'pagado' || x.estado === 'cerrada') ? true : false,

    // helpers para escribir
    coordPath: coordEmail
  };
}

/* ================== CATALOGOS ================== */
async function preloadCatalogs(){
  state.caches.groupById.clear();
  state.caches.groupsByCoord.clear();
  state.caches.coords.length = 0;

  const snap = await getDocs(collection(db,'grupos'));
  snap.forEach(d=>{
    const x = d.data() || {};
    const gid = d.id;
    const numero = coalesce(x.numeroNegocio, x.numNegocio, x.idNegocio, gid);
    const nombre = coalesce(x.nombreGrupo, x.aliasGrupo, x.nombre, x.grupo, gid);
    const coordEmail = coalesce(
      x.coordinadorEmail, x.coordinador?.email, x.coordinador, x.coord, x.responsable, x.owner, ''
    ).toString().toLowerCase();

    state.caches.groupById.set(gid, { numero, nombre, coordEmail });
    if (coordEmail){
      if (!state.caches.groupsByCoord.has(coordEmail)) state.caches.groupsByCoord.set(coordEmail, new Set());
      state.caches.groupsByCoord.get(coordEmail).add(gid);
      if (!state.caches.coords.includes(coordEmail)) state.caches.coords.push(coordEmail);
    }
  });

  // datalists
  const dlG = document.getElementById('dl-grupos');
  const dlC = document.getElementById('dl-coords');
  if (dlG){
    dlG.innerHTML='';
    for (const [gid, info] of state.caches.groupById.entries()){
      const opt=document.createElement('option');
      opt.value = gid;
      opt.label = `${info.numero} — ${info.nombre}`;
      dlG.appendChild(opt);
    }
  }
  if (dlC){
    dlC.innerHTML='';
    for (const email of state.caches.coords){
      const opt=document.createElement('option');
      opt.value = email;
      opt.label = email;
      dlC.appendChild(opt);
    }
  }
}

/* ================== LECTURAS (SIN collectionGroup) ================== */
// GASTOS: leemos SIEMPRE desde el path del coordinador
async function loadGastos({ coordEmail, grupoId }){
  if (!coordEmail){
    // Si viene sólo grupo, buscamos su coordinador y usamos ese path
    if (grupoId){
      const g = state.caches.groupById.get(grupoId);
      coordEmail = g?.coordEmail || '';
      if (!coordEmail) return; // sin coord → no podemos leer gastos
    } else {
      return; // no hay criterio suficiente
    }
  }

  const base = collection(db,'coordinadores', coordEmail, 'gastos');
  const qy   = grupoId ? query(base, where('grupoId','==', grupoId)) : base;
  const snap = await getDocs(qy);
  snap.forEach(s=>{
    const x = { id:s.id, ...s.data(), __from:'coord:gastos' };
    const gInfo = state.caches.groupById.get(x.grupoId) || { numero:x.grupoId, nombre:'', coordEmail };
    state.rawItems.push(toItem(x.grupoId, gInfo, x, 'gasto'));
  });
}

// PAGOS: leemos desde subcolección del/los grupo(s)
async function loadPagos({ coordEmail, grupoId }){
  const grupos = new Set();

  if (grupoId) grupos.add(grupoId);
  else if (coordEmail){
    const set = state.caches.groupsByCoord.get(coordEmail);
    if (set) set.forEach(gid => grupos.add(gid));
  } else {
    return; // no hay criterio suficiente
  }

  const tasks = [];
  grupos.forEach(gid => {
    tasks.push((async ()=>{
      const base = collection(db,'grupos', gid, 'finanzas_abonos');
      const snap = await getDocs(base);
      const gInfo = state.caches.groupById.get(gid) || { numero:gid, nombre:'', coordEmail: '' };
      snap.forEach(s=>{
        const x = { id:s.id, ...s.data(), __from:'grupo:abonos' };
        state.rawItems.push(toItem(gid, gInfo, x, 'pago'));
      });
    })());
  });
  await Promise.all(tasks);
}

/* ================== FILTROS Y ORDEN ================== */
function applyFilters(arr){
  const f = state.filtros;
  const byEstado = f.estado;
  return arr.filter(x=>{
    // tipo visual
    if (f.tipo === 'gastos' && x.tipo !== 'gasto') return false;
    if (f.tipo === 'pagos'  && x.tipo !== 'pago')  return false;

    // estado
    if (byEstado === 'pagables') {
      const isPagable = (x.tipo === 'pago') ? (x.rev1 === 'aprobado' && x.rev2 === 'aprobado' && x.revPago !== 'pagado')
                                            : (x.estado === 'aprobado');
      if (!isPagable) return false;
    } else if (byEstado === 'cerrada') {
      if (!x.cerrado) return false;
    } else if (byEstado && byEstado !== x.estado) {
      return false;
    }

    // coord / grupo (ya vienen acotados por la carga, pero dejamos defensa)
    if (f.coord && !norm(x.coordinador).includes(norm(f.coord))) return false;
    if (f.grupo) {
      const blob = norm([x.grupoId, x.nombreGrupo, x.numeroNegocio].join(' '));
      if (!blob.includes(norm(f.grupo))) return false;
    }
    return true;
  });
}

const sortState = { key:'', dir:'asc' };
function getSortValue(item, key){
  switch (key){
    case 'tipo':    return item.tipo || '';
    case 'grupo':   return item.grupoId || '';
    case 'coord':   return item.coordinador || '';
    case 'asunto':  return item.asunto || '';
    case 'monto':   return Number(item.monto) || 0;
    case 'moneda':  return item.moneda || '';
    case 'rev1':    return item.rev1 || '';
    case 'rev2':    return item.rev2 || '';
    case 'revpago': return item.revPago || '';
    case 'estado':  return item.estado || '';
    default:        return '';
  }
}
function sortItems(list){
  if (!sortState.key) return list.slice();
  const dir = sortState.dir === 'asc' ? 1 : -1;
  return list.slice().sort((a,b)=>{
    const va = getSortValue(a, sortState.key);
    const vb = getSortValue(b, sortState.key);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb),'es',{numeric:true, sensitivity:'base'}) * dir;
  });
}
function applySortHeaderUI(){
  document.querySelectorAll('#tblFinanzas thead th.sortable')
    .forEach(th=>{
      th.classList.remove('asc','desc');
      if (th.dataset.sortKey === sortState.key) th.classList.add(sortState.dir);
    });
}

/* ================== WRITE: REVISIONES ================== */
function getRefFor(item){
  if (item.tipo === 'gasto') return doc(db,'coordinadores', item.coordPath, 'gastos', item.id);
  return doc(db,'grupos', item.grupoId, 'finanzas_abonos', item.id); // pago
}

function violatesCrossReview({ user, item, which }){
  const me = (user||'').toLowerCase();
  const r1 = (item.rev1By||'').toLowerCase();
  const r2 = (item.rev2By||'').toLowerCase();
  const rp = (item.revPagoBy||'').toLowerCase();
  if (which === 'rev1' && (me && me === r2)) return 'REV. 1 y REV. 2 deben ser distintos.';
  if (which === 'rev2' && (me && me === r1)) return 'REV. 1 y REV. 2 deben ser distintos.';
  if (which === 'revPago' && (me && (me === r1 || me === r2))) return 'REV. PAGO debe ser distinto a REV. 1 y REV. 2.';
  return '';
}

async function updateRevision(item, which /* 'rev1'|'rev2'|'revPago' */, nuevo /* 'pendiente'|'aprobado'|'rechazado'|'pagado' */){
  const user = state.userEmail;
  const msg = violatesCrossReview({ user, item, which });
  if (msg) { alert(msg); return false; }

  const ref = getRefFor(item);
  const fieldBase = (which === 'revPago') ? 'revPago' : (which === 'rev1' ? 'revision1' : 'revision2');

  try{
    await updateDoc(ref, {
      [`${fieldBase}.estado`]: nuevo,
      [`${fieldBase}.user`]: user,
      [`${fieldBase}.at`]: Date.now()
    });

    const snap = await getDoc(ref);
    const data = snap.data() || {};
    // reflejo
    item.rev1     = (data.revision1?.estado || item.rev1 || '');
    item.rev2     = (data.revision2?.estado || item.rev2 || '');
    item.revPago  = (data.revPago?.estado   || data.pago?.estado || item.revPago || '');
    item.rev1By   = (data.revision1?.user || item.rev1By || '');
    item.rev2By   = (data.revision2?.user || item.rev2By || '');
    item.revPagoBy= (data.revPago?.user   || data.pago?.user || item.revPagoBy || '');
    item.estado   = deriveEstado({ rev1:item.rev1, rev2:item.rev2 });
    item.cerrado  = (item.revPago === 'pagado');

    renderTable();
    return true;
  }catch(e){
    console.error('[REV] updateRevision', e);
    alert('No se pudo guardar la revisión.');
    return false;
  }
}

/* ================== RENDER ================== */
function nextEstado(cur){
  const c = (cur||'pendiente').toLowerCase();
  if (c === 'pendiente') return 'aprobado';
  if (c === 'aprobado')  return 'rechazado';
  return 'pendiente';
}
function renderTable(){
  const tbody   = document.querySelector('#tblFinanzas tbody');
  const resumen = document.getElementById('resumen');
  const totales = document.getElementById('totales');
  const pagInfo = document.getElementById('pagInfo');

  const filtered = applyFilters(state.rawItems);
  const data = sortItems(filtered);

  // totales
  const sum = data.reduce((acc,x)=>{
    if (x.tipo === 'gasto') acc.g += Number(x.monto)||0;
    else acc.p += Number(x.monto)||0;
    return acc;
  }, { g:0, p:0 });
  totales.textContent = `Gastos: ${money(sum.g)} · Abonos: ${money(sum.p)}${(sum.g && sum.p) ? (' · Saldo: '+money(sum.p - sum.g)) : ''}`;

  tbody.innerHTML='';
  if (!data.length){
    const tr=document.createElement('tr');
    const td=document.createElement('td');
    td.colSpan = 10;
    td.innerHTML = '<div class="muted">SIN MOVIMIENTOS PARA ESTE CRITERIO.</div>';
    tr.appendChild(td); tbody.appendChild(tr);
  } else {
    const frag = document.createDocumentFragment();

    data.forEach(item=>{
      const tr = document.createElement('tr');

      const tdTipo = document.createElement('td');
      tdTipo.textContent = item.tipo.toUpperCase();

      const tdGrupo = document.createElement('td');
      tdGrupo.innerHTML = `<div class="mono">${item.grupoId}</div><span class="small">${(item.numeroNegocio? item.numeroNegocio+' · ' : '')}${item.nombreGrupo||''}</span>`;

      const tdCoord = document.createElement('td');
      tdCoord.innerHTML = `<span>${(item.coordinador||'—').toUpperCase()}</span>`;

      const tdAsunto = document.createElement('td');
      tdAsunto.textContent = item.asunto ? String(item.asunto).toUpperCase() : '—';

      const tdMonto = document.createElement('td');
      tdMonto.innerHTML = `<span class="mono">${money(item.monto, item.moneda)}</span>`;

      const tdMoneda = document.createElement('td');
      tdMoneda.textContent = item.moneda || '—';

      function makeRevCell(which){
        const td = document.createElement('td');
        const wrap = document.createElement('div'); wrap.className = 'rev-cell';
        const btn = document.createElement('button'); btn.className = 'revbtn'; btn.type='button';
        const who = document.createElement('span');  who.className = 'small';

        const applyUI = ()=>{
          const cur = (which==='rev1' ? item.rev1 : which==='rev2' ? item.rev2 : item.revPago) || 'pendiente';
          if (cur === 'aprobado' || (which==='revPago' && cur==='pagado')) { btn.textContent='✓'; btn.dataset.state='aprobado'; }
          else if (cur === 'rechazado') { btn.textContent='✗'; btn.dataset.state='rechazado'; }
          else { btn.textContent='—'; btn.dataset.state='pendiente'; }
          const by = which==='rev1' ? item.rev1By : which==='rev2' ? item.rev2By : item.revPagoBy;
          who.textContent = by ? by.toUpperCase() : '';
        };

        btn.onclick = async ()=>{
          const cur = (which==='rev1' ? item.rev1 : which==='rev2' ? item.rev2 : item.revPago) || 'pendiente';
          const nuevo = (which==='revPago')
            ? (cur==='pagado' ? 'pendiente' : 'pagado')   // REV. PAGO: toggle pagado/pendiente
            : nextEstado(cur);
          await updateRevision(item, which, nuevo);
          applyUI();
          tdEstado.innerHTML = `<span class="badge ${item.cerrado?'cerrada':item.estado}">${(item.cerrado?'CERRADA':item.estado).toUpperCase()}</span>`;
        };

        wrap.append(btn, who); td.appendChild(wrap); applyUI();
        return td;
      }

      const tdR1 = makeRevCell('rev1');
      const tdR2 = makeRevCell('rev2');
      const tdRpago = (item.tipo === 'pago') ? makeRevCell('revPago') : document.createElement('td');

      const tdEstado = document.createElement('td');
      tdEstado.innerHTML = `<span class="badge ${item.cerrado?'cerrada':item.estado}">${(item.cerrado?'CERRADA':item.estado).toUpperCase()}</span>`;

      tr.append(tdTipo, tdGrupo, tdCoord, tdAsunto, tdMonto, tdMoneda, tdR1, tdR2, tdRpago, tdEstado);
      frag.appendChild(tr);
    });

    tbody.appendChild(frag);
  }

  resumen.textContent = `Mostrando ${data.length} / total ${state.rawItems.length}`;
  pagInfo.textContent = state.paging.loading ? 'Cargando…' : 'Listo.';
  applySortHeaderUI();
}

/* ================== UI ================== */
function refreshGroupDatalist(limitCoord=''){
  const dlG = document.getElementById('dl-grupos');
  if (!dlG) return;
  dlG.innerHTML='';
  let ids = [...state.caches.groupById.keys()];
  if (limitCoord){
    const set = state.caches.groupsByCoord.get(limitCoord);
    ids = set ? [...set] : [];
  }
  ids.forEach(gid=>{
    const info = state.caches.groupById.get(gid) || {};
    const opt = document.createElement('option');
    opt.value = gid;
    opt.label = `${info.numero} — ${info.nombre}`;
    dlG.appendChild(opt);
  });
}

function wireUI(){
  const tabs = document.getElementById('stateTabs');
  tabs.addEventListener('click', (ev)=>{
    const btn = ev.target.closest('button[data-estado]');
    if (!btn) return;
    tabs.querySelectorAll('button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    state.filtros.estado = btn.getAttribute('data-estado') || '';
    renderTable();
  });

  // tipo (select nuevo: GASTOS / PAGOS / TODOS)
  document.getElementById('filtroTipo').onchange = (e)=>{
    const v = (e.target.value || '').toLowerCase();
    state.filtros.tipo = (v==='gastos'||v==='pagos'||v==='todos') ? v : '';
  };

  // coord input: limita datalist de grupos
  const inputCoord = document.getElementById('filtroCoord');
  inputCoord.oninput = (e)=>{
    const val = (e.target.value||'').toLowerCase().trim();
    state.filtros.coord = val;
    // si hay match exacto, limitamos grupos
    const exact = [...state.caches.groupsByCoord.keys()].find(k => norm(k) === norm(val));
    refreshGroupDatalist(exact || '');
  };

  // grupo input
  document.getElementById('filtroGrupo').oninput = (e)=>{
    state.filtros.grupo = e.target.value || '';
  };

  // ordenar
  document.querySelector('#tblFinanzas thead')?.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.dataset.sortKey;
      if (!key) return;
      if (sortState.key === key) sortState.dir = (sortState.dir==='asc'?'desc':'asc');
      else { sortState.key = key; sortState.dir = 'asc'; }
      renderTable();
    });
  });

  // aplicar = cargar (no hacemos nada si no hay coord ni grupo)
  document.getElementById('btnAplicar').onclick = async ()=>{
    const t0 = (state.filtros.tipo || '').toLowerCase() || 'todos';
    const coord = (state.filtros.coord || '').toLowerCase().trim();
    const grupo = (state.filtros.grupo || '').trim();

    if (!coord && !grupo){
      state.rawItems = [];
      renderTable();
      alert('Selecciona COORDINADOR o GRUPO para cargar movimientos.');
      return;
    }

    state.paging.loading = true;
    state.rawItems = [];
    renderTable();

    try{
      // GASTOS
      if (t0 === 'gastos' || t0 === 'todos'){
        await loadGastos({ coordEmail: coord, grupoId: grupo || '' });
      }
      // PAGOS
      if (t0 === 'pagos' || t0 === 'todos'){
        await loadPagos({ coordEmail: coord, grupoId: grupo || '' });
      }
    }catch(e){
      console.error('[FINZ] aplicar filtros', e);
      alert('No se pudo cargar. Revisa la consola.');
    }finally{
      state.paging.loading = false;
      renderTable();
    }
  };

  document.getElementById('btnRecargar').onclick = async ()=>{
    await preloadCatalogs();
    refreshGroupDatalist('');
    state.rawItems = [];
    renderTable();
  };

  document.getElementById('btnMas').onclick = ()=>{/* sin paginación por ahora */};
}

/* ================== ARRANQUE ================== */
async function boot(){
  await preloadCatalogs();
  wireUI();
  // Arrancar en blanco (no cargamos nada hasta que el usuario aplique filtros)
  state.rawItems = [];
  renderTable();
}

onAuthStateChanged(auth, async (user)=>{
  if (!user){ location = 'login.html'; return; }
  state.userEmail = (user.email||'').toLowerCase();
  try { document.querySelector('#btn-logout')?.addEventListener('click', ()=>signOut(auth).then(()=>location='login.html')); } catch {}
  await boot();
});

/* Debug */
window.__finz = { state, list(){ return state.rawItems; } };
