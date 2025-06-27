// ✅ 1) Importaciones y setup de Firebase
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);
let cargaInicialHecha = false;

// ✅ 2) URL del Apps Script que entrega los datos “ventas”
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";

// ✅ 3) Endpoint Vercel para guardar en BaseOperaciones
const saveEndpoint = "https://operaciones-rtv10.vercel.app/api/guardar-sheet";

// ✅ 4) URL del Apps Script doGet “Leer Operaciones”
const operacionesURL = "https://script.google.com/macros/s/AKfycbw8rnoex-TfYk-RbRp2Cec77UK2kxuSET3wuEFkk9bQlfGivZQir1ChLT7x-umXFdIM/exec";

// ✅ 5) Mapeo de campos sheet → IDs de inputs HTML
const campos = {
  numeroNegocio:      "numeroNegocio",
  nombreGrupo:        "nombreGrupo",
  cantidadgrupo:      "cantidadgrupo",
  colegio:            "colegio",
  curso:              "curso",
  anoViaje:           "anoViaje",
  destino:            "destino",
  programa:           "programa",
  hotel:              "hotel",
  asistenciaEnViajes: "asistenciaEnViajes",
  autorizacion:       "autorizacion",
  fechaDeViaje:       "fechaDeViaje",
  observaciones:      "observaciones",
  fechaCreacion:      "fechaCreacion",
  versionFicha:       "text1"
};

// ─────────── 6) Cargar y montar datalists de número y nombre ──────────────
async function cargarNumeroNegocio() {
  try {
    const res   = await fetch(sheetURL);
    const datos = await res.json();

    const listaNumero = document.getElementById("negocioList");
    const listaNombre = document.getElementById("nombreList");
    const inputNum    = document.getElementById("numeroNegocio");
    const inputNom    = document.getElementById("nombreGrupo");
    const filtroAno   = document.getElementById("filtroAno");

    // 6.1) Rellenar select de años
    const anos = [...new Set(datos.map(d => d.anoViaje))].filter(Boolean).sort();
    filtroAno.innerHTML = anos.map(a => `<option value="${a}">${a}</option>`).join("");
    filtroAno.value = new Date().getFullYear();

    // 6.2) Repoblar datalists según año
    function actualizarListas() {
      const año = filtroAno.value;
      const filtrados = datos.filter(d => d.anoViaje == año);
      listaNumero.innerHTML = filtrados
        .sort((a,b)=>Number(a.numeroNegocio)-Number(b.numeroNegocio))
        .map(d=>`<option value="${d.numeroNegocio}">`)
        .join("");
      listaNombre.innerHTML = filtrados
        .sort((a,b)=>(a.nombreGrupo||"").localeCompare(b.nombreGrupo||""))
        .map(d=>`<option value="${d.nombreGrupo}">`)
        .join("");
    }

    // 6.3) Poblar formulario al elegir opción
    function cargarDatosGrupo(valor) {
      const fila = datos.find(d =>
        String(d.numeroNegocio).trim() === valor.trim() ||
        String(d.nombreGrupo).trim() === valor.trim()
      );
      if (!fila) {
        console.warn("⚠️ Grupo no encontrado:", valor);
        Object.values(campos).forEach(id => document.getElementById(id).value = "");
        return;
      }

      // Rellenar inputs
      Object.entries(campos).forEach(([campo,id]) => {
        let val = fila[campo] || "";
        if (["autorizacion","fechaDeViaje","observaciones"].includes(campo)) {
          const tmp = document.createElement("div");
          tmp.innerHTML = val;
          val = tmp.textContent || "";
        }
        if (campo === "fechaCreacion" && val) {
          val = new Date(val).toLocaleString("es-CL", {
            timeZone: "America/Santiago",
            day: "2-digit", month: "2-digit", year: "numeric",
            hour: "2-digit", minute: "2-digit"
          });
        }
        const inp = document.getElementById(id);
        inp.value = val;
        inp.setAttribute("data-original", val);
      });

      // Refrescar tabla operaciones
      cargarDesdeOperaciones(fila.numeroNegocio);
    }

    // 6.4) Listeners
    inputNum.addEventListener("change", ()=>{ if(!cargaInicialHecha){ cargarDatosGrupo(inputNum.value); cargaInicialHecha=true; } });
    inputNom.addEventListener("change", ()=>{ if(!cargaInicialHecha){ cargarDatosGrupo(inputNom.value); cargaInicialHecha=true; } });
    filtroAno.addEventListener("change", actualizarListas);

    actualizarListas();
  } catch (e) {
    console.error("❌ Error al cargar sheetURL:", e);
  }
}

