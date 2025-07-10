// —————————————————————————————————————————————————————————————
// 0) Imports y setup Firebase v9 (modular)
// —————————————————————————————————————————————————————————————
import { app } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import {
  getFirestore,
  collection, getDocs, doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

const auth = getAuth(app);
const db   = getFirestore(app);

// —————————————————————————————————————————————————————————————
// 1) Cache de elementos del DOM
// —————————————————————————————————————————————————————————————
const selNum       = document.getElementById('numeroNegocio');
const inpNombre    = document.getElementById('nombreGrupo');
const inpDestino   = document.getElementById('destino');
const inpPrograma  = document.getElementById('programa');
const inpInicio    = document.getElementById('fechaInicio');
const inpDuracion  = document.getElementById('duracion');
const inpFin       = document.getElementById('fechaFin');
const inpTotal     = document.getElementById('totalPax');
const inpAdultos   = document.getElementById('adultos');
const inpEst       = document.getElementById('estudiantes');
const selTran      = document.getElementById('transporte');
const subformVuelos= document.getElementById('subformVuelos');
const vuelosCont   = document.getElementById('vuelosContainer');
const btnAddVuelo  = document.getElementById('btnAddVuelo');
const subformBuses = document.getElementById('subformBuses');
const busesCont    = document.getElementById('busesContainer');
const inpHoteles   = document.getElementById('hoteles');
const inpCiudades  = document.getElementById('ciudades');
const inpObs       = document.getElementById('observaciones');
const form         = document.getElementById('formInfoViaje');

// Contadores para numerar tramos
let cntVuelo = 0, cntBus = 0;

// —————————————————————————————————————————————————————————————
// 2) Autenticación y arranque
// —————————————————————————————————————————————————————————————
onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    initForm();
  }
});

// —————————————————————————————————————————————————————————————
// 3) Inicializa formulario: carga lista de grupos + wiring
// —————————————————————————————————————————————————————————————
async function initForm() {
  // 3.1) Leer colección “grupos” para poblar el select
  const snap = await getDocs(collection(db, 'grupos'));
  selNum.innerHTML = snap.docs.map(d =>
    `<option value="${d.id}">${d.data().numeroNegocio}</option>`
  ).join('');

  // 3.2) Al cambiar de grupo, carga sus datos
  selNum.onchange = loadGrupo;
  selNum.dispatchEvent(new Event('change'));

  // 3.3) Calcular fecha fin cuando cambian inicio/duración
  inpInicio.onchange = calcularFin;
  inpDuracion.oninput= calcularFin;

  // 3.4) Ajustar adultos/estudiantes
  inpAdultos.oninput = ajustarComp;
  inpEst.oninput     = ajustarComp;

  // 3.5) Mostrar/ocultar subformularios por transporte
  selTran.onchange = toggleForms;

  // 3.6) Botones “Añadir tramo”
  btnAddVuelo.onclick = () => addVuelo();
  document.getElementById('btnAddBus').onclick = () => addBus();

  // 3.7) Envío de form
  form.onsubmit = guardarInfo;
}

// —————————————————————————————————————————————————————————————
// 4) Cargar datos del grupo + info de “viajes” si existe
// —————————————————————————————————————————————————————————————
async function loadGrupo() {
  const id = selNum.value;
  // 4.1) Datos base en “grupos”
  const snapG = await getDoc(doc(db, 'grupos', id));
  const g     = snapG.data()||{};
  inpNombre.value   = g.nombreGrupo||'';
  inpDestino.value  = g.destino     ||'';
  inpPrograma.value = g.programa    ||'';
  inpTotal.value    = g.cantidadgrupo||'';

  // 4.2) Datos previos de “viajes” (merge)
  const snapV = await getDoc(doc(db, 'viajes', id));
  if (snapV.exists()) {
    const v = snapV.data();
    inpInicio.value   = v.fechaInicio||'';
    inpDuracion.value = v.duracion   ||'';
    inpAdultos.value  = v.adultos    ||0;
    inpEst.value      = v.estudiantes||0;
    selTran.value     = v.transporte ||'';
    inpHoteles.value  = (v.hoteles||[]).join('; ');
    inpCiudades.value = (v.ciudades||[]).join('; ');
    inpObs.value      = v.observaciones||'';

    // Render de tramos pasados
    clearTramos();
    if (v.vuelos) v.vuelos.forEach(addVuelo);
    if (v.buses)  v.buses.forEach(addBus);
  } else {
    // limpio form completamente
    [inpInicio, inpDuracion, inpAdultos, inpEst].forEach(i=>i.value='');
    selTran.value=''; inpHoteles.value=inpCiudades.value=inpObs.value='';
    clearTramos();
  }

  calcularFin();
  toggleForms();
}

// —————————————————————————————————————————————————————————————
// 5) Calcula fechaFin = fechaInicio + duracion -1
// —————————————————————————————————————————————————————————————
function calcularFin() {
  const inicio = inpInicio.valueAsDate;
  const dias   = parseInt(inpDuracion.value,10);
  if (!inicio || !dias) {
    inpFin.value='';
    return;
  }
  const f = new Date(inicio);
  f.setDate(f.getDate() + dias - 1);
  inpFin.value = f.toISOString().slice(0,10);
}

// —————————————————————————————————————————————————————————————
// 6) Adultos/Estudiantes mutuamente condicionados
// —————————————————————————————————————————————————————————————
function ajustarComp(e) {
  const tot = parseInt(inpTotal.value,10) || 0;
  const a   = parseInt(inpAdultos.value,10)||0;
  const s   = parseInt(inpEst.value,10)||0;
  if (e.target===inpAdultos) {
    inpEst.value = tot - a;
  } else {
    inpAdultos.value = tot - s;
  }
}

