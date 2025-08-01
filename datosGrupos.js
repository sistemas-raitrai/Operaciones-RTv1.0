// datosGrupos.js

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 1) IMPORTACIONES DE FIREBASE
// ──────────────────────────────────────────────────────────────────────────────
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app, db } from "./firebase-init.js";   // tu init exporta app y db
import {
  doc, setDoc,
  collection, addDoc,
  query, where, orderBy, getDocs
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";
import { doc as docRef, getDoc } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

const auth = getAuth(app);
let cargaInicialHecha = false;

// ──────────────────────────────────────────────────────────────────────────────
// ✅ 2) CONFIGURACIÓN DE ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────

const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";
const guardarEndpoint = "https://operaciones-rtv10.vercel.app/api/guardar-sheet";
const operacionesURL  = "https://script.google.com/macros/s/AKfycbzr12TXE8-lFd86P1yK_yRSVyyFFSuUnAHY_jOefJHYQZCQ5yuQGQsoBP2OWh699K22/exec";  // Historial/Operaciones

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
async function cargarNumeroNegocio() {
  try {
    const res   = await fetch(sheetURL);
    const datos = await res.json();

    const listaNumero = document.getElementById("negocioList");
    const listaNombre = document.getElementById("nombreList");
    const filtroAno   = document.getElementById("filtroAno");
    const inputNumero = document.getElementById("numeroNegocio");
    const inputNombre = document.getElementById("nombreGrupo");

    // 5.1) Rellenar años
    const anosUnicos = [...new Set(datos.map(r => r.anoViaje))].filter(Boolean).sort();
    filtroAno.innerHTML = `<option value="">Todos</option>` +
      anosUnicos.map(a => `<option value="${a}">${a}</option>`).join("");
    filtroAno.value = new Date().getFullYear();

    // 5.2) Refrescar datalists según año
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

    // 5.3) Rellenar formulario al elegir un ítem del datalist
    function cargarDatosGrupo(valor) {
      const fila = datos.find(r =>
        String(r.numeroNegocio).trim() === valor.trim() ||
        String(r.nombreGrupo).trim()    === valor.trim()
      );
      if (!fila) {
        // limpio todo y pinto sólo tabla
        Object.values(campos).forEach(id => {
          const inp = document.getElementById(id);
          if (inp) inp.value = "";
        });
        cargarDesdeOperaciones(valor);
        return;
      }
      // relleno cada campo
      Object.entries(campos).forEach(([campo,id]) => {
        const inp = document.getElementById(id);
        if (!inp) return;
        let val = fila[campo] ?? "";
        if (["autorizacion","fechaDeViaje","observaciones"].includes(campo)) {
          const tmp = document.createElement("div");
          tmp.innerHTML = val;
          val = tmp.textContent || "";
        }
        if (campo === "fechaCreacion" && val) {
          val = new Date(val).toLocaleString("es-CL", {
            timeZone:"America/Santiago",
            day:"2-digit", month:"2-digit", year:"numeric",
            hour:"2-digit", minute:"2-digit"
          });
        }
        inp.value = val;
        inp.setAttribute("data-original", val);
      });
      // por último refresco la tabla histórica:
      cargarDesdeOperaciones(fila.numeroNegocio);
    }

    // 5.4) Listeners en el datalist (change, no input)
    inputNumero.addEventListener("change", () => cargarDatosGrupo(inputNumero.value));
    inputNombre.addEventListener("change", () => cargarDatosGrupo(inputNombre.value));

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
  Object.entries(campos).forEach(([campo, id]) => {
    const el = document.getElementById(id);
    const v  = el?.value.trim() || "";
    datosForm[campo] = campo === "numeroNegocio" ? String(v) : v;
    const orig = el?.getAttribute("data-original") || "";
    if (v !== orig) cambios.push({ campo, anterior: orig, nuevo: v });
  });
  datosForm.modificadoPor = usuario;

  // Si no hay fechaCreacion, la generamos
  if (!datosForm.fechaCreacion) {
    datosForm.fechaCreacion = new Date().toLocaleString("es-CL", {
      timeZone: "America/Santiago",
      day:      "2-digit",
      month:    "2-digit",
      year:     "numeric",
      hour:     "2-digit",
      minute:   "2-digit",
      second:   "2-digit"
    }).replace(",", " /");
    datosForm.creadoPor = usuario;
  }

  try {
    // —— 6.2) Guardar en Google Sheets ——
    console.time("⏱ Guardar Google Sheets");
    const res = await fetch(guardarEndpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
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

    // —— 6.4) Guardar cada cambio en la colección "historial" ——
    const histCol = collection(db, "historial");
    const ts      = new Date();
    await Promise.all(cambios.map(change =>
      addDoc(histCol, {
        numeroNegocio: datosForm.numeroNegocio,
        nombreGrupo:   datosForm.nombreGrupo,
        anoViaje:      datosForm.anoViaje,
        campo:         change.campo,
        anterior:      change.anterior,
        nuevo:         change.nuevo,
        modificadoPor: datosForm.modificadoPor,
        timestamp:     ts
      })
    ));
    console.log(`✅ ${cambios.length} cambios guardados en historial`);

    alert("✅ Datos guardados en Sheets, Firestore e historial.");
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
    // 1️⃣ Referencia al documento
    const docSnap = await getDoc(docRef(db, "grupos", String(numeroNegocio)));

    if (!docSnap.exists()) {
      // Si no existe aún, dejamos una fila vacía
      return appendEmptyRow(tbody);
    }

    // 2️⃣ Obtenemos los datos
    const data = docSnap.data();

    // 3️⃣ Creamos una fila con TODOS los campos del 'grupo'
    const tr = document.createElement("tr");

    // Suponiendo que tu <thead> tiene exactamente estos <th> en este orden:
    // numeroNegocio, nombreGrupo, cantidadgrupo, colegio, curso,
    // anoViaje, destino, programa, hotel, asistenciaEnViajes,
    // autorizacion, fechaDeViaje, observaciones, versionFicha, creadoPor, fechaCreacion
    // Si añades nuevos campos en Firestore, simplemente agrégalos aquí.
    [
      data.numeroNegocio,
      data.nombreGrupo,
      data.cantidadgrupo,
      data.colegio,
      data.curso,
      data.anoViaje,
      data.destino,
      data.programa,
      data.hotel,
      data.asistenciaEnViajes,
      data.autorizacion,
      data.fechaDeViaje,
      data.observaciones,
      data.versionFicha,
      data.creadoPor,
      data.fechaCreacion
    ].forEach(valor => {
      const td = document.createElement("td");
      td.textContent = valor ?? "";
      tr.appendChild(td);
    });

    tbody.appendChild(tr);

  } catch (err) {
    console.error("❌ Error al cargar grupo desde Firestore:", err);
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
