// itinerario.js

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

console.log("▶️ itinerario.js cargado");

// 1) URLs de datos
const OPENSHEET = "https://opensheet.elk.sh/124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI/LecturaBaseOperaciones";
const GAS_URL   = "https://script.google.com/macros/s/AKfycbwkyIMHb_bzAzMWoO3Yte2a6aFtVDguFGsiL0aaG6Tupn8B807oovR34S0YbR9I9mz0/exec";

// 2) Elementos principales del DOM
const selectNum      = document.getElementById("grupo-select-num");   // selector por código
const selectName     = document.getElementById("grupo-select-name");  // selector por nombre
const titleGrupo     = document.getElementById("grupo-title");
const contItinerario = document.getElementById("itinerario-container");

// 3) Elementos del modal de actividad
const modalBg   = document.getElementById("modal-backdrop");
const modal     = document.getElementById("modal");
const formModal = document.getElementById("modal-form");
const fldFecha  = document.getElementById("m-fecha");
const fldBloques = document.getElementById("m-bloques");  // contenedor dinámico de bloques
const fldAct    = document.getElementById("m-actividad");
const fldPas    = document.getElementById("m-pasajeros");
const fldNotas  = document.getElementById("m-notas");
let editData    = null;  // datos de la actividad en edición

// 4) Bloques predefinidos
const BLOQUES = [
  { key: 'desayuno', label: 'Desayuno',    start: '07:00', end: '09:00' },
  { key: 'manana',   label: 'Mañana',      start: '09:00', end: '13:00' },
  { key: 'almuerzo', label: 'Almuerzo',    start: '13:00', end: '15:00' },
  { key: 'tarde',    label: 'Tarde',       start: '15:00', end: '19:00' },
  { key: 'cena',     label: 'Cena',        start: '20:00', end: '22:00' },
  { key: 'noche',    label: 'Noche',       start: '22:00', end: '03:00' },
  { key: 'pernocte', label: 'Pernocte',    start: '',      end: ''      },
];

// 5) Al cargar el DOM, comprobamos sesión y arrancamos
document.addEventListener("DOMContentLoaded", () => {
  onAuthStateChanged(auth, user => {
    if (!user) return location.href = "login.html";
    init();
  });
});

// 6) Inicialización: cargar grupos y primer render
async function init() {
  const datos = await (await fetch(OPENSHEET)).json();
  const mapa = new Map();
  datos.forEach(r => {
    if (r.numeroNegocio && r.nombreGrupo && !mapa.has(r.numeroNegocio)) {
      mapa.set(r.numeroNegocio, r.nombreGrupo);
    }
  });
  const grupos = Array.from(mapa.entries());
  selectNum.innerHTML  = grupos.map(([n])=>`<option value="${n}">${n}</option>`).join("");
  selectName.innerHTML = grupos.map(([n,gn])=>`<option value="${n}">${gn}</option>`).join("");
  selectNum.onchange  = () => { selectName.value = selectNum.value; renderItinerario(); };
  selectName.onchange = () => { selectNum.value  = selectName.value; renderItinerario(); };
  await renderItinerario();
}

/**
 * 7) formModal: onsubmit → guarda actividad
 *    Mantiene horaInicio y horaFin por bloque.
 */
formModal.onsubmit = async e => {
  e.preventDefault();
  const grupo = selectNum.value;
  // Elegimos bloque activo (el primero seleccionado)
  const bloqueSel = document.querySelector('input[name="bloque"]:checked');
  const start = bloqueSel?.dataset.start || fldBloques.querySelector('input[data-key="desayuno"]').value;
  const end   = bloqueSel?.dataset.end   || fldBloques.querySelector('input[data-key="desayuno_end"]').value;
  const payload = {
    numeroNegocio: grupo,
    fecha:         fldFecha.value,
    horaInicio:    start,
    horaFin:       end,
    actividad:     fldAct.value,
    pasajeros:     parseInt(fldPas.value,10),
    notas:         fldNotas.value
  };
  if (editData) payload.id = editData.id;
  await fetch(GAS_URL, {
    method:  "POST",
    headers: { "Content-Type":"application/json" },
    body:    JSON.stringify({ datos: payload })
  });
  closeModal();
  loadActivities(grupo, fldFecha.value);
};

