// viajes.js FINAL - Nacho Pastor 2024/25 - FULL FUNCIONALIDAD Y COMENTARIOS

import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

let paxExtraEditMode = false;
let paxExtraEditIdx = null;
// VARIABLES DOM MODAL VUELO (deben estar arriba para usarlas en todo el archivo)
let tipoVueloEl, multitramoChkEl, camposSimpleEl, multitramoOpEl, tramosSectionEl;


const auth = getAuth(app);
let grupos = [], vuelos = [];
let isEdit=false, editId=null, choiceGrupos, currentUserEmail, dtHist=null;
let editingTramos = []; // Para modal vuelo REGULAR
let editingPaxExtras = []; // Para pax extras
let editingVueloId = null; // Para pax extras

function toUpper(x) { return (typeof x === 'string') ? x.toUpperCase() : x; }

onAuthStateChanged(auth,user=>{
  if(!user) return location.href='login.html';
  currentUserEmail = user.email;
  init();
});

async function init(){
  await loadGrupos();
  bindUI();
  initModal();
  await renderVuelos();

  document.getElementById('group-cancel').onclick = closeGroupModal;
  document.getElementById('group-form').onsubmit = onSubmitGroup;

  document.getElementById('btnHistorial').onclick = showHistorialModal;
  document.getElementById('hist-close').onclick  = closeHistorialModal;
  document.getElementById('hist-refresh').onclick= loadHistorial;
  document.getElementById('hist-start').onchange = loadHistorial;
  document.getElementById('hist-end').onchange   = loadHistorial;
}

async function loadGrupos(){
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// 1️⃣ BOTONES PRINCIPALES Y MODALES

function bindUI(){
  document.getElementById('btnAddVuelo').onclick = ()=>openModal();
  document.getElementById('btnExportExcel').onclick = exportToExcel;
}

function initModal(){
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-form').onsubmit  = onSubmitVuelo;

  // Selecciona los elementos DOM que usarás en todo el archivo
  tipoVueloEl     = document.getElementById('m-tipoVuelo');
  multitramoChkEl = document.getElementById('m-multitramo');
  camposSimpleEl  = document.getElementById('campos-vuelo-simple');
  multitramoOpEl  = document.getElementById('multitramo-opcion');
  tramosSectionEl = document.getElementById('tramos-section');

  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton:true }
  );
  choiceGrupos.setChoices(
    grupos.map(g=>({
      value:g.id,
      label:toUpper(`${g.numeroNegocio} – ${g.nombreGrupo}`)
    })),
    'value','label', false
  );

  // Siempre parte en charter simple al abrir
  tipoVueloEl.value = "charter";
  camposSimpleEl.style.display = 'block';
  multitramoOpEl.style.display = 'none';
  tramosSectionEl.style.display = 'none';
  if(multitramoChkEl) multitramoChkEl.checked = false;

  // Cuando cambia el tipo de vuelo (regular/charter)
  tipoVueloEl.onchange = function() {
    const tipo = tipoVueloEl.value;
    if (tipo === "charter") {
      camposSimpleEl.style.display = 'block';
      multitramoOpEl.style.display = 'none';
      tramosSectionEl.style.display = 'none';
      if(multitramoChkEl) multitramoChkEl.checked = false;
    } else if (tipo === "regular") {
      camposSimpleEl.style.display = 'block';
      multitramoOpEl.style.display = 'block';
      tramosSectionEl.style.display = 'none';
      if(multitramoChkEl) multitramoChkEl.checked = false;
    }
  };

  // Cuando activas/desactivas “múltiples tramos”
  if(multitramoChkEl) multitramoChkEl.onchange = function() {
    if (multitramoChkEl.checked) {
      camposSimpleEl.style.display = 'none';
      tramosSectionEl.style.display = 'block';
    } else {
      tramosSectionEl.style.display = 'none';
      camposSimpleEl.style.display = 'block';
    }
  };

  document.getElementById('btnAddTramo').onclick = addTramoRow;
  document.getElementById('btnAddPaxExtra').onclick = ()=>openPaxExtraModal(editingVueloId);

  // Modal Pax Extra
  document.getElementById('paxextra-cancel').onclick = closePaxExtraModal;
  document.getElementById('paxextra-form').onsubmit = onSubmitPaxExtra;
}

// 2️⃣ RENDER VUELOS Y CARDS

