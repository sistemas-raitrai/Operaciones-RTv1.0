// datosGrupos.js

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 1) IMPORTACIONES DE FIREBASE
// ──────────────────────────────────────────────────────────────────────────────
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db } from "./firebase-init.js";   // tu init exporta app, auth y db
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

const auth = getAuth(app);        // Autenticación
let cargaInicialHecha = false;    // Para evitar dobles triggers

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 2) CONFIGURACIÓN DE ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────
// Apps Script que devuelve las ventas (BaseOperaciones)
const sheetURL       = "https://script.google.com/macros/s/…/exec";
// API Vercel / Google Sheets para guardar cambios
const guardarEndpoint= "https://operaciones-rtv10.vercel.app/api/guardar-sheet";
// Apps Script que devuelve el historial de operaciones por númeroNegocio
const operacionesURL= "https://script.google.com/macros/s/…/exec";

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 3) MAPEO DE CAMPOS DEL SHEET → IDs EN EL HTML
// ──────────────────────────────────────────────────────────────────────────────
const campos = {
  numeroNegocio:     "numeroNegocio",
  nombreGrupo:       "nombreGrupo",
  cantidadgrupo:     "cantidadgrupo",
  colegio:           "colegio",
  curso:             "curso",
  anoViaje:          "anoViaje",
  destino:           "destino",
  programa:          "programa",
  hotel:             "hotel",
  asistenciaEnViajes:"asistenciaEnViajes",
  autorizacion:      "autorizacion",
  fechaDeViaje:      "fechaDeViaje",
  observaciones:     "observaciones",
  fechaCreacion:     "fechaCreacion",
  versionFicha:      "text1"
};

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 4) AL CARGAR EL DOM: inicializamos datalists, listeners y export Excel
// ──────────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // 4.1) Forzar mayúsculas en los inputs mapeados
  Object.values(campos).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", e => e.target.value = e.target.value.toUpperCase());
  });

  cargarNumeroNegocio();  // llena los datalists de N°Negocio y NombreGrupo

  // Exportar hoja como Excel
  const btnExportar = document.getElementById("btnExportarExcel");
  if (btnExportar) btnExportar.addEventListener("click", descargarLecturaExcel);

  // Exponer funciones globales para botones
  window.guardarDatos      = guardarDatos;
  window.guardarYContinuar = () => guardarDatos(false);

  // Al tipear N°Negocio, refresca la tabla de operaciones
  document.getElementById("numeroNegocio")
    .addEventListener("input", () => cargarDesdeOperaciones(
      document.getElementById("numeroNegocio").value.trim()
    ));
});

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 5) FUNCIONALIDAD: poblar datalists de número y nombre según año
// ──────────────────────────────────────────────────────────────────────────────
async function cargarNumeroNegocio() {
  try {
    const res   = await fetch(sheetURL);
    const datos = await res.json();

    const listaNumero = document.getElementById("negocioList");
    const listaNombre = document.getElementById("nombreList");
    const filtroAno   = document.getElementById("filtroAno");

    // 5.1) Rellenar selector de años únicos
    const anosUnicos = [...new Set(datos.map(r => r.anoViaje))].filter(Boolean).sort();
    filtroAno.innerHTML = `<option value="">Todos</option>` +
      anosUnicos.map(a => `<option value="${a}">${a}</option>`).join("");
    filtroAno.value = new Date().getFullYear();

    // 5.2) Función interna para refrescar listas según año
    function actualizarListas() {
      const año = filtroAno.value;
      const filtrados = datos.filter(r => !año || r.anoViaje == año);

      listaNumero.innerHTML = filtrados
        .sort((a,b) => a.numeroNegocio - b.numeroNegocio)
        .map(r => `<option value="${r.numeroNegocio}">`).join("");

      listaNombre.innerHTML = filtrados
        .sort((a,b) => (r => r.nombreGrupo)(a).localeCompare((r => r.nombreGrupo)(b)))
        .map(r => `<option value="${r.nombreGrupo}">`).join("");
    }

    // 5.3) Listeners de filtro y primera ejecución
    filtroAno.addEventListener("change", actualizarListas);
    actualizarListas();

  } catch (err) {
    console.error("❌ Error cargando datalists:", err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 6) GUARDAR: Sheets → Firestore (merge) → Refrescar tabla
// ──────────────────────────────────────────────────────────────────────────────
async function guardarDatos(continuar = true) {
  // 6.1) Construcción de datosForm y detección de cambios
  const datosForm = {};
  const cambios   = [];
  const usuario   = auth.currentUser?.email || "Desconocido";

  Object.entries(campos).forEach(([campo, id]) => {
    const v = document.getElementById(id)?.value.trim() || "";
    datosForm[campo] = campo === "numeroNegocio" ? String(v) : v;
  });
  datosForm.modificadoPor = usuario;
  if (!datosForm.fechaCreacion) {
    datosForm.fechaCreacion = new Date().toLocaleString("es-CL", {
      timeZone:"America/Santiago", day:"2-digit", month:"2-digit", year:"numeric",
      hour:"2-digit", minute:"2-digit", second:"2-digit"
    }).replace(",", " /");
    datosForm.creadoPor = usuario;
  }

  // (Opcional) detectar historial:
  Object.entries(campos).forEach(([campo,id]) => {
    const inp = document.getElementById(id);
    const orig = inp?.getAttribute("data-original") || "";
    if (inp.value.trim() !== orig) {
      cambios.push({ campo, anterior: orig, nuevo: inp.value.trim() });
    }
  });

  try {
    // —— 6.2) Guardar en Google Sheets ——
    console.time("⏱ Guardar Google Sheets");
    const res = await fetch(guardarEndpoint, {
      method:  "POST",
      headers: {"Content-Type":"application/json"},
      body:    JSON.stringify({ datos: datosForm, historial: cambios })
    });
    console.timeEnd("⏱ Guardar Google Sheets");
    if (!res.ok) throw new Error(`Sheets respondió ${res.status}`);

    // —— 6.3) Guardar espejo en Firestore ——
    await setDoc(
      doc(db, "grupos", String(datosForm.numeroNegocio)),
      datosForm,
      { merge: true }
    );
    console.log(`✅ Grupo ${datosForm.numeroNegocio} sincronizado a Firestore`);

    alert("✅ Datos guardados en Sheets y Firestore.");
    cargarDesdeOperaciones(datosForm.numeroNegocio);
    if (!continuar) window.history.back();

  } catch (err) {
    console.error("❌ Error guardando:", err);
    alert("❌ No se pudo guardar.");
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 7) DESCARGAR LA LECTURA COMO EXCEL
// ──────────────────────────────────────────────────────────────────────────────
function descargarLecturaExcel() {
  const fileId = "124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI";
  const gid    = "1332196755";
  window.open(
    `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx&gid=${gid}`,
    "_blank"
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 8) CARGAR Y PINTAR TABLA DE OPERACIONES POR N°Negocio
// ──────────────────────────────────────────────────────────────────────────────
async function cargarDesdeOperaciones(numeroNegocio) {
  const tbody = document.getElementById("tbodyTabla");
  tbody.innerHTML = "";               // limpiar

  if (!numeroNegocio) return;

  try {
    const resp = await fetch(`${operacionesURL}?numeroNegocio=${encodeURIComponent(numeroNegocio)}`);
    if (!resp.ok) throw new Error(`Fetch error ${resp.status}`);
    const { existe, valores: raw } = await resp.json();

    if (!existe || !raw.length) {
      return appendEmptyRow(tbody);
    }

    // si viene un solo array plano, envolvemos en [ [... ] ]
    const valores = Array.isArray(raw[0]) ? raw : [raw];

    valores.forEach(filaArray => {
      const tr = document.createElement("tr");
      filaArray.forEach(celda => {
        const td = document.createElement("td");
        td.textContent = celda ?? "";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

  } catch (err) {
    console.error("❌ Error al consultar Operaciones:", err);
    appendEmptyRow(tbody);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 9) FILA VACÍA (helper)
// ──────────────────────────────────────────────────────────────────────────────
function appendEmptyRow(tbody) {
  const cols = document.querySelectorAll("#tablaRegistros thead th").length;
  const tr   = document.createElement("tr");
  for (let i = 0; i < cols; i++) {
    const td = document.createElement("td");
    td.innerHTML = "&nbsp;";
    tr.appendChild(td);
  }
  tbody.appendChild(tr);
}
