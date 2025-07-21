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
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";

// 2.1⃣ Campos del formulario
const campos = [
  'numeroNegocio','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora','observaciones'
];

// 2.2⃣ Destinos canónicos
const DESTINOS_CANONICOS = [
  'SUR DE CHILE',
  'NORTE DE CHILE',
  'BARILOCHE',
  'BRASIL',
  'SUR DE CHILE Y BARILOCHE',
  'OTRO'
];

// 2.3⃣ Programas por destino
const PROGRAMAS_POR_DESTINO = {
  'SUR DE CHILE': [
    'SUR DE CHILE 7/6',
    'SUR DE CHILE HUILO HUILO 7/6',
    'SUR DE CHILE PUCON 7/6'
  ],
  'NORTE DE CHILE': [
    'SAN PEDRO DE ATACAMA 7/6'
  ],
  'BARILOCHE': [
    'BARILOCHE 6/5',
    'BARILOCHE 7/6'
  ],
  'BRASIL': [
    'CAMBORIÚ ECO 8/7',
    'CAMBORIÚ VUELO DIRECTO 6/5',
    'CAMBORIÚ VUELO DIRECTO 8/7'
  ],
  'SUR DE CHILE Y BARILOCHE': [
    'SUR DE CHILE Y BARILOCHE 7/6',
    'SUR DE CHILE Y BARILOCHE 8/7'
  ],
  'OTRO': []
};

// 2.4⃣ Hoteles por destino
const HOTELES_POR_DESTINO = {
  'SUR DE CHILE': ['HOTEL BORDELAGO','HOTEL PUCÓN','HOTEL VIENTOS DEL SUR'],
  'NORTE DE CHILE': ['HOTEL LA ALDEA'],
  'BARILOCHE': ['HOTEL PIONEROS VILLA HUINID','HOTEL ECOMAX'],
  'BRASIL': ['HOTEL MARIMAR','HOTEL PLAZA CAMBORIÚ','HOTEL BRUT','HOTEL HM','HOTEL GERANIUM','HOTEL MARAMBAIA'],
  'SUR DE CHILE Y BARILOCHE': ['HOTEL BORDELAGO','HOTEL PUCÓN','HOTEL VIENTOS DEL SUR','HOTEL PIONEROS VILLA HUINID','HOTEL ECOMAX'],
  'OTRO': []
};

// Cuando el usuario elige “OTRO” destino, no forzamos programa/destino
let manualMode = false;

// 3️⃣ Referencias al DOM
const elems = {};
[
  'filtroAno','negocioList','nombreList',
  'destinosList','programasList','hoteles',
  'numeroNegocio','nombreGrupo','cantidadgrupo',
  'colegio','curso','anoViaje',
  'destino','programa','fechaInicio',
  'duracion','noches','fechaFin',
  'adultos','estudiantes',
  'asistenciaEnViajes','autorizacion','fechaDeViaje',
  'vendedora','formRegistro','tbodyTabla'
].forEach(id => elems[id] = document.getElementById(id));

// 4️⃣ Autenticación y arranque
auth.onAuthStateChanged(user => {
  if (!user) {
    location.href = 'login.html';
  } else {
    init();
  }
});

// 5️⃣ Inicialización de la UI
async function init() {
  // 5.1) Leer datos de Ventas desde Sheets
  const ventas = await (await fetch(sheetURL)).json();

  // 5.2) Filtrar años en datalist negocio/nombre
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

  // 5.3) Cargar destinos canónicos
  elems.destinosList.innerHTML =
    DESTINOS_CANONICOS.map(d => `<option>${d}</option>`).join('');

  // 5.4) Listeners principales
  ['numeroNegocio','nombreGrupo'].forEach(id => {
    elems[id].onchange = () => loadVenta(ventas);
  });
  elems.destino.onchange      = handleDestinoChange;
  elems.programa.onchange     = handleProgramaChange;
  elems.fechaInicio.onchange  = calcularFin;
  elems.adultos.oninput       = ajustComp;
  elems.estudiantes.oninput   = ajustComp;
  elems.formRegistro.onsubmit = e => { e.preventDefault(); guardar(); };
}

// 6️⃣ Al cambiar DESTINO
function handleDestinoChange() {
  const d = elems.destino.value;
  manualMode = (d === 'OTRO');

  // Poblar programas
  elems.programasList.innerHTML =
    (PROGRAMAS_POR_DESTINO[d] || []).map(p => `<option>${p}</option>`).join('');

  // Poblar lista de hoteles (multi-select)
  elems.hoteles.innerHTML =
    (HOTELES_POR_DESTINO[d] || []).map(h => `<option value="${h}">${h}</option>`).join('');
}

// 7️⃣ Al cambiar PROGRAMA
function handleProgramaChange() {
  if (!manualMode) {
    const p = elems.programa.value;
    // Forzar destino si coincide
    const dest = Object.entries(PROGRAMAS_POR_DESTINO)
      .find(([, arr]) => arr.includes(p))?.[0];
    if (dest && elems.destino.value !== dest) {
      elems.destino.value = dest;
      handleDestinoChange();
    }
    // Extraer días/noches de “X/Y”
    const m = p.match(/(\d+)\/(\d+)$/);
    if (m) { elems.duracion.value = m[1]; elems.noches.value = m[2]; }
    calcularFin();
  }
}

