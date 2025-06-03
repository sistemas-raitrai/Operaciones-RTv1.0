// ✅ infoViajes.js: lógica de formulario Información del Viaje
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";

const auth = getAuth(app);

// ✅ Referencias a los elementos del DOM
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
const divHoteles = document.getElementById("seccionHoteles");
const inputObservaciones = document.getElementById("observaciones");

const sheetID = "124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI";
const sheetName = "LecturaBaseOperaciones";
const sheetURL = `https://opensheet.elk.sh/${sheetID}/${sheetName}`;

// ✅ Cargar datos iniciales desde la hoja
async function cargarNumerosDeNegocio() {
  try {
    const res = await fetch(sheetURL);
    const datos = await res.json();
    const usados = new Set();
    selectNegocio.innerHTML = "";
    selectDestino.innerHTML = "";

    datos.forEach(row => {
      const num = row.numeroNegocio;
      if (num && !usados.has(num)) {
        const opt = document.createElement("option");
        opt.value = num;
        opt.textContent = num;
        selectNegocio.appendChild(opt);
        usados.add(num);
      }
    });

    const destinosUnicos = [...new Set(datos.map(r => r.destino).filter(Boolean))];
    destinosUnicos.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      selectDestino.appendChild(opt);
    });

    // Verificar si viene con número desde registro.html
    const urlParams = new URLSearchParams(window.location.search);
    const numero = urlParams.get("numeroNegocio");
    if (numero) {
      selectNegocio.value = numero;
      cargarDatosExistentes(numero);
    }

    // También cargar al seleccionar manualmente
    selectNegocio.addEventListener("change", () => {
      cargarDatosExistentes(selectNegocio.value);
    });

  } catch (err) {
    console.error("❌ Error al cargar datos:", err);
  }
}

// ✅ Cargar info existente si la hay
async function cargarDatosExistentes(numeroNegocio) {
  try {
    const res = await fetch(`https://script.google.com/macros/s/YOUR_DEPLOYED_SCRIPT_ID/exec?numeroNegocio=${numeroNegocio}`);
    const json = await res.json();
    if (!json.existe) return;

    const fila = json.valores;
    inputFechaInicio.value = fila[16] || ""; // Q
    inputFechaFin.value = fila[17] || "";    // R
    inputAdultos.value = fila[18] || "";     // S
    inputEstudiantes.value = fila[19] || ""; // T
    selectTransporte.value = fila[20] || ""; // U
    selectCiudades.value = "";               // V (se manejará como string plano)
    inputObservaciones.value = fila[24] || ""; // Y

    // Si hay ciudades, seleccionarlas
    const ciudades = fila[21]?.split(",") || [];
    [...selectCiudades.options].forEach(option => {
      option.selected = ciudades.includes(option.value);
    });

    // Si hay tramos, parsearlos
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
    console.error("⚠️ Error cargando datos existentes:", err);
  }
}

// ✅ Mostrar u ocultar tramos según transporte
selectTransporte.addEventListener("change", () => {
  if (selectTransporte.value) {
    seccionTramos.style.display = "block";
  } else {
    seccionTramos.style.display = "none";
    divDetalleTramos.innerHTML = "";
  }
});

// ✅ Generar campos de tramos
function generarCamposTramos(cantidad) {
  divDetalleTramos.innerHTML = "";
  for (let i = 1; i <= cantidad; i++) {
    const div = document.createElement("div");
    div.innerHTML = `
      <h4>Tramo ${i}</h4>
      <label>Tipo:</label>
      <select name="tipoTramo${i}">
        <option value="terrestre">Terrestre</option>
        <option value="aereo">Aéreo</option>
      </select>
      <label>Compañía / Empresa:</label>
      <input name="empresa${i}" />
      <label>Conductor o N° de Vuelo:</label>
      <input name="info${i}" />
      <label>Fecha y Hora de Salida:</label>
      <input type="datetime-local" name="salida${i}" />
      <label>Terminal / Aeropuerto:</label>
      <input name="lugar${i}" />
      <hr />
    `;
    divDetalleTramos.appendChild(div);
  }
}

inputCantidadTramos.addEventListener("input", () => {
  const cantidad = parseInt(inputCantidadTramos.value);
  if (cantidad >= 1) generarCamposTramos(cantidad);
});

// ✅ Obtener tramos como array
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

// ✅ Obtener ciudades seleccionadas
function obtenerCiudades() {
  return [...selectCiudades.selectedOptions].map(opt => opt.value);
}

// ✅ Guardar datos
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
    hoteles: "", // Se puede completar en el futuro
    tramos: JSON.stringify(obtenerTramos()),
    observaciones: inputObservaciones.value
  };

  try {
    const res = await fetch("https://script.google.com/macros/s/YOUR_DEPLOYED_SCRIPT_ID/exec", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      alert("✅ Datos guardados correctamente");
    } else {
      alert("❌ Error al guardar: " + data.error);
    }
  } catch (err) {
    alert("❌ Error inesperado: " + err.message);
  }
});

// ✅ Verificar sesión activa
onAuthStateChanged(auth, (user) => {
  if (!user) window.location.href = "login.html";
});

// ✅ Al cargar
document.addEventListener("DOMContentLoaded", () => {
  cargarNumerosDeNegocio();
});
