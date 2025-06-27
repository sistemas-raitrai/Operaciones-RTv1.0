// ✅ 1) Importaciones y setup de Firebase
import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);
let cargaInicialHecha = false;

// ✅ 2) URL del Apps Script que devuelve los datos de “ventas”
const sheetURL = 'https://script.google.com/macros/s/…/exec';

// ✅ 3) Mapeo de campos del sheet a IDs de inputs en el HTML
const campos = {
  numeroNegocio:   'numeroNegocio',
  nombreGrupo:     'nombreGrupo',
  cantidadgrupo:   'cantidadgrupo',
  colegio:         'colegio',
  curso:           'curso',
  anoViaje:        'anoViaje',
  destino:         'destino',
  programa:        'programa',
  hotel:           'hotel',
  asistenciaEnViajes: 'asistenciaEnViajes',
  autorizacion:    'autorizacion',
  fechaDeViaje:    'fechaDeViaje',
  observaciones:   'observaciones',
  fechaCreacion:   'fechaCreacion',
  versionFicha:    'text1'
};

// ─── 4) Carga y configura los datalists de número y nombre ─────────────────
async function cargarNumeroNegocio() {
  try {
    const res   = await fetch(sheetURL);
    const datos = await res.json();

    const listaNumero = document.getElementById("negocioList");
    const listaNombre = document.getElementById("nombreList");
    const inputNumero = document.getElementById("numeroNegocio");
    const inputNombre = document.getElementById("nombreGrupo");
    const filtroAno   = document.getElementById("filtroAno");

    // 4.1) Llenar dropdown de años
    const anosUnicos = [...new Set(datos.map(f => f.anoViaje))]
                        .filter(Boolean).sort();
    filtroAno.innerHTML = '';
    anosUnicos.forEach(a => {
      const o = document.createElement("option");
      o.value = o.textContent = a;
      filtroAno.appendChild(o);
    });
    filtroAno.value = new Date().getFullYear();

    // 4.2) Función para repoblar datalists según año
    function actualizarListas() {
      const anoSel = filtroAno.value;
      listaNumero.innerHTML = listaNombre.innerHTML = '';

      const filtrados = datos.filter(r => r.anoViaje == anoSel);

      // → Opciones por número (orden numérico)
      filtrados
        .sort((a,b) => Number(a.numeroNegocio) - Number(b.numeroNegocio))
        .forEach(r => {
          if (r.numeroNegocio) {
            const o = document.createElement("option");
            o.value = r.numeroNegocio;
            listaNumero.appendChild(o);
          }
        });

      // → Opciones por nombre (orden alfabético)
      filtrados
        .sort((a,b) => (a.nombreGrupo||'').localeCompare(b.nombreGrupo||''))
        .forEach(r => {
          if (r.nombreGrupo) {
            const o = document.createElement("option");
            o.value = r.nombreGrupo;
            listaNombre.appendChild(o);
          }
        });
    }

    // 4.3) Función que rellena el formulario al escoger una opción
    function cargarDatosGrupo(valor) {
      const fila = datos.find(r =>
        String(r.numeroNegocio).trim() === valor.trim() ||
        String(r.nombreGrupo).trim()    === valor.trim()
      );
      if (!fila) {
        console.warn("⚠️ Grupo no encontrado:", valor);
        Object.values(campos).forEach(id => document.getElementById(id).value = '');
        return;
      }

      // → Rellenar inputs con valores de la fila
      Object.entries(campos).forEach(([campo,id]) => {
        let val = fila[campo] ?? '';
        // Si contiene HTML, extraer solo texto
        if (["autorizacion","fechaDeViaje","observaciones"].includes(campo)) {
          const tmp = document.createElement("div");
          tmp.innerHTML = val;
          val = tmp.textContent || '';
        }
        // Formatear fechaCreacion a locale
        if (campo === "fechaCreacion" && val) {
          val = new Date(val).toLocaleString('es-CL', {
            timeZone:'America/Santiago',
            day:'2-digit', month:'2-digit', year:'numeric',
            hour:'2-digit', minute:'2-digit'
          });
        }
        const inp = document.getElementById(id);
        inp.value = val;
        inp.setAttribute("data-original", val);
      });

      // → Finalmente, repoblar la tabla de operaciones
      cargarDesdeOperaciones(fila.numeroNegocio);
    }

    // 4.4) Listeners en los inputs y select
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

    actualizarListas();
  } catch (err) {
    console.error("❌ Error al cargar sheetURL:", err);
  }
}

