// viajes.js
// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection,
  getDocs,
  doc,
  getDoc,
  updateDoc,
  addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias DOM + estado
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contVuelos     = document.getElementById("vuelos-container");
const contTerrestres = document.getElementById("terrestres-container");
const btnAddVuelo    = document.getElementById("add-vuelo");
const btnAddTerrestre= document.getElementById("add-terrestre");

const modalBg        = document.getElementById("modal-backdrop");
const modal          = document.getElementById("modal-transporte");
const formModal      = document.getElementById("modal-form");

let editData = null; // { tipo, idx }

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initViajes();
});

async function initViajes() {
  const snap = await getDocs(collection(db,'grupos'));
  const grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  selectNum.innerHTML  = grupos.map(g=>
    `<option value="${g.id}">${g.numeroNegocio}</option>`
  ).join('');
  selectName.innerHTML = grupos.map(g=>
    `<option value="${g.id}">${g.nombreGrupo.toUpperCase()}</option>`
  ).join('');

  selectNum.onchange  = ()=>{ selectName.value=selectNum.value; renderTransportes(); };
  selectName.onchange = ()=>{ selectNum.value=selectName.value; renderTransportes(); };

  btnAddVuelo.onclick     = ()=> openModalTransporte({ tipo: 'aereo' }, false);
  btnAddTerrestre.onclick = ()=> openModalTransporte({ tipo: 'terrestre' }, false);
  formModal.onsubmit      = onSubmitModalTransporte;
  document.getElementById("modal-cancel").onclick = closeModal;

  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderTransportes(): pinta vuelos y tramos
// —————————————————————————————————
async function renderTransportes() {
  contVuelos.innerHTML = contTerrestres.innerHTML = '';
  const grupoId = selectNum.value;
  const refG = doc(db,'grupos',grupoId);
  const snapG = await getDoc(refG);
  const g = snapG.data() || {};

  titleGrupo.textContent = (g.nombreGrupo||"–").toUpperCase();

  // si no existe transportes, inicializar
  if (!g.transportes) {
    await updateDoc(refG,{ transportes: { aereos: [], terrestres: [] } });
    g.transportes = { aereos: [], terrestres: [] };
  }

  // — VUELOS —
  g.transportes.aereos.forEach((v, i) => {
    const card = document.createElement('div');
    card.className = 'activity-card';
    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numeroVuelo} (${v.tipoVuelo.toUpperCase()})</h4>
      <p>Ida: ${v.fechaIda} • Vuelta: ${v.fechaVuelta}</p>
      <p>👥 ${v.pasajeros} pax (A:${v.adultos} E:${v.estudiantes})</p>
      <div class="actions">
        <button class="btn-edit" data-tipo="aereo" data-idx="${i}">✏️</button>
        <button class="btn-del"  data-tipo="aereo" data-idx="${i}">🗑️</button>
      </div>
    `;
    card.querySelector('.btn-edit').onclick = ()=> openModalTransporte({ ...v, tipo:'aereo', idx:i }, true);
    card.querySelector('.btn-del').onclick  = ()=> deleteTransporte('aereos', i);
    contVuelos.appendChild(card);
  });

  // — TERRESTRES —
  g.transportes.terrestres.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'activity-card';
    card.innerHTML = `
      <h4>🚌 ${t.empresa}</h4>
      <p>${t.horaInicio} – ${t.horaFin}</p>
      <p>👥 ${t.pasajeros} pax (Cond: ${t.conductor1||'-'} / ${t.conductor2||'-'})</p>
      <div class="actions">
        <button class="btn-edit" data-tipo="terrestre" data-idx="${i}">✏️</button>
        <button class="btn-del"  data-tipo="terrestre" data-idx="${i}">🗑️</button>
      </div>
    `;
    card.querySelector('.btn-edit').onclick = ()=> openModalTransporte({ ...t, tipo:'terrestre', idx:i }, true);
    card.querySelector('.btn-del').onclick  = ()=> deleteTransporte('terrestres', i);
    contTerrestres.appendChild(card);
  });
}

// —————————————————————————————————
// 4) openModalTransporte(): precarga modal
// —————————————————————————————————
function openModalTransporte(data, isEdit) {
  editData = isEdit ? data : null;
  document.getElementById('modal-title').textContent = isEdit ? 'Editar Transporte' : 'Nuevo Transporte';

  // Tipo
  const tipoSelect = document.getElementById('m-tipo');
  tipoSelect.value = data.tipo;
  toggleFields(data.tipo);
  tipoSelect.onchange = e => toggleFields(e.target.value);

  // Campos específicos
  if (data.tipo === 'aereo') {
    document.getElementById('m-proveedor').value = data.proveedor||'';
    document.getElementById('m-vuelo-num').value = data.numeroVuelo||'';
    document.getElementById('m-fechaIda').value = data.fechaIda||'';
    document.getElementById('m-fechaVuelta').value = data.fechaVuelta||'';
    document.getElementById('m-tipoVuelo').value = data.tipoVuelo||'regular';
  } else {
    document.getElementById('m-empresa').value   = data.empresa||'';
    document.getElementById('m-horaInicio').value = data.horaInicio||'07:00';
    document.getElementById('m-horaFin').value    = data.horaFin|| sumarUnaHora('07:00');
    document.getElementById('m-conductor1').value = data.conductor1||'';
    document.getElementById('m-conductor2').value = data.conductor2||'';
  }
  document.getElementById('m-adultos').value     = data.adultos||0;
  document.getElementById('m-estudiantes').value = data.estudiantes||0;

  modalBg.style.display = modal.style.display = 'block';
}

function toggleFields(tipo) {
  document.getElementById('fields-aereo').style.display     = tipo==='aereo' ? 'block':'none';
  document.getElementById('fields-terrestre').style.display = tipo==='terrestre' ? 'block':'none';
}

function closeModal() {
  modalBg.style.display = modal.style.display = 'none';
}

// —————————————————————————————————
// 5) onSubmitModalTransporte(): guarda o actualiza
// —————————————————————————————————
async function onSubmitModalTransporte(evt) {
  evt.preventDefault();
  const grupoId = selectNum.value;
  const refG = doc(db,'grupos',grupoId);
  const snapG = await getDoc(refG);
  const g = snapG.data() || {};

  const tipo = document.getElementById('m-tipo').value;
  // construir payload
  let item = {};
  if (tipo==='aereo') {
    const a = parseInt(document.getElementById('m-adultos').value,10)||0;
    const e = parseInt(document.getElementById('m-estudiantes').value,10)||0;
    item = {
      tipo,
      proveedor:   document.getElementById('m-proveedor').value.trim().toUpperCase(),
      numeroVuelo: document.getElementById('m-vuelo-num').value.trim(),
      fechaIda:    document.getElementById('m-fechaIda').value,
      fechaVuelta: document.getElementById('m-fechaVuelta').value,
      tipoVuelo:   document.getElementById('m-tipoVuelo').value,
      adultos:     a,
      estudiantes: e,
      pasajeros:   a+e
    };
    var arr = g.transportes?.aereos || [];
  } else {
    const a = parseInt(document.getElementById('m-adultos').value,10)||0;
    const e = parseInt(document.getElementById('m-estudiantes').value,10)||0;
    item = {
      tipo,
      empresa:     document.getElementById('m-empresa').value.trim(),
      horaInicio:  document.getElementById('m-horaInicio').value,
      horaFin:     document.getElementById('m-horaFin').value,
      conductor1:  document.getElementById('m-conductor1').value.trim(),
      conductor2:  document.getElementById('m-conductor2').value.trim(),
      adultos:     a,
      estudiantes: e,
      pasajeros:   a+e
    };
    var arr = g.transportes?.terrestres || [];
  }

  if (!g.transportes) g.transportes = { aereos: [], terrestres: [] };

  if (editData) {
    arr[editData.idx] = item;
  } else {
    arr.push(item);
  }

  // persisto en Firestore
  const field = tipo==='aereo' ? 'transportes.aereos' : 'transportes.terrestres';
  await updateDoc(refG, { [field]: arr });
  closeModal();
  renderTransportes();
}

// —————————————————————————————————
// 6) deleteTransporte(): borra y recarga
// —————————————————————————————————
async function deleteTransporte(subcampo, idx) {
  if (!confirm('¿Eliminar este transporte?')) return;
  const grupoId = selectNum.value;
  const refG    = doc(db,'grupos',grupoId);
  const snapG   = await getDoc(refG);
  const g       = snapG.data()||{};
  const arr     = (g.transportes?.[subcampo]||[]);
  arr.splice(idx,1);
  await updateDoc(refG,{ [`transportes.${subcampo}`]: arr });
  renderTransportes();
}

// —————————————————————————————————
// Utilidades
// —————————————————————————————————
function sumarUnaHora(hhmm) {
  const [h,m] = hhmm.split(":").map(Number);
  const d     = new Date(); d.setHours(h+1,m);
  return d.toTimeString().slice(0,5);
}
