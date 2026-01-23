// bodega.js (COMPLETO)
// Inventario por ítem (total) + desglose por CAJAS con UBICACIÓN
// Firestore:
// - bodegas/{bodegaId}
// - bodegas/{bodegaId}/cajas/{cajaId} {nombre, ubicacion}
// - bodegas/{bodegaId}/items/{itemId} {unidadesTotal, minimo, ...}
// - bodegas/{bodegaId}/items/{itemId}/stocks/{cajaId} {cajaId, unidades, actualizadoEn}
// - .../movimientos/{movId} {ts, delta, stock, by, nota}

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
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction
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
  toastTimer = setTimeout(()=> el.style.display='none', 2400);
}
function safeNum(n, def=0){
  const x = Number(n);
  return Number.isFinite(x) ? x : def;
}
function setEstado(msg){
  $('lblEstado').textContent = msg || 'Listo.';
}
function U(s){ return String(s||'').trim().toUpperCase(); }
function escapeHtml(str){
  return String(str ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

/* Paths */
const COL_BODEGAS = 'bodegas';

function bodegasCol(){ return collection(db, COL_BODEGAS); }

function cajasCol(bodegaId){ return collection(db, COL_BODEGAS, bodegaId, 'cajas'); }
function cajaDoc(bodegaId, cajaId){ return doc(db, COL_BODEGAS, bodegaId, 'cajas', cajaId); }

function itemsCol(bodegaId){ return collection(db, COL_BODEGAS, bodegaId, 'items'); }
function itemDoc(bodegaId, itemId){ return doc(db, COL_BODEGAS, bodegaId, 'items', itemId); }

function stocksCol(bodegaId, itemId){ return collection(db, COL_BODEGAS, bodegaId, 'items', itemId, 'stocks'); }
function stockDoc(bodegaId, itemId, cajaId){ return doc(db, COL_BODEGAS, bodegaId, 'items', itemId, 'stocks', cajaId); }

function movsCol(bodegaId, itemId, cajaId){
  return collection(db, COL_BODEGAS, bodegaId, 'items', itemId, 'stocks', cajaId, 'movimientos');
}

/* State */
const state = {
  user: null,
  bodegas: [],
  bodegaId: null,

  cajas: [],          // [{id,nombre,ubicacion}]
  cajasById: new Map(),

  items: [],          // [{id,nombre,unidadesTotal,minimo,...}]

  modal: {
    item: null,       // item activo en modal cajas
    stocks: [],       // [{cajaId, unidades}]
    stocksByCaja: new Map(),
  }
};

/* Auth UI */
$('btnLogin').addEventListener('click', async ()=>{
  const email = $('loginEmail').value.trim();
  const pass  = $('loginPass').value;
  if(!email || !pass){ toast('Completa email y contraseña.'); return; }

  try{
    setEstado('Ingresando...');
    await signInWithEmailAndPassword(auth, email, pass);
  }catch(err){
    console.error(err);
    toast('No se pudo ingresar.');
    setEstado('Error de login.');
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
    state.cajasById = new Map();
    state.items = [];
    $('selBodega').innerHTML = '';
    $('itemsList').innerHTML = '';
  }
});

/* Boot */
async function boot(){
  try{
    setEstado('Cargando bodegas...');
    await ensureDefaultBodegasIfEmpty();
    await loadBodegasIntoSelect();

    setEstado('Cargando cajas...');
    await loadCajas();

    setEstado('Cargando inventario...');
    await loadItems();

    wireFilters();
    wireCajasModal();
    setEstado('Listo.');
  }catch(err){
    console.error(err);
    setEstado('Error cargando.');
    toast('Error cargando bodega.');
  }
}

async function ensureDefaultBodegasIfEmpty(){
  const snap = await getDocs(query(bodegasCol(), orderBy('nombre','asc'), limit(5)));
  if(snap.empty){
    const defaults = ['Bodega Externa', 'Oficina'];
    for(const nombre of defaults){
      await addDoc(bodegasCol(), {
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

  const snap = await getDocs(query(bodegasCol(), orderBy('nombre','asc')));
  state.bodegas = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));

  if(!state.bodegaId){
    state.bodegaId = state.bodegas[0]?.id || null;
  }else if(!state.bodegas.some(b=>b.id===state.bodegaId)){
    state.bodegaId = state.bodegas[0]?.id || null;
  }

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
    await loadItems();
  };
}

/* Cajas (catálogo por bodega) */
async function loadCajas(){
  state.cajas = [];
  state.cajasById = new Map();

  $('itCajaSel').innerHTML = '';
  $('cxSel').innerHTML = '';

  if(!state.bodegaId) return;

  const snap = await getDocs(query(cajasCol(state.bodegaId), orderBy('nombre','asc')));
  state.cajas = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));
  for(const c of state.cajas) state.cajasById.set(c.id, c);

  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = '(sin caja)';
  $('itCajaSel').appendChild(opt0);

  for(const c of state.cajas){
    const t = `${c.nombre || '(sin nombre)'}${c.ubicacion ? ' · ' + c.ubicacion : ''}`;

    const o1 = document.createElement('option');
    o1.value = c.id;
    o1.textContent = t;
    $('itCajaSel').appendChild(o1);

    const o2 = document.createElement('option');
    o2.value = c.id;
    o2.textContent = t;
    $('cxSel').appendChild(o2);
  }
}

/* Items */
$('btnCrearItem').addEventListener('click', async ()=>{
  if(!state.bodegaId){ toast('Selecciona bodega.'); return; }

  const nombre = $('itNombre').value.trim();
  const desc = $('itDesc').value.trim();
  const minimo = Math.max(0, safeNum($('itMinimo').value, 0));
  const unidadesInit = Math.max(0, safeNum($('itUnidades').value, 0));
  const file = $('itFoto').files?.[0] || null;

  const cajaSel = $('itCajaSel').value || '';
  const cajaNueva = ($('itCajaNueva').value || '').trim();
  const cajaUbic = ($('itCajaUbic').value || '').trim();

  if(!nombre){ toast('Ponle un nombre al ítem.'); return; }

  try{
    setEstado('Guardando ítem...');

    let cajaId = cajaSel;

    if(cajaNueva){
      const cRef = await addDoc(cajasCol(state.bodegaId), {
        nombre: cajaNueva,
        ubicacion: cajaUbic || '',
        creadoEn: serverTimestamp(),
        creadoPor: state.user?.email || null,
        actualizadoEn: serverTimestamp()
      });
      cajaId = cRef.id;

      await loadCajas();
      $('itCajaSel').value = cajaId;
    }

    const itRef = await addDoc(itemsCol(state.bodegaId), {
      nombre,
      descripcion: desc || '',
      minimo,
      unidadesTotal: 0,
      fotoURL: null,
      fotoPath: null,
      creadoEn: serverTimestamp(),
      creadoPor: state.user?.email || null,
      actualizadoEn: serverTimestamp()
    });

    if(file){
      const path = `bodegas/${state.bodegaId}/items/${itRef.id}/${Date.now()}_${file.name}`;
      const r = sRef(storage, path);

      await new Promise((resolve, reject)=>{
        const task = uploadBytesResumable(r, file);
        task.on('state_changed', null, reject, resolve);
      });

      const url = await getDownloadURL(r);
      await updateDoc(itRef, { fotoURL:url, fotoPath:path, actualizadoEn: serverTimestamp() });
    }

    if(unidadesInit > 0){
      const targetCajaId = cajaId || '_SIN_CAJA_';
      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: itRef.id,
        cajaId: targetCajaId,
        delta: +unidadesInit,
        nota: 'Carga inicial'
      });
    }

    $('itNombre').value = '';
    $('itDesc').value = '';
    $('itUnidades').value = '0';
    $('itMinimo').value = '3';
    $('itFoto').value = '';
    $('itCajaNueva').value = '';
    $('itCajaUbic').value = '';
    $('itCajaSel').value = '';

    toast('Ítem guardado ✅');
    await loadItems();
    setEstado('Listo.');
  }catch(err){
    console.error(err);
    toast('Error guardando ítem.');
    setEstado('Error.');
  }
});

