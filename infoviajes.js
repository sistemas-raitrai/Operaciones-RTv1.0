// ✅ infoViajes.js – Lectura y escritura con Google Apps Script
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

// 🔗 URL del Web App desplegado (ya funcionando en tu sistema)
const GAS_URL = "https://script.google.com/macros/s/AKfycbzr12TXE8-lFd86P1yK_yRSVyyFFSuUnAHY_jOefJHYQZCQ5yuQGQsoBP2OWh699K22/exec";

// 🌐 Elementos del DOM
const selectNegocio = document.getElementById("numeroNegocio");
const selectDestino = document.getElementById("destino");
const inputFechaInicio = document.getElementById("fechaInicio");
const inputFechaFin = document.getElementById("fechaFin");
const inputAdultos = document.getElementById("adultos");
const inputEstudiantes = document.getElementById("estudiantes");
const selectTransporte = document.getElementById("transporte");
const seccionTramos = document.getElementById("seccionTramos");
const inputCantidadTramos = document.getElementById("cantidadTramos");
const divDetalleTramos = document.getElementById("detalleTramos");
const selectCiudades = document.getElementById("ciudades");
const inputObservaciones = document.getElementById("observaciones");

// 📥 Cargar número de negocio y destinos desde hoja pública
const sheetID = "124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI";
const hojaLectura = "LecturaBaseOperaciones";
const urlLectura = `https://opensheet.elk.sh/${sheetID}/${hojaLectura}`;

async function cargarNumerosDeNegocio() {
  try {
    const res = await fetch(urlLectura);
    const datos = await res.json();
    selectNegocio.innerHTML = "";
    selectDestino.innerHTML = "";

    const usados = new Set();

    datos.forEach(row => {
      if (row.numeroNegocio && !usados.has(row.numeroNegocio)) {
        const opt = document.createElement("option");
        opt.value = row.numeroNegocio;
        opt.textContent = row.numeroNegocio;
        selectNegocio.appendChild(opt);
        usados.add(row.numeroNegocio);
      }
    });

    // Cargar destinos únicos
    const destinosUnicos = [...new Set(datos.map(f => f.destino).filter(Boolean))];
    destinosUnicos.forEach(dest => {
      const opt = document.createElement("option");
      opt.value = dest;
      opt.textContent = dest;
      selectDestino.appendChild(opt);
    });

    // Detectar si viene desde registro.html
    const numero = sessionStorage.getItem("numeroNegocio") || new URLSearchParams(location.search).get("numeroNegocio");
    if (numero) {
      selectNegocio.value = numero;
      cargarDatosExistentes(numero);
    }

    selectNegocio.addEventListener("change", () => {
      cargarDatosExistentes(selectNegocio.value);
    });

  } catch (err) {
    console.error("❌ Error cargando datos:", err);
  }
}

// 🧠 Cargar datos existentes desde GAS
async function cargarDatosExistentes(numeroNegocio) {
  try {
    const res = await fetch(`${GAS_URL}?numeroNegocio=${numeroNegocio}`);
    const json = await res.json();
    if (!json.existe) return;

    const fila = json.valores;
    const destino = fila[6]; // Columna G

    // Asegura que el destino esté en el select
    if (destino && ![...selectDestino.options].some(opt => opt.value === destino)) {
      const opt = document.createElement("option");
      opt.value = destino;
      opt.textContent = destino;
      selectDestino.appendChild(opt);
    }

    selectDestino.value = destino;
    inputFechaInicio.value = fila[16] || "";
    inputFechaFin.value = fila[17] || "";
    inputAdultos.value = fila[18] || "";
    inputEstudiantes.value = fila[19] || "";
    selectTransporte.value = fila[20] || "";
    inputObservaciones.value = fila[24] || "";

    // Ciudades
    const ciudades = fila[21]?.split(",") || [];
    [...selectCiudades.options].forEach(opt => {
      opt.selected = ciudades.includes(opt.value);
    });

    // Tramos
    if (fila[23]) {
      const tramos = JSON.parse(fila[23]);
      inputCantidadTramos.value = tramos.length;
      generarCamposTramos(tramos.length);
      setTimeout(() => {
        tramos.forEach((t, i) => {
          const idx = i + 1;
          document.querySelector(`[name=tipoTramo${idx}]`).value = t.tipo;
          document.querySelector(`[name=empresa${idx}]`).value = t.empresa;
          document.querySelector(`[name=info${idx}]`).value = t.info;
          document.querySelector(`[name=salida${idx}]`).value = t.salida;
          document.querySelector(`[name=lugar${idx}]`).value = t.lugar;
        });
      }, 100);
    }

  } catch (err) {
    console.error("⚠️ Error cargando fila desde GAS:", err);
  }
}

// 🧱 Crear tramos dinámicos
function generarCamposTramos(cantidad) {
  divDetalleTramos.innerHTML = "";
  for (let i = 1; i <= cantidad; i++) {
    divDetalleTramos.innerHTML += `
      <div>
        <h4>Tramo ${i}</h4>
        <label>Tipo:</label>
        <select name="tipoTramo${i}">
          <option value="terrestre">Terrestre</option>
          <option value="aereo">Aéreo</option>
        </select>
        <label>Empresa / Compañía:</label>
        <input name="empresa${i}" />
        <label>Conductor / Nº Vuelo:</label>
        <input name="info${i}" />
        <label>Fecha y hora salida:</label>
        <input type="datetime-local" name="salida${i}" />
        <label>Terminal / Aeropuerto:</label>
        <input name="lugar${i}" />
        <hr />
      </div>
    `;
  }
}

// 🧩 Obtener tramos como array
function obtenerTramos() {
  const cantidad = parseInt(inputCantidadTramos.value);
  const tramos = [];
  for (let i = 1; i <= cantidad; i++) {
    tramos.push({
      tipo: document.querySelector(`[name=tipoTramo${i}]`)?.value || "",
      empresa: document.querySelector(`[name=empresa${i}]`)?.value || "",
      info: document.querySelector(`[name=info${i}]`)?.value || "",
      salida: document.querySelector(`[name=salida${i}]`)?.value || "",
      lugar: document.querySelector(`[name=lugar${i}]`)?.value || ""
    });
  }
  return tramos;
}

// 🧠 Ciudades seleccionadas
function obtenerCiudades() {
  return [...selectCiudades.selectedOptions].map(o => o.value);
}

// 💾 Enviar datos al script GAS (doPost)
document.getElementById("formInfoViaje").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    numeroNegocio: selectNegocio.value,
    fechaInicio: inputFechaInicio.value,
    fechaFin: inputFechaFin.value,
    adultos: inputAdultos.value,
    estudiantes: inputEstudiantes.value,
    transporte: selectTransporte.value,
    ciudades: obtenerCiudades().join(", "),
    tramos: JSON.stringify(obtenerTramos()),
    observaciones: inputObservaciones.value
  };

  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify({ datos: payload }),
      headers: { "Content-Type": "application/json" }
    });
    const result = await res.text();
    alert("✅ Datos guardados correctamente");
  } catch (err) {
    console.error("❌ Error al guardar:", err);
    alert("❌ Error al guardar datos");
  }
});

// 🔐 Autenticación Firebase
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.href = "login.html";
});

// 🚀 Inicialización
document.addEventListener("DOMContentLoaded", cargarNumerosDeNegocio);
