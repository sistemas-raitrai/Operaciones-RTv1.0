// ——————————————————————————————
// 0) Importes Firebase (v11.7.3 modular)
// ——————————————————————————————
import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  doc, getDoc, updateDoc,
  collection, getDocs, addDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);

// ——————————————————————————————
// 1) Referencias DOM
// ——————————————————————————————
const selNum       = document.getElementById('numeroNegocio');
const inpNombre    = document.getElementById('nombreGrupo');
const inpDestino   = document.getElementById('destino');
const inpPrograma  = document.getElementById('programa');
const inpCoord     = document.getElementById('coordinador');
const inpInicio    = document.getElementById('fechaInicio');
const inpDuracion  = document.getElementById('duracion');
const inpFin       = document.getElementById('fechaFin');
const inpTotal     = document.getElementById('totalPax');
const inpAdultos   = document.getElementById('adultos');
const inpEst       = document.getElementById('estudiantes');
const selTran      = document.getElementById('transporte');
const seccionTramos= document.getElementById('seccionTramos');
const contTramos   = document.getElementById('tramosDetalle');
const btnAddTramo  = document.getElementById('btnAddTramo');
const inpHoteles   = document.getElementById('hoteles');
const inpCiudades  = document.getElementById('ciudades');
const inpObs       = document.getElementById('observaciones');
const form         = document.getElementById('formInfoViaje');

let tramoCount = 0;

// ——————————————————————————————
// 2) Autenticación y arranque
// ——————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    initForm();
  }
});

// ——————————————————————————————
// 3) init: poblar select y listeners
// ——————————————————————————————
async function initForm() {
  // leer todos los grupos
  const snap = await getDocs(collection(db, 'grupos'));
  selNum.innerHTML = snap.docs.map(d => {
    const dta = d.data();
    return `<option value="${d.id}">${dta.numeroNegocio}</option>`;
  }).join('');

  // listeners
  selNum.onchange      = cargarGrupo;
  inpInicio.onchange   = calcularFin;
  inpDuracion.oninput  = calcularFin;
  inpAdultos.oninput   = ajustarComp;
  inpEst.oninput       = ajustarComp;
  selTran.onchange      = toggleTramos;
  btnAddTramo.onclick   = () => addTramo();
  form.onsubmit         = guardarInfo;

  // disparar primera carga
  selNum.dispatchEvent(new Event('change'));
}

// ——————————————————————————————
// 4) cargarGrupo: mezcla “grupos/{id}” + “viajes/{id}”
// ——————————————————————————————
async function cargarGrupo() {
  const id    = selNum.value;
  const snapG = await getDoc(doc(db,'grupos'));
  if (!snapG.exists()) return;
  const g = snapG.data();

  // base de grupos
  inpNombre.value   = g.nombreGrupo   || '';
  inpDestino.value  = g.destino       || '';
  inpPrograma.value = g.programa      || '';
  inpTotal.value    = g.cantidadgrupo || '';

  // PRECARGAR COORDINADOR si viene de “viajes”
  const snapV = await getDoc(doc(db,'viajes',id));
  if (snapV.exists()) {
    const v = snapV.data();
    inpCoord.value    = v.coordinador    || '';
    inpInicio.value   = v.fechaInicio    || '';
    inpDuracion.value = v.duracion       || '';
    inpAdultos.value  = v.adultos        || '';
    inpEst.value      = v.estudiantes    || '';
    selTran.value     = v.transporte     || '';
    inpHoteles.value  = (v.hoteles  || []).join('; ');
    inpCiudades.value = (v.ciudades || []).join('; ');
    inpObs.value      = v.observaciones  || '';
    toggleTramos();
    if (v.tramos) renderTramos(v.tramos);
  } else {
    // limpiar
    inpCoord.value = '';
    inpInicio.value= inpDuracion.value= '';
    inpAdultos.value= inpEst.value= '';
    selTran.value='';
    inpHoteles.value= inpCiudades.value= inpObs.value='';
    contTramos.innerHTML='';
    seccionTramos.style.display='none';
  }

  calcularFin();
}

// ——————————————————————————————
// 5) calcularFin: inicio + duracion -1
// ——————————————————————————————
function calcularFin() {
  if (!inpInicio.value || !inpDuracion.value) {
    inpFin.value = '';
    return;
  }
  const d = new Date(inpInicio.value);
  d.setDate(d.getDate() + Number(inpDuracion.value) -1);
  inpFin.value = d.toISOString().slice(0,10);
}

// ——————————————————————————————
// 6) ajustarComp: adultos+est = total
// ——————————————————————————————
function ajustarComp(e) {
  const total = Number(inpTotal.value)||0;
  const a     = Number(inpAdultos.value)||0;
  const s     = Number(inpEst.value)||0;
  if (e.target===inpAdultos) {
    inpEst.value = total - a;
  } else {
    inpAdultos.value = total - s;
  }
}

