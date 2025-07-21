// registro.js

import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db } from "./firebase-init.js";
import {
  doc, setDoc, updateDoc, getDoc,
  collection, addDoc, getDocs
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// --- Constantes y mapeo
const auth = getAuth(app);
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";
// Campos HTML ↔ prop
const campos = [
  'numeroNegocio', 'nombreGrupo', 'cantidadgrupo',
  'colegio', 'curso', 'anoViaje',
  'destino', 'programa', 'fechaInicio',
  'duracion', 'noches', 'adultos', 'estudiantes',
  'vendedora'
];

// Datos estáticos de destinos y programas (pueden venir de ventas)
const DESTINOS = [];
const PROGRAMAS = [];
// Mapa destino → lista de hoteles
const HOTELES_MAP = {};

// Referencias DOM
const elems = {};
['filtroAno','negocioList','nombreList','destinosList','programasList','hoteles',
 'numeroNegocio','nombreGrupo','cantidadgrupo','colegio','curso','anoViaje',
 'destino','programa','fechaInicio','duracion','noches','adultos','estudiantes','vendedora',
 'formRegistro','tbodyTabla']
.forEach(id => elems[id] = document.getElementById(id));

// Al iniciar
auth.onAuthStateChanged(user => {
  if (!user) return location.href = 'login.html';
  init();
});

async function init() {
  // 1) Cargar datos de ventas desde Sheet
  const ventas = await (await fetch(sheetURL)).json();
  // extraer únicos
  const anos = [...new Set(ventas.map(r=>r.anoViaje))].sort();
  elems.filtroAno.innerHTML = `<option value="">Todos</option>`+
    anos.map(a=>`<option>${a}</option>`).join('');
  elems.filtroAno.value = new Date().getFullYear();

  populateDatalists(ventas);
  setupListeners(ventas);
  elems.formRegistro.onsubmit = e => { e.preventDefault(); guardar(); };
  // primera carga
  elems.filtroAno.dispatchEvent(new Event('change'));
}

function populateDatalists(ventas) {
  // Negocio / Grupo por año
  function filtrar() {
    const year = elems.filtroAno.value;
    const list = year ? ventas.filter(r=>r.anoViaje==year) : ventas;
    elems.negocioList.innerHTML = list.map(r=>`<option value="${r.numeroNegocio}"></option>`).join('');
    elems.nombreList.innerHTML  = list.map(r=>`<option value="${r.nombreGrupo}"></option>`).join('');
  }
  elems.filtroAno.onchange = filtrar;
  filtrar();

  // Destinos y programas únicos
  const dests = [...new Set(ventas.map(r=>r.destino))].sort();
  const progs = [...new Set(ventas.map(r=>r.programa))].sort();
  elems.destinosList.innerHTML = dests.map(d=>`<option>${d}</option>`).join('');
  elems.programasList.innerHTML = progs.map(p=>`<option>${p}</option>`).join('');

  destinosInit(dests, ventas);
}

function destinosInit(dests, ventas) {
  // construir HOTELES_MAP según ventas
  dests.forEach(d => {
    HOTELES_MAP[d] = [...new Set(
      ventas.filter(r=>r.destino===d)
            .map(r=>r.hotel)
            .filter(Boolean)
    )];
  });
}

function setupListeners(ventas) {
  // Carga datos al elegir negocio o nombre
  ['numeroNegocio','nombreGrupo'].forEach(id => {
    elems[id].onchange = () => cargarGrupo(elems[id].value, ventas);
  });
  // Programa → extraer días/noches
  elems.programa.onchange = onProgramaChange;
  // Destino → recargar hoteles
  elems.destino.onchange  = onDestinoChange;
  // Adultos/Estudiantes → ajustar composición
  elems.adultos.oninput    = ajustarComp;
  elems.estudiantes.oninput= ajustarComp;
}

function cargarGrupo(valor, ventas) {
  const row = ventas.find(r=>String(r.numeroNegocio)==valor||r.nombreGrupo===valor);
  if (!row) return;
  // rellenar campos básicos
  campos.forEach(c => {
    if (c==='duracion'||c==='noches') return;
    const el = elems[c];
    el.value = row[c]||'';
  });
  elems.cantidadgrupo.value = row.cantidadgrupo;
  elems.vendedora.value      = row.vendedora||'';
  // disparar programa & destino
  onProgramaChange();
  onDestinoChange();
  // cargar históricos
  pintarTabla(row.numeroNegocio);
}

function onProgramaChange() {
  const m = elems.programa.value.match(/(\d+)\/(\d+)$/);
  if (m) {
    elems.duracion.value = m[1];
    elems.noches.value   = m[2];
  }
}

function onDestinoChange() {
  const d = elems.destino.value;
  const opts = HOTELES_MAP[d]||[];
  elems.hoteles.innerHTML = opts.map(h=>`<option value="${h}">${h}</option>`).join('');
}

function ajustarComp(e) {
  const total = Number(elems.cantidadgrupo.value)||0;
  const a = Number(elems.adultos.value)||0;
  const s = Number(elems.estudiantes.value)||0;
  if (e.target===elems.adultos) elems.estudiantes.value = Math.max(0, total - a);
  else elems.adultos.value = Math.max(0, total - s);
}

async function guardar() {
  const user = auth.currentUser.email;
  const docRef = doc(db,'grupos', elems.numeroNegocio.value);
  // armar payload
  const payload = {};
  campos.forEach(c => payload[c] = elems[c].value);
  payload.hoteles = [...elems.hoteles.selectedOptions].map(o=>o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn  = new Date();
  // guardar
  await setDoc(docRef, payload, { merge:true });
  // historial
  const beforeSnap = await getDoc(docRef);
  const before = beforeSnap.exists() ? beforeSnap.data() : {};
  const cambios = [];
  for (let k in payload) {
    if (JSON.stringify(before[k]||'')!==JSON.stringify(payload[k]||'')) {
      cambios.push({ campo:k, anterior: before[k]||null, nuevo: payload[k] });
    }
  }
  if (cambios.length) {
    const colH = collection(db,'historial');
    await Promise.all(cambios.map(c => addDoc(colH, {
      numeroNegocio: elems.numeroNegocio.value,
      campo: c.campo,
      anterior: c.anterior,
      nuevo: c.nuevo,
      modificadoPor: user,
      timestamp: new Date()
    })));
  }
  alert('✅ Datos guardados en Firestore');
  pintarTabla(elems.numeroNegocio.value);
}

async function pintarTabla(id) {
  const tbody = elems.tbodyTabla;
  tbody.innerHTML = '';
  const snap = await getDoc(doc(db,'grupos',id));
  if (!snap.exists()) return;
  const d = snap.data();
  const tr = document.createElement('tr');
  [
    d.numeroNegocio, d.nombreGrupo, d.cantidadgrupo,
    d.colegio, d.curso, d.anoViaje,
    d.destino, d.programa, d.fechaInicio,
    d.duracion, d.noches, d.adultos, d.estudiantes,
    d.vendedora, (d.hoteles||[]).join(', '),
    d.actualizadoPor, d.actualizadoEn.toLocaleString()
  ].forEach(v => {
    const td = document.createElement('td'); td.textContent = v||''; tr.appendChild(td);
  });
  tbody.appendChild(tr);
}
