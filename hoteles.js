import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

let hoteles          = [];
let grupos           = [];
let isEdit           = false;
let editId           = null;
let currentUserEmail = null;
let choiceGrupos     = null;

// Utilitarios
const toUpper = x => typeof x==='string'?x.toUpperCase():x;
function fmtFecha(iso) {
  if(!iso) return '';
  const dt = new Date(iso+'T00:00:00');
  return dt.toLocaleDateString('es-CL', {
    weekday:'long', day:'2-digit', month:'long', year:'numeric'
  }).replace(/^\w/, c=>c.toUpperCase());
}

// Autenticación e init
const auth = getAuth(app);
onAuthStateChanged(auth, user => {
  if(!user) return location.href='login.html';
  currentUserEmail = user.email;
  init();
});

async function init() {
  await loadGrupos();
  setupUI();
  setupModal();
  await renderHoteles();
  hideAllModals();
}

async function loadGrupos() {
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// UI principal
function setupUI() {
  document.getElementById('search-input')
    .addEventListener('input', e=>filterHoteles(e.target.value));

  document.getElementById('btnAddHotel')
    .addEventListener('click', ()=>openHotelModal(null));
  document.getElementById('btnHistorial')
    .addEventListener('click', showHistorialModal);
  document.getElementById('btnExportExcel')
    .addEventListener('click', exportToExcel);

  document.getElementById('hist-close')
    .addEventListener('click', closeHistorialModal);
  document.getElementById('occ-close')
    .addEventListener('click', closeOccupancyModal);

  document.body.addEventListener('click', e=>{
    if(e.target.classList.contains('modal-backdrop'))
      hideAllModals();
  }, true);
}

function hideAllModals() {
  document.querySelectorAll('.modal-backdrop')
    .forEach(b=>b.style.display='none');
  document.querySelectorAll('.modal')
    .forEach(m=>m.style.display='none');
}

// Modal hotel
function setupModal() {
  // Choices.js
  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton:true }
  );

  document.getElementById('modal-cancel')
    .addEventListener('click', closeHotelModal);
  document.getElementById('modal-form')
    .addEventListener('submit', onSubmitHotel);
}

function filterHoteles(q) {
  const terms = q.toLowerCase().split(',').map(t=>t.trim()).filter(Boolean);
  document.querySelectorAll('.hotel-card').forEach(card=>{
    const txt = card.textContent.toLowerCase();
    card.style.display = (!terms.length || terms.some(t=>txt.includes(t)))?'':'none';
  });
}

