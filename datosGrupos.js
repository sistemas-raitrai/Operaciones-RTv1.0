// ✅ 1) Importaciones modernas para Firebase
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);
let cargaInicialHecha = false;

// ✅ 2) URL del Apps Script que entrega los datos “ventas”
const sheetURL = "https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec";

// ✅ 3) Endpoint Vercel para guardar en BaseOperaciones
const guardarEndpoint = "https://operaciones-rtv10.vercel.app/api/guardar-sheet";

// 4) URL del Apps Script doGet “Leer Operaciones” (la que ya está implementada en GAS)
const operacionesURL = "https://script.google.com/macros/s/AKfycbzr12TXE8-lFd86P1yK_yRSVyyFFSuUnAHY_jOefJHYQZCQ5yuQGQsoBP2OWh699K22/exec";

// ✅ 5) Mapeo de campos del sheet a los IDs de los inputs en el HTML
const campos = {
  numeroNegocio:    "numeroNegocio",
  nombreGrupo:      "nombreGrupo",
  cantidadgrupo:    "cantidadgrupo",
  colegio:          "colegio",
  curso:            "curso",
  anoViaje:         "anoViaje",
  destino:          "destino",
  programa:         "programa",
  hotel:            "hotel",
  asistenciaEnViajes:"asistenciaEnViajes",
  autorizacion:     "autorizacion",
  fechaDeViaje:     "fechaDeViaje",
  observaciones:    "observaciones",
  fechaCreacion:    "fechaCreacion",
  versionFicha:     "text1"
};

// ─────────── 6) Cuando el DOM esté listo, inicia todo ─────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Forzar mayúsculas en todos los campos
  Object.values(campos).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", e => e.target.value = e.target.value.toUpperCase());
  });

  // Carga inicial de datalists y listeners
  cargarNumeroNegocio();

  // Botón Exportar Excel
  const btnExportar = document.getElementById("btnExportarExcel");
  if (btnExportar) btnExportar.addEventListener("click", descargarLecturaExcel);

  // Exponer globals para tus botones HTML
  window.guardarDatos = guardarDatos;
  window.guardarYContinuar = () => guardarDatos(false);
  window.descargarLecturaExcel = descargarLecturaExcel;

  // ————————— Listener para actualizar la tabla al tipear N°Negocio —————————
  const inputNegocio = document.getElementById("numeroNegocio");
  inputNegocio.addEventListener("input", () => {
    console.log("Listener inputNegocio:", inputNegocio.value);
    cargarDesdeOperaciones(inputNegocio.value.trim());
  });

});

// ─────────── 7) Carga y monta los datalists de número y nombre ───────────
async function cargarNumeroNegocio() {
  try {
    const res   = await fetch(sheetURL);
    const datos = await res.json();

    const listaNumero = document.getElementById("negocioList");
    const listaNombre = document.getElementById("nombreList");
    const inputNumero = document.getElementById("numeroNegocio");
    const inputNombre = document.getElementById("nombreGrupo");
    const filtroAno   = document.getElementById("filtroAno");

    if (!listaNumero || !listaNombre || !inputNumero || !inputNombre || !filtroAno) {
      console.error("Faltan elementos de datalist en el DOM");
      return;
    }

    // 7.1) Población inicial del filtro de año
    const anosUnicos = [...new Set(datos.map(r => r.anoViaje))].filter(Boolean).sort();
    filtroAno.innerHTML = anosUnicos.map(a => `<option value="${a}">${a}</option>`).join("");
    filtroAno.value = new Date().getFullYear();

    // 7.2) Función que repuebla los datalists según año
    function actualizarListas() {
      const año = filtroAno.value;
      const filtrados = datos.filter(r => r.anoViaje == año);

      listaNumero.innerHTML = filtrados
        .sort((a,b) => Number(a.numeroNegocio) - Number(b.numeroNegocio))
        .map(r => `<option value="${r.numeroNegocio}">`)
        .join("");

      listaNombre.innerHTML = filtrados
        .sort((a,b) => (a.nombreGrupo||"").localeCompare(b.nombreGrupo||""))
        .map(r => `<option value="${r.nombreGrupo}">`)
        .join("");
    }

    // 7.3) Al seleccionar un número o nombre, carga el formulario (y siempre refresca operaciones)
    function cargarDatosGrupo(valor) {
      // 7.3.1) Buscamos en la “base de ventas” si existe ese valor (nº de negocio o nombre)
      const fila = datos.find(r =>
        String(r.numeroNegocio).trim() === valor.trim() ||
        String(r.nombreGrupo).trim()    === valor.trim()
      );
    
      if (!fila) {
        console.warn("⚠️ Grupo no encontrado en Ventas:", valor);
    
        // 7.3.2) Limpiamos todos los inputs del formulario
        Object.values(campos).forEach(id => {
          const inp = document.getElementById(id);
          if (inp) inp.value = "";
        });
    
        // 7.3.3) Aunque no exista en Ventas, seguimos cargando la tabla de Operaciones
        //    para mostrar datos históricos de ese número de negocio
        cargarDesdeOperaciones(valor);
        return;
      }
    
      // 7.3.4) Si sí existe en Ventas, rellenamos cada input con sus datos
      Object.entries(campos).forEach(([campo, id]) => {
        const inp = document.getElementById(id);
        if (!inp) return;
        let val = fila[campo] ?? "";
    
        // — Si el campo trae HTML, extraemos solo texto
        if (["autorizacion","fechaDeViaje","observaciones"].includes(campo)) {
          const tmp = document.createElement("div");
          tmp.innerHTML = val;
          val = tmp.textContent || "";
        }
    
        // — Formateamos la fecha de creación a locale 'es-CL'
        if (campo === "fechaCreacion" && val) {
          val = new Date(val).toLocaleString("es-CL", {
            timeZone: "America/Santiago",
            day: "2-digit", month: "2-digit", year: "numeric",
            hour: "2-digit", minute: "2-digit"
          });
        }
    
        inp.value = val;
        inp.setAttribute("data-original", val);
      });
    
      // 7.3.5) Finalmente: refrescamos la tabla de Operaciones para ese número
      cargarDesdeOperaciones(fila.numeroNegocio);
    }


    // 7.4) Listeners en inputs y filtro
    filtroAno.addEventListener("change", actualizarListas);
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

    // Primera ejecución
    actualizarListas();

  } catch (err) {
    console.error("❌ Error al cargar sheetURL:", err);
  }
}

