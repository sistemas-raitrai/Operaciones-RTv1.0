// datosGrupos.js

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 1) IMPORTACIONES DE FIREBASE
// ──────────────────────────────────────────────────────────────────────────────
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db } from "./firebase-init.js";   // tu init exporta app, auth y db
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

const auth = getAuth(app);
let cargaInicialHecha = false;

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 2) CONFIGURACIÓN DE ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────
const sheetURL        = "https://script.google.com/macros/s/…/exec";  // Ventas
const guardarEndpoint = "https://operaciones-rtv10.vercel.app/api/guardar-sheet"; // Sheets POST
const operacionesURL  = "https://script.google.com/macros/s/…/exec";  // Historial/Operaciones

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 3) MAPEO DE CAMPOS SHEET → IDs EN HTML
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
// ✅ 4) DOMContentLoaded: inicializar datalists, Excel y listeners
// ──────────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Forzar mayúsculas en los inputs
  Object.values(campos).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", e => e.target.value = e.target.value.toUpperCase());
  });

  cargarNumeroNegocio();

  // Exportar Excel
  document.getElementById("btnExportarExcel")
    ?.addEventListener("click", descargarLecturaExcel);

  // Botones globales
  window.guardarDatos      = guardarDatos;
  window.guardarYContinuar = () => guardarDatos(false);

  // Al tipear N°Negocio, refresca tabla
  document.getElementById("numeroNegocio")
    .addEventListener("input", () =>
      cargarDesdeOperaciones(
        document.getElementById("numeroNegocio").value.trim()
      )
    );
});

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 5) cargarNumeroNegocio(): poblar datalists según año
// ──────────────────────────────────────────────────────────────────────────────
async function cargarNumeroNegocio() {
  try {
    const res   = await fetch(sheetURL);
    const datos = await res.json();

    const listaNumero = document.getElementById("negocioList");
    const listaNombre = document.getElementById("nombreList");
    const filtroAno   = document.getElementById("filtroAno");

    // 5.1) Rellenar selector de años
    const anosUnicos = [...new Set(datos.map(r => r.anoViaje))].filter(Boolean).sort();
    filtroAno.innerHTML =
      `<option value="">Todos</option>` +
      anosUnicos.map(a => `<option value="${a}">${a}</option>`).join("");
    filtroAno.value = new Date().getFullYear();

    // 5.2) Refrescar listas según año
    function actualizarListas() {
      const año = filtroAno.value;
      const filtrados = datos.filter(r => !año || r.anoViaje == año);

      listaNumero.innerHTML = filtrados
        .sort((a,b) => Number(a.numeroNegocio) - Number(b.numeroNegocio))
        .map(r => `<option value="${r.numeroNegocio}">`).join("");

      listaNombre.innerHTML = filtrados
        .sort((a,b) => (a.nombreGrupo||"").localeCompare(b.nombreGrupo||""))
        .map(r => `<option value="${r.nombreGrupo}">`).join("");
    }

    filtroAno.addEventListener("change", actualizarListas);
    actualizarListas();

  } catch (err) {
    console.error("❌ Error cargando datalists:", err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 6) guardarDatos(): Sheets → Firestore → refrescar tabla
// ──────────────────────────────────────────────────────────────────────────────
async function guardarDatos(continuar = true) {
  const datosForm = {};
  const cambios   = [];
  const usuario   = auth.currentUser?.email || "Desconocido";

  // 6.1) Leer inputs y detectar cambios
  Object.entries(campos).forEach(([campo,id]) => {
    const el = document.getElementById(id);
    const v = el?.value.trim() || "";
    datosForm[campo] = campo === "numeroNegocio" ? String(v) : v;
    const orig = el?.getAttribute("data-original") || "";
    if (v !== orig) cambios.push({ campo, anterior: orig, nuevo: v });
  });
  datosForm.modificadoPor = usuario;

  if (!datosForm.fechaCreacion) {
    datosForm.fechaCreacion = new Date().toLocaleString("es-CL", {
      timeZone:"America/Santiago",
      day:"2-digit", month:"2-digit", year:"numeric",
      hour:"2-digit", minute:"2-digit", second:"2-digit"
    }).replace(",", " /");
    datosForm.creadoPor = usuario;
  }

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
// ✅ 7) descargarLecturaExcel(): exportar LecturaBaseOperaciones como .xlsx
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
// ✅ 8) cargarDesdeOperaciones(): pinta la tabla de operaciones para un número
// ──────────────────────────────────────────────────────────────────────────────
async function cargarDesdeOperaciones(numeroNegocio) {
  const tbody = document.getElementById("tbodyTabla");
  tbody.innerHTML = "";

  if (!numeroNegocio) return;

  try {
    const resp = await fetch(`${operacionesURL}?numeroNegocio=${encodeURIComponent(numeroNegocio)}`);
    if (!resp.ok) throw new Error(`Fetch error ${resp.status}`);
    const { existe, valores: raw } = await resp.json();
    if (!existe || !raw.length) return appendEmptyRow(tbody);

    const filas = Array.isArray(raw[0]) ? raw : [raw];
    filas.forEach(f => {
      const tr = document.createElement("tr");
      f.forEach(c => {
        const td = document.createElement("td");
        td.textContent = c ?? "";
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
// ✅ 9) appendEmptyRow(): helper para mostrar fila vacía
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