async function renderHoteles() {
  const cont = document.getElementById('hoteles-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db,'hoteles'));
  hoteles = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  hoteles.forEach(h => {
    const card = document.createElement('div');
    card.className = 'hotel-card';

    // header
    const header = `
      <div class="encabezado-rojo">
        ${toUpper(h.nombre)} —
        ${fmtFecha(h.fechaInicio)} → ${fmtFecha(h.fechaFin)}
      </div>`;

    // grupos list
    const gruposHtml = (h.grupos||[]).map((gObj,idx)=>{
      const grp = grupos.find(x=>x.id===gObj.id)||{};
      const A=+grp.adultos||0, E=+grp.estudiantes||0, C=+grp.coordinadores||0;
      const tot=A+E+C;
      return `
      <div class="group-item">
        <div style="width:4em;font-weight:bold;">${toUpper(grp.numeroNegocio)}</div>
        <div style="flex:1;">
          <div>${tot} (A:${A} E:${E} C:${C})</div>
          <div style="font-size:.9em;color:#555;">
            ${fmtFecha(grp.fechaInicio)} → ${fmtFecha(grp.fechaFin)}
          </div>
        </div>
        <div class="status-cell">
          ${gObj.status==='confirmado'?'✅ CONFIRMADO':'🕗 PENDIENTE'}
        </div>
        <div style="display:flex;gap:.3em;">
          <button class="btn-small" data-action="assign" data-id="${h.id}">✏️</button>
          <button class="btn-small" data-action="remove" data-id="${h.id}" data-idx="${idx}">🗑️</button>
          <button class="btn-small" data-action="swap"   data-id="${h.id}" data-idx="${idx}">🔄</button>
        </div>
      </div>`;
    }).join('');

    // acciones principales
    const actions = `
      <div style="margin-top:.7em;">
        <button class="btn-small" data-action="assign" data-id="${h.id}">
          ✏️ ASIGNAR GRUPOS
        </button>
        <button class="btn-small" data-action="delete" data-id="${h.id}">
          🗑️ ELIMINAR
        </button>
        <button class="btn-small" data-action="occup" data-id="${h.id}">
          📊 OCUPACIÓN
        </button>
      </div>`;

    card.innerHTML = header + gruposHtml + actions;
    cont.appendChild(card);
  });

  // Delegación de eventos en container
  cont.querySelectorAll('.btn-small').forEach(btn=>{
    const act = btn.dataset.action;
    const id  = btn.dataset.id;
    const idx = btn.dataset.idx;
    if(act==='assign') {
      btn.onclick = ()=>openHotelModal(hoteles.find(x=>x.id===id));
    }
    if(act==='delete') {
      btn.onclick = ()=>deleteHotel(id);
    }
    if(act==='remove') {
      btn.onclick = ()=>removeGroup(id, Number(idx));
    }
    if(act==='swap') {
      btn.onclick = ()=>swapGroup(id, Number(idx));
    }
    if(act==='occup') {
      btn.onclick = ()=>openOccupancyModal(id);
    }
  });

  filterHoteles(document.getElementById('search-input').value);
}

function openHotelModal(h) {
  isEdit = !!h; editId = h?.id ?? null;
  document.getElementById('modal-title').textContent =
    isEdit ? `ASIGNAR GRUPOS — ${toUpper(h.nombre)}` : 'NUEVO HOTEL';

  // Campos básicos
  ['nombre','destino','direccion','fechaInicio','fechaFin','singles','dobles','triples','cuadruples']
    .forEach(k => {
      document.getElementById(`m-${k}`).value = h?.[k] ?? '';
    });
  document.getElementById('m-contactoNombre').value  = h?.contactoNombre  ?? '';
  document.getElementById('m-contactoCorreo').value  = h?.contactoCorreo  ?? '';
  document.getElementById('m-contactoTelefono').value= h?.contactoTelefono?? '';

  // Status default
  document.getElementById('m-statusDefault').value =
    h?.grupos?.[0]?.status ?? 'confirmado';

  // Multiselect solo en edición
  const grpCont = document.getElementById('m-grupos-container');
  if (isEdit) {
    grpCont.style.display = 'block';
    choiceGrupos.removeActiveItems();
    choiceGrupos.setChoiceByValue((h.grupos||[]).map(g=>g.id));
  } else {
    grpCont.style.display = 'none';
  }

  document.getElementById('modal-backdrop').style.display = 'block';
  document.getElementById('modal-hotel').style.display   = 'block';
}

async function onSubmitHotel(evt) {
  evt.preventDefault();

  const payload = {
    nombre:      toUpper(document.getElementById('m-nombre').value.trim()),
    destino:     toUpper(document.getElementById('m-destino').value.trim()),
    direccion:   toUpper(document.getElementById('m-direccion').value.trim()),
    contactoNombre:   toUpper(document.getElementById('m-contactoNombre').value.trim()),
    contactoCorreo:   document.getElementById('m-contactoCorreo').value.trim(),
    contactoTelefono: document.getElementById('m-contactoTelefono').value.trim(),
    fechaInicio: document.getElementById('m-fechaInicio').value,
    fechaFin:    document.getElementById('m-fechaFin').value,
    singles:   +document.getElementById('m-singles').value || 0,
    dobles:    +document.getElementById('m-dobles').value  || 0,
    triples:   +document.getElementById('m-triples').value || 0,
    cuadruples:+document.getElementById('m-cuadruples').value||0
  };

  if (isEdit) {
    const sel = choiceGrupos.getValue(true);
    const status0 = document.getElementById('m-statusDefault').value;
    payload.grupos = sel.map(id=>({
      id, status: status0, changedBy: currentUserEmail
    }));
  }

  if (isEdit) {
    const beforeSnap = await getDoc(doc(db,'hoteles',editId));
    const beforeData = beforeSnap.data();
    await updateDoc(doc(db,'hoteles',editId), payload);
    await addDoc(collection(db,'historial'),{
      tipo:'hotel-edit', hotelId:editId,
      antes:beforeData, despues:payload,
      usuario:currentUserEmail, ts:serverTimestamp()
    });
  } else {
    const ref = await addDoc(collection(db,'hoteles'), payload);
    await addDoc(collection(db,'historial'),{
      tipo:'hotel-new', hotelId:ref.id,
      antes:null, despues:payload,
      usuario:currentUserEmail, ts:serverTimestamp()
    });
  }

  hideAllModals();
  await renderHoteles();
}

async function deleteHotel(id) {
  if (!confirm('¿Eliminar hotel?')) return;
  const snap = await getDoc(doc(db,'hoteles',id));
  const before = snap.data();
  await deleteDoc(doc(db,'hoteles',id));
  await addDoc(collection(db,'historial'),{
    tipo:'hotel-del', hotelId:id,
    antes:before, despues:null,
    usuario:currentUserEmail, ts:serverTimestamp()
  });
  await renderHoteles();
}

window.removeGroup = async (hotelId, idx) => {
  const ref = doc(db,'hoteles',hotelId);
  const snap = await getDoc(ref);
  const data = snap.data();
  const before = data.grupos[idx];
  data.grupos.splice(idx,1);
  await updateDoc(ref,{ grupos:data.grupos });
  await addDoc(collection(db,'historial'),{
    tipo:'hotel-grupo-del', hotelId,
    antes, despues:null,
    usuario:currentUserEmail, ts:serverTimestamp()
  });
  await renderHoteles();
};

window.swapGroup = (hotelId, idx) => {
  console.warn('swapGroup: implementar intercambio');
};

window.showHistorialModal = () => {
  document.getElementById('hist-backdrop').style.display = 'block';
  document.getElementById('hist-modal').style.display     = 'block';
  loadHistorial();
};
window.closeHistorialModal = () => {
  document.getElementById('hist-backdrop').style.display = 'none';
  document.getElementById('hist-modal').style.display     = 'none';
};
async function loadHistorial() {
  const tbody = document.querySelector('#hist-table tbody');
  tbody.innerHTML = '';
  const start = document.getElementById('hist-start').value;
  const end   = document.getElementById('hist-end').value;
  const snap  = await getDocs(query(collection(db,'historial'),orderBy('ts','desc')));
  snap.docs.forEach(dSnap=>{
    const d = dSnap.data(), ts = d.ts?.toDate();
    if(start && ts<new Date(start+'T00:00:00')) return;
    if(end   && ts>new Date(end+'T23:59:59')) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ts?ts.toLocaleString('es-CL'):''}</td>
      <td>${d.usuario||''}</td>
      <td>${d.hotelId||''}</td>
      <td>${d.tipo||''}</td>
      <td>${d.antes?JSON.stringify(d.antes):''}</td>
      <td>${d.despues?JSON.stringify(d.despues):''}</td>`;
    tbody.appendChild(tr);
  });
}

window.openOccupancyModal = async hotelId => {
  const snap = await getDoc(doc(db,'hoteles',hotelId));
  const h    = { id:snap.id, ...snap.data() };
  document.getElementById('occ-header').innerHTML = `
    <strong>${h.nombre}</strong><br>
    ${fmtFecha(h.fechaInicio)} → ${fmtFecha(h.fechaFin)}`;
  const start = new Date(h.fechaInicio), end=new Date(h.fechaFin), days=[];
  for(let d=new Date(start); d<=end; d.setDate(d.getDate()+1)) days.push(new Date(d));
  const tbl = document.getElementById('occ-table');
  tbl.innerHTML = `
    <thead><tr><th>Fecha</th><th>Grupos</th><th>Pax</th></tr></thead>
    <tbody>${days.map(d=>{
      const iso=d.toISOString().slice(0,10);
      const arr=(h.grupos||[]).filter(gObj=>{
        const grp=grupos.find(x=>x.id===gObj.id)||{};
        return grp.fechaInicio<=iso&&iso<grp.fechaFin;
      });
      const numG=arr.length;
      const pax=arr.reduce((s,gObj)=>{
        const grp=grupos.find(x=>x.id===gObj.id)||{};
        return s+((+grp.adultos||0)+(+grp.estudiantes||0)+(+grp.coordinadores||0));
      },0);
      return `<tr><td>${iso}</td><td>${numG}</td><td>${pax}</td></tr>`;
    }).join('')}</tbody>`;
  document.getElementById('occ-backdrop').style.display    = 'block';
  document.getElementById('modal-occupancy').style.display = 'block';
};
window.closeOccupancyModal = ()=>{
  document.getElementById('occ-backdrop').style.display    ='none';
  document.getElementById('modal-occupancy').style.display='none';
};

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
