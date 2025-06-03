// ✅ infoViajes.js: lógica de formulario Información del Viaje
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";

const auth = getAuth(app);

// ✅ IDs de elementos del formulario
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

// ✅ Cargar número de negocio y destinos existentes desde Google Sheet
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

    // cargar destinos si existen
    const destinosUnicos = [...new Set(datos.map(r => r.destino).filter(Boolean))];
    destinosUnicos.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      selectDestino.appendChild(opt);
    });

    // Ver si viene con número desde registro.html
    const urlParams = new URLSearchParams(window.location.search);
    const numero = urlParams.get("numeroNegocio");
    if (numero) {
      selectNegocio.value = numero;
    }
  } catch (err) {
    console.error("❌ Error al cargar datos:", err);
  }
}

// 🚦 Mostrar sección de tramos si corresponde
selectTransporte.addEventListener("change", () => {
  if (selectTransporte.value) {
    seccionTramos.style.display = "block";
  } else {
    seccionTramos.style.display = "none";
    divDetalleTramos.innerHTML = "";
  }
});

// 🧱 Generar tramos según cantidad
inputCantidadTramos.addEventListener("input", () => {
  divDetalleTramos.innerHTML = "";
  const cantidad = parseInt(inputCantidadTramos.value);
  if (!cantidad || cantidad < 1) return;

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
});

// ✅ Guardar datos en servidor (se implementará después)
document.getElementById("formInfoViaje").addEventListener("submit", async (e) => {
  e.preventDefault();
  alert("Función de guardado pendiente de integrar con backend (columna Q en adelante).");
});

// ✅ Autenticación
onAuthStateChanged(auth, (user) => {
  if (!user) return (window.location.href = "login.html");
});

// ✅ Ejecutar al cargar
document.addEventListener("DOMContentLoaded", () => {
  cargarNumerosDeNegocio();
});