async function renderVuelos(){
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';

  const snap = await getDocs(collection(db,'vuelos'));
  vuelos = snap.docs.map(d=>({ id:d.id, ...d.data() }));

  vuelos.sort((a,b)=>{
    const getFecha = v =>
      v.tipoVuelo === "regular"
        ? Math.min(...(v.tramos||[]).map(t=>+new Date(t.fechaIda)))
        : +new Date(v.fechaIda);
    if (getFecha(a) !== getFecha(b)) return getFecha(a) - getFecha(b);
    return (a.ts? a.ts.seconds : 0) - (b.ts? b.ts.seconds : 0);
  });

  for(const v of vuelos){
    let totA = 0, totE = 0, totC = 0, totX = 0;
    let confA = 0, confE = 0, confC = 0, confX = 0;
    let paxExtrasArr = v.paxExtras || [];

    let cardBody = '';
    if (v.tipoVuelo === "regular" && v.tramos && v.tramos.length) {
      cardBody += `<div class="tramos" style="margin-bottom:0.7em;">`;
      v.tramos.forEach((tramo, i) => {
        cardBody += `
          <div class="tramo" style="margin-bottom:0.5em;">
            <span style="font-weight:bold;font-size:1.05em;">✈️ ${toUpper(tramo.aerolinea)} ${toUpper(tramo.numero)}</span> <span style="font-size:.97em;">(${toUpper(v.tipoVuelo)})</span><br>
            <span style="color:red">${fmtFechaLarga(tramo.fechaIda)}</span><br>
            <span style="color:#444;">Origen: ${toUpper(tramo.origen)} — Destino: ${toUpper(tramo.destino)}</span>
          </div>
        `;
      });
      cardBody += `</div>`;
    }


    const filas = (v.grupos || []).map((gObj, idx) => {
      const g = grupos.find(x=>x.id===gObj.id) || {};
      const a = parseInt(g.adultos     || 0, 10);
      const e = parseInt(g.estudiantes || 0, 10);
      const c = Math.max(parseInt(g.coordinadores ?? 1, 10), 1);
      const totalRow = a + e + c;
      totA += a; totE += e; totC += c;
      if (gObj.status === 'confirmado') {
        confA += a; confE += e; confC += c;
      }
      const mail     = gObj.changedBy || '–';
      return `
        <div class="group-item">
          <div class="num">${toUpper(g.numeroNegocio)}</div>
          <div class="name">
            <span class="group-name" onclick="openGroupModal('${g.id}')">
              ${toUpper(g.nombreGrupo)}
            </span>
            <span class="pax-inline">
              ${totalRow} (A:${a} E:${e} C:${c})
            </span>
          </div>
          <div class="status-cell">
            <span>
              ${gObj.status==='confirmado' ? '✅ CONFIRMADO' : '🕗 PENDIENTE'}
            </span>
            <span class="by-email">${toUpper(mail)}</span>
            <button class="btn-small" onclick="toggleStatus('${v.id}',${idx})">🔄</button>
          </div>
          <div class="delete-cell">
            <button class="btn-small" onclick="removeGroup('${v.id}',${idx})">🗑️</button>
          </div>
        </div>`;
    }).join('');

    let filasExtras = '';
    if(paxExtrasArr.length) {
      filasExtras = paxExtrasArr.map((pax, idx) => {
        const val = parseInt(pax.cantidad || 0, 10);
        totX += val;
        if (pax.status === 'confirmado') confX += val;
        return `
          <div class="group-item" style="background:#ffebe7">
            <div class="num">–</div>
            <div class="name">
              <span class="group-name" style="cursor:pointer;text-decoration:underline;" onclick="window.editPaxExtra('${v.id}',${idx})">${toUpper(pax.nombre||'')}</span>
              <span class="pax-inline">${val}</span>
            </div>
            <div class="status-cell">
              <span>${pax.status==='confirmado' ? '✅ CONFIRMADO' : '🕗 PENDIENTE'}</span>
              <span class="by-email">${toUpper(pax.changedBy||'')}</span>
              <button class="btn-small" onclick="togglePaxExtraStatus('${v.id}',${idx})">🔄</button>
            </div>
            <div class="delete-cell">
              <button class="btn-small" onclick="removePaxExtra('${v.id}',${idx})">🗑️</button>
            </div>
          </div>
        `;
      }).join('');
    }

    // CABECERA ESTILO IMAGEN: título, fecha ida / fecha vuelta, origen/destino y separación
    let fechaCard = "";
    if (v.tipoVuelo === "regular" && v.tramos && v.tramos.length) {
      const primerTramo = v.tramos[0];
      const fechaIda = fmtFechaLarga(primerTramo.fechaIda);
      const fechaVuelta = fmtFechaLarga(primerTramo.fechaVuelta);
      fechaCard = `
        <div class="titulo-vuelo" style="margin-bottom:.5em;">
          <div style="font-size:1.1em; font-weight:bold;">
            <span style="margin-right:.4em;">✈️</span>
            ${toUpper(primerTramo.aerolinea || v.proveedor)} ${toUpper(primerTramo.numero || v.numero)} (${toUpper(v.tipoVuelo)})
          </div>
          <div style="font-weight:bold; margin:.15em 0 .6em 0; font-size:.98em;">
            <span style="color:red">${fechaIda}</span>${fechaVuelta ? ' / <span style="color:red">' + fechaVuelta + '</span>' : ''}
          </div>
          <div style="font-size:.97em; color:#444; margin-bottom:.7em;">
            <span>Origen: ${toUpper(primerTramo.origen||v.origen||'')}</span>
            &nbsp;&nbsp;
            <span>Destino: ${toUpper(primerTramo.destino||v.destino||'')}</span>
          </div>
        </div>
      `;
    } else {
      const fechaIda = fmtFechaLarga(v.fechaIda);
      const fechaVuelta = fmtFechaLarga(v.fechaVuelta);
      fechaCard = `
        <div class="titulo-vuelo" style="margin-bottom:.5em;">
          <div style="font-size:1.1em; font-weight:bold;">
            <span style="margin-right:.4em;">✈️</span>
            ${toUpper(v.proveedor || '')} ${toUpper(v.numero || '')} (${toUpper(v.tipoVuelo)})
          </div>
          <div style="font-weight:bold; margin:.15em 0 .6em 0; font-size:.98em;">
            <span style="color:red">${fechaIda}</span>${fechaVuelta ? ' / <span style="color:red">' + fechaVuelta + '</span>' : ''}
          </div>
          <div style="font-size:.97em; color:#444; margin-bottom:.7em;">
            <span>Origen: ${toUpper(v.origen||'')}</span>
            &nbsp;&nbsp;
            <span>Destino: ${toUpper(v.destino||'')}</span>
          </div>
        </div>
      `;
    }


    const totalPax = totA + totE + totC + totX;
    const totalConf = confA + confE + confC + confX;

    const card = document.createElement('div');
    card.className = 'flight-card';
    card.innerHTML = `
      <h4>${fechaCard}</h4>
      ${cardBody}
      <div>${filas || '<p>— SIN GRUPOS —</p>'}</div>
      ${filasExtras}
      <p><strong>TOTAL PAX:</strong> ${totalPax} (A:${totA} E:${totE} C:${totC} X:${totX}) – CONFIRMADOS: ${totalConf}</p>
      <div class="actions">
        <button class="btn-add btn-edit">✏️ EDITAR</button>
        <button class="btn-add btn-del">🗑️ ELIMINAR</button>
        <button class="btn-add btn-pax" style="background:green;color:white;" onclick="openPaxExtraModal('${v.id}')">+ AGREGAR PAX</button>
      </div>
    `;
    card.querySelector('.btn-edit').onclick = ()=>openModal(v);
    card.querySelector('.btn-del' ).onclick = ()=>deleteVuelo(v.id);

    cont.appendChild(card);
  }
}