// ─── 5) Guardar datos en “BaseOperaciones” y registrar historial ────────────
async function guardarDatos(continuar = true) {
  const form = {}, cambios = [];

  // 5.1) Leer todos los inputs en form
  Object.entries(campos).forEach(([campo,id]) => {
    const val = document.getElementById(id).value.trim();
    form[campo] = campo === "numeroNegocio" ? String(val) : val;
  });
  const usuario = auth.currentUser?.email || "Desconocido";
  form.modificadoPor = usuario;

  // 5.2) Si no existe fechaCreacion, ponerla ahora
  if (!form.fechaCreacion) {
    form.fechaCreacion = new Date().toLocaleString("es-CL", {
      timeZone:"America/Santiago",
      day:"2-digit", month:"2-digit", year:"numeric",
      hour:"2-digit", minute:"2-digit", second:"2-digit",
      hour12:false
    }).replace(",", " /");
    form.creadoPor = usuario;
  }

  // 5.3) Detectar qué campos cambiaron
  Object.entries(campos).forEach(([campo,id]) => {
    const inp = document.getElementById(id);
    const nuevo = inp.value.trim();
    const orig  = inp.getAttribute("data-original") || "";
    if (nuevo !== orig) cambios.push({ campo, anterior: orig, nuevo });
  });

  // 5.4) Post al servidor y refrescar tabla
  try {
    console.time("⏱ Guardar Sheets");
    const res = await fetch("https://operaciones-rtv10.vercel.app/api/guardar-sheet", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ datos: form, historial: cambios })
    });
    console.timeEnd("⏱ Guardar Sheets");

    if (res.ok) {
      alert("✅ Datos guardados.");
      cargarDesdeOperaciones(form.numeroNegocio);
      if (!continuar) window.history.back();
    } else {
      alert("⚠️ Falló al guardar en Sheets.");
    }
  } catch (err) {
    console.error("❌ Error guardando:", err);
    alert("❌ No se pudo conectar.");
  }
}

// ─── 6) Descargar Excel de “LecturaBaseOperaciones” ─────────────────────────
function descargarLecturaExcel() {
  const fileId = "124rwvhKhVLDnGuGHB1IGIm1-KrtWXencFqr8SfnbhRI";
  const gid    = "1332196755";
  window.open(`https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx&gid=${gid}`, "_blank");
}

// ─── 7) Inicialización al cargar la página ─────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Forzar mayúsculas en todos los inputs
  Object.values(campos).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", e => e.target.value = e.target.value.toUpperCase());
  });

  // Iniciar carga de datos de ventas
  cargarNumeroNegocio();

  // Botón de Excel
  const btn = document.getElementById("btnExportarExcel");
  if (btn) btn.addEventListener("click", descargarLecturaExcel);
});

// ─── 8) Exponer funciones globales para botones HTML ───────────────────────
window.guardarDatos          = guardarDatos;
window.guardarYContinuar     = () => guardarDatos(false);
window.descargarLecturaExcel = descargarLecturaExcel;

// ─── 9) Cargar datos de “BaseOperaciones” en la tabla según númeroNegocio ──
async function cargarDesdeOperaciones(numeroNegocio) {
  if (!numeroNegocio) return;
  try {
    const resp = await fetch('https://script.google.com/macros/s/…/exec');
    const { datos } = await resp.json();
    const tbody = document.getElementById("tbodyTabla");
    tbody.innerHTML = "";

    // Filtrar filas exactas por númeroNegocio
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
      // Si no hay datos, mostrar fila vacía
      const tr = document.createElement("tr");
      for (let i = 0; i < Object.keys(campos).length; i++) {
        const td = document.createElement("td");
        td.innerHTML = "&nbsp;";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error("❌ Error al consultar operaciones:", err);
  }
}
