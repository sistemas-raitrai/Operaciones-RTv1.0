// bodega.js (COMPLETO)
// ✅ Firebase Auth: login/logout
// ✅ Firestore: coleccion "bodegas" + subcoleccion items
// ✅ Storage: sube imagen por item
// ✅ Stock: + / - con historial en subcoleccion movimientos
// ✅ UI: lista responsiva + filtros

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
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';


/* =========================
   0) Helpers
========================= */
const $ = (id) => document.getElementById(id);
const auth = getAuth(app);
const storage = getStorage(app);

function nowCL(){
  return new Date().toLocaleString('es-CL', { dateStyle:'short', timeStyle:'medium' });
}

let toastTimer = null;
function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.style.display='none', 2400);
}

function U(s){ return String(s||'').trim().toUpperCase(); }
function safeNum(n, def=0){
  const x = Number(n);
  return Number.isFinite(x) ? x : def;
}

function setEstado(msg){
  $('lblEstado').textContent = msg || 'Listo.';
}

/* =========================
   1) Firestore Paths (IND.)
========================= */
// coleccion independiente del resto del programa:
const COL_BODEGAS = 'bodegas'; // bodegas/{bodegaId}
function itemsCol(bodegaId){ return collection(db, COL_BODEGAS, bodegaId, 'items'); }
function itemDoc(bodegaId, itemId){ return doc(db, COL_BODEGAS, bodegaId, 'items', itemId); }
function movsCol(bodegaId, itemId){ return collection(db, COL_BODEGAS, bodegaId, 'items', itemId, 'movimientos'); }

// movimientos agregados (para ver “todo junto” en modal):
// (sencillo: leemos últimos por cada item visible; para “global” real, habría que duplicar a una colección central)
async function fetchMovimientosUltimos(bodegaId, maxItems=200){
  // Estrategia simple y suficiente:
  // - Trae items
  // - Para cada item, trae últimos 20 movimientos
  // - Junta y ordena en memoria
  const itemsSnap = await getDocs(query(itemsCol(bodegaId), orderBy('nombre','asc')));
  const moves = [];

  for (const it of itemsSnap.docs){
    const itData = it.data() || {};
    const ms = await getDocs(query(movsCol(bodegaId, it.id), orderBy('ts','desc'), limit(20)));
    ms.forEach(d=>{
      moves.push({
        ...d.data(),
        _itemNombre: itData.nombre || '(sin nombre)',
      });
    });
  }

  moves.sort((a,b)=>{
    const ta = a.ts?.toMillis ? a.ts.toMillis() : 0;
    const tb = b.ts?.toMillis ? b.ts.toMillis() : 0;
    return tb - ta;
  });

  return moves.slice(0, maxItems);
}

/* =========================
   2) State
========================= */
const state = {
  user: null,
  bodegas: [],        // [{id,nombre}]
  bodegaId: null,
  items: [],          // [{id, ...data}]
};

/* =========================
   3) Auth UI
========================= */
$('btnLogin').addEventListener('click', async ()=>{
  const email = $('loginEmail').value.trim();
  const pass  = $('loginPass').value;

  if(!email || !pass){
    toast('Completa email y contraseña.');
    return;
  }

  try{
    setEstado('Ingresando...');
    await signInWithEmailAndPassword(auth, email, pass);
  }catch(err){
    console.error(err);
    toast('No se pudo ingresar. Revisa credenciales.');
    setEstado('Error de login.');
  }
});

$('btnLogout').addEventListener('click', async ()=>{
  try{
    await signOut(auth);
  }catch(e){
    console.error(e);
    toast('No se pudo cerrar sesión.');
  }
});

onAuthStateChanged(auth, async (user)=>{
  state.user = user || null;

  // topbar
  $('userPill').textContent = user?.email ? user.email : 'No autenticado';
  $('btnLogout').classList.toggle('hide', !user);

  // views
  $('loginView').classList.toggle('hide', !!user);
  $('appView').classList.toggle('hide', !user);

  if(user){
    await boot();
  }else{
    // reset
    state.bodegas = [];
    state.bodegaId = null;
    state.items = [];
    $('selBodega').innerHTML = '';
    $('itemsList').innerHTML = '';
  }
});

/* =========================
   4) Boot: bodegas + items
========================= */
async function boot(){
  try{
    setEstado('Cargando bodegas...');
    await ensureDefaultBodegasIfEmpty();
    await loadBodegasIntoSelect();
    await loadItems();
    wireFilters();
    setEstado('Listo.');
  }catch(err){
    console.error(err);
    setEstado('Error cargando.');
    toast('Error cargando bodegas/inventario.');
  }
}