function fmtFecha(iso) {
  const dt = new Date(iso + 'T00:00:00');
  return dt.toLocaleDateString('es-CL', { weekday:'long', day:'2-digit', month:'long', year:'numeric' }).replace(/(^\w)/, m=>m.toUpperCase());
}

function fmtFechaLarga(iso) {
  if (!iso) return '';
  const dt = new Date(iso + 'T00:00:00');
  let txt = dt.toLocaleDateString('es-CL', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  return txt.toUpperCase();
}

// 3️⃣ MODAL VUELO

function openModal(v=null){
  isEdit=!!v; editId=v?.id||null; editingVueloId = v?.id||null;
  document.getElementById('modal-title').textContent = v?'EDITAR VUELO':'NUEVO VUELO';

  // Reset campos principales
  ['proveedor','numero','tipoVuelo','origen','destino','fechaIda','fechaVuelta']
    .forEach(k=>document.getElementById(`m-${k}`).value=v?.[k]||'');

  // Estado por defecto
  tipoVueloEl.value = v?.tipoVuelo || 'charter';
  camposSimpleEl.style.display = 'block';
  multitramoOpEl.style.display = (v?.tipoVuelo === 'regular') ? 'block' : 'none';
  tramosSectionEl.style.display = 'none';
  if(multitramoChkEl) multitramoChkEl.checked = false;

  // Si es regular y tiene tramos, marca multitramo
  if(v && v.tipoVuelo === 'regular'){
    multitramoOpEl.style.display = 'block';
    if(v.tramos && v.tramos.length){
      multitramoChkEl.checked = true;
      camposSimpleEl.style.display = 'none';
      tramosSectionEl.style.display = 'block';
      editingTramos = [...v.tramos];
      renderTramosList();
    } else {
      multitramoChkEl.checked = false;
      camposSimpleEl.style.display = 'block';
      tramosSectionEl.style.display = 'none';
      editingTramos = [];
      renderTramosList();
    }
  } else {
    editingTramos = [];
    renderTramosList();
  }

  // Grupos y estado
  choiceGrupos.removeActiveItems();
  if(v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));
  document.getElementById('m-statusDefault').value=v?.grupos?.[0]?.status||'confirmado';

  document.getElementById('modal-backdrop').style.display='block';
  document.getElementById('modal-vuelo').style.display='block';
}