// —————————————————————————————————————————————————————————————
// 7) Mostrar/ocultar vuelo/bus según transporte
// —————————————————————————————————————————————————————————————
function toggleForms() {
  const t = selTran.value;
  subformVuelos.style.display = (t==='aereo'||t==='mixto')?'block':'none';
  subformBuses .style.display = (t==='terrestre'||t==='mixto')?'block':'none';
}

// —————————————————————————————————————————————————————————————
// 8) Limpia ambos containers de tramos
// —————————————————————————————————————————————————————————————
function clearTramos() {
  vuelosCont.innerHTML = ''; cntVuelo=0;
  busesCont.innerHTML  = ''; cntBus =0;
}

// —————————————————————————————————————————————————————————————
// 9) Añade un tramo de vuelo (usa data opcional para precarga)
// —————————————————————————————————————————————————————————————
function addVuelo(data={}) {
  cntVuelo++;
  const div = document.createElement('div');
  div.className = 'tramo'; div.dataset.tipo='vuelo';
  div.innerHTML = `
    <fieldset>
      <legend>Vuelo ${cntVuelo}</legend>
      <label>Origen:<input name="vueloOrigen"   value="${data.origen||''}"></label>
      <label>Salida:<input type="time" name="vueloSalida"   value="${data.salida||''}"></label>
      <label>Aerolínea:
        <select name="vueloAerolinea">
          <option${data.aerolinea==='LATAM'?' selected':''}>LATAM</option>
          <option${data.aerolinea==='SKY'  ?' selected':''}>SKY</option>
          <option${data.aerolinea==='OTRO' ?' selected':''}>OTRO</option>
        </select>
      </label>
      <label>Nº Vuelo:<input name="vueloNum"      value="${data.numero||''}"></label>
      <label>Llegada:<input type="time" name="vueloLlegada"  value="${data.llegada||''}"></label>
      <button type="button" class="remove">Eliminar</button>
    </fieldset>`;
  div.querySelector('.remove').onclick = () => div.remove();
  vuelosCont.appendChild(div);
}

// —————————————————————————————————————————————————————————————
// 10) Añade tramo de bus
// —————————————————————————————————————————————————————————————
function addBus(data={}) {
  cntBus++;
  const div = document.createElement('div');
  div.className = 'tramo'; div.dataset.tipo='bus';
  div.innerHTML = `
    <fieldset>
      <legend>Bus ${cntBus}</legend>
      <label>Empresa:<input name="busEmpresa"     value="${data.empresa||''}"></label>
      <label>Cond.1:<input name="busConductor1"  value="${data.conductor1||''}"></label>
      <label>Cond.2:<input name="busConductor2"  value="${data.conductor2||''}"></label>
      <label>Ida - Lugar:<input name="busSalidaLugar" value="${data.lugarIda||''}"></label>
      <label>Ida - Hora:<input type="time" name="busSalidaHora" value="${data.horaIda||''}"></label>
      <label>Vta - Lugar:<input name="busRetornoLugar" value="${data.lugarVta||''}"></label>
      <label>Vta - Hora:<input type="time" name="busRetornoHora"  value="${data.horaVta||''}"></label>
      <button type="button" class="remove">Eliminar</button>
    </fieldset>`;
  div.querySelector('.remove').onclick = () => div.remove();
  busesCont.appendChild(div);
}

// —————————————————————————————————————————————————————————————
// 11) Guardar todo en Firestore (colección “viajes”)
// —————————————————————————————————————————————————————————————
async function guardarInfo(evt) {
  evt.preventDefault();
  const id = selNum.value;

  // Recojo vuelos y buses en arrays de objetos
  const vuelos = [...vuelosCont.querySelectorAll('.tramo[data-tipo=vuelo]')].map(fs => ({
    origen:      fs.querySelector('[name=vueloOrigen]').value,
    salida:      fs.querySelector('[name=vueloSalida]').value,
    aerolinea:   fs.querySelector('[name=vueloAerolinea]').value,
    numero:      fs.querySelector('[name=vueloNum]').value,
    llegada:     fs.querySelector('[name=vueloLlegada]').value
  }));
  const buses = [...busesCont.querySelectorAll('.tramo[data-tipo=bus]')].map(fs => ({
    empresa:     fs.querySelector('[name=busEmpresa]').value,
    conductor1:  fs.querySelector('[name=busConductor1]').value,
    conductor2:  fs.querySelector('[name=busConductor2]').value,
    lugarIda:    fs.querySelector('[name=busSalidaLugar]').value,
    horaIda:     fs.querySelector('[name=busSalidaHora]').value,
    lugarVta:    fs.querySelector('[name=busRetornoLugar]').value,
    horaVta:     fs.querySelector('[name=busRetornoHora]').value
  }));

  // Construyo el objeto final
  const payload = {
    fechaInicio:   inpInicio.value,
    duracion:      Number(inpDuracion.value),
    fechaFin:      inpFin.value,
    adultos:       Number(inpAdultos.value),
    estudiantes:   Number(inpEst.value),
    transporte:    selTran.value,
    vuelos, buses,
    hoteles:       inpHoteles.value.split(';').map(s=>s.trim()).filter(Boolean),
    ciudades:      inpCiudades.value.split(';').map(s=>s.trim()).filter(Boolean),
    observaciones: inpObs.value,
    modificadoPor: auth.currentUser.email,
    fechaMod:      new Date().toISOString()
  };

  // Grabo con merge (no borra campos anteriores)
  await setDoc(doc(db, 'viajes', id), payload, { merge: true });
  alert('✅ Información guardada correctamente');
}