// 8️⃣ Calcular fecha de término = inicio + días - 1
function calcularFin() {
  const inicio = elems.fechaInicio.value;
  const dias   = Number(elems.duracion.value) || 0;
  if (inicio && dias) {
    const d = new Date(inicio);
    d.setDate(d.getDate() + dias - 1);
    elems.fechaFin.value = d.toISOString().slice(0,10);
  } else elems.fechaFin.value = '';
}

// 9️⃣ Ajustar Adultos/Estudiantes
function ajustComp(e) {
  const total = Number(elems.cantidadgrupo.value) || 0;
  const val   = Number(e.target.value) || 0;
  if (e.target === elems.adultos) elems.estudiantes.value = Math.max(0, total - val);
  else                             elems.adultos.value     = Math.max(0, total - val);
}

// 🔟 Cargar un registro EXISTENTE y normalizar
async function loadVenta(ventas) {
  const v = ventas.find(r =>
    String(r.numeroNegocio) === elems.numeroNegocio.value ||
    r.nombreGrupo === elems.nombreGrupo.value
  );
  if (!v) return;

  // 10.1) Rellenar campos (excepto días/noches/fechaFin)
  campos.forEach(c => {
    if (!['duracion','noches','fechaFin'].includes(c)) {
      elems[c].value = v[c] || '';
    }
  });

  // 10.2) Normalizar destino
  const dn = DESTINOS_CANONICOS.find(d => v.destino?.toUpperCase().includes(d)) || 'OTRO';
  elems.destino.value = dn;
  handleDestinoChange();

  // 10.3) Normalizar programa
  const pn = (PROGRAMAS_POR_DESTINO[dn] || [])
    .find(p => v.programa?.toUpperCase().includes(p)) || v.programa || '';
  elems.programa.value = pn;
  handleProgramaChange();

  // 10.4) Fecha fin
  calcularFin();

  // 10.5) **Multi-select de Hoteles**:
  //    Unimos texto libre de Ventas + lista canónica
  const origText  = (v.hotel || '').toUpperCase();
  const libres    = origText.split(/,| Y /i).map(h => h.trim()).filter(Boolean);
  const canonicos = HOTELES_POR_DESTINO[dn] || [];
  const union     = Array.from(new Set([...libres, ...canonicos]));

  elems.hoteles.innerHTML = union
    .map(h => {
      // Pre-seleccionamos los que venían en el texto libre
      const sel = libres.includes(h) ? ' selected' : '';
      return `<option value="${h}"${sel}>${h}</option>`;
    }).join('');

  // 10.6) Mostrar historial
  paintTable(v.numeroNegocio);
}

// 1️⃣1️⃣ Guardar en Firestore + registrar historial
async function guardar() {
  const id   = elems.numeroNegocio.value;
  const ref  = doc(db, 'grupos', id);
  const user = auth.currentUser.email;
  const payload = {};

  // 11.1) Leer todos los campos
  campos.forEach(c => payload[c] = elems[c].value);
  // 11.2) Leer TODOS los hoteles seleccionados
  payload.hoteles        = [...elems.hoteles.selectedOptions].map(o => o.value);
  payload.actualizadoPor = user;
  payload.actualizadoEn  = new Date();

  // 11.3) Guardar con merge
  await setDoc(ref, payload, { merge: true });

  // 11.4) Registrar historial de cambios
  const snapB = await getDoc(ref);
  const before = snapB.exists() ? snapB.data() : {};
  const cambios = [];
  Object.keys(payload).forEach(k => {
    if (JSON.stringify(before[k] || '') !== JSON.stringify(payload[k] || '')) {
      cambios.push({ campo: k, anterior: before[k] || null, nuevo: payload[k] });
    }
  });
  if (cambios.length) {
    const col = collection(db, 'historial');
    await Promise.all(cambios.map(c =>
      addDoc(col, {
        numeroNegocio: id,
        campo:         c.campo,
        anterior:      c.anterior,
        nuevo:         c.nuevo,
        modificadoPor: user,
        timestamp:     new Date()
      })
    ));
  }

  alert('✅ Datos guardados en Firestore');
  paintTable(id);
}

// 1️⃣2️⃣ Pintar la tabla con el registro actual
async function paintTable(id) {
  const snap = await getDoc(doc(db, 'grupos', id));
  if (!snap.exists()) return;
  const d     = snap.data();
  const tbody = elems.tbodyTabla;
  tbody.innerHTML = '';
  const tr = document.createElement('tr');

  [
    d.numeroNegocio, d.nombreGrupo, d.cantidadgrupo,
    d.colegio, d.curso, d.anoViaje,
    d.destino, d.programa, d.fechaInicio,
    d.duracion, d.noches, d.fechaFin,
    d.adultos, d.estudiantes,
    d.asistenciaEnViajes, d.autorizacion, d.fechaDeViaje,
    d.vendedora, (d.hoteles||[]).join('; '),
    d.actualizadoPor, d.actualizadoEn.toLocaleString()
  ].forEach(v => {
    const td = document.createElement('td');
    td.textContent = v || '';
    tr.appendChild(td);
  });

  tbody.appendChild(tr);
}