// 8) Render del itinerario: días y actividades
async function renderItinerario() {
  const grupo = selectNum.value;
  const datos = await (await fetch(OPENSHEET)).json();
  const fila  = datos.find(r => r.numeroNegocio===grupo) || {};
  titleGrupo.textContent = fila.programa || "Sin programa";
  contItinerario.innerHTML = "";
  const fechas = await getRangoFechas(grupo);
  fldFecha.innerHTML = fechas.map(f=>`<option value="${f}">${f}</option>`).join("");
  // Prepara modal con los 7 bloques
  prepModalBloques();
  for (let i=0; i<fechas.length; i++) {
    const fecha = fechas[i];
    const dObj  = new Date(fecha);
    const weekday = dObj.toLocaleDateString('es-CL',{weekday:'long'});
    const dd = String(dObj.getDate()).padStart(2,'0'),
          mm = String(dObj.getMonth()+1).padStart(2,'0');
    const titulo = `Día ${i+1} – ${weekday.charAt(0).toUpperCase()+weekday.slice(1)} ${dd}/${mm}`;
    const sec = document.createElement("section");
    sec.className     = "dia-seccion";
    sec.dataset.fecha = fecha;
    sec.innerHTML     = `
      <h3>${titulo}</h3>
      <ul class="activity-list"></ul>
      <button class="btn-add" data-fecha="${fecha}">+ Añadir actividad</button>
    `;
    contItinerario.appendChild(sec);
    sec.querySelector(".btn-add").onclick = () => openModal({ fecha }, false);
    await loadActivities(grupo,fecha);
  }
}

// 9) Lee el rango de fechas entre inicio/fin
function parseDdMmYyyy(s){
  const [d,m,y]=s.split('-').map(n=>+n);
  return new Date(y,m-1,d);
}
async function getRangoFechas(grupo){
  const datos=await (await fetch(OPENSHEET)).json();
  const fila =datos.find(r=>r.numeroNegocio===grupo);
  const inicio=parseDdMmYyyy(fila.fechaInicio);
  const fin   =parseDdMmYyyy(fila.fechaFin);
  const dias=[];
  for(let d=new Date(inicio);d<=fin;d.setDate(d.getDate()+1)){
    dias.push(d.toISOString().slice(0,10));
  }
  return dias;
}

// 10) Pinta actividades de un día (sólo show horaInicio)
async function loadActivities(grupo,fecha){
  const res=await fetch(`${GAS_URL}?numeroNegocio=${grupo}&fecha=${fecha}&alertas=1`);
  const { valores=[] }=await res.json();
  const ul=document.querySelector(`section[data-fecha="${fecha}"] .activity-list`);
  ul.innerHTML="";
  if(!valores.length){
    ul.innerHTML=`<li class="activity-card" style="text-align:center;color:#666">— Sin actividades —</li>`;
    return;
  }
  valores.forEach(act=>{
    const li=document.createElement("li");
    li.className="activity-card";
    li.innerHTML=`
      <h4>${act.horaInicio}</h4>
      <p><strong>${act.actividad}</strong></p>
      <p>👥 ${act.pasajeros} pax</p>
      <div style="text-align:right">
        <button class="btn-edit">✏️</button>
        <button class="btn-del">🗑️</button>
      </div>
    `;
    if(act.alerta) li.style.border="2px solid red";
    li.querySelector(".btn-edit").onclick=()=>openModal(act,true);
    li.querySelector(".btn-del").onclick=async()=>{
      if(!confirm("¿Eliminar actividad?"))return;
      await fetch(GAS_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({datos:{...act,borrar:true}})});
      loadActivities(grupo,fecha);
    };
    ul.appendChild(li);
  });
}

// 11) Prepara el formulario del modal con los 7 bloques
function prepModalBloques(){
  fldBloques.innerHTML = "";
  BLOQUES.forEach(b=>{
    const row = document.createElement("div");
    row.className="bloque-row";
    // radio para seleccionar bloque
    row.innerHTML=`
      <label>
        <input type="radio" name="bloque" data-key="${b.key}"
               data-start="${b.start}" data-end="${b.end}">
        ${b.label}
      </label>
      <input type="time" data-key="${b.key}" value="${b.start}">
      <input type="time" data-key="${b.key}_end" value="${b.end}">
    `;
    fldBloques.appendChild(row);
  });
}

// 12) Abre el modal, rellena campos
function openModal(data,isEdit){
  editData = isEdit? data : null;
  document.getElementById("modal-title").textContent = isEdit? "Editar actividad":"Nueva actividad";
  fldFecha.value   = data.fecha;
  fldAct.value     = data.actividad||"";
  fldPas.value     = data.pasajeros || data.totalPax || 0;
  fldNotas.value   = data.notas||"";
  // si es edición, marca el bloque correspondiente
  if(isEdit){
    fldBloques.querySelectorAll('input[name="bloque"]').forEach(r=>{
      if(r.dataset.start===data.horaInicio) r.checked=true;
    });
    // y actualiza tiempos en inputs
    fldBloques.querySelectorAll("input[type=time]").forEach(i=>{
      const key=i.dataset.key;
      i.value = data[key] || i.value;
    });
  }
  modalBg.style.display = modal.style.display = "block";
}

// 13) Cierra el modal
function closeModal(){
  modalBg.style.display = modal.style.display = "none";
}
document.getElementById("modal-cancel").onclick = closeModal;
modalBg.onclick = closeModal;
