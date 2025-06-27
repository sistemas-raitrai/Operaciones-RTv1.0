// ✅ Importaciones modernas para Firebase
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);
let cargaInicialHecha = false;

// ✅ URL del script de Google Apps Script que entrega los datos desde la base de ventas
const sheetURL = 'https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec';

// ✅ Mapeo entre campos del Google Sheet y los IDs de los inputs del HTML
const campos = {
  numeroNegocio: 'numeroNegocio',
  nombreGrupo: 'nombreGrupo',
  cantidadgrupo: 'cantidadgrupo',
  colegio: 'colegio',
  curso: 'curso',
  anoViaje: 'anoViaje',
  destino: 'destino',
  programa: 'programa',
  hotel: 'hotel',
  asistenciaEnViajes: 'asistenciaEnViajes',
  autorizacion: 'autorizacion',
  fechaDeViaje: 'fechaDeViaje',
  observaciones: 'observaciones',
  fechaCreacion: 'fechaCreacion',
  versionFicha: 'text1'
};

// ─── 1) Carga y monta los datalists de número y nombre ───────────────────────
async function cargarNumeroNegocio() {
  try {
    const res = await fetch(sheetURL);
    const datos = await res.json();
    const listaNumero  = document.getElementById("negocioList");
    const listaNombre  = document.getElementById("nombreList");
    const inputNumero  = document.getElementById("numeroNegocio");
    const inputNombre  = document.getElementById("nombreGrupo");
    const filtroAno    = document.getElementById("filtroAno");

    // 🔄 Obtener años únicos para el filtro
    const anosUnicos = [...new Set(datos.map(f => f.anoViaje))].filter(Boolean).sort();
    filtroAno.innerHTML = '';
    anosUnicos.forEach(a => {
      const opt = document.createElement("option");
      opt.value = opt.textContent = a;
      filtroAno.appendChild(opt);
    });

    // ✅ Seleccionar año actual
    filtroAno.value = new Date().getFullYear();

    // 🔁 Actualizar ambos datalists según año seleccionado
    function actualizarListas() {
      const anoSel = filtroAno.value;
      listaNumero.innerHTML = listaNombre.innerHTML = '';
      const datosFil = datos.filter(f => f.anoViaje == anoSel);

      // → datalist númeroNegocio
      datosFil
        .sort((a,b) => Number(a.numeroNegocio)-Number(b.numeroNegocio))
        .forEach(f => {
          if (f.numeroNegocio) {
            const o = document.createElement("option");
            o.value = f.numeroNegocio;
            listaNumero.appendChild(o);
          }
        });

      // → datalist nombreGrupo
      datosFil
        .sort((a,b) => (a.nombreGrupo||'').localeCompare(b.nombreGrupo||''))
        .forEach(f => {
          if (f.nombreGrupo) {
            const o = document.createElement("option");
            o.value = f.nombreGrupo;
            listaNombre.appendChild(o);
          }
        });
    }

    // ─── 2) Al elegir un número o nombre, poblar el formulario ────────────────
    function cargarDatosGrupo(valor) {
      const fila = datos.find(r =>
        String(r.numeroNegocio).trim() === String(valor).trim() ||
        String(r.nombreGrupo).trim()    === String(valor).trim()
      );
      if (!fila) {
        console.warn("⚠️ Grupo no hallado:", valor);
        // Limpiar campos
        Object.values(campos).forEach(id => document.getElementById(id).value = '');
        return;
      }

      // 2.1) Rellenar cada input con su valor
      Object.entries(campos).forEach(([campo, id]) => {
        const input = document.getElementById(id);
        let val = fila[campo] ?? '';
        // Quitar HTML si lo hay
        if (["autorizacion","fechaDeViaje","observaciones"].includes(campo)) {
          const tmp = document.createElement("div");
          tmp.innerHTML = val;
          val = tmp.textContent;
        }
        // Formatear fechaCreacion
        if (campo==="fechaCreacion" && val) {
          val = new Date(val).toLocaleString('es-CL', {
            timeZone:'America/Santiago',
            day:'2-digit',month:'2-digit',year:'numeric',
            hour:'2-digit',minute:'2-digit'
          });
        }
        input.value = String(val);
        input.setAttribute("data-original", input.value);
      });

      // 2.2) Y refrescar la tabla final con operaciones
      cargarDesdeOperaciones(fila.numeroNegocio);
    }

    // ─── 3) Listeners en los inputs de número y nombre ─────────────────────────
    inputNumero.addEventListener("change", () => {
      if (!cargaInicialHecha) {
        cargarDatosGrupo(inputNumero.value);
        cargaInicialHecha = true;
      }
    });
    inputNombre.addEventListener("change", () => {
      if (!cargaInicialHecha) {
        cargarDatosGrupo(inputNombre.value);
        cargaInicialHecha = true;
      }
    });
    filtroAno.addEventListener("change", actualizarListas);

    actualizarListas();  // Carga inicial
  } catch (err) {
    console.error("❌ Error al cargar sheetURL:", err);
  }
}

