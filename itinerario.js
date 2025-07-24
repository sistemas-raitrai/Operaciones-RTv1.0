// itinerario.js

// —————————————————————————————————
// 0) Importes de Firebase
// —————————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  collection, getDocs, doc, getDoc,
  updateDoc, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// —————————————————————————————————
// 1) Referencias DOM + estado
// —————————————————————————————————
const selectNum      = document.getElementById("grupo-select-num");
const selectName     = document.getElementById("grupo-select-name");
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

const qaDia          = document.getElementById("qa-dia");
const qaHoraInicio   = document.getElementById("qa-horaInicio");
const qaAct          = document.getElementById("qa-actividad");
const qaAddBtn       = document.getElementById("qa-add");

const btnGuardarTpl  = document.getElementById("btnGuardarTpl");
const btnCargarTpl   = document.getElementById("btnCargarTpl");
const selPlantillas  = document.getElementById("sel-plantillas");

const modalBg        = document.getElementById("modal-backdrop");
const modal          = document.getElementById("modal");
const formModal      = document.getElementById("modal-form");
const fldFecha       = document.getElementById("m-fecha");
const fldHi          = document.getElementById("m-horaInicio");
const fldHf          = document.getElementById("m-horaFin");
const fldAct         = document.getElementById("m-actividad");
const fldAdultos     = document.getElementById("m-adultos");
const fldEstudiantes = document.getElementById("m-estudiantes");
const fldPax         = document.getElementById("m-pax");
const fldNotas       = document.getElementById("m-notas");
const btnCancel      = document.getElementById("modal-cancel");

let editData    = null;
let choicesDias = null;

// —————————————————————————————————
// Función global para sumar numéricamente
// —————————————————————————————————
function actualizarPax() {
  const a = parseInt(fldAdultos.value, 10) || 0;
  const e = parseInt(fldEstudiantes.value, 10) || 0;
  fldPax.value = a + e;
}
fldAdultos.addEventListener('input', actualizarPax);
fldEstudiantes.addEventListener('input', actualizarPax);

// —————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) location.href = "login.html";
  else initItinerario();
});

async function initItinerario() {
  // poblar grupos
  const snap = await getDocs(collection(db,'grupos'));
  const grupos = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  selectNum.innerHTML = grupos.map(g=>`<option value="${g.id}">${g.numeroNegocio}</option>`).join('');
  selectName.innerHTML= grupos.map(g=>`<option value="${g.id}">${g.nombreGrupo.toUpperCase()}</option>`).join('');
  selectNum.onchange = ()=>{ selectName.value=selectNum.value; renderItinerario(); };
  selectName.onchange= ()=>{ selectNum.value=selectName.value; renderItinerario(); };

  // quick-add, modal, plantillas
  qaAddBtn.onclick   = quickAddActivity;
  btnCancel.onclick  = closeModal;
  formModal.onsubmit = onSubmitModal;

  btnGuardarTpl.onclick  = guardarPlantilla;
  btnCargarTpl.onclick   = cargarPlantilla;
  await cargarListaPlantillas();

  selectNum.dispatchEvent(new Event('change'));
}