function closeModal(){
  document.getElementById('modal-backdrop').style.display='none';
  document.getElementById('modal-vuelo').style.display='none';
}

// Tramos dinámicos
function renderTramosList(){
  const cont = document.getElementById('tramos-list');
  cont.innerHTML = '';
  editingTramos.forEach((t,i)=>{
    const row = document.createElement('div');
    row.className = 'tramo-row';
    row.innerHTML = `
      <input class="long" type="text" value="${toUpper(t.aerolinea||'')}" placeholder="AEROLÍNEA" data-t="aerolinea" data-i="${i}"/>
      <input type="text" value="${toUpper(t.numero||'')}" placeholder="N°" data-t="numero" data-i="${i}"/>
      <input class="long" type="text" value="${toUpper(t.origen||'')}" placeholder="ORIGEN" data-t="origen" data-i="${i}"/>
      <input class="long" type="text" value="${toUpper(t.destino||'')}" placeholder="DESTINO" data-t="destino" data-i="${i}"/>
      <input type="date" value="${t.fechaIda||''}" placeholder="FECHA IDA" data-t="fechaIda" data-i="${i}"/>
      <input type="date" value="${t.fechaVuelta||''}" placeholder="FECHA VUELTA" data-t="fechaVuelta" data-i="${i}"/>
      <button type="button" class="tramo-remove" onclick="removeTramo(${i})">X</button>
    `;
    // Cambios dinámicos
    row.querySelectorAll('input').forEach(inp=>{
      inp.onchange = function(){
        const key = inp.dataset.t;
        editingTramos[i][key] = inp.value.toUpperCase();
      };
    });
    cont.appendChild(row);
  });
}
window.removeTramo = idx => {
  editingTramos.splice(idx,1);
  renderTramosList();
};
function addTramoRow(){
  editingTramos.push({
    aerolinea:'',numero:'',origen:'',destino:'',
    fechaIda:'',fechaVuelta:''
  });
  renderTramosList();
}

