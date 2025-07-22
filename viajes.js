// viajes.js
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);
let grupos = [], vuelos = [];
let isEdit = false, editId = null;
let choiceGrupos;

// 1) Autenticación
onAuthStateChanged(auth, user => {
  if (!user) return location.href = 'login.html';
  init();
});

async function init() {
  await loadGrupos();
  bindUI();
  initModal();
  renderVuelos();
}

// 2) Carga grupos
async function loadGrupos() {
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// 3) Botón Nuevo Vuelo
function bindUI() {
  document.getElementById('btnAddVuelo')
    .onclick = () => openModal();
}

// 4) Inicializa Choices.js y enlaza modal
function initModal() {
  document.getElementById('modal-cancel')
    .onclick = closeModal;
  document.getElementById('modal-form')
    .onsubmit = onSubmit;

  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton: true }
  );
  choiceGrupos.setChoices(
    grupos.map(g=>({
      value: g.id,
      label: `${g.numeroNegocio} – ${g.nombreGrupo}`
    })), 'value','label', false
  );
}

// 5) Render de tarjetas con grid de 4 columnas y grupos clicables
async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';

  const snap = await getDocs(collection(db,'vuelos'));
  vuelos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  vuelos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'flight-card';

    // formateo de fechas unidas
    const fmt = d => {
      const D = new Date(d);
      return D.toLocaleDateString('es-CL',{
        weekday:'long', day:'2-digit',
        month:'long', year:'numeric'
      }).replace(/(^\w)/, m=>m.toUpperCase());
    };

    let adultos = 0, estudi = 0, adultosC = 0, estudiC = 0;

    // construyo las filas de grupos
    const gruposHtml = (v.grupos||[]).map((gObj, idx) => {
      const g = grupos.find(x=>x.id===gObj.id) || {};
      const a = g.adultos || 0, e = g.estudiantes || 0;
      adultos += a; estudi += e;
      const confirmado = gObj.status !== 'pendiente';
      if (confirmado) { adultosC += a; estudiC += e; }

      // <-- ESTE return está dentro del callback de map, ¡perfectamente legal!
      return `
        <div class="group-item">
          <div class="num">${g.numeroNegocio}</div>
          <div class="name">
            <span class="group-name"
                  onclick="openGroupModal('${g.id}')">
              ${g.nombreGrupo}
            </span>
            <span class="pax-inline">${a+e} (A:${a} E:${e})</span>
          </div>
          <div class="status-cell">
            <span>${confirmado?'✅ Confirmado':'🕗 Pendiente'}</span>
            <button class="btn-small"
                    onclick="toggleGroupStatus('${v.id}',${idx})">
              🔄
            </button>
          </div>
          <div class="delete-cell">
            <button class="btn-small"
                    onclick="removeGroup('${v.id}',${idx})">
              🗑️
            </button>
          </div>
        </div>`;
    }).join(''); // <-- join es llamado sobre el array de strings

    // aquí montas el HTML principal de la tarjeta
    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
      <p class="dates">
        Ida: ${fmt(v.fechaIda)}
        <span class="arrow">↔️</span>
        Vuelta: ${fmt(v.fechaVuelta)}
      </p>
      <div>${gruposHtml || '<p>— Sin grupos —</p>'}</div>
      <p>
        <strong>Total Pax:</strong> ${adultos+estudi}
        (A:${adultos} E:${estudi})
        – Pax Confirmados: ${adultosC+estudiC}
        (A:${adultosC} E:${estudiC})
      </p>
      <div class="actions">
        <button class="btn-add btn-edit">✏️ Editar</button>
        <button class="btn-add btn-del">🗑️ Eliminar</button>
      </div>`;

    cont.appendChild(card);

    // atar handlers de editar y eliminar
    card.querySelector('.btn-edit')
        .addEventListener('click', ()=> openModal(v));
    card.querySelector('.btn-del')
        .addEventListener('click', ()=> deleteVuelo(v.id));
  });
}

// 6) Abrir modal
function openModal(v=null){
  isEdit = !!v; editId = v?.id||null;
  document.getElementById('modal-title')
          .textContent = v?'Editar Vuelo':'Nuevo Vuelo';
  ['proveedor','numero','tipoVuelo','fechaIda','fechaVuelta']
    .forEach(k=>document.getElementById(`m-${k}`).value = v?.[k]||'');
  document.getElementById('m-statusDefault').value =
    v?.grupos?.[0]?.status||'confirmado';
  choiceGrupos.removeActiveItems();
  if(v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

// 7) Submit
async function onSubmit(evt){
  evt.preventDefault();
  const sel = choiceGrupos.getValue(true);
  const statusDefault = document.getElementById('m-statusDefault').value;
  const gruposArr = sel.map(id=>({ id, status: statusDefault }));
  const payload = {
    proveedor:   document.getElementById('m-proveedor').value.trim().toUpperCase(),
    numero:      document.getElementById('m-numero').value.trim(),
    tipoVuelo:   document.getElementById('m-tipoVuelo').value,
    fechaIda:    document.getElementById('m-fechaIda').value,
    fechaVuelta: document.getElementById('m-fechaVuelta').value,
    grupos:      gruposArr
  };
  if(isEdit) await updateDoc(doc(db,'vuelos',editId),payload);
  else       await addDoc(collection(db,'vuelos'),payload);
  closeModal(); renderVuelos();
}

// 8) Borrar vuelo
async function deleteVuelo(id){
  if(!confirm('¿Eliminar vuelo completo?'))return;
  await deleteDoc(doc(db,'vuelos',id));
  renderVuelos();
}

// 9) Quitar grupo
window.removeGroup = async (vueloId,idx)=>{
  const ref = doc(db,'vuelos',vueloId),
        snap = await getDoc(ref),
        data= snap.data();
  data.grupos.splice(idx,1);
  await updateDoc(ref,{grupos:data.grupos});
  renderVuelos();
};

// 10) Toggle status
window.toggleGroupStatus = async (vueloId,idx)=>{
  const ref = doc(db,'vuelos',vueloId),
        snap = await getDoc(ref),
        data= snap.data();
  data.grupos[idx].status =
    data.grupos[idx].status==='pendiente'?'confirmado':'pendiente';
  await updateDoc(ref,{grupos:data.grupos});
  renderVuelos();
};

// 11) Cerrar modal
function closeModal(){
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}

// 12) Abre modal de Grupo
window.openGroupModal = (grupoId) => {
  const g = grupos.find(x => x.id === grupoId);
  if (!g) return alert("Grupo no encontrado");

  // rellenar campos
  document.getElementById('g-numeroNegocio').value = g.numeroNegocio;
  document.getElementById('g-nombreGrupo').value   = g.nombreGrupo;
  document.getElementById('g-adultos').value      = g.adultos || 0;
  document.getElementById('g-estudiantes').value  = g.estudiantes || 0;

  // guardamos el id en un atributo
  document.getElementById('group-form').dataset.grupoId = grupoId;

  // mostramos modal
  document.getElementById('group-backdrop').style.display = 'block';
  document.getElementById('group-modal').style.display    = 'block';
};

// 13) Cierra modal de Grupo
function closeGroupModal() {
  document.getElementById('group-backdrop').style.display = 'none';
  document.getElementById('group-modal').style.display    = 'none';
}

// 14) Submit para actualizar el grupo en Firestore
async function onSubmitGroup(evt) {
  evt.preventDefault();
  const form = document.getElementById('group-form');
  const id   = form.dataset.grupoId;
  const data = {
    nombreGrupo: document.getElementById('g-nombreGrupo').value.trim(),
    adultos:     parseInt(document.getElementById('g-adultos').value, 10) || 0,
    estudiantes: parseInt(document.getElementById('g-estudiantes').value, 10) || 0
  };
  // actualizamos en Firestore
  await updateDoc(doc(db,'grupos',id), data);
  // refrescamos listado de grupos en memoria y re-render
  await loadGrupos();
  renderVuelos();
  closeGroupModal();
}

// 15) Dentro de init(), añade:
document.getElementById('group-cancel')
        .addEventListener('click', closeGroupModal);
document.getElementById('group-form')
        .addEventListener('submit', onSubmitGroup);

// 16) Finalmente, en renderVuelos(), cambia la casilla de nombre:
// Antes estabas generando:
//   <div class="name"><span class="group-name">…</span>…</div>
// Ahora añade el onclick:
return `
  <div class="group-item">
    …
    <div class="name">
      <span class="group-name"
            style="cursor:pointer; text-decoration:underline;"
            onclick="openGroupModal('${g.id}')">
        ${g.nombreGrupo}
      </span>
      <span class="pax-inline">…</span>
    </div>
    …
  </div>`;