async function ensureDefaultBodegasIfEmpty(){
  const snap = await getDocs(query(collection(db, COL_BODEGAS), orderBy('nombre','asc'), limit(5)));
  if(snap.empty){
    // crea 2 bodegas por defecto
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

  // pick first if none
  if(!state.bodegaId){
    state.bodegaId = state.bodegas[0]?.id || null;
  }else{
    // si ya estaba seteada, valida que exista
    const ok = state.bodegas.some(b=>b.id === state.bodegaId);
    if(!ok) state.bodegaId = state.bodegas[0]?.id || null;
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
    await loadItems();
  };
}

/* =========================
   5) Items CRUD + Stock
========================= */
$('btnCrearItem').addEventListener('click', async ()=>{
  if(!state.bodegaId){
    toast('Primero selecciona una bodega.');
    return;
  }

  const nombre = $('itNombre').value.trim();
  const desc = $('itDesc').value.trim();
  const unidades = Math.max(0, safeNum($('itUnidades').value, 0));
  const minimo = Math.max(0, safeNum($('itMinimo').value, 0));
  const file = $('itFoto').files?.[0] || null;

  if(!nombre){
    toast('Ponle un nombre al ítem.');
    return;
  }

  try{
    setEstado('Guardando ítem...');

    // 1) crea doc item
    const itRef = await addDoc(itemsCol(state.bodegaId), {
      nombre,
      descripcion: desc || '',
      unidades,
      minimo,
      fotoURL: null,
      fotoPath: null,
      creadoEn: serverTimestamp(),
      creadoPor: state.user?.email || null,
      actualizadoEn: serverTimestamp()
    });

    // 2) si hay foto -> sube a storage y guarda URL
    if(file){
      const path = `bodegas/${state.bodegaId}/items/${itRef.id}/${Date.now()}_${file.name}`;
      const r = sRef(storage, path);

      await new Promise((resolve, reject)=>{
        const task = uploadBytesResumable(r, file);
        task.on('state_changed', null, reject, resolve);
      });

      const url = await getDownloadURL(r);
      await updateDoc(itRef, {
        fotoURL: url,
        fotoPath: path,
        actualizadoEn: serverTimestamp()
      });
    }

    // 3) crea movimiento inicial si unidades > 0
    if(unidades > 0){
      await addDoc(movsCol(state.bodegaId, itRef.id), {
        ts: serverTimestamp(),
        delta: +unidades,
        stock: unidades,
        by: state.user?.email || null,
        nota: 'Carga inicial'
      });
    }

    // reset form
    $('itNombre').value = '';
    $('itDesc').value = '';
    $('itUnidades').value = '0';
    $('itMinimo').value = '3';
    $('itFoto').value = '';

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

function wireFilters(){
  $('btnRefrescar').onclick = loadItems;
  $('txtSearch').oninput = renderItems;
  $('selFiltroStock').onchange = renderItems;

  $('btnVerMovimientos').onclick = async ()=>{
    if(!state.bodegaId) return;
    $('movBackdrop').style.display = 'flex';
    $('movTbody').innerHTML = '<tr><td colspan="6" class="muted">Cargando...</td></tr>';

    try{
      const moves = await fetchMovimientosUltimos(state.bodegaId, 200);
      renderMovimientos(moves);
    }catch(e){
      console.error(e);
      $('movTbody').innerHTML = '<tr><td colspan="6" class="muted">Error cargando movimientos.</td></tr>';
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

  // search
  if(q){
    items = items.filter(it=>{
      const a = (it.nombre || '').toLowerCase();
      const b = (it.descripcion || '').toLowerCase();
      return a.includes(q) || b.includes(q);
    });
  }

  // filter stock
  if(f === 'low'){
    items = items.filter(it => safeNum(it.unidades,0) <= safeNum(it.minimo,3) && safeNum(it.unidades,0) > 0);
  }else if(f === 'zero'){
    items = items.filter(it => safeNum(it.unidades,0) === 0);
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
  const unidades = safeNum(it.unidades,0);
  const minimo  = safeNum(it.minimo,3);

  const card = document.createElement('div');
  card.className = 'item';

  // badges
  let badgeClass = 'good';
  let badgeText = 'OK';
  if(unidades === 0){ badgeClass='bad'; badgeText='STOCK 0'; }
  else if(unidades <= minimo){ badgeClass='warn'; badgeText='BAJO'; }

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
          <span class="badge">ID: ${it.id.slice(0,6)}…</span>
        </div>
      </div>
    </div>

    <div class="bottom">
      <div>
        <div class="mini">UNIDADES</div>
        <div class="qty">
          <button class="btn small" data-act="dec">−</button>
          <span>${unidades}</span>
          <button class="btn small" data-act="inc">+</button>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end;">
        <button class="btn small" data-act="ajuste">Ajuste</button>
        <button class="btn small" data-act="editar">Editar</button>
        <button class="btn small danger" data-act="borrar">Borrar</button>
      </div>
    </div>
  `;

  // actions
  card.querySelector('[data-act="inc"]').onclick = ()=> changeStock(it, +1, 'Ingreso +1');
  card.querySelector('[data-act="dec"]').onclick = ()=> changeStock(it, -1, 'Salida -1');

  card.querySelector('[data-act="ajuste"]').onclick = async ()=>{
    const v = prompt(`Ajuste de stock para "${it.nombre}"\n\nIngresa el NUEVO stock total (ej: 25):`, String(unidades));
    if(v === null) return;
    const nuevo = Math.max(0, safeNum(v, unidades));
    const delta = nuevo - unidades;
    if(delta === 0) return toast('Sin cambios.');

    const nota = prompt('Nota (opcional):', 'Ajuste manual') || 'Ajuste manual';
    await changeStock(it, delta, nota);
  };

  card.querySelector('[data-act="editar"]').onclick = ()=> editItem(it);
  card.querySelector('[data-act="borrar"]').onclick = ()=> deleteItem(it);

  return card;
}

async function changeStock(it, delta, nota='Movimiento'){
  if(!state.bodegaId) return;

  const unidades = safeNum(it.unidades,0);
  const nuevo = unidades + delta;

  if(nuevo < 0){
    toast('No puedes dejar stock negativo.');
    return;
  }

  try{
    setEstado('Guardando movimiento...');

    // update item stock
    await updateDoc(itemDoc(state.bodegaId, it.id), {
      unidades: nuevo,
      actualizadoEn: serverTimestamp()
    });

    // add movement log
    await addDoc(movsCol(state.bodegaId, it.id), {
      ts: serverTimestamp(),
      delta,
      stock: nuevo,
      by: state.user?.email || null,
      nota: nota || ''
    });

    // update local state
    it.unidades = nuevo;
    // también actualiza en array base
    const idx = state.items.findIndex(x=>x.id===it.id);
    if(idx>=0) state.items[idx].unidades = nuevo;

    renderItems();
    toast(`Stock actualizado: ${nuevo}`);
    setEstado('Listo.');
  }catch(err){
    console.error(err);
    toast('Error actualizando stock.');
    setEstado('Error.');
  }
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

  const ok = confirm(`¿Borrar "${it.nombre}"?\n\nEsto eliminará el ítem del inventario.\n(La foto también se intentará borrar del Storage).`);
  if(!ok) return;

  try{
    setEstado('Borrando ítem...');

    // intenta borrar foto storage si hay path
    if(it.fotoPath){
      try{
        await deleteObject(sRef(storage, it.fotoPath));
      }catch(e){
        // no bloquea: puede fallar si no existe o permisos
        console.warn('No se pudo borrar foto en Storage:', e);
      }
    }

    // borra doc item (nota: no borra subcolección movimientos automáticamente)
    // para borrado total, habría que correr una Cloud Function o script admin.
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

/* =========================
   6) Bodegas: crear
========================= */
$('btnCrearBodega').addEventListener('click', async ()=>{
  const nombre = $('bdNombre').value.trim();
  if(!nombre){
    toast('Escribe el nombre de la bodega.');
    return;
  }

  try{
    setEstado('Creando bodega...');
    await addDoc(collection(db, COL_BODEGAS), {
      nombre,
      creadoEn: serverTimestamp(),
      creadoPor: state.user?.email || null,
      activo: true
    });

    $('bdNombre').value = '';
    toast('Bodega creada ✅');
    await loadBodegasIntoSelect();
    await loadItems();
    setEstado('Listo.');
  }catch(e){
    console.error(e);
    toast('Error creando bodega.');
    setEstado('Error.');
  }
});

/* =========================
   7) Movimientos modal
========================= */
function renderMovimientos(moves){
  const tb = $('movTbody');
  tb.innerHTML = '';

  if(!moves.length){
    tb.innerHTML = '<tr><td colspan="6" class="muted">Sin movimientos.</td></tr>';
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

/* =========================
   8) Small utils
========================= */
function escapeHtml(str){
  return String(str ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}
