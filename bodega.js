import { app, db } from './firebase-init.js';

import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';

import {
  getStorage,
  ref as sRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-storage.js';

import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const $ = (id) => document.getElementById(id);
const auth = getAuth(app);
const storage = getStorage(app);

let toastTimer = null;
function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.style.display='none', 2200);
}
function safeNum(n, def=0){
  const x = Number(n);
  return Number.isFinite(x) ? x : def;
}
function setEstado(msg){
  $('lblEstado').textContent = msg || 'Listo.';
}
function escapeHtml(str){
  return String(str ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

const COL_BODEGAS = 'bodegas';

function cajasCol(bodegaId){ return collection(db, COL_BODEGAS, bodegaId, 'cajas'); }
function cajaDoc(bodegaId, cajaId){ return doc(db, COL_BODEGAS, bodegaId, 'cajas', cajaId); }

function contCol(bodegaId, cajaId){ return collection(db, COL_BODEGAS, bodegaId, 'cajas', cajaId, 'contenidos'); }
function contDoc(bodegaId, cajaId, contId){ return doc(db, COL_BODEGAS, bodegaId, 'cajas', cajaId, 'contenidos', contId); }

function movsCol(bodegaId, cajaId, contId){
  return collection(db, COL_BODEGAS, bodegaId, 'cajas', cajaId, 'contenidos', contId, 'movimientos');
}

const state = {
  user: null,
  bodegas: [],
  bodegaId: null,

  cajas: [],
  cajaActiva: null,
  contenidos: [],
};

$('btnLogin').addEventListener('click', async ()=>{
  const email = $('loginEmail').value.trim();
  const pass  = $('loginPass').value;
  if(!email || !pass){ toast('Faltan datos'); return; }
  try{
    setEstado('Ingresando...');
    await signInWithEmailAndPassword(auth, email, pass);
  }catch(e){
    console.error(e);
    toast('Error de ingreso');
    setEstado('Error');
  }
});

$('btnLogout').addEventListener('click', async ()=>{
  try{ await signOut(auth); }catch(e){ console.error(e); }
});

onAuthStateChanged(auth, async (user)=>{
  state.user = user || null;

  $('userPill').textContent = user?.email ? user.email : 'No autenticado';
  $('btnLogout').classList.toggle('hide', !user);

  $('loginView').classList.toggle('hide', !!user);
  $('appView').classList.toggle('hide', !user);

  if(user){
    await boot();
  }else{
    state.bodegas = [];
    state.bodegaId = null;
    state.cajas = [];
    state.cajaActiva = null;
    state.contenidos = [];
    $('selBodega').innerHTML = '';
    $('cajasList').innerHTML = '';
  }
});

async function boot(){
  try{
    setEstado('Cargando...');
    await ensureDefaultBodegasIfEmpty();
    await loadBodegasIntoSelect();
    await loadCajas();
    wireUI();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    setEstado('Error');
    toast('Error');
  }
}

async function ensureDefaultBodegasIfEmpty(){
  const snap = await getDocs(query(collection(db, COL_BODEGAS), orderBy('nombre','asc'), limit(5)));
  if(snap.empty){
    const defaults = ['Bodega Externa', 'Oficina'];
    for(const nombre of defaults){
      await addDoc(collection(db, COL_BODEGAS), {
        nombre,
        creadoEn: serverTimestamp(),
        creadoPor: state.user?.email || null,
        activo: true
      });
    }
  }
}

async function loadBodegasIntoSelect(){
  const sel = $('selBodega');
  sel.innerHTML = '';

  const snap = await getDocs(query(collection(db, COL_BODEGAS), orderBy('nombre','asc')));
  state.bodegas = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));

  if(!state.bodegaId) state.bodegaId = state.bodegas[0]?.id || null;
  else if(!state.bodegas.some(b=>b.id===state.bodegaId)) state.bodegaId = state.bodegas[0]?.id || null;

  for(const b of state.bodegas){
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.nombre || '(sin nombre)';
    sel.appendChild(opt);
  }
  sel.value = state.bodegaId || '';

  sel.onchange = async ()=>{
    state.bodegaId = sel.value;
    await loadCajas();
  };
}