// —————————————————————————————————
// 3) renderItinerario()
// —————————————————————————————————
async function renderItinerario() {
  contItinerario.innerHTML = "";
  const grupoId = selectNum.value;
  const snapG = await getDoc(doc(db,'grupos',grupoId));
  const g     = snapG.data()||{};
  titleGrupo.textContent = (g.programa||"–").toUpperCase();
  await prepararCampoActividad("qa-actividad", g.destino);

  if (!g.itinerario) {
    const rango = getDateRange(g.fechaInicio, g.fechaFin);
    const init = {};
    rango.forEach(d=> init[d]=[]);
    await updateDoc(doc(db,'grupos',grupoId),{ itinerario:init });
    g.itinerario = init;
  }

  const fechas = Object.keys(g.itinerario).sort((a,b)=> new Date(a)-new Date(b));
  // Choices.js…
  const opts = fechas.map((d,i)=>({ value:i, label:`Día ${i+1} – ${formatDateReadable(d)}` }));
  if (choicesDias) {
    choicesDias.clearChoices();
    choicesDias.setChoices(opts,'value','label',false);
  } else {
    choicesDias = new Choices(qaDia,{ removeItemButton:true, placeholderValue:'Selecciona día(s)', choices:opts });
  }
  fldFecha.innerHTML = fechas.map((d,i)=>`<option value="${d}">Día ${i+1} – ${formatDateReadable(d)}</option>`).join('');

  fechas.forEach((fecha, idx)=>{
    const sec = document.createElement("section");
    sec.className="dia-seccion";
    if (new Date(fecha).getDay()===0) sec.classList.add('domingo');
    sec.dataset.fecha=fecha;
    sec.innerHTML=`
      <h3>Día ${idx+1} – ${formatDateReadable(fecha)}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);
    sec.querySelector(".btn-add").onclick = ()=> openModal({ fecha },false);

    const ul = sec.querySelector(".activity-list");
    const arr = (g.itinerario[fecha]||[]).slice().sort((a,b)=>a.horaInicio.localeCompare(b.horaInicio));
    if (!arr.length) ul.innerHTML=`<li class="empty">— Sin actividades —</li>`;
    else arr.forEach((act,i)=>{
      const li=document.createElement("li");
      li.className="activity-card";
      li.innerHTML=`
        <h4>${act.horaInicio} – ${act.horaFin}</h4>
        <p><strong>${act.actividad}</strong></p>
        <p>👥 ${act.pasajeros} pax (A:${act.adultos} E:${act.estudiantes})</p>
        <div class="actions">
          <button class="btn-edit" data-idx="${i}">✏️</button>
          <button class="btn-del"  data-idx="${i}">🗑️</button>
        </div>
      `;
      li.querySelector(".btn-edit").onclick=()=>openModal({...act,fecha,idx:i},true);
      li.querySelector(".btn-del").onclick=async()=>{
        if(!confirm("¿Eliminar actividad?")) return;
        await addDoc(collection(db,'historial'),{
          numeroNegocio:grupoId, accion:'BORRAR ACTIVIDAD',
          anterior: (g.itinerario[fecha]||[]).map(a=>a.actividad).join(' – '),
          nuevo:'', usuario:auth.currentUser.email, timestamp:new Date()
        });
        g.itinerario[fecha].splice(i,1);
        await updateDoc(doc(db,'grupos',grupoId),{[`itinerario.${fecha}`]:g.itinerario[fecha]});
        renderItinerario();
      };
      ul.appendChild(li);
    });
  });
}

// —————————————————————————————————
// 4) quickAddActivity()
// —————————————————————————————————
async function quickAddActivity() {
  const grupoId=selectNum.value;
  const selIdx =choicesDias.getValue(true);
  const horaInicio=qaHoraInicio.value;
  const text=qaAct.value.trim().toUpperCase();
  if(!selIdx.length||!text) return alert("Selecciona día(s) y escribe la actividad");
  const snapG=await getDoc(doc(db,'grupos',grupoId)); const g=snapG.data()||{};
  const fechas=Object.keys(g.itinerario).sort((a,b)=>new Date(a)-new Date(b));
  for(let idx of selIdx){
    const f=fechas[idx], arr=g.itinerario[f]||[];
    const item={horaInicio, horaFin:sumarUnaHora(horaInicio),
      actividad:text, pasajeros:(g.adultos||0)+(g.estudiantes||0),
      adultos:g.adultos||0, estudiantes:g.estudiantes||0, notas:""};
    await addDoc(collection(db,'historial'),{
      numeroNegocio:grupoId, accion:'CREAR ACTIVIDAD',
      anterior:'', nuevo:item.actividad,
      usuario:auth.currentUser.email, timestamp:new Date()
    });
    arr.push(item);
    await updateDoc(doc(db,'grupos',grupoId),{[`itinerario.${f}`]:arr});
  }
  qaAct.value=""; renderItinerario();
}

// —————————————————————————————————
// 5) openModal()
// —————————————————————————————————
async function openModal(data,isEdit) {
  editData=isEdit?data:null;
  document.getElementById("modal-title").textContent=isEdit?"Editar actividad":"Nueva actividad";

  const snapG=await getDoc(doc(db,'grupos',selectNum.value));
  const g=snapG.data()||{};
  const totalAdults=g.adultos||0, totalStudents=g.estudiantes||0;

  fldFecha.value=data.fecha;
  fldHi.value=data.horaInicio||"07:00";
  fldHf.value=data.horaFin||sumarUnaHora(fldHi.value);
  fldAct.value=data.actividad||"";
  await prepararCampoActividad("m-actividad",g.destino);
  fldNotas.value=data.notas||"";

  if(isEdit){
    fldAdultos.value=data.adultos??totalAdults;
    fldEstudiantes.value=data.estudiantes??totalStudents;
  } else {
    fldAdultos.value=totalAdults;
    fldEstudiantes.value=totalStudents;
  }
  actualizarPax();

  fldHi.onchange=()=>{ fldHf.value=sumarUnaHora(fldHi.value); };

  modalBg.style.display=modal.style.display="block";
}

// —————————————————————————————————
// 6) closeModal()
// —————————————————————————————————
function closeModal(){
  modalBg.style.display=modal.style.display="none";
}

// —————————————————————————————————
// 7) onSubmitModal()
// —————————————————————————————————
async function onSubmitModal(evt){
  evt.preventDefault();
  const grupoId=selectNum.value;
  const fecha=fldFecha.value;
  const a=parseInt(fldAdultos.value,10)||0;
  const e=parseInt(fldEstudiantes.value,10)||0;
  const pax=parseInt(fldPax.value,10)||0;
  const snapG=await getDoc(doc(db,'grupos',grupoId)); const g=snapG.data()||{};
  const maxP=(g.adultos||0)+(g.estudiantes||0);
  if(pax>maxP) return alert(`Adultos+Estudiantes (${pax}) no puede exceder total de grupo (${maxP}).`);

  const payload={
    horaInicio:fldHi.value, horaFin:fldHf.value,
    actividad:fldAct.value.trim().toUpperCase(),
    pasajeros:pax, adultos:a, estudiantes:e,
    notas:fldNotas.value.trim().toUpperCase()
  };

  const arr=(g.itinerario?.[fecha]||[]).slice();
  if(editData){
    const antes=arr.map(x=>x.actividad).join(' – ');
    arr[editData.idx]=payload;
    const despues=arr.map(x=>x.actividad).join(' – ');
    await addDoc(collection(db,'historial'),{
      numeroNegocio:grupoId, accion:'MODIFICAR ACTIVIDAD',
      anterior:antes, nuevo:despues,
      usuario:auth.currentUser.email, timestamp:new Date()
    });
  } else {
    arr.push(payload);
    await addDoc(collection(db,'historial'),{
      numeroNegocio:grupoId, accion:'CREAR ACTIVIDAD',
      anterior:'', nuevo:payload.actividad,
      usuario:auth.currentUser.email, timestamp:new Date()
    });
  }
  await updateDoc(doc(db,'grupos',grupoId),{[`itinerario.${fecha}`]:arr});
  closeModal(); renderItinerario();
}

// —————————————————————————————————
// 8) Utilidades de fecha y hora
// —————————————————————————————————
function getDateRange(startStr,endStr){
  const out=[];
  const start=new Date(startStr+"T00:00:00"), end=new Date(endStr+"T00:00:00");
  for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
    const yyyy=d.getFullYear(),
          mm=String(d.getMonth()+1).padStart(2,'0'),
          dd=String(d.getDate()).padStart(2,'0');
    out.push(`${yyyy}-${mm}-${dd}`);
  }
  return out;
}
function formatDateReadable(isoStr){
  const [yyyy,mm,dd]=isoStr.split('-').map(Number),
        d=new Date(yyyy,mm-1,dd),
        wd=d.toLocaleDateString("es-CL",{weekday:"long"});
  return `${wd.charAt(0).toUpperCase()+wd.slice(1)} ${dd.toString().padStart(2,'0')}/${mm.toString().padStart(2,'0')}`;
}
function sumarUnaHora(hhmm){
  const [h,m]=hhmm.split(":").map(Number), d=new Date();
  d.setHours(h+1,m); return d.toTimeString().slice(0,5);
}

// —————————————————————————————————
// 9) Plantillas: guardar y cargar
// —————————————————————————————————
async function guardarPlantilla(){
  const nombre=prompt("Nombre de la plantilla:");
  if(!nombre) return;
  const grupoId=selectNum.value;
  const snapG=await getDoc(doc(db,'grupos',grupoId));
  const g=snapG.data()||{};
  const datosParaPlantilla={};
  for(const fecha in g.itinerario){
    datosParaPlantilla[fecha]=g.itinerario[fecha].map(act=>({
      horaInicio:act.horaInicio,
      horaFin:act.horaFin,
      actividad:act.actividad,
      notas:act.notas
    }));
  }
  await addDoc(collection(db,'plantillasItinerario'),{
    nombre, creador:auth.currentUser.email,
    createdAt:new Date(), datos:datosParaPlantilla
  });
  alert("Plantilla guardada");
  await cargarListaPlantillas();
}
async function cargarListaPlantillas(){
  selPlantillas.innerHTML="";
  const snap=await getDocs(collection(db,'plantillasItinerario'));
  snap.docs.forEach(d=>{
    const data=d.data();
    const opt=document.createElement("option");
    opt.value=d.id;
    opt.textContent=data.nombre;
    selPlantillas.appendChild(opt);
  });
}
async function cargarPlantilla(){
  const id=selPlantillas.value;
  if(!id) return alert("Selecciona una plantilla");
  const tplSnap=await getDoc(doc(db,'plantillasItinerario',id));
  const tpl=tplSnap.data().datos;
  const grupoId=selectNum.value;
  const snapG=await getDoc(doc(db,'grupos',grupoId));
  const g=snapG.data()||{};
  const nuevoIt={};
  for(const fecha in tpl){
    nuevoIt[fecha]=tpl[fecha].map(act=>({
      ...act,
      pasajeros:(g.adultos||0)+(g.estudiantes||0),
      adultos:g.adultos||0,
      estudiantes:g.estudiantes||0
    }));
  }
  await updateDoc(doc(db,'grupos',grupoId),{itinerario:nuevoIt});
  renderItinerario();
}

// —————————————————————————————————
// 10) Actividades por destino
// —————————————————————————————————
async function obtenerActividadesPorDestino(destino) {
  if (!destino) return [];
  const colecServicios = "Servicios";
  const colecListado   = "Listado";
  const partes = destino.toString().split(/\s+Y\s+/i).map(s=>s.trim().toUpperCase());
  const todas=[];
  for(const parte of partes){
    const ref=collection(db,colecServicios,parte,colecListado);
    try{
      const snap=await getDocs(ref);
      snap.docs.forEach(ds=>todas.push((ds.data().nombre||ds.id).toUpperCase()));
    }catch{}
  }
  return [...new Set(todas)].sort();
}

// —————————————————————————————————
// 11) Datalist dinámico
// —————————————————————————————————
async function prepararCampoActividad(inputId,destino){
  const input=document.getElementById(inputId);
  const acts=await obtenerActividadesPorDestino(destino);
  const oldList=document.getElementById("lista-"+inputId);
  if(oldList) oldList.remove();
  const dl=document.createElement("datalist");
  dl.id="lista-"+inputId;
  acts.forEach(a=>{
    const opt=document.createElement("option");
    opt.value=a; dl.appendChild(opt);
  });
  document.body.appendChild(dl);
  input.setAttribute("list","lista-"+inputId);
}

// —————————————————————————————————
// 12) Calendario modal
// —————————————————————————————————
document.getElementById("btnAbrirCalendario").addEventListener("click",()=>{
  const grupoTxt=selectNum.options[selectNum.selectedIndex].text;
  if(!selectNum.value) return alert("Selecciona un grupo");
  const iframe=document.getElementById("iframe-calendario");
  iframe.src=`calendario.html?busqueda=${encodeURIComponent(grupoTxt)}`;
  document.getElementById("modal-calendario").style.display="block";
  document.getElementById("modal-backdrop").style.display="block";
});
window.cerrarCalendario=()=>{
  document.getElementById("modal-calendario").style.display="none";
  document.getElementById("modal-backdrop").style.display="none";
  document.getElementById("iframe-calendario").src="";
};
