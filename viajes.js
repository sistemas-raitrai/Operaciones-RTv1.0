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

// 3) Botón Nuevo
function bindUI() {
  document.getElementById('btnAddVuelo')
    .onclick = () => openModal();
}

// 4) Inicializa Choices y modal
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

// 5) Render de tarjetas (reemplaza por esto)
async function renderVuelos() {
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';
  const snap = await getDocs(collection(db,'vuelos'));
  vuelos = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  vuelos.forEach(v => {
    const card = document.createElement('div');
    card.className = 'flight-card';

    // formateo de fecha
    const fmt = d => {
      const D = new Date(d);
      return D.toLocaleDateString('es-CL',{
        weekday:'long', day:'2-digit',
        month:'long', year:'numeric'
      }).replace(/(^\w)/, m => m.toUpperCase());
    };

    // construyo las filas de grupos
    let adultos = 0, estudi = 0;
    const gruposHtml = (v.grupos || []).map((gObj, idx) => {
      const g = grupos.find(x => x.id === gObj.id) || {};
      const a = g.adultos || 0, e = g.estudiantes || 0;
      adultos += a; estudi += e;
      return `
        <div class="group-item">
          <div class="group-info">
            • <strong>${g.numeroNegocio} – ${g.nombreGrupo}</strong>
            (A:${a} E:${e})
            <span class="status">
              ${gObj.status === 'pendiente' ? '🕗 Pendiente' : '✅ Confirmado'}
            </span>
          </div>
          <div>
            <button class="btn-small"
                    onclick="toggleGroupStatus('${v.id}', ${idx})">
              🔄
            </button>
            <button class="btn-small"
                    onclick="removeGroup('${v.id}', ${idx})">
              🗑️
            </button>
          </div>
        </div>`;
    }).join('');

    // monto el innerHTML sin JSON.stringify
    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
      <p>Ida: ${fmt(v.fechaIda)}</p>
      <p>Vuelta: ${fmt(v.fechaVuelta)}</p>
      <div>${gruposHtml || '<p>— Sin grupos —</p>'}</div>
      <p><strong>Total Pax:</strong> ${adultos + estudi}
         (A:${adultos} E:${estudi})</p>
      <div class="actions">
        <button class="btn-add btn-edit">✏️ Editar</button>
        <button class="btn-add btn-del">🗑️ Eliminar</button>
      </div>`;

    cont.appendChild(card);

    // ahora ata los eventos en JS
    card.querySelector('.btn-edit')
        .addEventListener('click', () => openModal(v));
    card.querySelector('.btn-del')
        .addEventListener('click', () => deleteVuelo(v.id));
  });
}


// 6) Abre modal
function openModal(v=null) {
  isEdit = !!v; editId = v?.id||null;
  document.getElementById('modal-title')
    .textContent = v?'Editar Vuelo':'Nuevo Vuelo';

  // Pre-llenar
  ['proveedor','numero','tipoVuelo','fechaIda','fechaVuelta']
    .forEach(k =>
      document.getElementById(`m-${k}`).value = v?.[k]||''
    );
  document.getElementById('m-statusDefault').value =
    v?.grupos?.[0]?.status||'confirmado';

  choiceGrupos.removeActiveItems();
  if(v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));

  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'block';
}

// 7) Submit
async function onSubmit(evt) {
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

  if(isEdit) await updateDoc(doc(db,'vuelos',editId), payload);
  else       await addDoc(collection(db,'vuelos'), payload);

  closeModal();
  renderVuelos();
}

// 8) Borrar vuelo
async function deleteVuelo(id) {
  if(!confirm('¿Eliminar vuelo completo?')) return;
  await deleteDoc(doc(db,'vuelos',id));
  renderVuelos();
}

// 9) Remove group
window.removeGroup = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId),
        snap = await getDoc(ref),
        data= snap.data();
  data.grupos.splice(idx,1);
  await updateDoc(ref,{ grupos: data.grupos });
  renderVuelos();
};

// 10) Toggle status
window.toggleGroupStatus = async (vueloId, idx) => {
  const ref = doc(db,'vuelos',vueloId),
        snap = await getDoc(ref),
        data= snap.data();
  data.grupos[idx].status =
    data.grupos[idx].status==='pendiente'?'confirmado':'pendiente';
  await updateDoc(ref,{ grupos: data.grupos });
  renderVuelos();
};

// 11) Close modal
function closeModal() {
  document.getElementById('modal-backdrop').style.display =
  document.getElementById('modal-vuelo').style.display = 'none';
}