// 4️⃣ GUARDAR / EDITAR VUELO
async function onSubmitVuelo(evt){
  evt.preventDefault();
  const tipoVuelo = document.getElementById('m-tipoVuelo').value;
  const sel = choiceGrupos.getValue(true);
  const defaultStatus = document.getElementById('m-statusDefault').value;
  const gruposArr = sel.map(id=>({ id, status:defaultStatus, changedBy:currentUserEmail }));
  let pay = {};

  // Detectar si es multitramo
  const multitramo = multitramoChkEl && multitramoChkEl.checked;

  if(tipoVuelo === 'regular' && multitramo){
    pay = {
      tipoVuelo: 'regular',
      tramos: editingTramos.map(t=>({
        aerolinea: toUpper(t.aerolinea),
        numero: toUpper(t.numero),
        origen: toUpper(t.origen),
        destino: toUpper(t.destino),
        fechaIda: t.fechaIda,
        fechaVuelta: t.fechaVuelta
      })),
      grupos: gruposArr
    };
  } else if(tipoVuelo === 'regular'){ // regular simple
    pay = {
      tipoVuelo: 'regular',
      tramos: [], // sin tramos
      proveedor: toUpper(document.getElementById('m-proveedor').value.trim()),
      numero:    toUpper(document.getElementById('m-numero').value.trim()),
      origen:    toUpper(document.getElementById('m-origen').value.trim()),
      destino:   toUpper(document.getElementById('m-destino').value.trim()),
      fechaIda:  document.getElementById('m-fechaIda').value,
      fechaVuelta:document.getElementById('m-fechaVuelta').value,
      grupos: gruposArr
    };
  } else { // charter
    pay = {
      proveedor: toUpper(document.getElementById('m-proveedor').value.trim()),
      numero:    toUpper(document.getElementById('m-numero').value.trim()),
      tipoVuelo,
      origen:    toUpper(document.getElementById('m-origen').value.trim()),
      destino:   toUpper(document.getElementById('m-destino').value.trim()),
      fechaIda:  document.getElementById('m-fechaIda').value,
      fechaVuelta:document.getElementById('m-fechaVuelta').value,
      grupos: gruposArr
    };
  }

  // Guardado igual que antes
  if(isEdit){
    const before=(await getDoc(doc(db,'vuelos',editId))).data();
    await updateDoc(doc(db,'vuelos',editId),pay);
    await addDoc(collection(db,'historial'),{ tipo:'vuelo-edit', vueloId:editId, antes:before, despues:pay, usuario:currentUserEmail, ts:serverTimestamp() });
  } else {
    const ref=await addDoc(collection(db,'vuelos'),pay);
    await addDoc(collection(db,'historial'),{ tipo:'vuelo-new', vueloId:ref.id, antes:null, despues:pay, usuario:currentUserEmail, ts:serverTimestamp() });
  }
  closeModal(); renderVuelos();
}

// 5️⃣ MODAL PAX EXTRA

function openPaxExtraModal(vueloId){
  editingVueloId = vueloId;
  document.getElementById('paxextra-nombre').value = '';
  document.getElementById('paxextra-cantidad').value = 1;
  document.getElementById('paxextra-status').value = 'pendiente';
  document.getElementById('paxextra-backdrop').style.display='block';
  document.getElementById('paxextra-modal').style.display='block';
}
window.openPaxExtraModal = openPaxExtraModal;

window.editPaxExtra = (vueloId, idx) => {
  paxExtraEditMode = true;
  paxExtraEditIdx = idx;
  editingVueloId = vueloId;
  // Trae datos actuales
  getDoc(doc(db, 'vuelos', vueloId)).then(snap => {
    const data = snap.data();
    const pax = (data.paxExtras || [])[idx] || {};
    document.getElementById('paxextra-nombre').value = pax.nombre || '';
    document.getElementById('paxextra-cantidad').value = pax.cantidad || 1;
    document.getElementById('paxextra-status').value = pax.status || 'pendiente';
    document.getElementById('paxextra-backdrop').style.display='block';
    document.getElementById('paxextra-modal').style.display='block';
  });
};

function closePaxExtraModal(){
  document.getElementById('paxextra-backdrop').style.display='none';
  document.getElementById('paxextra-modal').style.display='none';
}
async function onSubmitPaxExtra(evt){
  evt.preventDefault();
  const nombre = toUpper(document.getElementById('paxextra-nombre').value.trim());
  const cantidad = parseInt(document.getElementById('paxextra-cantidad').value,10);
  const status = document.getElementById('paxextra-status').value;
  const pax = { nombre, cantidad, status, changedBy:currentUserEmail };
  if(!nombre || cantidad < 1) return alert('Completa todos los campos correctamente');
  const ref = doc(db, 'vuelos', editingVueloId), snap = await getDoc(ref), data = snap.data();
  let paxExtrasArr = data.paxExtras || [];
  if (paxExtraEditMode && paxExtraEditIdx !== null) {
    // Modo edición
    const antes = paxExtrasArr[paxExtraEditIdx];
    paxExtrasArr[paxExtraEditIdx] = pax;
    await updateDoc(ref, { paxExtras: paxExtrasArr });
    await addDoc(collection(db,'historial'),{ tipo:'pax-extra-edit', vueloId:editingVueloId, antes, despues:pax, usuario:currentUserEmail, ts:serverTimestamp() });
  } else {
    // Nuevo
    paxExtrasArr.push(pax);
    await updateDoc(ref, { paxExtras: paxExtrasArr });
    await addDoc(collection(db,'historial'),{ tipo:'pax-extra-add', vueloId:editingVueloId, antes:null, despues:pax, usuario:currentUserEmail, ts:serverTimestamp() });
  }
  // Reinicia flags
  paxExtraEditMode = false; paxExtraEditIdx = null;
  closePaxExtraModal(); renderVuelos();
}

