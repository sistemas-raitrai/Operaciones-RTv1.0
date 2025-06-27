// ✅ Importaciones modernas para Firebase
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);
let cargaInicialHecha = false;

// ✅ URL del script de Google Apps Script que entrega los datos desde la base de ventas
const sheetURL = 'https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec';

// ✅ Relación entre campos del Google Sheet y los inputs del HTML
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

// ✅ Cargar datos desde Google Sheet y preparar la búsqueda
async function cargarNumeroNegocio() {
  try {
    const res = await fetch(sheetURL);
    const datos = await res.json();
    const listaNumero = document.getElementById("negocioList");
    const listaNombre = document.getElementById("nombreList");
    const inputNumero = document.getElementById("numeroNegocio");
    const inputNombre = document.getElementById("nombreGrupo");
    const filtroAno = document.getElementById("filtroAno");

    // 🔄 Obtener años únicos desde los datos para el filtro
    const anosUnicos = [...new Set(datos.map(f => f.anoViaje))].filter(Boolean).sort();
    filtroAno.innerHTML = '';
    anosUnicos.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a;
      opt.textContent = a;
      filtroAno.appendChild(opt);
    });

    // ✅ Seleccionar año actual por defecto
    const anioActual = new Date().getFullYear();
    filtroAno.value = anioActual;

    // ✅ Función para actualizar ambos datalists según filtro de año
    function actualizarListas() {
      const anoSeleccionado = filtroAno.value;
      listaNumero.innerHTML = '';
      listaNombre.innerHTML = '';
    
      const datosFiltrados = datos.filter(f => f.anoViaje == anoSeleccionado);
    
      // 🔢 Ordenar número de negocio (menor a mayor)
      const ordenadosPorNumero = [...datosFiltrados].sort((a, b) =>
        Number(a.numeroNegocio) - Number(b.numeroNegocio)
      );
    
      ordenadosPorNumero.forEach(fila => {
        if (fila.numeroNegocio) {
          const opt = document.createElement("option");
          opt.value = fila.numeroNegocio;
          listaNumero.appendChild(opt);
        }
      });
    
      // 🔠 Ordenar nombre de grupo (A a Z)
      const ordenadosPorNombre = [...datosFiltrados].sort((a, b) =>
        a.nombreGrupo?.localeCompare(b.nombreGrupo || '')
      );
    
      ordenadosPorNombre.forEach(fila => {
        if (fila.nombreGrupo) {
          const opt2 = document.createElement("option");
          opt2.value = fila.nombreGrupo;
          listaNombre.appendChild(opt2);
        }
      });
    }
    // ✅ Buscar y cargar datos al seleccionar nombre o número
    function cargarDatosGrupo(valor) {
      const fila = datos.find(r =>
        String(r.numeroNegocio).trim() === String(valor).trim() ||
        String(r.nombreGrupo).trim() === String(valor).trim()
      );

      if (!fila) {
        console.warn("⚠️ No se encontró el grupo:", valor);
        for (const campo in campos) {
          if (campo !== 'numeroNegocio' && campo !== 'nombreGrupo') {
            const input = document.getElementById(campos[campo]);
            if (input) input.value = '';
          }
        }
        return;
      }

      // ✅ Agrega esta línea justo aquí
      cargarDatosDeOperaciones(fila.numeroNegocio);
      
      for (const campo in campos) {
        const id = campos[campo];
        const input = document.getElementById(id);
        if (input) {
          let valor = fila[campo];
      
          // ✅ Limpiar HTML enriquecido si aplica
          if (["autorizacion", "fechaDeViaje", "observaciones"].includes(campo)) {
            const tempDiv = document.createElement("div");
            tempDiv.innerHTML = valor;
            valor = tempDiv.textContent || tempDiv.innerText || "";
          }
      
          // ✅ Mostrar fecha formateada localmente si es fechaCreacion
          if (campo === "fechaCreacion" && valor) {
            const fechaLocal = new Date(valor).toLocaleString('es-CL', {
              timeZone: 'America/Santiago',
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            });
            input.value = fechaLocal;
          } else {
            input.value = valor !== undefined ? String(valor) : '';
          }
      
          input.setAttribute("data-original", input.value);
        }
      }
    
      // ✅ Cargar datos desde Excel Online (BaseOperaciones)
      cargarDesdeOperaciones(fila.numeroNegocio);
    }
    // ✅ Vincular eventos a inputs
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

    actualizarListas(); // 🟢 Cargar listas al inicio
  } catch (err) {
    console.error("❌ Error al cargar datos desde sheetURL:", err);
  }
}