// ─────────── 8) Guardar datos en BaseOperaciones y registrar historial ─────
async function guardarDatos(continuar = true) {
  const datosForm = {};
  const cambios    = [];
  const usuario    = auth.currentUser?.email || "Desconocido";

  // Lee todos los inputs
  Object.entries(campos).forEach(([campo,id]) => {
    const inp = document.getElementById(id);
    if (!inp) return;
    const v = inp.value.trim();
    datosForm[campo] = campo === "numeroNegocio" ? String(v) : v;
  });
  datosForm.modificadoPor = usuario;

  // Si no tiene fechaCreacion, la genera ahora
  if (!datosForm.fechaCreacion) {
    datosForm.fechaCreacion = new Date().toLocaleString("es-CL", {
      timeZone: "America/Santiago",
      day:"2-digit", month:"2-digit", year:"numeric",
      hour:"2-digit", minute:"2-digit", second:"2-digit"
    }).replace(",", " /");
    datosForm.creadoPor = usuario;
  }

  // Detecta cambios entre data-original y valor actual
  Object.entries(campos).forEach(([campo,id]) => {
    const inp = document.getElementById(id);
    if (!inp) return;
    const nuevo    = inp.value.trim();
    const original = inp.getAttribute("data-original") || "";
    if (nuevo !== original) cambios.push({ campo, anterior: original, nuevo });
  });

  try {
    console.time("⏱ Guardar Google Sheets");
    const res = await fetch(guardarEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datos: datosForm, historial: cambios })
    });
    console.timeEnd("⏱ Guardar Google Sheets");

    if (res.ok) {
      alert("✅ Datos guardados.");
      cargarDesdeOperaciones(datosForm.numeroNegocio);
      if (!continuar) window.history.back();
    } else {
      alert("⚠️ No se pudo guardar.");
    }
  } catch (err) {
    console.error("❌ Error guardando:", err);
    alert("❌ No se pudo conectar.");
  }
}

// ─────────── 9) Descargar Excel de “LecturaBaseOperaciones” ───────────────
function descargarLecturaExcel() {
  const fileId = "124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI";
  const gid    = "1332196755";
  window.open(
    `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx&gid=${gid}`,
    "_blank"
  );
}

/**
 * 10) Refrescar tabla “BaseOperaciones” según numeroNegocio.
 *    Ahora filtrando con includes() para incluir todos los grupos que
 *    contengan el texto ingresado, y refrescando en cada cambio input.
 */
async function cargarDesdeOperaciones(busqueda) {
  console.log("→ cargarDesdeOperaciones llamado con:", busqueda);
  if (!busqueda) {
    document.getElementById("tbodyTabla").innerHTML = "";
    return;
  }

  try {
    const url = `${operacionesURL}?numeroNegocio=${encodeURIComponent(busqueda)}`;
    console.log("  fetch a:", url);
    const resp = await fetch(url);
    console.log("  status fetch:", resp.status);
    if (!resp.ok) throw new Error(`Fetch falló con status ${resp.status}`);

    const { existe, valores } = await resp.json();
    console.log("  respuesta JSON:", { existe, valores });
    console.table(valores);

    const tbody = document.getElementById("tbodyTabla");
    tbody.innerHTML = "";

    if (existe && Array.isArray(valores)) {
      // ─── PINTAR TODAS LAS FILAS ───────────────────────
      valores.forEach(row => {
        const tr = document.createElement("tr");
        row.forEach(celda => {
          const td = document.createElement("td");
          td.textContent = celda ?? "";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      // ──────────────────────────────────────────────────

      // Si luego quieres aplicar de nuevo el filtro por 'busqueda', vuelve a:
      // valores.filter(row => String(row[0]).trim().includes(busqueda))
      // y mapea ese array en lugar de 'valores.forEach' directamente.

      // (Opción de fila vacía si no hay datos)
      if (!tbody.children.length) {
        const tr = document.createElement("tr");
        const cols = valores[0]?.length || 14;
        for (let i = 0; i < cols; i++) {
          const td = document.createElement("td");
          td.innerHTML = "&nbsp;";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }

    } else {
      // si existe===false, mostrar fila vacía
      const tr = document.createElement("tr");
      for (let i = 0; i < 14; i++) {
        const td = document.createElement("td");
        td.innerHTML = "&nbsp;";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

  } catch (e) {
    console.error("❌ Error al consultar Operaciones:", e);
  }
}