window.removePaxExtra = async (vueloId, idx)=>{
  const ref = doc(db, 'vuelos', vueloId), snap = await getDoc(ref), data = snap.data();
  const arr = data.paxExtras || [];
  const antes = arr[idx];
  arr.splice(idx,1);
  await updateDoc(ref, { paxExtras: arr });
  await addDoc(collection(db,'historial'),{ tipo:'pax-extra-del', vueloId:vueloId, antes, despues:null, usuario:currentUserEmail, ts:serverTimestamp() });
  renderVuelos();
};
window.togglePaxExtraStatus = async (vueloId, idx)=>{
  const ref = doc(db, 'vuelos', vueloId), snap = await getDoc(ref), data = snap.data();
  const arr = data.paxExtras || [];
  const old = arr[idx];
  arr[idx] = { ...old, status: old.status==='pendiente'?'confirmado':'pendiente', changedBy:currentUserEmail };
  await updateDoc(ref, { paxExtras: arr });
  await addDoc(collection(db,'historial'),{ tipo:'pax-extra-status', vueloId:vueloId, antes:old, despues:arr[idx], usuario:currentUserEmail, ts:serverTimestamp() });
  renderVuelos();
};

// 6️⃣ MODAL GRUPO

window.openGroupModal=grupoId=>{
  const g=grupos.find(x=>x.id===grupoId);
  if(!g) return alert('Grupo no encontrado');
  document.getElementById('g-numeroNegocio').value=g.numeroNegocio;
  document.getElementById('g-nombreGrupo').value  =g.nombreGrupo;
  document.getElementById('g-cantidadGrupo').value=g.cantidadGrupo||0;
  document.getElementById('g-adultos').value      =g.adultos||0;
  document.getElementById('g-estudiantes').value  =g.estudiantes||0;
  if (!g.coordinadores || g.coordinadores === 0) {
    document.getElementById('g-coordinadores').value = 1;
  } else {
    document.getElementById('g-coordinadores').value = g.coordinadores;
  }
  document.getElementById('group-form').dataset.grupoId=grupoId;
  document.getElementById('group-backdrop').style.display='block';
  document.getElementById('group-modal').style.display   ='block';

  // 1) Ajuste automático de PAX ↔ adultos/estudiantes
  ['g-adultos','g-estudiantes'].forEach(id=>{
    document.getElementById(id).oninput = ()=>ajustarPAXdesdeAdultosEstudiantes();
  });
  document.getElementById('g-cantidadGrupo').oninput = ()=>ajustarAdultosEstudiantesDesdePAX();

  // 2) Recalcula el TOTAL FINAL en cada cambio
  ['g-adultos','g-estudiantes','g-coordinadores'].forEach(id=>{
    document.getElementById(id).oninput = recalcularTotalFinal;
  });
  recalcularTotalFinal(); // Y al abrir el modal

  // --- AJUSTE FINAL: Si el PAX está en 0, lo calcula automáticamente
  if (!g.cantidadGrupo || g.cantidadGrupo === 0) ajustarPAXdesdeAdultosEstudiantes();
};

function closeGroupModal(){
  document.getElementById('group-backdrop').style.display='none';
  document.getElementById('group-modal').style.display   ='none';
}

// Si cambias Adultos/Estudiantes, PAX se ajusta automático
function ajustarPAXdesdeAdultosEstudiantes(){
  const a = +document.getElementById('g-adultos').value || 0;
  const e = +document.getElementById('g-estudiantes').value || 0;
  document.getElementById('g-cantidadGrupo').value = a + e;
}
// Si cambias PAX, Estudiantes se ajusta (mantiene Adultos fijo)
function ajustarAdultosEstudiantesDesdePAX(){
  const pax = +document.getElementById('g-cantidadGrupo').value || 0;
  const a   = +document.getElementById('g-adultos').value || 0;
  let e     = pax - a;
  e = e >= 0 ? e : 0;
  document.getElementById('g-estudiantes').value = e;
}