// ✅ Función para guardar datos en la hoja 'BaseOperaciones' y registrar historial
async function guardarDatos(continuar = true) {
  const datos = {};
  const cambios = [];

  for (const campo in campos) {
    const id = campos[campo];
    const input = document.getElementById(id);
    if (campo === "numeroNegocio") {
      datos[campo] = String(input.value).trim();
    } else {
      datos[campo] = input ? input.value.trim() : "";
    }
  }

  const usuario = auth.currentUser?.email || "Desconocido";
  datos.modificadoPor = usuario;

  // 🕒 Formatear fecha local (Chile) si es nueva creación
  if (!datos.fechaCreacion) {
    const ahora = new Date();
    const fechaChile = ahora.toLocaleString("es-CL", {
      timeZone: "America/Santiago",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).replace(",", " /");

    datos.fechaCreacion = fechaChile;
    datos.creadoPor = usuario;
  }

  for (const campo in campos) {
    const id = campos[campo];
    const input = document.getElementById(id);
    const valorNuevo = input ? input.value.trim() : "";
    const valorAnterior = input?.getAttribute("data-original") || "";

    if (valorNuevo !== valorAnterior) {
      cambios.push({
        campo,
        anterior: valorAnterior,
        nuevo: valorNuevo
      });
    }
  }

  const payload = {
    datos,
    historial: cambios
  };

  const endpointSheets = "https://operaciones-rtv10.vercel.app/api/guardar-sheet";

  try {
    console.time("⏱ Guardar Google Sheets");

    // ✅ Guardar solo en Google Sheets
    const resSheets = await fetch(endpointSheets, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    console.timeEnd("⏱ Guardar Google Sheets");

    if (resSheets.ok) {
      alert("✅ Datos guardados correctamente.");
      console.log("Actualizando tabla para:", datos.numeroNegocio);
      cargarDesdeOperaciones(datos.numeroNegocio);

      if (!continuar) window.history.back();
    } else {
      alert("⚠️ No se pudo guardar en Google Sheets.");
    }

  } catch (err) {
    console.error("❌ Error al guardar:", err);
    alert("❌ No se pudo conectar con el servidor.");
  }
}

// ✅ Función para descargar LecturaBaseOperaciones como Excel
function descargarLecturaExcel() {
  const fileId = "124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI";
  const gid = "1332196755"; // GID correspondiente a LecturaBaseOperaciones
  const url = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx&gid=${gid}`;
  window.open(url, "_blank");
}

// ✅ Ejecutar todo al cargar el DOM
document.addEventListener("DOMContentLoaded", () => {
  // 🟢 Activar mayúsculas en todos los campos
  Object.values(campos).forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", e => {
        e.target.value = e.target.value.toUpperCase();
      });
    }
  });

  // 🟢 Cargar datos desde Google Sheets
  cargarNumeroNegocio();
  
  // ✅ Enlazar botón de descarga de Excel por ID
  const btnExportar = document.getElementById("btnExportarExcel");
  if (btnExportar) {
    btnExportar.addEventListener("click", descargarLecturaExcel);
  }
});

// ✅ Exponer funciones globales para los botones HTML
window.guardarDatos = guardarDatos;
window.guardarYContinuar = function () {
  const numeroNegocio = document.getElementById("numeroNegocio")?.value;
  if (numeroNegocio) {
    sessionStorage.setItem("numeroNegocio", numeroNegocio);
  }
  guardarDatos(false);
  setTimeout(() => {
    window.location.href = "infoViajes.html";
  }, 1000);
};

window.descargarLecturaExcel = descargarLecturaExcel; // ✅ <-- AGREGA ESTA LÍNEA

async function cargarDesdeOperaciones(numeroNegocio) {
  if (!numeroNegocio) return;

  try {
    const url = `https://script.google.com/macros/s/AKfycbzr12TXE8-lFd86P1yK_yRSVyyFFSuUnAHY_jOefJHYQZCQ5yuQGQsoBP2OWh699K22/exec`;
    const resp = await fetch(url);
    const resultado = await resp.json();

    const cuerpoTabla = document.getElementById("tbodyTabla");
    cuerpoTabla.innerHTML = ""; // Limpia la tabla completa

    if (Array.isArray(resultado.datos)) {
      const coincidencias = resultado.datos.filter(row =>
        row.numeroNegocio?.includes(numeroNegocio)
      );

      if (coincidencias.length > 0) {
        coincidencias.forEach(row => {
          const tr = document.createElement("tr");
          const columnas = [
            "numeroNegocio", "nombreGrupo", "cantidadgrupo", "colegio", "curso",
            "anoViaje", "destino", "programa", "hotel", "asistenciaEnViajes",
            "autorizacion", "fechaDeViaje", "observaciones", "versionFicha"
          ];

          columnas.forEach(col => {
            const td = document.createElement("td");
            td.textContent = row[col] || "";
            tr.appendChild(td);
          });

          cuerpoTabla.appendChild(tr);
        });
      } else {
        const tr = document.createElement("tr");
        for (let i = 0; i < 14; i++) {
          const td = document.createElement("td");
          td.innerHTML = "&nbsp;";
          tr.appendChild(td);
        }
        cuerpoTabla.appendChild(tr);
      }

    } else {
      console.warn("⚠️ Respuesta inesperada del servidor:", resultado);
    }

  } catch (error) {
    console.error("❌ Error al consultar LecturaBaseOperaciones:", error);
  }
}

// Detectar cuando cambia manualmente el valor del input
document.getElementById("numeroNegocio").addEventListener("change", () => {
  const numero = document.getElementById("numeroNegocio").value.trim();
  if (numero !== "") {
    cargarDatosDeOperaciones(numero);
  }
});

// Detectar cuando presiona Enter en el campo
document.getElementById("numeroNegocio").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const numero = document.getElementById("numeroNegocio").value.trim();
    if (numero !== "") {
      cargarDatosDeOperaciones(numero);
    }
  }
});