async function loadItems(){
  if(!state.bodegaId){
    $('itemsList').innerHTML = '';
    return;
  }

  setEstado('Cargando inventario...');
  const snap = await getDocs(query(itemsCol(state.bodegaId), orderBy('nombre','asc')));
  state.items = snap.docs.map(d=>({ id:d.id, ...(d.data()||{}) }));

  renderItems();
  setEstado(`Listo · ${state.items.length} ítems`);
}

/* UI filters */
function wireFilters(){
  $('btnRefrescar').onclick = async ()=>{
    await loadCajas();
    await loadItems();
  };
  $('txtSearch').oninput = renderItems;
  $('selFiltroStock').onchange = renderItems;

  $('btnVerMovimientos').onclick = async ()=>{
    if(!state.bodegaId) return;
    $('movBackdrop').style.display = 'flex';
    $('movTbody').innerHTML = '<tr><td colspan="8" class="muted">Cargando...</td></tr>';
    try{
      const moves = await fetchMovimientosUltimos(state.bodegaId, 200);
      renderMovimientos(moves);
    }catch(e){
      console.error(e);
      $('movTbody').innerHTML = '<tr><td colspan="8" class="muted">Error cargando movimientos.</td></tr>';
    }
  };

  $('btnCerrarMov').onclick = ()=> $('movBackdrop').style.display = 'none';
  $('movBackdrop').addEventListener('click', (ev)=>{
    if(ev.target === $('movBackdrop')) $('movBackdrop').style.display = 'none';
  });
}