// ─────────── 7) Guardar datos en BaseOperaciones + historial ──────────────
async function guardarDatos(continuar = true) {
  const form = {}, cambios = [];
  Object.entries(campos).forEach(([campo,id])=>{
    const val = document.getElementById(id).value.trim();
    form[campo] = campo==="numeroNegocio" ? String(val) : val;
  });
  const user = auth.currentUser?.email || "Desconocido";
  form.modificadoPor = user;

  if (!form.fechaCreacion) {
    form.fechaCreacion = new Date().toLocaleString("es-CL",{
      timeZone:"America/Santiago",
      day:"2-digit",month:"2-digit",year:"numeric",
      hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false
    }).replace(",", " /");
    form.creadoPor = user;
  }

  Object.entries(campos).forEach(([campo,id]) => {
    const inp = document.getElementById(id);
    const nuevo = inp.value.trim();
    const orig  = inp.getAttribute("data-original")||"";
    if (nuevo!==orig) cambios.push({ campo, anterior: orig, nuevo });
  });

  try {
    console.time("⏱ Guardar Sheets");
    const res = await fetch(saveEndpoint, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ datos: form, historial: cambios })
    });
    console.timeEnd("⏱ Guardar Sheets");
    if (res.ok) {
      alert("✅ Datos guardados.");
      cargarDesdeOperaciones(form.numeroNegocio);
      if (!continuar) window.history.back();
    } else {
      alert("⚠️ Falló guardar.");
    }
  } catch (e) {
    console.error("❌ Error guardando:", e);
    alert("❌ No se pudo conectar.");
  }
}

// ─────────── 8) Descargar Excel de “LecturaBaseOperaciones” ───────────────
function descargarLecturaExcel() {
  const fileId = "124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI";
  const gid    = "1332196755";
  window.open(
    `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx&gid=${gid}`,
    "_blank"
  );
}

// ─────────── 9) Inicialización al cargar DOM ──────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  Object.values(campos).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", e => e.target.value = e.target.value.toUpperCase());
  });
  cargarNumeroNegocio();
  const btn = document.getElementById("btnExportarExcel");
  if (btn) btn.addEventListener("click", descargarLecturaExcel);
});

// ─────────── 10) Exponer globales para botones HTML ───────────────────────
window.guardarDatos          = guardarDatos;
window.guardarYContinuar     = () => guardarDatos(false);
window.descargarLecturaExcel = descargarLecturaExcel;

// ─────────── 11) Refrescar tabla “BaseOperaciones” según numeroNegocio ─────
async function cargarDesdeOperaciones(numeroNegocio) {
  if (!numeroNegocio) return;
  try {
    const resp = await fetch(`${operacionesURL}?numeroNegocio=${encodeURIComponent(numeroNegocio)}`);
    const { existe, valores } = await resp.json();
    const tbody = document.getElementById("tbodyTabla");
    tbody.innerHTML = "";

    if (existe) {
      // valores es un array con columnas en orden; lo pasamos a objeto
      const obj = Object.keys(campos).reduce((o, c, i) => {
        o[c] = valores[i] || "";
        return o;
      }, {});
      const tr = document.createElement("tr");
      Object.keys(campos).forEach(c => {
        const td = document.createElement("td");
        td.textContent = obj[c];
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    } else {
      // fila vacía
      const tr = document.createElement("tr");
      Object.keys(campos).forEach(()=> {
        const td = document.createElement("td");
        td.innerHTML = "&nbsp;";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  } catch (e) {
    console.error("❌ Error al consultar operaciones:", e);
  }
}
