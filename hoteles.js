import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc, setDoc, 
  serverTimestamp, query, where, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

let hoteles = [], grupos = [], asignaciones = [];
let isEditHotel = false, editHotelId = null;
let isEditAssign = false, editAssignId = null;
let currentUserEmail = null;
let choiceDestino = null, choiceGrupo = null;
let swapMode = false;
let swapFirstAssignId = null;

function fmtFechaCorta(iso) {
  const d = new Date(iso + 'T00:00:00');
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Utilitarios
const toUpper = x => typeof x==='string'?x.toUpperCase():x;
function fmtFecha(iso) {
  if(!iso) return '';
  const d=new Date(iso+'T00:00:00');
  return d.toLocaleDateString('es-CL',{
    weekday:'long',day:'2-digit',month:'long',year:'numeric'
  }).replace(/^\w/,c=>c.toUpperCase());
}

// ─── Inicialización ─────────────────────────────────────
onAuthStateChanged(getAuth(app), user=>{
  if(!user) return location.href='login.html';
  currentUserEmail = user.email;
  init();
});

async function init(){
  // 1) Carga grupos y destinos
  await loadGrupos();
  // 2) Prepara los selects del modal hotel
  setupHotelModal();
  // 3) Prepara los selects del modal asignar
  setupAssignModal();
  // 4) Conecta UI
  bindUI();
  // 5) Render general
  await loadAsignaciones();
  await renderHoteles();
}

// ─── Carga Grupos y extrae Destinos únicos ─────────────
async function loadGrupos() {
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  // Destinos únicos
  const destinos = [...new Set(grupos.map(g=>g.destino))];

  const elDestino = document.getElementById('m-destino');

  // ✅ Inicializa una sola vez
  if (!choiceDestino) {
    choiceDestino = new Choices(elDestino, { searchEnabled:false });
  } else {
    // si ya existe, limpiamos las opciones
    choiceDestino.clearChoices();
  }

  // ✅ repone opciones (replace = true)
  choiceDestino.setChoices(
    destinos.map(d => ({ value:d, label: toUpper(d) })),
    'value','label', true
  );
}

// ─── Carga todas las asignaciones ──────────────────────
async function loadAsignaciones(){
  const snap = await getDocs(collection(db,'hotelAssignments'));
  asignaciones = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// ─── UI principal ──────────────────────────────────────
function bindUI(){
  document.getElementById('search-input')
    .addEventListener('input',e=>filterHoteles(e.target.value));
  document.getElementById('btnAddHotel')
    .addEventListener('click',()=>openHotelModal(null));
  document.getElementById('btnHistorial')
    .addEventListener('click',showHistorialModal);
  document.getElementById('btnExportExcel')
    .addEventListener('click',exportToExcel);
  document.getElementById('hist-close')
    .addEventListener('click',closeHistorialModal);
  document.getElementById('occ-close')
    .addEventListener('click',closeOccupancyModal);

  // backdrop cierra
  document.body.addEventListener('click',e=>{
    if(e.target.classList.contains('modal-backdrop'))
      hideModals();
  },true);
}

function hideModals(){
  document.querySelectorAll('.modal, .modal-backdrop')
    .forEach(el=>el.style.display='none');
}

// ─── Modal Crear/Editar Hotel ──────────────────────────
function setupHotelModal(){
  document.getElementById('modal-cancel')
    .addEventListener('click',closeHotelModal);
  document.getElementById('modal-form')
    .addEventListener('submit',onSubmitHotel);

  // Botón interno que abre el modal de asignar
  document.getElementById('btnOpenAssign')
    .addEventListener('click',()=>{
      if(!editHotelId) return alert('Guarda primero el hotel');
      openAssignModal(editHotelId,null);
    });
}

function filterHoteles(q){
  const terms = q.toLowerCase().split(',').map(t=>t.trim()).filter(Boolean);
  document.querySelectorAll('.hotel-card').forEach(card=>{
    const txt=card.textContent.toLowerCase();
    card.style.display = (!terms.length||terms.some(t=>txt.includes(t)))?'':'none';
  });
}

async function renderHoteles() {
  const cont = document.getElementById('hoteles-container');
  cont.innerHTML = '';

  // 1️⃣ Cargar hoteles desde Firestore
  const snapH = await getDocs(collection(db, 'hoteles'));
  hoteles = snapH.docs.map(d => ({ id: d.id, ...d.data() }));

  for (const h of hoteles) {
    // 2️⃣ Filtrar asignaciones de este hotel
    const asigns = asignaciones.filter(a => a.hotelId === h.id);

    // 2.1 Cabecera de hotel
    let html = `
      <h3>${toUpper(h.nombre)}</h3>
      <div class="subtitulo">DESTINO: ${toUpper(h.destino)}</div>
      <div class="subsubtitulo">
        DISPONIBILIDAD: ${fmtFecha(h.fechaInicio)} → ${fmtFecha(h.fechaFin)}
      </div>
    `;

    // 2.2 Cada bloque de grupo asignado (igual que vuelos)
    for (const a of asigns) {
      const g = grupos.find(x => x.id === a.grupoId);
      if (!g) {
        html += `<div class="group-block group-missing">
          <div class="group-header" style="color:red;">
            Grupo eliminado o no encontrado (ID: ${a.grupoId})
          </div>
          <div class="group-dates">
            CHEQ IN: ${fmtFechaCorta(a.checkIn)}
            CHEQ OUT: ${fmtFechaCorta(a.checkOut)}
          </div>
        </div>`;
        continue;
      }
      const adSum = a.adultos.M + a.adultos.F + a.adultos.O;
      const esSum = a.estudiantes.M + a.estudiantes.F + a.estudiantes.O;
      const totalSinCoord = adSum + esSum;

      html += `
        <div class="group-block">
          <div class="group-header" style="gap: 0.5em; flex-wrap: wrap;">
            <span>
              <strong>${g.numeroNegocio} - ${g.identificador} — ${toUpper(g.nombreGrupo)}</strong>
              &nbsp; PAX: ${totalSinCoord}
              (A:${a.adultos.M}/${a.adultos.F}/${a.adultos.O}
               – E:${a.estudiantes.M}/${a.estudiantes.F}/${a.estudiantes.O})
              + ${a.coordinadores} Coord. + ${a.conductores || 0} Cond.
            </span>
            <span class="status-cell" style="display: flex; align-items: center; gap: .5em;">
              <span class="status-ico" style="font-size:1.2em;">
                ${a.status === 'confirmado' ? '✅' : '🕗'}
              </span>
              <span class="status-txt" style="font-weight:bold; color:${a.status==='confirmado' ? '#28a745' : '#da9a00'};">
                ${a.status === 'confirmado' ? 'CONFIRMADO' : 'PENDIENTE'}
              </span>
              <span class="by-email" style="font-size:0.92em;color:#666;">
                ${a.changedBy || ''}
              </span>
              <button class="btn-small" style="margin-left:0.5em;" data-act="togA" data-id="${a.id}">🔄</button>
              <button class="btn-small" data-act="editA" data-id="${a.id}" data-hid="${h.id}">✏️</button>
              <button class="btn-small" data-act="delA"  data-id="${a.id}">🗑️</button>
              <button class="btn-small" data-act="swapA" data-id="${a.id}">🚀</button>
            </span>
          </div>
          <div class="group-dates">
            CHEQ IN: ${fmtFechaCorta(a.checkIn)}
            CHEQ OUT: ${fmtFechaCorta(a.checkOut)}
            (${a.noches} noches)
          </div>
        </div>
      `;
    }

    // 2.3 Acciones generales del hotel
    html += `
      <div style="margin-top:.7em;">
        <button class="btn-small" data-act="editH"   data-id="${h.id}">✏️ EDITAR</button>
        <button class="btn-small" data-act="assignH" data-id="${h.id}">🔗 ASIGNAR</button>
        <button class="btn-small" data-act="delH"    data-id="${h.id}">🗑️ ELIMINAR</button>
        <button class="btn-small" data-act="espH"    data-id="${h.id}">🧩 ESPECIALES</button>
        <button class="btn-small" data-act="occH"    data-id="${h.id}">📊 OCUPACIÓN</button>        
      </div>
    `;

    // 2.4 Render de la tarjeta
    const card = document.createElement('div');
    card.className = 'hotel-card';
    card.innerHTML = html;
    cont.appendChild(card);
  }

  // 3️⃣ Delegar todos los botones
  cont.querySelectorAll('.btn-small, .btn-status').forEach(btn => {
    const act = btn.dataset.act, id = btn.dataset.id;
    if (act === 'editH')   btn.onclick = () => openHotelModal(hoteles.find(x => x.id === id));
    if (act === 'assignH') btn.onclick = () => openAssignModal(id, null);
    if (act === 'delH')    btn.onclick = () => deleteHotel(id);
    if (act === 'editA')   btn.onclick = () => openAssignModal(btn.dataset.hid || null, id);
    if (act === 'delA')    btn.onclick = () => deleteAssign(id);
    if (act === 'occH')    btn.onclick = () => openOccupancyModal(id);
    if (act === 'espH')    btn.onclick = () => openSpecialsModal(id);
    if (act === 'togA')    btn.onclick = () => toggleAssignStatus(id);
    if (act === 'swapA') btn.onclick = () => handleSwapClick(id, btn);
  });

  // 4️⃣ Reaplicar filtro
  filterHoteles(document.getElementById('search-input').value);
}

function handleSwapClick(assignId, btn) {
  // Si ya estamos en modo swap y hay uno seleccionado:
  if (swapMode && swapFirstAssignId && swapFirstAssignId !== assignId) {
    const first = asignaciones.find(a => a.id === swapFirstAssignId);
    const second = asignaciones.find(a => a.id === assignId);
    if (!first || !second) return;
    // Realiza el swap
    swapAssignments(first, second);
    // Limpia visual y estado
    swapMode = false;
    swapFirstAssignId = null;
    document.querySelectorAll('.btn-small.selected-swap').forEach(b => b.classList.remove('selected-swap'));
  } else {
    // Selecciona el primero
    swapMode = true;
    swapFirstAssignId = assignId;
    // Marca botón
    document.querySelectorAll('.btn-small.selected-swap').forEach(b => b.classList.remove('selected-swap'));
    btn.classList.add('selected-swap');
  }
}

// Quita selección si se hace click fuera
document.body.addEventListener('click', e => {
  if (!e.target.classList.contains('btn-small') || e.target.dataset.act !== 'swapA') {
    swapMode = false;
    swapFirstAssignId = null;
    document.querySelectorAll('.btn-small.selected-swap').forEach(b => b.classList.remove('selected-swap'));
  }
}, true);

async function swapAssignments(a1, a2) {
  // Intercambia hotelId, fechas, noches, etc. Mantiene grupoId y los datos de pasajeros originales
  const { hotelId: h1, checkIn: in1, checkOut: out1, noches: n1 } = a1;
  const { hotelId: h2, checkIn: in2, checkOut: out2, noches: n2 } = a2;

  // Swapea hotel y fechas
  await updateDoc(doc(db, 'hotelAssignments', a1.id), {
    hotelId: h2, checkIn: in2, checkOut: out2, noches: n2
  });
  await updateDoc(doc(db, 'hotelAssignments', a2.id), {
    hotelId: h1, checkIn: in1, checkOut: out1, noches: n1
  });

  // Historial
  await addDoc(collection(db, 'historial'), {
    tipo: 'swap-assign',
    ids: [a1.id, a2.id],
    antes: { a1, a2 },
    despues: {
      a1: { ...a1, hotelId: h2, checkIn: in2, checkOut: out2, noches: n2 },
      a2: { ...a2, hotelId: h1, checkIn: in1, checkOut: out1, noches: n1 }
    },
    usuario: currentUserEmail,
    ts: serverTimestamp()
  });

  await loadAsignaciones();
  await renderHoteles();
}


// 5️⃣ Agrega al final (o donde estén tus helpers) esta función para alternar el status:
async function toggleAssignStatus(assignId) {
  // 1) Buscar la asignación
  const a = asignaciones.find(x=>x.id===assignId);
  if(!a) return;
  // 2) Nuevo valor
  const nuevo = a.status==='pendiente' ? 'confirmado' : 'pendiente';
  // 3) Guardar en Firestore
  await updateDoc(doc(db,'hotelAssignments',assignId),{ status: nuevo, changedBy: currentUserEmail });
  // 4) Registrar en historial
  await addDoc(collection(db,'historial'),{
    tipo: 'assign-status',
    docId: assignId,
    antes: a,
    despues: { ...a, status: nuevo },
    usuario: currentUserEmail,
    ts: serverTimestamp()
  });
  // 5) Recargar UI
  await loadAsignaciones();
  await renderHoteles();
}
  
// abrir/cerrar Hotel
function openHotelModal(h){
  isEditHotel = !!h; editHotelId = h?.id ?? null;
  document.getElementById('modal-title').textContent =
    isEditHotel?'EDITAR HOTEL':'NUEVO HOTEL';

  ['m-nombre','m-direccion','m-fechaInicio','m-fechaFin','m-singles','m-dobles','m-triples','m-cuadruples']
    .forEach(id=> document.getElementById(id).value = h?.[id.slice(2)] ?? '');
  choiceDestino.setChoiceByValue([h?.destino]||[]);
  document.getElementById('m-contactoNombre').value   = h?.contactoNombre   ?? '';
  document.getElementById('m-contactoCorreo').value   = h?.contactoCorreo   ?? '';
  document.getElementById('m-contactoTelefono').value = h?.contactoTelefono ?? '';

  document.getElementById('modal-backdrop').style.display='block';
  document.getElementById('modal-hotel').style.display  ='block';
}

function closeHotelModal(){ hideModals(); }

// guardar Hotel
async function onSubmitHotel(e){
  e.preventDefault();
  const p = {
    nombre:document.getElementById('m-nombre').value.trim(),
    destino:document.getElementById('m-destino').value,
    direccion:document.getElementById('m-direccion').value.trim(),
    contactoNombre:document.getElementById('m-contactoNombre').value.trim(),
    contactoCorreo:document.getElementById('m-contactoCorreo').value.trim(),
    contactoTelefono:document.getElementById('m-contactoTelefono').value.trim(),
    fechaInicio:document.getElementById('m-fechaInicio').value,
    fechaFin:   document.getElementById('m-fechaFin').value,
    singles:   +document.getElementById('m-singles').value||0,
    dobles:    +document.getElementById('m-dobles').value||0,
    triples:   +document.getElementById('m-triples').value||0,
    cuadruples:+document.getElementById('m-cuadruples').value||0
  };
  if(isEditHotel){
    const bef=(await getDoc(doc(db,'hoteles',editHotelId))).data();
    await updateDoc(doc(db,'hoteles',editHotelId),p);
    await addDoc(collection(db,'historial'),{
      tipo:'hotel-edit',hotelId:editHotelId,
      antes:bef,despues:p,usuario:currentUserEmail,ts:serverTimestamp()
    });
  } else {
    const ref=await addDoc(collection(db,'hoteles'),p);
    await addDoc(collection(db,'historial'),{
      tipo:'hotel-new',hotelId:ref.id,
      antes:null,despues:p,usuario:currentUserEmail,ts:serverTimestamp()
    });
  }
  await renderHoteles();
  hideModals();
}

// eliminar hotel
async function deleteHotel(id){
  if(!confirm('¿Eliminar hotel?'))return;
  const bef=(await getDoc(doc(db,'hoteles',id))).data();
  await deleteDoc(doc(db,'hoteles',id));
  await addDoc(collection(db,'historial'),{
    tipo:'hotel-del',hotelId:id,
    antes:bef,despues:null,usuario:currentUserEmail,ts:serverTimestamp()
  });
  await renderHoteles();
}

// ─── Modal Asignar Grupo ────────────────────────────────
function setupAssignModal(){
  const selGrupo = document.getElementById('a-grupo');

  // ✅ Inicializa una sola vez
  if (!choiceGrupo) {
    choiceGrupo = new Choices(selGrupo, { removeItemButton:false });
  }

  document.getElementById('assign-cancel')
    .addEventListener('click', closeAssignModal);
  document.getElementById('assign-form')
    .addEventListener('submit', onSubmitAssign);

  // Recalcular noches al cambiar fechas
  ['a-checkin','a-checkout'].forEach(id=>{
    document.getElementById(id).addEventListener('change', () => {
      const ci = document.getElementById('a-checkin').value;
      const co = document.getElementById('a-checkout').value;
      const noches = Math.round((new Date(co) - new Date(ci)) / (1000*60*60*24));
      document.getElementById('a-noches').value = noches;
    });
  });
}

function openAssignModal(hotelId, assignId){
  isEditAssign = !!assignId;

  // si vienes desde editar y no mandaron hotelId, recupéralo de la asignación
  if (!hotelId && assignId) {
    const ex = asignaciones.find(x => x.id === assignId);
    hotelId = ex?.hotelId || null;
  }
  editHotelId  = hotelId;
  editAssignId = assignId;

  // 1) opciones del grupo (filtradas por destino si hay hotel)
  const hotel = hoteles.find(h => h.id === editHotelId);
  const dest  = hotel?.destino;
  const candidatos = dest
    ? grupos.filter(g => g.destino === dest || (g.destino||'').includes(dest))
    : grupos.slice();

  choiceGrupo.clearChoices();
  choiceGrupo.setChoices(
    candidatos.map(g => ({
      value: g.id,
      label: `${g.numeroNegocio} – ${g.identificador} - ${g.nombreGrupo} (${g.cantidadgrupo} pax)`
    })),
    'value','label', true
  );

  // 2) reset UI base
  const form = document.getElementById('assign-form');
  form.reset();
  choiceGrupo.removeActiveItems();
  document.getElementById('assign-title').textContent =
    isEditAssign ? 'Editar Asignación' : 'Nueva Asignación';
  document.getElementById('a-conductores').value = '0';

  // 3) onchange del select (con guardia para no sobrescribir al cargar)
  let filling = false;
  const selGrupo = document.getElementById('a-grupo');
  selGrupo.onchange = (e) => {
    if (filling) return; // ⛔ no toques nada mientras estoy cargando
    const gid = e.target.value;
    const g   = grupos.find(x=>x.id===gid) || {};

    // topes y rótulos
    document.getElementById('max-adultos').textContent     = g.adultos    ?? 0;
    document.getElementById('max-estudiantes').textContent = g.estudiantes?? 0;
    document.getElementById('grupo-fechas').textContent =
      `Rango: ${fmtFechaCorta(g.fechaInicio)} → ${fmtFechaCorta(g.fechaFin)}`;

    // límites de fecha (NO sobreescribo valores si ya existen)
    const ci = document.getElementById('a-checkin');
    const co = document.getElementById('a-checkout');
    ci.min = g.fechaInicio; ci.max = g.fechaFin;
    co.min = g.fechaInicio; co.max = g.fechaFin;
    if (!ci.value) ci.value = g.fechaInicio;
    if (!co.value) co.value = g.fechaFin;

    document.getElementById('a-noches').value =
      Math.round((new Date(co.value)-new Date(ci.value))/(1000*60*60*24));

    // totales “de referencia” del grupo
    document.getElementById('g-adultos').value       = g.adultos ?? 0;
    document.getElementById('g-estudiantes').value   = g.estudiantes ?? 0;
    document.getElementById('g-cantidadgrupo').value = g.cantidadgrupo ?? g.cantidadGrupo ?? 0;
  };

  // 4) si es edición, rellenar TODO desde Firestore
  if (isEditAssign) {
    filling = true;
    const a = asignaciones.find(x=>x.id===assignId);

    // seleccionar el grupo (debe existir en choices)
    choiceGrupo.setChoiceByValue([a.grupoId]);

    // pinta topes/labels del grupo (sin tocar valores por el guardia)
    selGrupo.onchange({ target: { value: a.grupoId } });

    // fechas/noches
    document.getElementById('a-checkin').value  = a.checkIn;
    document.getElementById('a-checkout').value = a.checkOut;
    document.getElementById('a-noches').value   =
      a.noches ?? Math.round((new Date(a.checkOut)-new Date(a.checkIn))/(1000*60*60*24));

    // pax por sexo
    document.getElementById('a-ad-M').value = a.adultos?.M ?? 0;
    document.getElementById('a-ad-F').value = a.adultos?.F ?? 0;
    document.getElementById('a-ad-O').value = a.adultos?.O ?? 0;
    document.getElementById('a-es-M').value = a.estudiantes?.M ?? 0;
    document.getElementById('a-es-F').value = a.estudiantes?.F ?? 0;
    document.getElementById('a-es-O').value = a.estudiantes?.O ?? 0;

    // totales del grupo (campos “Adultos totales / Estudiantes / Pasajeros”)
    const g = grupos.find(x=>x.id===a.grupoId) || {};
    document.getElementById('g-adultos').value       = g.adultos       ?? a.adultosTotal      ?? 0;
    document.getElementById('g-estudiantes').value   = g.estudiantes   ?? a.estudiantesTotal  ?? 0;
    document.getElementById('g-cantidadgrupo').value = (g.cantidadgrupo ?? g.cantidadGrupo) ?? a.cantidadgrupo ?? 0;

    // habitaciones
    const hab = a.habitaciones || {};
    document.getElementById('a-singles').value    = hab.singles    ?? 0;
    document.getElementById('a-dobles').value     = hab.dobles     ?? 0;
    document.getElementById('a-triples').value    = hab.triples    ?? 0;
    document.getElementById('a-cuadruples').value = hab.cuadruples ?? 0;

    // staff
    document.getElementById('a-coordinadores').value = a.coordinadores ?? 0;
    document.getElementById('a-conductores').value   = a.conductores   ?? 0;

    filling = false;
  } else {
    // creación: dispara para pintar topes del grupo elegido
    selGrupo.onchange({ target: selGrupo });
  }

  // 5) abrir modal y enganchar validaciones
  document.getElementById('assign-backdrop').style.display='block';
  document.getElementById('modal-assign').style.display='block';

  ['a-singles','a-dobles','a-triples','a-cuadruples','a-ad-M','a-ad-F','a-ad-O','a-es-M','a-es-F','a-es-O']
    .forEach(id => { document.getElementById(id).oninput = chequearHabitacionesVsPax; });
  chequearHabitacionesVsPax();
}

function closeAssignModal(){ hideModals(); }

function chequearHabitacionesVsPax() {
  const singles    = Number(document.getElementById('a-singles').value)    || 0;
  const dobles     = Number(document.getElementById('a-dobles').value)     || 0;
  const triples    = Number(document.getElementById('a-triples').value)    || 0;
  const cuadruples = Number(document.getElementById('a-cuadruples').value) || 0;
  const paxHab = singles*1 + dobles*2 + triples*3 + cuadruples*4;
  const adSum = ['M','F','O'].reduce((sum, k) => sum + Number(document.getElementById(`a-ad-${k}`).value), 0);
  const esSum = ['M','F','O'].reduce((sum, k) => sum + Number(document.getElementById(`a-es-${k}`).value), 0);
  const totalPax = adSum + esSum;

  let aviso = '';
  if (paxHab > 0 && paxHab !== totalPax) {
    aviso = `⚠️ Atención: El total de personas en habitaciones (${paxHab}) no coincide con el total de pasajeros asignados (${totalPax}).`;
  }
  const avisoDiv = document.getElementById('habitaciones-aviso');
  avisoDiv.textContent = aviso;
  avisoDiv.style.display = aviso ? 'block' : 'none';
}


// guardar asignación
async function onSubmitAssign(e) {
  e.preventDefault();
  
  // fallback para no perder el hotel en edición
  const existing     = isEditAssign ? asignaciones.find(x => x.id === editAssignId) : null;
  const hotelIdFinal = isEditAssign ? (editHotelId || existing?.hotelId) : editHotelId;

  // 1️⃣ Recuperar datos del grupo
  const gId = document.getElementById('a-grupo').value;
  if (!gId) {
    alert('Selecciona un grupo');
    return;
  }
  // Datos generales desde inputs editables:
  const newAdultos      = Number(document.getElementById('g-adultos').value);
  const newEstudiantes  = Number(document.getElementById('g-estudiantes').value);
  const newCantidad     = Number(document.getElementById('g-cantidadgrupo').value);

  // Sumar adultos y estudiantes de asignación (por sexo)
  const adSum = ['M','F','O']
    .reduce((sum, k) => sum + Number(document.getElementById(`a-ad-${k}`).value), 0);
  const esSum = ['M','F','O']
    .reduce((sum, k) => sum + Number(document.getElementById(`a-es-${k}`).value), 0);

  // VALIDACIÓN PRINCIPAL: Suma adultos+estudiantes == cantidadgrupo
  if (newAdultos + newEstudiantes !== newCantidad) {
    return alert(`La suma de adultos (${newAdultos}) y estudiantes (${newEstudiantes}) debe ser igual a pasajeros totales (${newCantidad}). Corrige los datos.`);
  }

  // Ahora, la asignación NO puede asignar más de lo que los valores dicen
  if (adSum !== newAdultos) {
    return alert(`Debes asignar exactamente ${newAdultos} adultos (la suma de sexos no coincide).`);
  }
  if (esSum !== newEstudiantes) {
    return alert(`Debes asignar exactamente ${newEstudiantes} estudiantes (la suma de sexos no coincide).`);
  }

  // No puedes asignar más pax en habitaciones que adultos+estudiantes
  const singles    = Number(document.getElementById('a-singles').value)    || 0;
  const dobles     = Number(document.getElementById('a-dobles').value)     || 0;
  const triples    = Number(document.getElementById('a-triples').value)    || 0;
  const cuadruples = Number(document.getElementById('a-cuadruples').value) || 0;
  const paxHab = singles*1 + dobles*2 + triples*3 + cuadruples*4;
  if (paxHab > 0 && paxHab !== (newAdultos + newEstudiantes)) {
    return alert(`El total de personas en habitaciones (${paxHab}) no coincide con el total de adultos + estudiantes (${newAdultos + newEstudiantes}).`);
  }

  // ---- Sync de los datos generales hacia el documento del GRUPO ----
  const gRef    = doc(db, 'grupos', gId);
  const gSnap   = await getDoc(gRef);
  const gBefore = gSnap.data() || {};
  
  const gUpdate = {
    adultos:       newAdultos,
    estudiantes:   newEstudiantes,
    // mantengo ambas keys por compatibilidad con tu código
    cantidadgrupo: newCantidad,
    cantidadGrupo: newCantidad
  };
  
  await updateDoc(gRef, gUpdate);
  
  // Historial de la sincronización con grupos (opcional pero recomendado)
  await addDoc(collection(db,'historial'),{
    tipo:    'grupo-update-from-assign',
    grupoId: gId,
    antes: {
      adultos:       gBefore.adultos ?? 0,
      estudiantes:   gBefore.estudiantes ?? 0,
      cantidadgrupo: (gBefore.cantidadgrupo ?? gBefore.cantidadGrupo ?? 0)
    },
    despues: gUpdate,
    usuario: currentUserEmail,
    ts:      serverTimestamp()
  });

  // Construir el payload para Firestore
  const payload = {
    hotelId:   hotelIdFinal,
    grupoId:   gId,
    checkIn:   document.getElementById('a-checkin').value,
    checkOut:  document.getElementById('a-checkout').value,
    noches:    Number(document.getElementById('a-noches').value),
    adultos: {
      M: Number(document.getElementById('a-ad-M').value),
      F: Number(document.getElementById('a-ad-F').value),
      O: Number(document.getElementById('a-ad-O').value)
    },
    estudiantes: {
      M: Number(document.getElementById('a-es-M').value),
      F: Number(document.getElementById('a-es-F').value),
      O: Number(document.getElementById('a-es-O').value)
    },
    coordinadores: Number(document.getElementById('a-coordinadores').value),
    conductores: Number(document.getElementById('a-conductores').value),
    habitaciones: { singles, dobles, triples, cuadruples },
    ts:            serverTimestamp(),
    // NUEVO: Guarda los datos generales editados en el assignment
    adultosTotal: newAdultos,
    estudiantesTotal: newEstudiantes,
    cantidadgrupo: newCantidad,
    status: 'confirmado',
    changedBy: currentUserEmail
  };

  // Guardar/actualizar en Firestore + historial
  if (isEditAssign) {
    const before = asignaciones.find(a => a.id === editAssignId);
    await updateDoc(doc(db, 'hotelAssignments', editAssignId), payload);
    await addDoc(collection(db, 'historial'), {
      tipo:    'assign-edit',
      docId:   editAssignId,
      antes:   before,
      despues: payload,
      usuario: currentUserEmail,
      ts:      serverTimestamp()
    });
  } else {
    const ref = await addDoc(collection(db, 'hotelAssignments'), payload);
    await addDoc(collection(db, 'historial'), {
      tipo:    'assign-new',
      docId:   ref.id,
      antes:   null,
      despues: payload,
      usuario: currentUserEmail,
      ts:      serverTimestamp()
    });
  }

  // Refrescar UI y cerrar modales
  await loadAsignaciones();
  await loadGrupos();
  await renderHoteles();
  hideModals();
}



// eliminar asignación
async function deleteAssign(id){
  if(!confirm('¿Eliminar asignación?'))return;
  const bef = asignaciones.find(x=>x.id===id);
  await deleteDoc(doc(db,'hotelAssignments',id));
  await addDoc(collection(db,'historial'),{
    tipo:'assign-del', docId:id,
    antes:bef, despues:null,
    usuario:currentUserEmail, ts:serverTimestamp()
  });
  await loadAsignaciones();
  await renderHoteles();
}

// ─── HISTORIAL ─────────────────────────────────────────
function showHistorialModal(){
  document.getElementById('hist-backdrop').style.display='block';
  document.getElementById('hist-modal').style.display='block';
  loadHistorial();
}
function closeHistorialModal(){ hideModals(); }
async function loadHistorial(){
  const tbody=document.querySelector('#hist-table tbody');
  tbody.innerHTML='';
  const start=document.getElementById('hist-start').value;
  const end  =document.getElementById('hist-end').value;
  const snap=await getDocs(query(collection(db,'historial'),orderBy('ts','desc')));
  snap.docs.forEach(dSnap=>{
    const d=dSnap.data(), ts=d.ts?.toDate();
    if(start && ts<new Date(start+'T00:00:00'))return;
    if(end && ts>new Date(end+'T23:59:59'))return;
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>${ts?ts.toLocaleString('es-CL'):''}</td>
      <td>${d.usuario||''}</td>
      <td>${d.docId||''}</td>
      <td>${d.tipo||''}</td>
      <td>${d.antes?JSON.stringify(d.antes):''}</td>
      <td>${d.despues?JSON.stringify(d.despues):''}</td>`;
    tbody.appendChild(tr);
  });
}

// ─── OCUPACIÓN ──────────────────────────────────────────
function formateaFechaBonita(iso) {
  // Devuelve 02-12-2025
  const d = new Date(iso + 'T00:00:00');
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function openOccupancyModal(hotelId) {
  const h = hoteles.find(x => x.id === hotelId);
  const occ = asignaciones.filter(a => a.hotelId === hotelId);

  document.getElementById('occ-header').innerHTML =
    `<strong>${h.nombre}</strong> — ${fmtFecha(h.fechaInicio)}→${fmtFecha(h.fechaFin)}`;

  const start = new Date(h.fechaInicio), end = new Date(h.fechaFin), rows = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);

    // Sólo asignaciones confirmadas que ocupan esa noche
    const dayAss = occ.filter(a =>
      a.checkIn <= iso && iso < a.checkOut && a.status === "confirmado"
    );

    const gruposCount = dayAss.length;

    const totals = dayAss.reduce((acc, a) => {
      acc.adultos.M     += Number(a.adultos?.M || 0);
      acc.adultos.F     += Number(a.adultos?.F || 0);
      acc.adultos.O     += Number(a.adultos?.O || 0);
      acc.estudiantes.M += Number(a.estudiantes?.M || 0);
      acc.estudiantes.F += Number(a.estudiantes?.F || 0);
      acc.estudiantes.O += Number(a.estudiantes?.O || 0);
      acc.coordinadores += Number(a.coordinadores || 0);
      acc.conductores   += Number(a.conductores   || 0);   // ← NUEVO
      acc.grupos.push(a.grupoId);
      return acc;
    }, {
      adultos: { M: 0, F: 0, O: 0 },
      estudiantes: { M: 0, F: 0, O: 0 },
      coordinadores: 0,
      conductores: 0,                                        // ← NUEVO
      grupos: []
    });

    const totalPax  = totals.adultos.M + totals.adultos.F + totals.adultos.O
                    + totals.estudiantes.M + totals.estudiantes.F + totals.estudiantes.O;

    const totalFull = totalPax + totals.coordinadores + totals.conductores; // ← CAMBIO

    // Habitaciones ocupadas
    const hab = { singles:0, dobles:0, triples:0, cuadruples:0 };
    dayAss.forEach(a => {
      const hh = a.habitaciones || {};
      hab.singles    += Number(hh.singles    || 0);
      hab.dobles     += Number(hh.dobles     || 0);
      hab.triples    += Number(hh.triples    || 0);
      hab.cuadruples += Number(hh.cuadruples || 0);
    });

    rows.push({ iso, gruposCount, totals, totalPax, totalFull, grupos: totals.grupos, hab });
  }

  // Render tabla (agregamos columna "Cond." y renombramos el total)
  const tbl = document.getElementById('occ-table');
  tbl.innerHTML = `
    <thead>
      <tr>
        <th>Fecha</th>
        <th>Grupos</th>
        <th>A M/F/O</th>
        <th>E M/F/O</th>
        <th>Habitaciones Ocupadas</th>
        <th>Total Pax</th>
        <th>Coord.</th>
        <th>Cond.</th>                 <!-- NUEVO -->
        <th>Total+Coord.+Cond.</th>    <!-- CAMBIO -->
      </tr>
    </thead>
    <tbody>
      ${rows.map((r, idx) => `
        <tr>
          <td>${formateaFechaBonita(r.iso)}</td>
          <td class="celda-detalle-grupos" data-idx="${idx}" style="cursor:pointer; color:#007bff; text-decoration:underline;">
            ${r.gruposCount}
          </td>
          <td>(${r.totals.adultos.M + r.totals.adultos.F + r.totals.adultos.O})
              ${r.totals.adultos.M} | ${r.totals.adultos.F} | ${r.totals.adultos.O}</td>
          <td>(${r.totals.estudiantes.M + r.totals.estudiantes.F + r.totals.estudiantes.O})
              ${r.totals.estudiantes.M} | ${r.totals.estudiantes.F} | ${r.totals.estudiantes.O}</td>
          <td>S: ${r.hab.singles} | D: ${r.hab.dobles} | T: ${r.hab.triples} | C: ${r.hab.cuadruples}</td>
          <td>${r.totalPax}</td>
          <td>${r.totals.coordinadores}</td>
          <td>${r.totals.conductores}</td>  <!-- NUEVO -->
          <td>${r.totalFull}</td>
        </tr>
      `).join('')}
    </tbody>
  `;

  // Detalle emergente de grupos (igual que antes)
  tbl.querySelectorAll('.celda-detalle-grupos').forEach(td => {
    td.addEventListener('click', () => {
      const idx = td.dataset.idx;
      const r = rows[idx];
      if (!r.grupos.length) return showFloatingDetail(td, "Sin grupos ese día");
      const detalles = r.grupos.map(gid => {
        const g = grupos.find(x => x.id === gid);
        return g ? `<div>(${g.numeroNegocio}) ${g.nombreGrupo}</div>` : `<div>Grupo eliminado</div>`;
      }).join('');
      showFloatingDetail(td, detalles);
    });
  });

  document.getElementById('occ-backdrop').style.display = 'block';
  document.getElementById('modal-occupancy').style.display = 'block';
}

// **Ventana flotante para el detalle de grupos**
function showFloatingDetail(td, html) {
  // Quita anterior si hay
  document.querySelectorAll('.detalle-grupos-popup').forEach(e => e.remove());
  const div = document.createElement('div');
  div.className = 'detalle-grupos-popup';
  div.innerHTML = html;
  Object.assign(div.style, {
    position: 'absolute',
    zIndex: 2000,
    background: '#fff',
    border: '1px solid #007bff',
    boxShadow: '0 2px 12px #007bff33',
    padding: '1em',
    borderRadius: '7px',
    left: (td.getBoundingClientRect().left + window.scrollX) + 'px',
    top: (td.getBoundingClientRect().bottom + window.scrollY) + 'px',
    minWidth: '200px'
  });
  document.body.appendChild(div);
  // Cierra al hacer clic fuera
  const cerrar = (e) => {
    if (!div.contains(e.target)) {
      div.remove();
      document.removeEventListener('mousedown', cerrar);
    }
  };
  setTimeout(()=>document.addEventListener('mousedown', cerrar),50);
}

function closeOccupancyModal(){ hideModals(); }

// ─── EXPORTAR EXCEL (mejorado) ─────────────────────────
function exportToExcel() {
  const safeNum = v => Number(v || 0);

  // Mapa: hotelId -> asignaciones de ese hotel
  const asignPorHotel = new Map();
  hoteles.forEach(h => {
    asignPorHotel.set(h.id, asignaciones.filter(a => a.hotelId === h.id));
  });

  // ---------- RESUMEN POR HOTEL ----------
  const resumen = hoteles.map(h => {
    const as = asignPorHotel.get(h.id) || [];

    const gruposCount = as.length;

    const adTotal = as.reduce((s, a) =>
      s + safeNum(a.adultos?.M) + safeNum(a.adultos?.F) + safeNum(a.adultos?.O), 0);
    const esTotal = as.reduce((s, a) =>
      s + safeNum(a.estudiantes?.M) + safeNum(a.estudiantes?.F) + safeNum(a.estudiantes?.O), 0);
    const pax = adTotal + esTotal;

    const coord = as.reduce((s, a) => s + safeNum(a.coordinadores), 0);
    const cond  = as.reduce((s, a) => s + safeNum(a.conductores),   0);
    const totalStaff = pax + coord + cond;

    const singles = as.reduce((s, a) => s + safeNum(a.habitaciones?.singles),    0);
    const dobles  = as.reduce((s, a) => s + safeNum(a.habitaciones?.dobles),     0);
    const triples = as.reduce((s, a) => s + safeNum(a.habitaciones?.triples),    0);
    const cuads   = as.reduce((s, a) => s + safeNum(a.habitaciones?.cuadruples), 0);

    const noches  = as.reduce((s, a) => s + safeNum(a.noches), 0);
    const rnS = as.reduce((s, a) => s + safeNum(a.habitaciones?.singles)    * safeNum(a.noches), 0);
    const rnD = as.reduce((s, a) => s + safeNum(a.habitaciones?.dobles)     * safeNum(a.noches), 0);
    const rnT = as.reduce((s, a) => s + safeNum(a.habitaciones?.triples)    * safeNum(a.noches), 0);
    const rnC = as.reduce((s, a) => s + safeNum(a.habitaciones?.cuadruples) * safeNum(a.noches), 0);

    const fechas = as.flatMap(a => [a.checkIn, a.checkOut]).filter(Boolean);
    const asignDesde = fechas.length ? fechas.reduce((m, f) => f < m ? f : m) : '';
    const asignHasta = fechas.length ? fechas.reduce((M, f) => f > M ? f : M) : '';

    return {
      Hotel: h.nombre,
      Destino: h.destino,
      'Dispon. desde': h.fechaInicio,
      'Dispon. hasta': h.fechaFin,
      'Asign. desde': asignDesde,
      'Asign. hasta': asignHasta,
      Grupos: gruposCount,
      'Adultos': adTotal,
      'Estudiantes': esTotal,
      'PAX Totales': pax,
      Coordinadores: coord,
      Conductores: cond,
      'Total+Staff': totalStaff,
      Singles: singles,
      Dobles: dobles,
      Triples: triples,
      Cuádruples: cuads,
      'Noches asignadas': noches,
      'RoomNights S': rnS,
      'RoomNights D': rnD,
      'RoomNights T': rnT,
      'RoomNights C': rnC
    };
  }).sort((a,b)=> (a.Destino||'').localeCompare(b.Destino||'') || (a.Hotel||'').localeCompare(b.Hotel||''));

  // ---------- DETALLE DE ASIGNACIONES ----------
  const detalle = [];
  hoteles.forEach(h => {
    const as = asignPorHotel.get(h.id) || [];
    as.forEach(a => {
      const g = grupos.find(x => x.id === a.grupoId) || {};
      const adM = safeNum(a.adultos?.M), adF = safeNum(a.adultos?.F), adO = safeNum(a.adultos?.O);
      const esM = safeNum(a.estudiantes?.M), esF = safeNum(a.estudiantes?.F), esO = safeNum(a.estudiantes?.O);
      const adSum = adM + adF + adO;
      const esSum = esM + esF + esO;
      const pax   = adSum + esSum;

      detalle.push({
        Hotel: h.nombre,
        Destino: h.destino,
        Grupo: g.numeroNegocio,
        NombreGrupo: g.nombreGrupo,
        Identificador: g.identificador,
        CheckIn: a.checkIn,
        CheckOut: a.checkOut,
        Noches: safeNum(a.noches),
        'Adultos M': adM, 'Adultos F': adF, 'Adultos O': adO,
        'Estudiantes M': esM, 'Estudiantes F': esF, 'Estudiantes O': esO,
        'Adultos Totales': adSum,
        'Estudiantes Totales': esSum,
        'PAX Totales': pax,
        Coordinadores: safeNum(a.coordinadores),
        Conductores: safeNum(a.conductores),
        'Total+Staff': pax + safeNum(a.coordinadores) + safeNum(a.conductores),
        Singles: safeNum(a.habitaciones?.singles),
        Dobles:  safeNum(a.habitaciones?.dobles),
        Triples: safeNum(a.habitaciones?.triples),
        Cuádruples: safeNum(a.habitaciones?.cuadruples),
        Estado: a.status
      });
    });
  });

  // ---------- Excel: crear libro y hojas ----------
  const wb  = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(resumen);
  const ws2 = XLSX.utils.json_to_sheet(detalle);

  // Autofiltro y ancho de columnas
  function fitToColumn(rows){
    if (!rows.length) return [];
    const headers = Object.keys(rows[0]);
    const widths = headers.map(h => Math.max(h.length, ...rows.map(r => String(r[h] ?? '').length)) + 2);
    return widths.map(w => ({ wch: w }));
  }
  function setAutofilter(ws, rows){
    if(!rows.length) return;
    const cols = Object.keys(rows[0]).length;
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:rows.length, c:cols-1} }) };
  }
  ws1['!cols'] = fitToColumn(resumen);
  ws2['!cols'] = fitToColumn(detalle);
  setAutofilter(ws1, resumen);
  setAutofilter(ws2, detalle);

  XLSX.utils.book_append_sheet(wb, ws1, 'Resumen_Hoteles');
  XLSX.utils.book_append_sheet(wb, ws2, 'Detalle_Asignaciones');

  const fecha = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, `distribucion_hotelera_${fecha}.xlsx`);
}

// ============================
// ESPECIALES (Conductores/Coord)
// ============================

// Capacidad por tipo
const CAP = { C:4, T:3, D:2, S:1 };

// Parsea prioridad "CTDS" -> ['C','T','D','S']
function parsePrioridad(code) {
  return code.split('');
}

// Greedy: empaqueta 'n' personas siguiendo prioridad (C/T/D/S)
function packRooms(n, prioridad = ['C','T','D','S']) {
  const out = { C:0, T:0, D:0, S:0 };
  let rem = Number(n||0);
  if (rem <= 0) return out;

  for (const typ of prioridad) {
    const cap = CAP[typ];
    if (!cap) continue;
    const k = Math.floor(rem / cap);
    if (k > 0) {
      out[typ] += k;
      rem -= k * cap;
    }
  }
  if (rem > 0) {
    // Lo que reste, singles
    out.S += rem;
    rem = 0;
  }
  return out;
}

// Suma 2 packs {C,T,D,S}
function addPack(a, b) {
  return { C:a.C+b.C, T:a.T+b.T, D:a.D+b.D, S:a.S+b.S };
}

// Formatea pack a "C:1 T:0 D:2 S:0"
function packStr(p) {
  return `C:${p.C} T:${p.T} D:${p.D} S:${p.S}`;
}

// Recorre fechas [start..end] inclusive
function* eachDateISO(startISO, endISO) {
  const d = new Date(startISO+'T00:00:00');
  const end = new Date(endISO+'T00:00:00');
  for (; d<=end; d.setDate(d.getDate()+1)) {
    yield d.toISOString().slice(0,10);
  }
}

// Calcula conteos diarios por categoría (conductores, coordM, coordF)
function calcDailyStaffForHotel(hotelId) {
  // filtro asignaciones del hotel y confirmadas
  const occ = asignaciones.filter(a => a.hotelId === hotelId && a.status === 'confirmado');
  // mapa iso -> { cond, coordM, coordF }
  const daily = new Map();
  // necesitamos rango usando el hotel
  const h = hoteles.find(x=>x.id===hotelId);
  if (!h) return { daily, start: null, end: null };
  const start = h.fechaInicio, end = h.fechaFin;

  for (const iso of eachDateISO(start, end)) {
    daily.set(iso, { cond:0, coordM:0, coordF:0, raw:[] });
  }

  for (const a of occ) {
    for (const [iso, rec] of daily) {
      if (a.checkIn <= iso && iso < a.checkOut) {
        const cond = Number(a.conductores || 0);
        const cm   = Number(a.coordM || 0); // opcional si los agregas a futuro
        const cf   = Number(a.coordF || 0); // opcional si los agregas a futuro
        let cTot   = Number(a.coordinadores || 0);

        // Si hay M/F específicos, úsalos; si no, deja todo en 'cTot'
        const useMF = (cm + cf) > 0;
        rec.cond   += cond;
        rec.coordM += useMF ? cm : 0;
        rec.coordF += useMF ? cf : 0;
        // coordinadores sin sexo → los listamos como "raw" para avisar
        if (!useMF && cTot>0) rec.raw.push({grupoId:a.grupoId, sinSexo:cTot});

        // Si quieres forzar algo: podrías repartir sinSexo entre M/F aquí.
      }
    }
  }

  return { daily, start, end };
}

// Segmenta por cambios: devuelve [{start,end,packCond,packCM,packCF}]
function buildSegmentedPlan(daily, prioridad) {
  const entries = [...daily.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  if (!entries.length) return [];

  const segs = [];
  let segStart = entries[0][0];
  let prevKey  = null;
  let prevVal  = null;

  function packRec(rec) {
    return {
      cond : packRooms(rec.cond, prioridad),
      cm   : packRooms(rec.coordM, prioridad),
      cf   : packRooms(rec.coordF, prioridad),
    };
  }

  for (const [iso, rec] of entries) {
    const pk = JSON.stringify([rec.cond, rec.coordM, rec.coordF]);
    if (prevKey === null) {
      prevKey = pk;
      prevVal = packRec(rec);
      segStart = iso;
    } else if (pk !== prevKey) {
      // cerramos segmento anterior
      segs.push({ start: segStart, end: prevISO(iso), packs: prevVal });
      // reabrimos
      prevKey = pk;
      prevVal = packRec(rec);
      segStart = iso;
    }
  }
  // último
  const lastISO = entries[entries.length-1][0];
  segs.push({ start: segStart, end: lastISO, packs: prevVal });
  return segs;
}

function prevISO(iso) {
  const d = new Date(iso+'T00:00:00'); d.setDate(d.getDate()-1);
  return d.toISOString().slice(0,10);
}

// Plan estático: toma el máximo diario en todo el rango
function buildStaticPlan(daily, prioridad) {
  let max = { cond:0, coordM:0, coordF:0 };
  for (const [, rec] of daily) {
    if (rec.cond   > max.cond)   max.cond = rec.cond;
    if (rec.coordM > max.coordM) max.coordM = rec.coordM;
    if (rec.coordF > max.coordF) max.coordF = rec.coordF;
  }
  const packs = {
    cond : packRooms(max.cond, prioridad),
    cm   : packRooms(max.coordM, prioridad),
    cf   : packRooms(max.coordF, prioridad),
  };
  // Un único segmento: todo el rango
  const entries = [...daily.keys()].sort();
  if (!entries.length) return [];
  return [{ start: entries[0], end: entries[entries.length-1], packs }];
}

// Expande segmentos a día a día para pintar la tabla
function expandPlanToDaily(segs) {
  const byDay = new Map();
  for (const seg of segs) {
    for (const iso of eachDateISO(seg.start, seg.end)) {
      byDay.set(iso, {
        cond: seg.packs.cond,
        cm:   seg.packs.cm,
        cf:   seg.packs.cf
      });
    }
  }
  return byDay;
}

// Render modal ESPECIALES
async function openSpecialsModal(hotelId) {
  const h = hoteles.find(x=>x.id===hotelId);
  if (!h) return;
  document.getElementById('spec-title').innerHTML =
    `Especiales — <strong>${h.nombre}</strong> (${fmtFecha(h.fechaInicio)}→${fmtFecha(h.fechaFin)})`;

  // Eventos básicos
  document.getElementById('spec-close').onclick = closeSpecialsModal;
  document.getElementById('spec-recalc').onclick = () => calcAndRenderSpecials(hotelId);
  document.getElementById('spec-save').onclick   = () => saveSpecialsPlan(hotelId);

  // Abre modal
  document.getElementById('spec-backdrop').style.display='block';
  document.getElementById('modal-specials').style.display='block';

  // Primera carga
  await calcAndRenderSpecials(hotelId);
}

function closeSpecialsModal() {
  document.getElementById('spec-backdrop').style.display='none';
  document.getElementById('modal-specials').style.display='none';
}

// Hace el cálculo según modo y prioridad seleccionados y lo pinta
async function calcAndRenderSpecials(hotelId) {
  const modo   = document.getElementById('spec-modo').value;         // 'estatico' | 'segmentado'
  const prc    = parsePrioridad(document.getElementById('spec-prioridad').value); // ['C','T','D','S']
  const { daily, start, end } = calcDailyStaffForHotel(hotelId);

  // Avisos por coordinadores sin sexo
  const warns = [];
  for (const [iso, rec] of daily) {
    if (rec.raw && rec.raw.length) {
      warns.push(`• ${iso}: ${rec.raw.reduce((s,r)=>s+r.sinSexo,0)} coord. sin sexo (grupos: ${rec.raw.map(r=>r.grupoId).join(', ')})`);
    }
  }
  document.getElementById('spec-warnings').innerHTML =
    warns.length ? (`<div><strong>Atención:</strong><br>${warns.join('<br>')}</div>`) : '';

  // Construye plan
  const segs = (modo === 'estatico')
    ? buildStaticPlan(daily, prc)
    : buildSegmentedPlan(daily, prc);

  // Render resumen por segmentos
  const sumHtml = segs.map(s => `
    <div style="padding:.4rem; border:1px solid #eee; border-radius:6px; margin:.3rem 0;">
      <strong>${fmtFechaCorta(s.start)}</strong> → <strong>${fmtFechaCorta(s.end)}</strong>
      <div>Conductores: ${packStr(s.packs.cond)}</div>
      <div>Coord. M:    ${packStr(s.packs.cm)}</div>
      <div>Coord. F:    ${packStr(s.packs.cf)}</div>
    </div>
  `).join('') || '<em>Sin datos para este rango.</em>';
  document.getElementById('spec-summary').innerHTML = sumHtml;

  // Render tabla diaria
  const dailyPlan = expandPlanToDaily(segs);
  const rows = [];
  // Asegura orden por fecha
  const allDays = [...daily.keys()].sort();
  for (const iso of allDays) {
    const pack = dailyPlan.get(iso) || { cond:{C:0,T:0,D:0,S:0}, cm:{C:0,T:0,D:0,S:0}, cf:{C:0,T:0,D:0,S:0} };
    rows.push(`
      <tr>
        <td>${formateaFechaBonita(iso)}</td>
        <td>${packStr(pack.cond)}</td>
        <td>${packStr(pack.cm)}</td>
        <td>${packStr(pack.cf)}</td>
      </tr>
    `);
  }
  document.querySelector('#spec-table tbody').innerHTML = rows.join('');

  // Guarda plan actual en memoria para botón Guardar
  window.__lastSpecialsPlan__ = { hotelId, modo, prioridad: prc, segs, start, end };
}

// Guarda el plan en Firestore (1 documento por hotel)
async function saveSpecialsPlan(hotelId) {
  const plan = window.__lastSpecialsPlan__;
  if (!plan || plan.hotelId !== hotelId) {
    alert('No hay plan calculado para guardar.');
    return;
  }
  const payload = {
    hotelId,
    ts: serverTimestamp(),
    createdBy: currentUserEmail,
    prefs: {
      modo: plan.modo,
      prioridad: plan.prioridad.join('')
    },
    plan: plan.segs.map(s => ({
      start: s.start,
      end: s.end,
      cond: s.packs.cond,
      coordM: s.packs.cm,
      coordF: s.packs.cf
    }))
  };

  // Un doc por hotelId (para poder sobreescribir/recalcular)
  await setDoc(doc(db,'hotelSpecials', hotelId), payload, { merge:true });

  await addDoc(collection(db,'historial'),{
    tipo: 'specials-save',
    hotelId,
    plan: payload,
    usuario: currentUserEmail,
    ts: serverTimestamp()
  });

  alert('Plan de “ESPECIALES” guardado.');
}