function renderItems(){
  const q = $('txtSearch').value.trim().toLowerCase();
  const f = $('selFiltroStock').value;

  const list = $('itemsList');
  list.innerHTML = '';

  let items = [...state.items];

  if(q){
    items = items.filter(it=>{
      const a = (it.nombre || '').toLowerCase();
      const b = (it.descripcion || '').toLowerCase();
      return a.includes(q) || b.includes(q);
    });
  }

  if(f === 'low'){
    items = items.filter(it=>{
      const total = safeNum(it.unidadesTotal,0);
      const min = safeNum(it.minimo,3);
      return total <= min && total > 0;
    });
  }else if(f === 'zero'){
    items = items.filter(it=> safeNum(it.unidadesTotal,0) === 0);
  }

  if(items.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '8px 2px';
    empty.textContent = 'No hay ítems para mostrar.';
    list.appendChild(empty);
    return;
  }

  for(const it of items){
    list.appendChild(renderItemCard(it));
  }
}

function renderItemCard(it){
  const total = safeNum(it.unidadesTotal,0);
  const minimo = safeNum(it.minimo,3);

  let badgeClass = 'good';
  let badgeText = 'OK';
  if(total === 0){ badgeClass='bad'; badgeText='STOCK 0'; }
  else if(total <= minimo){ badgeClass='warn'; badgeText='BAJO'; }

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
          <span class="badge ${badgeClass}">${badgeText}</span>
          <span class="badge">MÍN: ${minimo}</span>
          <span class="badge">TOTAL: ${total}</span>
        </div>
      </div>
    </div>

    <div class="bottom">
      <div>
        <div class="mini">STOCK TOTAL</div>
        <div class="qty">
          <span>${total}</span>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end;">
        <button class="btn small" data-act="cajas">Cajas</button>
        <button class="btn small" data-act="editar">Editar</button>
        <button class="btn small danger" data-act="borrar">Borrar</button>
      </div>
    </div>
  `;

  card.querySelector('[data-act="cajas"]').onclick = ()=> openCajasModal(it);
  card.querySelector('[data-act="editar"]').onclick = ()=> editItem(it);
  card.querySelector('[data-act="borrar"]').onclick = ()=> deleteItem(it);

  return card;
}

async function editItem(it){
  if(!state.bodegaId) return;

  const nombre = prompt('Nombre del ítem:', it.nombre || '');
  if(nombre === null) return;

  const desc = prompt('Descripción:', it.descripcion || '');
  if(desc === null) return;

  const minimo = prompt('Mínimo (alerta):', String(safeNum(it.minimo,3)));
  if(minimo === null) return;

  try{
    setEstado('Actualizando ítem...');
    await updateDoc(itemDoc(state.bodegaId, it.id), {
      nombre: nombre.trim(),
      descripcion: desc.trim(),
      minimo: Math.max(0, safeNum(minimo, 3)),
      actualizadoEn: serverTimestamp()
    });

    toast('Ítem actualizado ✅');
    await loadItems();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error actualizando ítem.');
    setEstado('Error.');
  }
}

async function deleteItem(it){
  if(!state.bodegaId) return;

  const ok = confirm(`¿Borrar "${it.nombre}"?\n\nSe borra el ítem.\n(No borra automáticamente subcolecciones en Firestore).`);
  if(!ok) return;

  try{
    setEstado('Borrando ítem...');

    if(it.fotoPath){
      try{ await deleteObject(sRef(storage, it.fotoPath)); }catch(e){}
    }

    await deleteDoc(itemDoc(state.bodegaId, it.id));

    toast('Ítem borrado.');
    await loadItems();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error borrando ítem.');
    setEstado('Error.');
  }
}

/* Modal Cajas */
function wireCajasModal(){
  $('btnCajasCerrar').onclick = ()=> $('cajasBackdrop').style.display = 'none';
  $('cajasBackdrop').addEventListener('click', (ev)=>{
    if(ev.target === $('cajasBackdrop')) $('cajasBackdrop').style.display = 'none';
  });

  $('btnCxCrear').onclick = async ()=>{
    if(!state.bodegaId) return;

    const nombre = ($('cxNuevaNombre').value || '').trim();
    const ubic = ($('cxNuevaUbic').value || '').trim();
    if(!nombre){ toast('Falta nombre caja'); return; }

    try{
      setEstado('Creando caja...');
      const cRef = await addDoc(cajasCol(state.bodegaId), {
        nombre,
        ubicacion: ubic || '',
        creadoEn: serverTimestamp(),
        creadoPor: state.user?.email || null,
        actualizadoEn: serverTimestamp()
      });

      $('cxNuevaNombre').value = '';
      $('cxNuevaUbic').value = '';

      await loadCajas();
      $('cxSel').value = cRef.id;
      toast('Caja creada ✅');
      setEstado('Listo.');
      await refreshCajasModalTable();
    }catch(e){
      console.error(e);
      toast('Error creando caja');
      setEstado('Error.');
    }
  };

  $('btnCxAplicar').onclick = async ()=>{
    const it = state.modal.item;
    if(!it || !state.bodegaId) return;

    const cajaId = $('cxSel').value || '';
    const delta = safeNum($('cxDelta').value, 0);
    const nota = ($('cxNota').value || '').trim() || 'Movimiento';

    if(!cajaId){
      toast('Selecciona caja');
      return;
    }
    if(delta === 0){
      toast('Delta 0');
      return;
    }

    try{
      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: it.id,
        cajaId,
        delta,
        nota
      });
      $('cxDelta').value = '0';
      $('cxNota').value = '';
      toast('Listo ✅');

      await loadItems();
      await openCajasModal(it, true);
    }catch(e){
      console.error(e);
      toast('Error aplicando');
    }
  };
}

async function openCajasModal(it, keepOpen=false){
  if(!state.bodegaId) return;

  state.modal.item = it;
  $('cajasTitle').textContent = `Cajas · ${it.nombre || ''}`;

  $('cxDelta').value = '0';
  $('cxNota').value = '';
  $('cxNuevaNombre').value = '';
  $('cxNuevaUbic').value = '';

  if(!keepOpen) $('cajasBackdrop').style.display = 'flex';

  await loadCajas();
  await loadStocksForItem(it.id);
  await refreshCajasModalTable();
}

async function loadStocksForItem(itemId){
  state.modal.stocks = [];
  state.modal.stocksByCaja = new Map();

  const snap = await getDocs(query(stocksCol(state.bodegaId, itemId)));
  state.modal.stocks = snap.docs.map(d=>({ cajaId: d.id, ...(d.data()||{}) }));
  for(const s of state.modal.stocks){
    state.modal.stocksByCaja.set(s.cajaId, s);
  }
}

async function refreshCajasModalTable(){
  const it = state.modal.item;
  if(!it) return;

  const tb = $('cajasTbody');
  tb.innerHTML = '';

  const cajas = [...state.cajas];

  const ensureSpecial = (id, nombre, ubicacion) => {
    if(!state.cajasById.has(id)){
      const obj = { id, nombre, ubicacion };
      cajas.push(obj);
      state.cajasById.set(id, obj);
    }
  };

  ensureSpecial('_SIN_CAJA_', '(sin caja)', '');

  cajas.sort((a,b)=> String(a.nombre||'').localeCompare(String(b.nombre||''), 'es'));

  for(const c of cajas){
    const s = state.modal.stocksByCaja.get(c.id);
    const unidades = safeNum(s?.unidades, 0);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:900;">${escapeHtml(c.nombre||'')}</td>
      <td class="muted">${escapeHtml(c.ubicacion||'')}</td>
      <td style="font-weight:900;">${unidades}</td>
      <td>
        <button class="btn small" data-act="dec">−1</button>
        <button class="btn small" data-act="inc">+1</button>
        <button class="btn small" data-act="ajuste">Ajuste</button>
        ${c.id === '_SIN_CAJA_' ? '' : `<button class="btn small danger" data-act="del">Borrar</button>`}
      </td>
    `;

    tr.querySelector('[data-act="inc"]').onclick = async ()=>{
      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: it.id,
        cajaId: c.id,
        delta: +1,
        nota: '+1'
      });
      await loadItems();
      await openCajasModal(it, true);
      toast('OK');
    };

    // ✅ AQUÍ MISMO (ANTES DEL appendChild)
    if(c.id !== '_SIN_CAJA_'){
      const btnDel = tr.querySelector('[data-act="del"]');
      if(btnDel){
        btnDel.onclick = async ()=>{
          await deleteCajaSeguro(c.id);
          await loadCajas();
          await refreshCajasModalTable();
        };
      }
    }  

    tr.querySelector('[data-act="dec"]').onclick = async ()=>{
      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: it.id,
        cajaId: c.id,
        delta: -1,
        nota: '-1'
      });
      await loadItems();
      await openCajasModal(it, true);
      toast('OK');
    };

    tr.querySelector('[data-act="ajuste"]').onclick = async ()=>{
      const v = prompt(`Ajuste stock en ${c.nombre}\nNuevo stock:`, String(unidades));
      if(v === null) return;
      const nuevo = Math.max(0, safeNum(v, unidades));
      const delta = nuevo - unidades;
      if(delta === 0) return toast('Sin cambios');

      const nota = prompt('Nota:', 'Ajuste') || 'Ajuste';

      await applyDeltaToItemCaja({
        bodegaId: state.bodegaId,
        itemId: it.id,
        cajaId: c.id,
        delta,
        nota
      });
      await loadItems();
      await openCajasModal(it, true);
      toast('OK');
    };

    tb.appendChild(tr);
  }
}