function wireUI(){
  $('btnRefrescar').onclick = loadCajas;
  $('txtSearch').oninput = renderCajas;
  $('selFiltro').onchange = renderCajas;

  $('btnCrearCaja').onclick = crearCaja;

  $('btnVerMovimientos').onclick = openMovModal;
  $('btnCerrarMov').onclick = ()=> $('movBackdrop').style.display = 'none';
  $('movBackdrop').addEventListener('click', (ev)=>{ if(ev.target === $('movBackdrop')) $('movBackdrop').style.display='none'; });

  $('btnOpenAdmin').onclick = openAdminModal;
  $('btnCerrarAdmin').onclick = ()=> $('adminBackdrop').style.display = 'none';
  $('adminBackdrop').addEventListener('click', (ev)=>{ if(ev.target === $('adminBackdrop')) $('adminBackdrop').style.display='none'; });

  $('btnCrearBodega').onclick = crearBodega;

  $('btnCajaCerrar').onclick = ()=> $('cajaBackdrop').style.display = 'none';
  $('cajaBackdrop').addEventListener('click', (ev)=>{ if(ev.target === $('cajaBackdrop')) $('cajaBackdrop').style.display='none'; });

  $('btnCrearContenido').onclick = crearContenidoEnCaja;
  $('cajaBuscar').oninput = renderContenidos;
  $('cajaFiltro').onchange = renderContenidos;

  $('btnCajaEditar').onclick = editarCajaActiva;
  $('btnCajaBorrar').onclick = borrarCajaActiva;
}

async function crearBodega(){
  const nombre = ($('bdNombre').value || '').trim();
  if(!nombre){ toast('Falta nombre'); return; }
  try{
    setEstado('Creando...');
    await addDoc(collection(db, COL_BODEGAS), {
      nombre,
      creadoEn: serverTimestamp(),
      creadoPor: state.user?.email || null,
      activo: true
    });
    $('bdNombre').value = '';
    toast('OK');
    await loadBodegasIntoSelect();
    await paintBodegasTable();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error');
    setEstado('Error');
  }
}

async function openAdminModal(){
  $('adminBackdrop').style.display = 'flex';
  await paintBodegasTable();
}

