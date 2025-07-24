// registro.js

// 1️⃣ IMPORTS DE FIREBASE
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db } from "./firebase-init.js";
import {
  doc,
  setDoc,
  getDoc,
  collection,
  addDoc
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// 2️⃣ CONSTANTES Y CATÁLOGOS
const auth     = getAuth(app);
const sheetURL = "https://script.google.com/macros/s/.../exec"; // tu URL

const campos = [
  'numeroNegocio','identificador','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora','observaciones'
];
// … DESTINOS_CANONICOS, PROGRAMAS_POR_DESTINO, HOTELES_POR_DESTINO …

let manualMode = false;

// 3️⃣ REFERENCIAS AL DOM
const elems = {};
[
  'filtroAno','negocioList','identificador','nombreList',
  'destinosList','programasList','hoteles',
  'numeroNegocio','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora','observaciones',
  'formRegistro','tbodyTabla'
].forEach(id => elems[id] = document.getElementById(id));

// referenciamos el botón Guardar
elems.btnGuardar = document.getElementById('btnGuardar');

// 4️⃣ AUTENTICACIÓN Y ARRANQUE
auth.onAuthStateChanged(user => {
  if (!user) location.href = 'login.html';
  else init();
});

// 5️⃣ INICIALIZACIÓN
async function init() {
  // 5.1) datos de ventas
  const ventas = await (await fetch(sheetURL)).json();
  const anos = [...new Set(ventas.map(r => r.anoViaje))].sort();

  elems.filtroAno.innerHTML =
    `<option value="">Todos</option>` +
    anos.map(a => `<option>${a}</option>`).join('');
  elems.filtroAno.value = new Date().getFullYear();
  elems.filtroAno.onchange = () => {
    const y = elems.filtroAno.value;
    const list = y ? ventas.filter(r => r.anoViaje == y) : ventas;
    elems.negocioList.innerHTML = list.map(r => `<option value="${r.numeroNegocio}">`).join('');
    elems.nombreList.innerHTML  = list.map(r => `<option value="${r.nombreGrupo}">`).join('');
  };
  elems.filtroAno.dispatchEvent(new Event('change'));

  // 5.2) catálogos
  elems.destinosList.innerHTML =
    DESTINOS_CANONICOS.map(d => `<option>${d}</option>`).join('');

  // 5.3) eventos de carga de datos
  ['numeroNegocio','nombreGrupo'].forEach(id => {
    elems[id].onchange = () => loadDatos(ventas);
  });

  elems.destino.onchange      = handleDestinoChange;
  elems.programa.onchange     = handleProgramaChange;
  elems.fechaInicio.onchange  = calcularFin;
  elems.adultos.oninput       = ajustComp;
  elems.estudiantes.oninput   = ajustComp;

  // 5.4) valor por defecto del identificador
  elems.identificador.value = '101';

  // 5.5) clic en Guardar
  elems.btnGuardar.onclick = guardar;
}

// 6️⃣ FUNCIONES DE CAMBIO (igual que antes) …
function handleDestinoChange() { /* … */ }
function handleProgramaChange() { /* … */ }
function calcularFin() { /* … */ }
function ajustComp(e) { /* … */ }

// 7️⃣ CARGAR DATOS DESDE VENTAS Y FIREBASE
async function loadDatos(ventas) {
  const id = elems.numeroNegocio.value || '';
  const nombre = elems.nombreGrupo.value || '';

  // 7.1) primero, datos de ventas
  const venta = ventas.find(r =>
    String(r.numeroNegocio) === id || r.nombreGrupo === nombre
  );
  if (venta) {
    campos.forEach(c => {
      if (['duracion','noches','fechaFin','identificador'].includes(c)) return;
      elems[c].value = venta[c] || '';
    });
    // … resto de tu lógica de DESTINOS/PROGRAMAS/HOTELES …
  }

  // 7.2) luego Firebase
  const ref = doc(db, 'grupos', id);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data();
    // volcamos el identificador guardado
    if (data.identificador) {
      elems.identificador.value = data.identificador;
    }
    paintTable(id);
  }
}

// 8️⃣ GUARDAR EN FIREBASE Y REGISTRAR HISTORIAL
async function guardar() {
  const id = elems.numeroNegocio.value;
  const ref = doc(db, 'grupos', id);
  const user = auth.currentUser.email;
  const payload = {};

  campos.forEach(c => payload[c] = elems[c].value);
  payload.hoteles = [...elems.hoteles.selectedOptions].map(o => o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn = new Date();

  const snapB = await getDoc(ref);
  const before = snapB.exists() ? snapB.data() : {};

  await setDoc(ref, payload, { merge: true });

  // historial…
  const cambios = [];
  Object.keys(payload).forEach(k => {
    if (JSON.stringify(before[k]||'') !== JSON.stringify(payload[k]||'')) {
      cambios.push({ campo:k, anterior:before[k]||null, nuevo:payload[k] });
    }
  });
  if (cambios.length) {
    const col = collection(db, 'historial');
    await Promise.all(cambios.map(c =>
      addDoc(col, {
        numeroNegocio: id,
        campo: c.campo,
        anterior: c.anterior,
        nuevo: c.nuevo,
        modificadoPor: user,
        timestamp: new Date()
      })
    ));
  }

  alert('✅ Datos guardados en Firestore');
  paintTable(id);
}

// 9️⃣ PINTAR TABLA INFERIOR
async function paintTable(id) {
  const snap = await getDoc(doc(db, 'grupos', id));
  if (!snap.exists()) return;
  const d = snap.data();
  const tbody = elems.tbodyTabla;
  tbody.innerHTML = '';
  const tr = document.createElement('tr');
  [
    d.numeroNegocio, d.identificador, d.nombreGrupo, d.cantidadgrupo,
    d.colegio, d.curso, d.anoViaje,
    d.destino, d.programa, d.fechaInicio,
    d.duracion, d.noches, d.fechaFin,
    d.adultos, d.estudiantes,
    d.asistenciaEnViajes, d.autorizacion, d.fechaDeViaje,
    d.vendedora, d.observaciones,
    (d.hoteles||[]).join('; '),
    d.actualizadoPor, d.actualizadoEn.toLocaleString()
  ].forEach(v => {
    const td = document.createElement('td');
    td.textContent = v || '';
    tr.appendChild(td);
  });
  tbody.appendChild(tr);
}