function recalcularTotalFinal() {
  const a = +document.getElementById('g-adultos').value || 0;
  const e = +document.getElementById('g-estudiantes').value || 0;
  const c = +document.getElementById('g-coordinadores').value || 0;
  document.getElementById('g-cantidadTotal').value = a + e + c;
}

async function onSubmitGroup(evt){
  evt.preventDefault();
  const form=document.getElementById('group-form'), id=form.dataset.grupoId;
  const before=(await getDoc(doc(db,'grupos',id))).data();
  const data={
    cantidadGrupo: +document.getElementById('g-cantidadGrupo').value||0,
    adultos:       +document.getElementById('g-adultos').value||0,
    estudiantes:   +document.getElementById('g-estudiantes').value||0,
    coordinadores: Math.max(+document.getElementById('g-coordinadores').value||1, 1),
  };
  data.cantidadTotal = data.adultos + data.estudiantes + data.coordinadores;
  await updateDoc(doc(db,'grupos',id),data);
  await addDoc(collection(db,'historial'),{ tipo:'grupo-edit', grupoId:id, antes:before, despues:data, usuario:currentUserEmail, ts:serverTimestamp() });
  await loadGrupos();
  renderVuelos();
  closeGroupModal();
}

// 7️⃣ ACCIONES DE GRUPO EN VUELO

window.removeGroup=async(vId,idx)=>{
  const ref=doc(db,'vuelos',vId), snap=await getDoc(ref), data=snap.data();
  const before=data.grupos[idx]; data.grupos.splice(idx,1);
  await updateDoc(ref,{grupos:data.grupos});
  await addDoc(collection(db,'historial'),{ tipo:'grupo-remove', vueloId:vId, grupoId:before.id, antes:before, despues:null, usuario:currentUserEmail, ts:serverTimestamp() });
  renderVuelos();
};
window.toggleStatus=async(vId,idx)=>{
  const ref=doc(db,'vuelos',vId), snap=await getDoc(ref), data=snap.data();
  const old=data.grupos[idx];
  const neu={ ...old, status:old.status==='pendiente'?'confirmado':'pendiente', changedBy:currentUserEmail };
  data.grupos[idx]=neu;
  await updateDoc(ref,{grupos:data.grupos});
  await addDoc(collection(db,'historial'),{ tipo:'grupo-status', vueloId:vId, grupoId:old.id, antes:old, despues:neu, usuario:currentUserEmail, ts:serverTimestamp() });
  renderVuelos();
};

// 8️⃣ ELIMINAR VUELO + HISTORIAL
async function deleteVuelo(id){
  if(!confirm('¿Eliminar vuelo completo?')) return;
  const before=(await getDoc(doc(db,'vuelos',id))).data();
  await deleteDoc(doc(db,'vuelos',id));
  await addDoc(collection(db,'historial'),{ tipo:'vuelo-del', vueloId:id, antes:before, despues:null, usuario:currentUserEmail, ts:serverTimestamp() });
  renderVuelos();
}

// 9️⃣ HISTORIAL Y EXPORTAR EXCEL (igual a versión anterior, no lo repito por espacio)

async function showHistorialModal(){
  document.getElementById('hist-backdrop').style.display='block';
  document.getElementById('hist-modal').style.display   ='block';
  await loadHistorial();
}

function closeHistorialModal(){
  document.getElementById('hist-backdrop').style.display='none';
  document.getElementById('hist-modal').style.display   ='none';
}

async function loadHistorial(){
  const tbody=document.querySelector('#hist-table tbody');
  tbody.innerHTML='';
  // Filtrar por fechas si están definidas
  const start = document.getElementById('hist-start').value;
  const end = document.getElementById('hist-end').value;
  let qSnap=query(collection(db,'historial'),orderBy('ts','desc'));
  const snap=await getDocs(qSnap);
  for(const dSnap of snap.docs){
    const d=dSnap.data(), ts=d.ts?.toDate?.();
    // Filtro de fechas si aplica
    if(start && ts && ts < new Date(start+'T00:00:00')) continue;
    if(end && ts && ts > new Date(end+'T23:59:59')) continue;
    const tr=document.createElement('tr');
    tr.innerHTML=`
      <td>${ts?ts.toLocaleString('es-CL'):''}</td>
      <td>${d.usuario||''}</td>
      <td>${d.vueloId||d.grupoId||''}</td>
      <td>${d.tipo||''}</td>
      <td>${d.antes?JSON.stringify(d.antes):''}</td>
      <td>${d.despues?JSON.stringify(d.despues):''}</td>`;
    tbody.appendChild(tr);
  }
  if(dtHist) dtHist.destroy();
  dtHist=$('#hist-table').DataTable({ language:{url:'https://cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'}, order:[[0,'desc']] });
}

