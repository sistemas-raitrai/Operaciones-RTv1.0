import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc,
  serverTimestamp, query, where, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

let hoteles = [], grupos = [], asignaciones = [];
let isEditHotel = false, editHotelId = null;
let isEditAssign = false, editAssignId = null;
let currentUserEmail = null;
let choiceDestino = null, choiceGrupo = null;

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
async function loadGrupos(){
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  // Destinos únicos
  const destinos = [...new Set(grupos.map(g=>g.destino))];
  choiceDestino = new Choices(
    document.getElementById('m-destino'),
    { searchEnabled:false }
  );
  choiceDestino.setChoices(
    destinos.map(d=>({ value:d, label:toUpper(d) })),
    'value','label', false
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

async function renderHoteles(){
  const cont = document.getElementById('hoteles-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db,'hoteles'));
  hoteles = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  for(const h of hoteles){
    // asignaciones de este hotel
    const asigns = asignaciones.filter(a=>a.hotelId===h.id);

    // HTML grupos asignados
    const htmlAsigns = asigns.map(a=>{
      const g = grupos.find(x=>x.id===a.grupoId) || {};
      const totAd = a.adultos.M + a.adultos.F + a.adultos.O;
      const totEs = a.estudiantes.M + a.estudiantes.F + a.estudiantes.O;
      return `
        <div class="group-item">
          <div style="width:4em;font-weight:bold;">
            ${toUpper(g.numeroNegocio)}
          </div>
          <div style="flex:1;">
            <div>
              Pax: A(${a.adultos.M}/${a.adultos.F}/${a.adultos.O})
                  E(${a.estudiantes.M}/${a.estudiantes.F}/${a.estudiantes.O})
                  C(${a.coordinadores})
            </div>
            <div style="font-size:.9em;color:#555;">
              ${a.checkIn} → ${a.checkOut} (${a.noches} noches)
            </div>
          </div>
          <div style="display:flex;gap:.3em;">
            <button class="btn-small" data-act="editA" data-id="${a.id}">✏️</button>
            <button class="btn-small" data-act="delA"  data-id="${a.id}">🗑️</button>
          </div>
        </div>`;
    }).join('');

    // Tarjeta hotel
    const card = document.createElement('div');
    card.className = 'hotel-card';
    card.innerHTML = `
      <div class="encabezado-rojo">
        ${toUpper(h.nombre)} —
        ${toUpper(h.destino)} —
        ${fmtFecha(h.fechaInicio)} → ${fmtFecha(h.fechaFin)}
      </div>
      ${htmlAsigns}
      <div style="margin-top:.7em;">
        <button class="btn-small" data-act="editH" data-id="${h.id}">✏️ EDITAR HOTEL</button>
        <button class="btn-small" data-act="assignH" data-id="${h.id}">🔗 ASIGNAR GRUPO</button>
        <button class="btn-small" data-act="delH"  data-id="${h.id}">🗑️ ELIMINAR HOTEL</button>
        <button class="btn-small" data-act="occH"  data-id="${h.id}">📊 OCUPACIÓN</button>
      </div>`;
    cont.appendChild(card);
  }
  
  // Delegación
  cont.querySelectorAll('.btn-small').forEach(b=>{
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'editH')   b.onclick = () => openHotelModal(hoteles.find(x=>x.id===id));
    if (act === 'assignH') b.onclick = () => openAssignModal(id, null);
    if (act === 'delH')    b.onclick = () => deleteHotel(id);
    if (act === 'editA')   b.onclick = () => openAssignModal(null, id);
    if (act === 'delA')    b.onclick = () => deleteAssign(id);
    if (act === 'occH')    b.onclick = () => openOccupancyModal(id);
  });

  // Finalmente reaplicas el filtro
  filterHoteles( document.getElementById('search-input').value );
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
  document.getElementById('m-statusDefault').value    = h?.statusDefault   ?? 'confirmado';

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
    cuadruples:+document.getElementById('m-cuadruples').value||0,
    statusDefault: document.getElementById('m-statusDefault').value
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
  // Choices para selector de grupos
  choiceGrupo = new Choices(
    document.getElementById('a-grupo'),
    { removeItemButton:false }
  );
  choiceGrupo.setChoices(
    grupos.map(g=>({
      value:g.id,
      label:`${g.numeroNegocio} – ${g.nombreGrupo}`
    })),
    'value','label', false
  );

    // Cuando cambio de grupo, guardo su cantidadGrupo para validación
  document.getElementById('a-grupo').addEventListener('change', e=>{
    const gid = e.target.value;
    const g = grupos.find(x=>x.id===gid);
    document.getElementById('max-pax').textContent = g?.cantidadGrupo || 0;

  document.getElementById('assign-cancel')
    .addEventListener('click',closeAssignModal);

  document.getElementById('assign-form')
    .addEventListener('submit',onSubmitAssign);

  // Al cambiar grupo, ajustamos fechas
  document.getElementById('a-grupo')
    .addEventListener('change',e=>{
      const gid=e.target.value;
      const g=grupos.find(x=>x.id===gid);
      if(!g) return;
      document.getElementById('grupo-fechas').textContent =
        `Rango: ${g.fechaInicio} → ${g.fechaFin}`;
      const ci = document.getElementById('a-checkin');
      const co = document.getElementById('a-checkout');
      ci.min = g.fechaInicio; ci.max = g.fechaFin;
      co.min = g.fechaInicio; co.max = g.fechaFin;
      ci.value = g.fechaInicio;
      co.value = g.fechaFin;
      document.getElementById('a-noches').value =
        (new Date(co.value)-new Date(ci.value))/(1000*60*60*24);
    });

  // Recalcula noches al cambiar fechas
  ['a-checkin','a-checkout'].forEach(id=>{
    document.getElementById(id).addEventListener('change',()=>{
      const ci=document.getElementById('a-checkin').value;
      const co=document.getElementById('a-checkout').value;
      const noches = (new Date(co)-new Date(ci))/(1000*60*60*24);
      document.getElementById('a-noches').value = noches;
    });
  });
}

function openAssignModal(hotelId, assignId){
  isEditAssign = !!assignId;
  editHotelId  = hotelId;
  editAssignId = assignId;
  document.getElementById('assign-title').textContent =
    isEditAssign ? 'Editar Asignación' : 'Nueva Asignación';

  // Si editamos, cargamos datos
  if(isEditAssign){
    const a = asignaciones.find(x=>x.id===assignId);
    choiceGrupo.setChoiceByValue([a.grupoId]);
    document.getElementById('a-checkin').value  = a.checkIn;
    document.getElementById('a-checkout').value = a.checkOut;
    document.getElementById('a-noches').value   = a.noches;
    document.getElementById('a-ad-M').value     = a.adultos.M;
    document.getElementById('a-ad-F').value     = a.adultos.F;
    document.getElementById('a-ad-O').value     = a.adultos.O;
    document.getElementById('a-es-M').value     = a.estudiantes.M;
    document.getElementById('a-es-F').value     = a.estudiantes.F;
    document.getElementById('a-es-O').value     = a.estudiantes.O;
    document.getElementById('a-coordinadores').value = a.coordinadores;
  } else {
    document.getElementById('assign-form').reset();
    choiceGrupo.removeActiveItems();
  }

  document.getElementById('assign-backdrop').style.display='block';
  document.getElementById('modal-assign').style.display='block';
}

function closeAssignModal(){ hideModals(); }

// guardar asignación
async function onSubmitAssign(e) {
  e.preventDefault();

  // 1️⃣ Recuperar el grupo y su capacidad total
  const grupoId = document.getElementById('a-grupo').value;
  const grupo   = grupos.find(g => g.id === grupoId);
  const maxPax  = grupo?.cantidadGrupo || 0;

  // 2️⃣ Sumar adultos + estudiantes (sin diferenciar sexo)
  const sumaAdultos = ['M','F','O']
    .reduce((acc, k) => acc + Number(document.getElementById(`a-ad-${k}`).value), 0);
  const sumaEst    = ['M','F','O']
    .reduce((acc, k) => acc + Number(document.getElementById(`a-es-${k}`).value), 0);

  if (sumaAdultos + sumaEst > maxPax) {
    return alert(
      `No puedes asignar más pax de las que tiene el grupo.\n` +
      `Total adultos+estudiantes = ${sumaAdultos + sumaEst}, máximo = ${maxPax}`
    );
  }

  // 3️⃣ Si pasa la validación, construyes el payload
  const payload = {
    hotelId:   editHotelId,
    grupoId,
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
    changedBy:     currentUserEmail,
    ts:            serverTimestamp()
  };

  // 4️⃣ Guardado / edición en Firestore + historial
  if (isEditAssign) {
    const before = asignaciones.find(a => a.id === editAssignId);
    await updateDoc(doc(db, 'hotelAssignments', editAssignId), payload);
    await addDoc(collection(db,'historial'), {
      tipo:   'assign-edit',
      docId:  editAssignId,
      antes:  before,
      despues: payload,
      usuario: currentUserEmail,
      ts:      serverTimestamp()
    });
  } else {
    const ref = await addDoc(collection(db,'hotelAssignments'), payload);
    await addDoc(collection(db,'historial'), {
      tipo:   'assign-new',
      docId:  ref.id,
      antes:  null,
      despues: payload,
      usuario: currentUserEmail,
      ts:      serverTimestamp()
    });
  }

  // 5️⃣ Refrescar UI y cerrar modal
  await loadAsignaciones();
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
function openOccupancyModal(hotelId){
  const h = hoteles.find(x=>x.id===hotelId);
  const occ = asignaciones.filter(a=>a.hotelId===hotelId);

  document.getElementById('occ-header').innerHTML=`
    <strong>${h.nombre}</strong> — ${fmtFecha(h.fechaInicio)}→${fmtFecha(h.fechaFin)}`;

  // calcular días
  const start=new Date(h.fechaInicio), end=new Date(h.fechaFin), rows=[];
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
    const iso=d.toISOString().slice(0,10);
    const dayAss=occ.filter(a=>a.checkIn<=iso && iso<a.checkOut);
    const gruposCount=dayAss.length;
    const totals = dayAss.reduce((acc,a)=>{
      acc.adultos.M += a.adultos.M;
      acc.adultos.F += a.adultos.F;
      acc.adultos.O += a.adultos.O;
      acc.estudiantes.M += a.estudiantes.M;
      acc.estudiantes.F += a.estudiantes.F;
      acc.estudiantes.O += a.estudiantes.O;
      acc.coordinadores += a.coordinadores;
      return acc;
    },{
      adultos:{M:0,F:0,O:0},
      estudiantes:{M:0,F:0,O:0},
      coordinadores:0
    });
    rows.push({ iso, gruposCount, totals });
  }

  const tbl=document.getElementById('occ-table');
  tbl.innerHTML=`
    <thead>
      <tr>
        <th>Fecha</th>
        <th>Grupos</th>
        <th>A M/F/O</th>
        <th>E M/F/O</th>
        <th>C</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map(r=>`
        <tr>
          <td>${r.iso}</td>
          <td>${r.gruposCount}</td>
          <td>${r.totals.adultos.M}/${r.totals.adultos.F}/${r.totals.adultos.O}</td>
          <td>${r.totals.estudiantes.M}/${r.totals.estudiantes.F}/${r.totals.estudiantes.O}</td>
          <td>${r.totals.coordinadores}</td>
        </tr>`).join('')}
    </tbody>`;

  document.getElementById('occ-backdrop').style.display='block';
  document.getElementById('modal-occupancy').style.display='block';
}
function closeOccupancyModal(){ hideModals(); }

// ─── EXPORTAR EXCEL ─────────────────────────────────────
function exportToExcel() {
  const resumen = hoteles.map(h=>({
    Nombre:    h.nombre,
    Destino:   h.destino,
    Desde:     h.fechaInicio,
    Hasta:     h.fechaFin,
    Singles:   h.singles,
    Dobles:    h.dobles,
    Triples:   h.triples,
    Cuadruples:h.cuadruples,
    Grupos:    (h.grupos||[]).length
  }));
  const detalle=[];
  hoteles.forEach(h=>{
    (h.grupos||[]).forEach(gObj=>{
      const grp=grupos.find(x=>x.id===gObj.id)||{};
      detalle.push({
        Hotel:    h.nombre,
        Grupo:    grp.numeroNegocio,
        CheckIn:  grp.fechaInicio,
        CheckOut: grp.fechaFin,
        Estado:   gObj.status
      });
    });
  });
  const wb  = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(resumen);
  const ws2 = XLSX.utils.json_to_sheet(detalle);
  XLSX.utils.book_append_sheet(wb,ws1,'Resumen_Hoteles');
  XLSX.utils.book_append_sheet(wb,ws2,'Detalle_Grupos');
  XLSX.writeFile(wb,'distribucion_hotelera.xlsx');
}
