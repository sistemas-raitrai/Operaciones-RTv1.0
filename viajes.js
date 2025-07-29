import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged }
  from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  addDoc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);
let grupos = [], vuelos = [];
let isEdit=false, editId=null, choiceGrupos, currentUserEmail, dtHist=null;

// 1) Autenticación y arranque
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

  // Grupo modal
  document.getElementById('group-cancel').onclick = closeGroupModal;
  document.getElementById('group-form').onsubmit = onSubmitGroup;

  // Historial modal
  document.getElementById('btnHistorial').onclick = showHistorialModal;
  document.getElementById('hist-close').onclick  = closeHistorialModal;
  document.getElementById('hist-refresh').onclick= loadHistorial;
  document.getElementById('hist-start').onchange = loadHistorial;
  document.getElementById('hist-end').onchange   = loadHistorial;
}

// 2) Cargo grupos
async function loadGrupos(){
  const snap = await getDocs(collection(db,'grupos'));
  grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// 3) Botón “Agregar Vuelo”
function bindUI(){
  document.getElementById('btnAddVuelo').onclick = ()=>openModal();
  document.getElementById('btnExportExcel').onclick = exportToExcel;
}

// 4) Modal Vuelo + Choices.js
function initModal(){
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-form').onsubmit  = onSubmit;
  choiceGrupos = new Choices(
    document.getElementById('m-grupos'),
    { removeItemButton:true }
  );
  choiceGrupos.setChoices(
    grupos.map(g=>({ value:g.id, label:`${g.numeroNegocio} – ${g.nombreGrupo}` })),
    'value','label', false
  );
}

// 5) Render de vuelos
async function renderVuelos(){
  const cont = document.getElementById('vuelos-container');
  cont.innerHTML = '';

  // Carga y ordena
  const snap = await getDocs(collection(db,'vuelos'));
  vuelos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  vuelos.sort((a,b)=>new Date(a.fechaIda)-new Date(b.fechaIda));

  // Recorre cada vuelo
  for(const v of vuelos){
    // Inicializa totales por vuelo
    let totA = 0, totE = 0, totC = 0;
    let confA = 0, confE = 0, confC = 0;

    // Construye las filas de grupos
    const filas = (v.grupos || []).map((gObj, idx) => {
      const g = grupos.find(x=>x.id===gObj.id) || {};

      // ——— Forzamos a número ———
      const a = parseInt(g.adultos     || 0, 10);
      const e = parseInt(g.estudiantes || 0, 10);

      // Contamos coordinadores
      const nombresArr = Array.isArray(g.nombresCoordinadores)
        ? g.nombresCoordinadores
        : (g.nombresCoordinadores
           ? g.nombresCoordinadores.split(',').map(s=>s.trim())
           : ['']);
      const c = nombresArr.length;

      // Suma numérica
      totA += a;
      totE += e;
      totC += c;
      if (gObj.status === 'confirmado') {
        confA += a;
        confE += e;
        confC += c;
      }

      const totalRow = a + e + c;
      const mail     = gObj.changedBy || '–';

      return `
        <div class="group-item">
          <div class="num">${g.numeroNegocio}</div>
          <div class="name">
            <span class="group-name"
                  onclick="openGroupModal('${g.id}')">
              ${g.nombreGrupo}
            </span>
            <span class="pax-inline">
              ${totalRow} (A:${a} E:${e} C:${c})
            </span>
          </div>
          <div class="status-cell">
            <span>
              ${gObj.status==='confirmado'
                ? '✅ Confirmado'
                : '🕗 Pendiente'}
            </span>
            <span class="by-email">${mail}</span>
            <button class="btn-small"
                    onclick="toggleStatus('${v.id}',${idx})">
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
    }).join('');

    // Crea la tarjeta completa
    const fmt = iso => new Date(iso)
      .toLocaleDateString('es-CL',{
        weekday:'long',day:'2-digit',month:'long',year:'numeric'
      }).replace(/(^\w)/,m=>m.toUpperCase());

    const card = document.createElement('div');
    card.className = 'flight-card';
    card.innerHTML = `
      <h4>✈️ ${v.proveedor} ${v.numero} (${v.tipoVuelo})</h4>
      <p class="dates">
        Origen: ${v.origen||'–'} &nbsp; Destino: ${v.destino||'–'}
      </p>
      <p class="dates">
        Ida: ${fmt(v.fechaIda)} ↔️ Vuelta: ${fmt(v.fechaVuelta)}
      </p>
      <div>${filas || '<p>— Sin grupos —</p>'}</div>
      <p><strong>Total Pax:</strong>
         ${totA + totE + totC}
         (A:${totA} E:${totE} C:${totC})
         – Confirmados: ${confA + confE + confC}
         (A:${confA} E:${confE} C:${confC})
      </p>
      <div class="actions">
        <button class="btn-add btn-edit">✏️ Editar</button>
        <button class="btn-add btn-del">🗑️ Eliminar</button>
      </div>`;

    // Añade event listeners
    card.querySelector('.btn-edit').onclick = ()=>openModal(v);
    card.querySelector('.btn-del' ).onclick = ()=>deleteVuelo(v.id);

    cont.appendChild(card);
  }
}

// 6) Abrir modal Vuelo
function openModal(v=null){
  isEdit=!!v; editId=v?.id||null;
  document.getElementById('modal-title').textContent=v?'Editar Vuelo':'Nuevo Vuelo';
  ['proveedor','numero','tipoVuelo','origen','destino','fechaIda','fechaVuelta']
    .forEach(k=>document.getElementById(`m-${k}`).value=v?.[k]||'');
  document.getElementById('m-statusDefault').value=v?.grupos?.[0]?.status||'confirmado';
  choiceGrupos.removeActiveItems();
  if(v?.grupos) choiceGrupos.setChoiceByValue(v.grupos.map(g=>g.id));
  document.getElementById('modal-backdrop').style.display='block';
  document.getElementById('modal-vuelo').style.display='block';
}

// 7) Guardar/Editar Vuelo + Historial
async function onSubmit(evt){
  evt.preventDefault();
  const sel=choiceGrupos.getValue(true);
  const defaultStatus=document.getElementById('m-statusDefault').value;
  const gruposArr=sel.map(id=>({ id, status:defaultStatus, changedBy:currentUserEmail }));
  const pay={
    proveedor:document.getElementById('m-proveedor').value.trim().toUpperCase(),
    numero:   document.getElementById('m-numero').value.trim(),
    tipoVuelo:document.getElementById('m-tipoVuelo').value,
    origen:   document.getElementById('m-origen').value.trim(),
    destino:  document.getElementById('m-destino').value.trim(),
    fechaIda: document.getElementById('m-fechaIda').value,
    fechaVuelta:document.getElementById('m-fechaVuelta').value,
    grupos:   gruposArr
  };
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

// 8) Eliminar Vuelo + Historial
async function deleteVuelo(id){
  if(!confirm('¿Eliminar vuelo completo?')) return;
  const before=(await getDoc(doc(db,'vuelos',id))).data();
  await deleteDoc(doc(db,'vuelos',id));
  await addDoc(collection(db,'historial'),{ tipo:'vuelo-del', vueloId:id, antes:before, despues:null, usuario:currentUserEmail, ts:serverTimestamp() });
  renderVuelos();
}

// 9) Quitar Grupo + Historial
window.removeGroup=async(vId,idx)=>{
  const ref=doc(db,'vuelos',vId), snap=await getDoc(ref), data=snap.data();
  const before=data.grupos[idx]; data.grupos.splice(idx,1);
  await updateDoc(ref,{grupos:data.grupos});
  await addDoc(collection(db,'historial'),{ tipo:'grupo-remove', vueloId:vId, grupoId:before.id, antes:before, despues:null, usuario:currentUserEmail, ts:serverTimestamp() });
  renderVuelos();
};

// 10) Toggle Estado + Historial
window.toggleStatus=async(vId,idx)=>{
  const ref=doc(db,'vuelos',vId), snap=await getDoc(ref), data=snap.data();
  const old=data.grupos[idx];
  const neu={ ...old, status:old.status==='pendiente'?'confirmado':'pendiente', changedBy:currentUserEmail };
  data.grupos[idx]=neu;
  await updateDoc(ref,{grupos:data.grupos});
  await addDoc(collection(db,'historial'),{ tipo:'grupo-status', vueloId:vId, grupoId:old.id, antes:old, despues:neu, usuario:currentUserEmail, ts:serverTimestamp() });
  renderVuelos();
};

// 11) Cerrar modal Vuelo
function closeModal(){
  document.getElementById('modal-backdrop').style.display='none';
  document.getElementById('modal-vuelo').style.display='none';
}

// 12) Abrir modal Grupo
window.openGroupModal=grupoId=>{
  const g=grupos.find(x=>x.id===grupoId);
  if(!g) return alert('Grupo no encontrado');
  document.getElementById('g-numeroNegocio').value=g.numeroNegocio;
  document.getElementById('g-nombreGrupo').value  =g.nombreGrupo;
  document.getElementById('g-empresaBus').value   =g.empresaBus||'';
  document.getElementById('g-adultos').value      =g.adultos||0;
  document.getElementById('g-estudiantes').value  =g.estudiantes||0;
  document.getElementById('g-cantCoordinadores').value = (Array.isArray(g.nombresCoordinadores)?g.nombresCoordinadores.length:1);
  document.getElementById('g-nombresCoordinadores').value = Array.isArray(g.nombresCoordinadores)?g.nombresCoordinadores.join(', '):'';
  document.getElementById('group-form').dataset.grupoId=grupoId;
  document.getElementById('group-backdrop').style.display='block';
  document.getElementById('group-modal').style.display   ='block';
};

// 13) Cerrar modal Grupo
function closeGroupModal(){
  document.getElementById('group-backdrop').style.display='none';
  document.getElementById('group-modal').style.display   ='none';
}

// 14) Guardar Grupo + Historial
async function onSubmitGroup(evt){
  evt.preventDefault();
  const form=document.getElementById('group-form'), id=form.dataset.grupoId;
  const before=(await getDoc(doc(db,'grupos',id))).data();
  const nombresArr=document.getElementById('g-nombresCoordinadores').value.split(',').map(s=>s.trim()).filter(Boolean);
  const data={
    empresaBus: document.getElementById('g-empresaBus').value.trim(),
    adultos:    +document.getElementById('g-adultos').value||0,
    estudiantes:+document.getElementById('g-estudiantes').value||0,
    nombresCoordinadores:nombresArr
  };
  await updateDoc(doc(db,'grupos',id),data);
  await addDoc(collection(db,'historial'),{ tipo:'grupo-edit', grupoId:id, antes:before, despues:data, usuario:currentUserEmail, ts:serverTimestamp() });
  await loadGrupos();
  renderVuelos();
  closeGroupModal();
}

// 15) Mostrar Historial
async function showHistorialModal(){
  document.getElementById('hist-backdrop').style.display='block';
  document.getElementById('hist-modal').style.display   ='block';
  await loadHistorial();
}

// 16) Cerrar Historial
function closeHistorialModal(){
  document.getElementById('hist-backdrop').style.display='none';
  document.getElementById('hist-modal').style.display   ='none';
}

// 17) Cargar & renderizar Historial
async function loadHistorial(){
  const tbody=document.querySelector('#hist-table tbody');
  tbody.innerHTML='';
  const qSnap=query(collection(db,'historial'),orderBy('ts','desc'));
  const snap=await getDocs(qSnap);
  for(const dSnap of snap.docs){
    const d=dSnap.data(), ts=d.ts?.toDate();
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

function exportToExcel(){
  // Hoja 1: resumen de vuelos
  const resumen = vuelos.map(v => {
    let totA=0, totE=0, totC=0;
    (v.grupos||[]).forEach(gObj => {
      const g = grupos.find(x=>x.id===gObj.id)||{};
      totA += parseInt(g.adultos||0,10);
      totE += parseInt(g.estudiantes||0,10);
      totC += Array.isArray(g.nombresCoordinadores)
                ? g.nombresCoordinadores.length
                : (g.nombresCoordinadores
                   ? g.nombresCoordinadores.split(',').length
                   : 1);
    });
    return {
      Aerolínea: v.proveedor,
      Vuelo: v.numero,
      Tipo: v.tipoVuelo,
      Origen: v.origen,
      Destino: v.destino,
      Fecha_Ida: v.fechaIda,
      Fecha_Vuelta: v.fechaVuelta,
      Total_Adultos: totA,
      Total_Estudiantes: totE,
      Total_Coordinadores: totC,
      Total_Pax: totA+totE+totC
    };
  });

  // Hoja 2: detalle de grupos
  const detalle = [];
  vuelos.forEach(v => {
    (v.grupos||[]).forEach(gObj => {
      const g = grupos.find(x=>x.id===gObj.id)||{};
      detalle.push({
        Fecha_Ida: v.fechaIda,
        Vuelo: v.numero,
        Grupo_Numero: g.numeroNegocio,
        Grupo_Nombre: g.nombreGrupo,
        Estado: gObj.status,
        Cambiado_Por: gObj.changedBy || ''
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