async function paintBodegasTable(){
  const tb = $('bdTbody');
  tb.innerHTML = '';
  const snap = await getDocs(query(collection(db, COL_BODEGAS), orderBy('nombre','asc')));
  const rows = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));
  for(const b of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(b.nombre||'')}</td><td class="muted">${escapeHtml(b.id)}</td>`;
    tb.appendChild(tr);
  }
}

async function crearCaja(){
  if(!state.bodegaId){ toast('Sin bodega'); return; }

  const nombre = ($('cxNombre').value || '').trim();
  const ubicacion = ($('cxUbicacion').value || '').trim();
  const file = $('cxFoto').files?.[0] || null;

  if(!nombre){ toast('Falta caja'); return; }

  try{
    setEstado('Guardando...');
    const cRef = await addDoc(cajasCol(state.bodegaId), {
      nombre,
      ubicacion: ubicacion || '',
      fotoURL: null,
      fotoPath: null,
      creadoEn: serverTimestamp(),
      creadoPor: state.user?.email || null,
      actualizadoEn: serverTimestamp()
    });

    if(file){
      const path = `bodegas/${state.bodegaId}/cajas/${cRef.id}/${Date.now()}_${file.name}`;
      const r = sRef(storage, path);
      await new Promise((resolve, reject)=>{
        const task = uploadBytesResumable(r, file);
        task.on('state_changed', null, reject, resolve);
      });
      const url = await getDownloadURL(r);
      await updateDoc(cRef, { fotoURL:url, fotoPath:path, actualizadoEn: serverTimestamp() });
    }

    $('cxNombre').value = '';
    $('cxUbicacion').value = '';
    $('cxFoto').value = '';

    toast('OK');
    await loadCajas();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error');
    setEstado('Error');
  }
}

async function loadCajas(){
  if(!state.bodegaId){
    $('cajasList').innerHTML = '';
    return;
  }

  setEstado('Cargando...');
  const snap = await getDocs(query(cajasCol(state.bodegaId), orderBy('nombre','asc')));
  state.cajas = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));

  await hydrateCajasConteo();
  renderCajas();
  setEstado(`Listo · ${state.cajas.length}`);
}

async function hydrateCajasConteo(){
  for(const c of state.cajas){
    try{
      const cs = await getDocs(query(contCol(state.bodegaId, c.id), limit(500)));
      c._countCont = cs.size;
    }catch(e){
      c._countCont = null;
    }
  }
}

function renderCajas(){
  const q = ($('txtSearch').value || '').trim().toLowerCase();
  const f = $('selFiltro').value;

  let cajas = [...state.cajas];

  if(q){
    cajas = cajas.filter(c=>{
      const a = (c.nombre || '').toLowerCase();
      const b = (c.ubicacion || '').toLowerCase();
      return a.includes(q) || b.includes(q);
    });
  }

  if(f === 'with'){
    cajas = cajas.filter(c => (c._countCont ?? 0) > 0);
  }else if(f === 'empty'){
    cajas = cajas.filter(c => (c._countCont ?? 0) === 0);
  }

  const list = $('cajasList');
  list.innerHTML = '';

  if(cajas.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '8px 2px';
    empty.textContent = 'Sin resultados';
    list.appendChild(empty);
    return;
  }

  for(const c of cajas){
    list.appendChild(renderCajaCard(c));
  }
}

function renderCajaCard(c){
  const card = document.createElement('div');
  card.className = 'item';

  const count = (c._countCont ?? 0);

  card.innerHTML = `
    <div class="top">
      <div class="thumb">
        ${c.fotoURL ? `<img src="${c.fotoURL}" alt="foto">` : `<span class="muted" style="font-size:12px;font-weight:900;">SIN<br>FOTO</span>`}
      </div>
      <div class="meta">
        <b title="${escapeHtml(c.nombre||'')}">${escapeHtml(c.nombre||'(sin nombre)')}</b>
        <div class="desc">${escapeHtml(c.ubicacion||'')}</div>
        <div class="badges">
          <span class="badge">${count} contenido(s)</span>
          <span class="badge">ID: ${c.id.slice(0,6)}…</span>
        </div>
      </div>
    </div>

    <div class="bottom">
      <div class="mini"> </div>
      <div class="row" style="justify-content:flex-end;">
        <button class="btn small" data-act="open">Abrir</button>
      </div>
    </div>
  `;

  card.querySelector('[data-act="open"]').onclick = ()=> openCaja(c);

  return card;
}

async function openCaja(c){
  state.cajaActiva = c;
  $('cajaTitle').textContent = c.nombre || 'Caja';
  $('cajaUbicacionView').value = c.ubicacion || '';

  $('ctNombre').value = '';
  $('ctDesc').value = '';
  $('ctUnidades').value = '0';
  $('ctPackSize').value = '100';
  $('ctMinimo').value = '3';
  $('ctFoto').value = '';
  $('cajaBuscar').value = '';
  $('cajaFiltro').value = 'all';

  $('contenidosList').innerHTML = '';
  $('cajaBackdrop').style.display = 'flex';

  await loadContenidosCaja();
}

async function loadContenidosCaja(){
  if(!state.bodegaId || !state.cajaActiva?.id) return;

  setEstado('Cargando...');
  const snap = await getDocs(query(contCol(state.bodegaId, state.cajaActiva.id), orderBy('nombre','asc')));
  state.contenidos = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));
  renderContenidos();
  setEstado('Listo.');
}

function calcBoxes(units, packSize){
  const ps = Math.max(1, safeNum(packSize, 1));
  const cajas = Math.floor(units / ps);
  const sueltas = units % ps;
  return { cajas, sueltas, ps };
}

function renderContenidos(){
  const q = ($('cajaBuscar').value || '').trim().toLowerCase();
  const f = $('cajaFiltro').value;

  let items = [...state.contenidos];

  if(q){
    items = items.filter(it=>{
      const a = (it.nombre || '').toLowerCase();
      const b = (it.descripcion || '').toLowerCase();
      return a.includes(q) || b.includes(q);
    });
  }

  if(f === 'low'){
    items = items.filter(it => safeNum(it.unidades,0) <= safeNum(it.minimo,3) && safeNum(it.unidades,0) > 0);
  }else if(f === 'zero'){
    items = items.filter(it => safeNum(it.unidades,0) === 0);
  }

  const list = $('contenidosList');
  list.innerHTML = '';

  if(items.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '8px 2px';
    empty.textContent = 'Sin resultados';
    list.appendChild(empty);
    return;
  }

  for(const it of items){
    list.appendChild(renderContenidoCard(it));
  }
}

function renderContenidoCard(it){
  const unidades = safeNum(it.unidades,0);
  const minimo  = safeNum(it.minimo,3);
  const packSize = Math.max(1, safeNum(it.packSize, 100));
  const { cajas, sueltas, ps } = calcBoxes(unidades, packSize);

  let badgeText = 'OK';
  let badgeStyle = '';
  if(unidades === 0){ badgeText='STOCK 0'; badgeStyle='border-color:#fecaca;color:#991b1b;'; }
  else if(unidades <= minimo){ badgeText='BAJO'; badgeStyle='border-color:#fde68a;color:#92400e;'; }
  else { badgeText='OK'; badgeStyle='border-color:#bbf7d0;color:#166534;'; }

  const card = document.createElement('div');
  card.className = 'item';

  card.innerHTML = `
    <div class="top">
      <div class="thumb">
        ${it.fotoURL ? `<img src="${it.fotoURL}" alt="foto">` : `<span class="muted" style="font-size:12px;font-weight:900;">SIN<br>FOTO</span>`}
      </div>
      <div class="meta">
        <b title="${escapeHtml(it.nombre||'')}">${escapeHtml(it.nombre||'(sin nombre)')}</b>
        <div class="desc">${escapeHtml(it.descripcion||'')}</div>
        <div class="badges">
          <span class="badge" style="${badgeStyle}">${badgeText}</span>
          <span class="badge">MÍN: ${minimo}</span>
          <span class="badge">${ps}/CAJA</span>
        </div>
      </div>
    </div>

    <div class="bottom">
      <div>
        <div class="mini">${cajas} caja(s) + ${sueltas} suelta(s) (${unidades})</div>
        <div class="row" style="margin-top:6px;">
          <button class="btn small" data-act="decBox">−1 caja</button>
          <button class="btn small" data-act="incBox">+1 caja</button>
          <button class="btn small" data-act="dec1">−1</button>
          <button class="btn small" data-act="inc1">+1</button>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end;">
        <button class="btn small" data-act="ajuste">Ajuste</button>
        <button class="btn small" data-act="editar">Editar</button>
        <button class="btn small danger" data-act="borrar">Borrar</button>
      </div>
    </div>
  `;

  card.querySelector('[data-act="inc1"]').onclick = ()=> changeContenidoStock(it, +1, '+1 unidad');
  card.querySelector('[data-act="dec1"]').onclick = ()=> changeContenidoStock(it, -1, '-1 unidad');
  card.querySelector('[data-act="incBox"]').onclick = ()=> changeContenidoStock(it, +ps, `+1 caja (${ps})`);
  card.querySelector('[data-act="decBox"]').onclick = ()=> changeContenidoStock(it, -ps, `-1 caja (${ps})`);

  card.querySelector('[data-act="ajuste"]').onclick = async ()=>{
    const v = prompt(`Nuevo stock total (unidades):`, String(unidades));
    if(v === null) return;
    const nuevo = Math.max(0, safeNum(v, unidades));
    const delta = nuevo - unidades;
    if(delta === 0) return toast('Sin cambios');
    const nota = prompt('Nota:', 'Ajuste') || 'Ajuste';
    await changeContenidoStock(it, delta, nota);
  };

  card.querySelector('[data-act="editar"]').onclick = ()=> editContenido(it);
  card.querySelector('[data-act="borrar"]').onclick = ()=> deleteContenido(it);

  return card;
}

async function crearContenidoEnCaja(){
  if(!state.bodegaId || !state.cajaActiva?.id){ toast('Sin caja'); return; }

  const nombre = ($('ctNombre').value || '').trim();
  const desc = ($('ctDesc').value || '').trim();
  const unidades = Math.max(0, safeNum($('ctUnidades').value, 0));
  const packSize = Math.max(1, safeNum($('ctPackSize').value, 100));
  const minimo = Math.max(0, safeNum($('ctMinimo').value, 3));
  const file = $('ctFoto').files?.[0] || null;

  if(!nombre){ toast('Falta contenido'); return; }

  try{
    setEstado('Guardando...');
    const itRef = await addDoc(contCol(state.bodegaId, state.cajaActiva.id), {
      nombre,
      descripcion: desc || '',
      unidades,
      packSize,
      minimo,
      fotoURL: null,
      fotoPath: null,
      creadoEn: serverTimestamp(),
      creadoPor: state.user?.email || null,
      actualizadoEn: serverTimestamp()
    });

    if(file){
      const path = `bodegas/${state.bodegaId}/cajas/${state.cajaActiva.id}/contenidos/${itRef.id}/${Date.now()}_${file.name}`;
      const r = sRef(storage, path);
      await new Promise((resolve, reject)=>{
        const task = uploadBytesResumable(r, file);
        task.on('state_changed', null, reject, resolve);
      });
      const url = await getDownloadURL(r);
      await updateDoc(itRef, { fotoURL:url, fotoPath:path, actualizadoEn: serverTimestamp() });
    }

    if(unidades > 0){
      await addDoc(movsCol(state.bodegaId, state.cajaActiva.id, itRef.id), {
        ts: serverTimestamp(),
        delta: +unidades,
        stock: unidades,
        by: state.user?.email || null,
        nota: 'Carga inicial'
      });
    }

    $('ctNombre').value = '';
    $('ctDesc').value = '';
    $('ctUnidades').value = '0';
    $('ctPackSize').value = '100';
    $('ctMinimo').value = '3';
    $('ctFoto').value = '';

    toast('OK');
    await loadContenidosCaja();
    await loadCajas();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error');
    setEstado('Error');
  }
}

async function changeContenidoStock(it, delta, nota){
  if(!state.bodegaId || !state.cajaActiva?.id) return;

  const unidades = safeNum(it.unidades,0);
  const nuevo = unidades + delta;
  if(nuevo < 0){ toast('No permitido'); return; }

  try{
    setEstado('Guardando...');

    await updateDoc(contDoc(state.bodegaId, state.cajaActiva.id, it.id), {
      unidades: nuevo,
      actualizadoEn: serverTimestamp()
    });

    await addDoc(movsCol(state.bodegaId, state.cajaActiva.id, it.id), {
      ts: serverTimestamp(),
      delta,
      stock: nuevo,
      by: state.user?.email || null,
      nota: nota || ''
    });

    it.unidades = nuevo;
    const idx = state.contenidos.findIndex(x=>x.id===it.id);
    if(idx>=0) state.contenidos[idx].unidades = nuevo;

    renderContenidos();
    toast('OK');
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error');
    setEstado('Error');
  }
}

async function editContenido(it){
  const nombre = prompt('Contenido:', it.nombre || '');
  if(nombre === null) return;

  const desc = prompt('Descripción:', it.descripcion || '');
  if(desc === null) return;

  const pack = prompt('Unidades por caja:', String(Math.max(1, safeNum(it.packSize, 100))));
  if(pack === null) return;

  const minimo = prompt('Mínimo:', String(safeNum(it.minimo, 3)));
  if(minimo === null) return;

  try{
    setEstado('Actualizando...');
    await updateDoc(contDoc(state.bodegaId, state.cajaActiva.id, it.id), {
      nombre: nombre.trim(),
      descripcion: desc.trim(),
      packSize: Math.max(1, safeNum(pack, 100)),
      minimo: Math.max(0, safeNum(minimo, 3)),
      actualizadoEn: serverTimestamp()
    });
    toast('OK');
    await loadContenidosCaja();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error');
    setEstado('Error');
  }
}

async function deleteContenido(it){
  const ok = confirm(`Borrar "${it.nombre}"?`);
  if(!ok) return;

  try{
    setEstado('Borrando...');

    if(it.fotoPath){
      try{ await deleteObject(sRef(storage, it.fotoPath)); }catch(e){}
    }

    await deleteDoc(contDoc(state.bodegaId, state.cajaActiva.id, it.id));

    toast('OK');
    await loadContenidosCaja();
    await loadCajas();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error');
    setEstado('Error');
  }
}

async function editarCajaActiva(){
  if(!state.bodegaId || !state.cajaActiva?.id) return;

  const nombre = prompt('Caja:', state.cajaActiva.nombre || '');
  if(nombre === null) return;

  const ubic = prompt('Ubicación:', state.cajaActiva.ubicacion || '');
  if(ubic === null) return;

  try{
    setEstado('Actualizando...');
    await updateDoc(cajaDoc(state.bodegaId, state.cajaActiva.id), {
      nombre: nombre.trim(),
      ubicacion: ubic.trim(),
      actualizadoEn: serverTimestamp()
    });
    toast('OK');
    await loadCajas();
    const c2 = state.cajas.find(x=>x.id===state.cajaActiva.id);
    state.cajaActiva = c2 || state.cajaActiva;
    $('cajaTitle').textContent = state.cajaActiva.nombre || 'Caja';
    $('cajaUbicacionView').value = state.cajaActiva.ubicacion || '';
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error');
    setEstado('Error');
  }
}

async function borrarCajaActiva(){
  if(!state.bodegaId || !state.cajaActiva?.id) return;

  const ok = confirm(`Borrar caja "${state.cajaActiva.nombre}"?`);
  if(!ok) return;

  try{
    setEstado('Borrando...');

    if(state.cajaActiva.fotoPath){
      try{ await deleteObject(sRef(storage, state.cajaActiva.fotoPath)); }catch(e){}
    }

    await deleteDoc(cajaDoc(state.bodegaId, state.cajaActiva.id));

    $('cajaBackdrop').style.display = 'none';
    state.cajaActiva = null;
    state.contenidos = [];

    toast('OK');
    await loadCajas();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error');
    setEstado('Error');
  }
}

async function fetchMovimientosUltimos(bodegaId, maxItems=200){
  const cajasSnap = await getDocs(query(cajasCol(bodegaId), orderBy('nombre','asc')));
  const moves = [];

  for(const c of cajasSnap.docs){
    const cData = c.data() || {};
    const contSnap = await getDocs(query(contCol(bodegaId, c.id), orderBy('nombre','asc')));
    for(const it of contSnap.docs){
      const itData = it.data() || {};
      const ms = await getDocs(query(movsCol(bodegaId, c.id, it.id), orderBy('ts','desc'), limit(10)));
      ms.forEach(d=>{
        moves.push({
          ...d.data(),
          _cajaNombre: cData.nombre || '(caja)',
          _contNombre: itData.nombre || '(contenido)',
        });
      });
    }
  }

  moves.sort((a,b)=>{
    const ta = a.ts?.toMillis ? a.ts.toMillis() : 0;
    const tb = b.ts?.toMillis ? b.ts.toMillis() : 0;
    return tb - ta;
  });

  return moves.slice(0, maxItems);
}

async function openMovModal(){
  if(!state.bodegaId) return;

  $('movBackdrop').style.display = 'flex';
  $('movTbody').innerHTML = '<tr><td colspan="7" class="muted">Cargando...</td></tr>';

  try{
    const moves = await fetchMovimientosUltimos(state.bodegaId, 200);
    renderMovimientos(moves);
  }catch(e){
    console.error(e);
    $('movTbody').innerHTML = '<tr><td colspan="7" class="muted">Error</td></tr>';
  }
}

function renderMovimientos(moves){
  const tb = $('movTbody');
  tb.innerHTML = '';

  if(!moves.length){
    tb.innerHTML = '<tr><td colspan="7" class="muted">Sin movimientos</td></tr>';
    return;
  }

  for(const m of moves){
    const tr = document.createElement('tr');
    const fecha = m.ts?.toDate ? m.ts.toDate().toLocaleString('es-CL') : '';
    const delta = safeNum(m.delta,0);
    const stock = safeNum(m.stock,0);

    tr.innerHTML = `
      <td>${escapeHtml(fecha)}</td>
      <td>${escapeHtml(m._cajaNombre || '')}</td>
      <td>${escapeHtml(m._contNombre || '')}</td>
      <td style="font-weight:900; ${delta<0?'color:#b91c1c':''} ${delta>0?'color:#166534':''}">
        ${delta>0?'+':''}${delta}
      </td>
      <td style="font-weight:900;">${stock}</td>
      <td class="muted">${escapeHtml(m.by || '')}</td>
      <td>${escapeHtml(m.nota || '')}</td>
    `;
    tb.appendChild(tr);
  }
}