/* Core: delta por caja + total */
async function applyDeltaToItemCaja({ bodegaId, itemId, cajaId, delta, nota }){
  const _cajaId = cajaId || '_SIN_CAJA_';

  const itRef = itemDoc(bodegaId, itemId);
  const stRef = stockDoc(bodegaId, itemId, _cajaId);

  await runTransaction(db, async (tx)=>{
    const itSnap = await tx.get(itRef);
    if(!itSnap.exists()) throw new Error('Item missing');

    const itData = itSnap.data() || {};
    const totalOld = safeNum(itData.unidadesTotal, 0);

    const stSnap = await tx.get(stRef);
    const stData = stSnap.exists() ? (stSnap.data()||{}) : {};
    const boxOld = safeNum(stData.unidades, 0);

    const boxNew = boxOld + delta;
    if(boxNew < 0) throw new Error('NEG');

    const totalNew = totalOld + delta;
    if(totalNew < 0) throw new Error('NEG_TOTAL');

    if(!stSnap.exists()){
      tx.set(stRef, {
        cajaId: _cajaId,
        unidades: boxNew,
        actualizadoEn: serverTimestamp()
      });
    }else{
      tx.update(stRef, { unidades: boxNew, actualizadoEn: serverTimestamp() });
    }

    tx.update(itRef, { unidadesTotal: totalNew, actualizadoEn: serverTimestamp() });

    const mvRef = doc(movsCol(bodegaId, itemId, _cajaId));
    tx.set(mvRef, {
      ts: serverTimestamp(),
      delta,
      stock: boxNew,
      by: state.user?.email || null,
      nota: nota || ''
    });
  });
}