// ─── 4) Guardar datos en BaseOperaciones y actualizar historial ─────────────
async function guardarDatos(continuar = true) {
  const datosForm = {}, cambios = [];
  Object.entries(campos).forEach(([campo,id]) => {
    const input = document.getElementById(id);
    datosForm[campo] = campo==="numeroNegocio"
      ? String(input.value).trim()
      : input.value.trim();
  });
  const usuario = auth.currentUser?.email || "Desconocido";
  datosForm.modificadoPor = usuario;

  // Fecha de creación si no existe
  if (!datosForm.fechaCreacion) {
    const ahora = new Date().toLocaleString("es-CL", {
      timeZone:"America/Santiago", day:"2-digit",month:"2-digit",year:"numeric",
      hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false
    }).replace(",", " /");
    datosForm.fechaCreacion = ahora;
    datosForm.creadoPor    = usuario;
  }

  // Detectar cambios
  Object.entries(campos).forEach(([campo,id]) => {
    const input = document.getElementById(id);
    const nuevo = input.value.trim();
    const anterior = input.getAttribute("data-original")||"";
    if (nuevo !== anterior) {
      cambios.push({campo,anterior,nuevo});
    }
  });

  const payload = { datos: datosForm, historial: cambios };
  const endpoint = "https://operaciones-rtv10.vercel.app/api/guardar-sheet";

  try {
    console.time("⏱ Guardar Sheets");
    const res = await fetch(endpoint, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    console.timeEnd("⏱ Guardar Sheets");
    if (res.ok) {
      alert("✅ Datos guardados.");
      cargarDesdeOperaciones(datosForm.numeroNegocio);
      if (!continuar) window.history.back();
    } else {
      alert("⚠️ Falló guardar en Sheets.");
    }
  } catch(err) {
    console.error("❌ Error guardando:", err);
    alert("❌ No se pudo conectar.");
  }
}

// ─── 5) Descarga Excel de LecturaBaseOperaciones ─────────────────────────────
function descargarLecturaExcel() {
  const fileId = "124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI";
  const gid    = "1332196755";
  window.open(https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx&gid=${gid}, "_blank");
}

// ─── 6) Al cargar el DOM: activar mayúsculas, listeners principales ─────────
document.addEventListener("DOMContentLoaded", () => {
  // Forzar mayúsculas
  Object.values(campos).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", e => e.target.value = e.target.value.toUpperCase());
  });

  // Iniciar carga de ventas
  cargarNumeroNegocio();

  // Botón Excel
  const btn = document.getElementById("btnExportarExcel");
  if (btn) btn.addEventListener("click", descargarLecturaExcel);
});

// Asociar globales para botones HTML
window.guardarDatos         = guardarDatos;
window.guardarYContinuar    = () => { guardarDatos(false); };
window.descargarLecturaExcel = descargarLecturaExcel;

// ─── 7) Función única para refrescar la tabla final (BaseOperaciones) ────────
async function cargarDesdeOperaciones(numeroNegocio) {
  if (!numeroNegocio) return;
  try {
    const url = "https://script.google.com/macros/s/AKfycbzr12TXE8-lFd.../exec";
    const resp = await fetch(url);
    const { datos } = await resp.json();
    const tbody = document.getElementById("tbodyTabla");
    tbody.innerHTML = "";

    // Filtrar filas que coinciden exactamente
    const filas = datos.filter(r => String(r.numeroNegocio).trim() === String(numeroNegocio).trim());
    if (filas.length) {
      filas.forEach(r => {
        const tr = document.createElement("tr");
        Object.keys(campos).forEach(c => {
          const td = document.createElement("td");
          td.textContent = r[c] || "";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    } else {
      // Si no hay, crear fila vacía
      const tr = document.createElement("tr");
      for (let i=0; i<14; i++){
        const td = document.createElement("td");
        td.innerHTML = "&nbsp;";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  } catch(err) {
    console.error("❌ Error al consultar operaciones:", err);
  }
}