// ===== EXPORTAR EXCEL =====

function exportToExcel(){
  // Hoja 1: resumen de vuelos
  const resumen = vuelos.map(v => {
    let totA=0, totE=0, totC=0, totX=0;
    (v.grupos||[]).forEach(gObj => {
      const g = grupos.find(x=>x.id===gObj.id)||{};
      totA += parseInt(g.adultos||0,10);
      totE += parseInt(g.estudiantes||0,10);
      totC += parseInt(g.coordinadores||0,10);
    });
    (v.paxExtras||[]).forEach(x=>{
      totX += parseInt(x.cantidad||0,10);
    });

    // Para vuelos regulares, concatenamos tramos en una columna
    let detallesTramos = '';
    if(v.tipoVuelo === 'regular' && v.tramos && v.tramos.length){
      detallesTramos = v.tramos.map((t,i)=>`${i+1}) ${toUpper(t.aerolinea)} ${toUpper(t.numero)}: ${toUpper(t.origen)}→${toUpper(t.destino)} [IDA:${t.fechaIda} VUELTA:${t.fechaVuelta}]`).join('\n');
    }

    return {
      Aerolínea: v.proveedor || (v.tramos?.[0]?.aerolinea || ''),
      Vuelo:     v.numero    || (v.tramos?.[0]?.numero    || ''),
      Tipo:      v.tipoVuelo,
      Origen:    v.origen    || (v.tramos?.[0]?.origen    || ''),
      Destino:   v.destino   || (v.tramos?.[0]?.destino   || ''),
      Fecha_Ida: v.fechaIda  || (v.tramos?.[0]?.fechaIda  || ''),
      Fecha_Vuelta: v.fechaVuelta || (v.tramos?.[0]?.fechaVuelta || ''),
      Tramos:    detallesTramos,
      Total_Adultos: totA,
      Total_Estudiantes: totE,
      Total_Coordinadores: totC,
      Total_Pax_Extra: totX,
      Total_Pax: totA+totE+totC+totX
    };
  });

  // Hoja 2: detalle de grupos
  const detalle = [];
  vuelos.forEach(v => {
    (v.grupos||[]).forEach(gObj => {
      const g = grupos.find(x=>x.id===gObj.id)||{};
      detalle.push({
        Fecha_Ida: v.fechaIda,
        Vuelo: v.numero || (v.tramos?.[0]?.numero || ''),
        Grupo_Numero: g.numeroNegocio,
        Grupo_Nombre: g.nombreGrupo,
        Adultos: g.adultos||0,
        Estudiantes: g.estudiantes||0,
        Coordinadores: g.coordinadores||0,
        Total: (g.adultos||0)+(g.estudiantes||0)+(g.coordinadores||0),
        Estado: gObj.status,
        Cambiado_Por: gObj.changedBy || ''
      });
    });
    // También agregamos pax extras al detalle
    (v.paxExtras||[]).forEach(x=>{
      detalle.push({
        Vuelo: v.numero || (v.tramos?.[0]?.numero || ''),
        Grupo_Numero: '-',
        Grupo_Nombre: x.nombre,
        Adultos: '-',
        Estudiantes: '-',
        Coordinadores: '-',
        Total: x.cantidad,
        Estado: x.status,
        Cambiado_Por: x.changedBy || ''
      });
    });
  });

  // Construir libro
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(resumen);
  const ws2 = XLSX.utils.json_to_sheet(detalle);
  XLSX.utils.book_append_sheet(wb, ws1, "Resumen_Vuelos");
  XLSX.utils.book_append_sheet(wb, ws2, "Detalle_Grupos");

  // Descargar
  XLSX.writeFile(wb, "planificacion_vuelos_completa.xlsx");
}


// 10️⃣ CERRAR MODALES DE BACKDROP AL HACER CLICK FUERA
document.body.addEventListener('click', function(e){
  if(e.target.classList.contains('modal-backdrop')) {
    e.target.style.display='none';
    const modal = document.querySelector('.modal[style*="display: block"]');
    if(modal) modal.style.display='none';
  }
}, true);