/* Movimientos (últimos) */
async function fetchMovimientosUltimos(bodegaId, maxItems=200){
  const itemsSnap = await getDocs(query(itemsCol(bodegaId), orderBy('nombre','asc')));
  const moves = [];

  const cajasSnap = await getDocs(query(cajasCol(bodegaId), orderBy('nombre','asc')));
  const cajasMap = new Map();
  cajasSnap.forEach(d=> cajasMap.set(d.id, d.data()||{}));
  cajasMap.set('_SIN_CAJA_', { nombre:'(sin caja)', ubicacion:'' });

  for (const it of itemsSnap.docs){
    const itData = it.data() || {};
    const stSnap = await getDocs(query(stocksCol(bodegaId, it.id)));
    for(const st of stSnap.docs){
      const cajaId = st.id;
      const ms = await getDocs(query(movsCol(bodegaId, it.id, cajaId), orderBy('ts','desc'), limit(10)));
      const cajaMeta = cajasMap.get(cajaId) || {};
      ms.forEach(d=>{
        moves.push({
          ...d.data(),
          _itemNombre: itData.nombre || '(sin nombre)',
          _cajaNombre: cajaMeta.nombre || '(caja)',
          _cajaUbic: cajaMeta.ubicacion || ''
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

function renderMovimientos(moves){
  const tb = $('movTbody');
  tb.innerHTML = '';

  if(!moves.length){
    tb.innerHTML = '<tr><td colspan="8" class="muted">Sin movimientos.</td></tr>';
    return;
  }

  for(const m of moves){
    const tr = document.createElement('tr');
    const fecha = m.ts?.toDate ? m.ts.toDate().toLocaleString('es-CL') : '';
    const delta = safeNum(m.delta,0);
    const stock = safeNum(m.stock,0);

    tr.innerHTML = `
      <td>${escapeHtml(fecha)}</td>
      <td>${escapeHtml(m._itemNombre || '')}</td>
      <td>${escapeHtml(m._cajaNombre || '')}</td>
      <td class="muted">${escapeHtml(m._cajaUbic || '')}</td>
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

async function deleteCajaSeguro(cajaId){
  if(!state.bodegaId) return;

  const cajaMeta = state.cajasById.get(cajaId) || {};
  const nombreCaja = cajaMeta.nombre || cajaId;

  const ok = confirm(`¿Borrar caja "${nombreCaja}"?\n\nSolo se puede borrar si NO tiene stock en ningún ítem.`);
  if(!ok) return;

  try{
    setEstado('Revisando stock de la caja...');

    // 1) Recorre todos los ítems de la bodega y verifica si esa caja tiene stock > 0
    const itemsSnap = await getDocs(query(itemsCol(state.bodegaId), orderBy('nombre','asc')));

    for(const it of itemsSnap.docs){
      const stRef = stockDoc(state.bodegaId, it.id, cajaId);
      const stSnap = await getDoc(stRef);
      if(stSnap.exists()){
        const u = safeNum(stSnap.data()?.unidades, 0);
        if(u > 0){
          toast(`No se puede borrar: stock ${u} en "${it.data()?.nombre || it.id}"`);
          setEstado('Listo.');
          return;
        }
      }
    }

    // 2) Si está todo en 0 (o no existe), borramos los stocks (en 0) para no dejar basura
    setEstado('Borrando referencias...');
    for(const it of itemsSnap.docs){
      const stRef = stockDoc(state.bodegaId, it.id, cajaId);
      const stSnap = await getDoc(stRef);
      if(stSnap.exists()){
        // unidades ya sabemos que es 0 aquí
        await deleteDoc(stRef);
        // Nota: no borramos subcolección movimientos automáticamente (Firestore no lo hace solo)
      }
    }

    // 3) Borrar la caja
    setEstado('Borrando caja...');
    await deleteDoc(cajaDoc(state.bodegaId, cajaId));

    toast('Caja borrada ✅');
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error borrando caja.');
    setEstado('Error.');
  }
}