// ——————————————————————————————
// 7) toggleTramos: muestra/oculta sección
// ——————————————————————————————
function toggleTramos() {
  const t = selTran.value;
  if (['aereo','terrestre','mixto'].includes(t)) {
    seccionTramos.style.display = 'block';
    contTramos.innerHTML = '';
    tramoCount = 0;
  } else {
    seccionTramos.style.display = 'none';
    contTramos.innerHTML = '';
    tramoCount = 0;
  }
}

// ——————————————————————————————
// 8) addTramo: crea fieldset con campos reducidos
// ——————————————————————————————
function addTramo(data={}) {
  const tipo = selTran.value;
  tramoCount++;
  let html = '';

  // VUELO ida+vta
  if (tipo==='aereo'||tipo==='mixto') {
    html += `
      <fieldset class="tramo">
        <legend>Vuelo ${tramoCount}</legend>
        <!-- Ida -->
        <label>Hora Inicio (ida):<input type="time" value="${data.salida||''}"></label>
        <label>Origen (ida):<input value="${data.origen||''}"></label>
        <label>Aerolínea:<input value="${data.aerolinea||''}"></label>
        <label>N° Vuelo:<input value="${data.numero||''}"></label>
        <!-- Vuelta -->
        <hr>
        <label>Origen (vta):<input value="${data.origenVta||''}"></label>
        <label>Aerolínea:<input value="${data.aerolineaVta||''}"></label>
        <label>N° Vuelo:<input value="${data.numeroVta||''}"></label>
        <label>Hora Salida (vta):<input type="time" value="${data.salidaVta||''}"></label>
        <button type="button" class="btn-del">Eliminar</button>
      </fieldset>
    `;
  }

  // BUS terrestre
  if (tipo==='terrestre'||tipo==='mixto') {
    html += `
      <fieldset class="tramo">
        <legend>Bus ${tramoCount}</legend>
        <label>Lugar Encuentro:<input value="${data.lugar||''}"></label>
        <label>Hora Inicio:<input type="time" value="${data.hora||''}"></label>
        <label>Empresa:<input value="${data.empresa||''}"></label>
        <label>Conductor 1:<input value="${data.cond1||''}"></label>
        <label>Conductor 2:<input value="${data.cond2||''}"></label>
        <button type="button" class="btn-del">Eliminar</button>
      </fieldset>
    `;
  }

  const div=document.createElement('div');
  div.innerHTML=html;
  div.querySelectorAll('.btn-del').forEach(b=> b.onclick=()=>b.closest('fieldset').remove());
  contTramos.appendChild(div);
}

// ——————————————————————————————
// 9) renderTramos: precargar si existen
// ——————————————————————————————
function renderTramos(arr) {
  arr.forEach(t=> addTramo(t));
}

// ——————————————————————————————
// 10) guardarInfo: updateDoc(grupos/{id}) + historial
// ——————————————————————————————
async function guardarInfo(evt) {
  evt.preventDefault();
  const id   = selNum.value;
  const refG = doc(db,'grupos',id);
  const snapG= await getDoc(refG);
  const before = snapG.exists()? snapG.data(): {};

  // recojo tramos
  const tramos = [...contTramos.querySelectorAll('fieldset.tramo')].map(fs=>{
    const i= fs.querySelectorAll('input');
    return {
      salida:     i[0].value,
      origen:     i[1].value,
      aerolinea:  i[2].value,
      numero:     i[3].value,
      origenVta:  i[5].value,
      aerolineaVta:i[6].value,
      numeroVta:  i[7].value,
      salidaVta:  i[8].value,
      lugar:      i[9]?.value||'',
      hora:       i[10]?.value||'',
      empresa:    i[11]?.value||'',
      cond1:      i[12]?.value||'',
      cond2:      i[13]?.value||''
    };
  });

  // payload
  const payload = {
    fechaInicio:   inpInicio.value,
    duracion:      Number(inpDuracion.value),
    fechaFin:      inpFin.value,
    adultos:       Number(inpAdultos.value),
    estudiantes:   Number(inpEst.value),
    transporte:    selTran.value,
    tramos,
    hoteles:       inpHoteles.value.split(';').map(s=>s.trim()).filter(x=>x),
    ciudades:      inpCiudades.value.split(';').map(s=>s.trim()).filter(x=>x),
    observaciones: inpObs.value,
    coordinador:   inpCoord.value,
    actualizadoPor: auth.currentUser.email,
    actualizadoEn:  new Date()
  };

  // 10.1 actualizar grupo
  await updateDoc(refG, payload);

  // 10.2 historial por campo
  const cambios=[];
  for(const k in payload){
    if (JSON.stringify(before[k]||'')!==JSON.stringify(payload[k]||'')){
      cambios.push({campo:k, anterior:before[k]||null, nuevo:payload[k]});
    }
  }
  if(cambios.length){
    await Promise.all(cambios.map(c=>
      addDoc(collection(db,'historial'),{
        numeroNegocio:id,
        campo:        c.campo,
        anterior:     c.anterior,
        nuevo:        c.nuevo,
        modificadoPor: auth.currentUser.email,
        timestamp:     new Date()
      })
    ));
  }

  alert('✅ Datos guardados y registrados en historial');
}
