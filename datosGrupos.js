import { getAuth } from "https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js";
import { app } from "./firebase-init.js";
const auth = getAuth(app);

// ✅ URL del script de Google Apps Script que entrega los datos
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
  versionFicha: 'text1'
};

// ✅ Forzar mayúsculas automáticamente en todos los inputs del formulario
Object.values(campos).forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("input", e => {
      e.target.value = e.target.value.toUpperCase();
    });
  }
});

// ✅ Cargar datos desde Google Sheet y preparar la búsqueda
async function cargarNumeroNegocio() {
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

    datos.filter(f => f.anoViaje == anoSeleccionado).forEach(fila => {
      if (fila.numeroNegocio) {
        const opt = document.createElement("option");
        opt.value = fila.numeroNegocio;
        listaNumero.appendChild(opt);
      }
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

    for (const campo in campos) {
      const id = campos[campo];
      const input = document.getElementById(id);
      if (input) {
        let valor = fila[campo];

        // ✅ Formato de fecha
        if (campo === "fechaDeViaje" && typeof valor === "object" && valor instanceof Date) {
          valor = valor.toLocaleDateString("es-CL", {
            day: "2-digit",
            month: "long",
            year: "numeric"
          });
        }

        // ✅ Limpiar HTML enriquecido
        if (["autorizacion", "fechaDeViaje", "observaciones"].includes(campo)) {
          const tempDiv = document.createElement("div");
          tempDiv.innerHTML = valor;
          valor = tempDiv.textContent || tempDiv.innerText || "";
        }

        input.value = valor !== undefined ? String(valor) : '';

        // 🆕 Guardar el valor original como atributo personalizado
        // Esto permite detectar después si ese valor cambió
        input.setAttribute("data-original", input.value);
      }
    }
  }

  // ✅ Vincular eventos a inputs
  inputNumero.addEventListener("change", () => cargarDatosGrupo(inputNumero.value));
  inputNombre.addEventListener("change", () => cargarDatosGrupo(inputNombre.value));
  filtroAno.addEventListener("change", actualizarListas);

  actualizarListas(); // 🟢 Cargar listas al inicio
}

// ✅ Botón de guardar y volver atrás
function guardarYVolver() {
  guardarDatos(false);
  setTimeout(() => {
    window.history.back();
  }, 1000);
}

// ✅ Iniciar todo
cargarNumeroNegocio();

// ✅ Función para guardar datos en la hoja 'BaseOperaciones' y registrar historial
async function guardarDatos(continuar = true) {
  const datos = {};
  const cambios = [];

  // 🔁 1. Recorrer todos los campos del formulario
  for (const campo in campos) {
    const id = campos[campo];
    const input = document.getElementById(id);
    datos[campo] = input ? input.value.trim() : "";
  }

  // 👤 2. Agregar usuario que modifica
  const usuario = auth.currentUser?.email || "Desconocido";
  datos.modificadoPor = usuario;

  // 🕒 3. Si el dato es nuevo, agregar quién lo creó y cuándo
  if (!datos.fechaCreacion) {
    datos.fechaCreacion = new Date().toISOString();
    datos.creadoPor = usuario;
  }

  // 🔍 4. Comparar con valores originales (guardados en data-original)
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

  // 📦 5. Armar el cuerpo del envío
  const payload = {
    datos,
    historial: cambios
  };

  // 🌐 6. URL de tu Web App desplegada (Apps Script)
  const endpoint = "https://script.google.com/macros/s/AKfycbyCXGlo0v-fNfFnM4UDP0caqnGrpOmqqTCmP7o35XJA9sW040J0OWT_XZKQqMp3WzFx/exec";

  // 🚀 7. Enviar al servidor
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      alert("✅ Datos guardados correctamente en la base de operaciones.");
      if (!continuar) window.history.back(); // volver si es "Guardar y Volver"
    } else {
      alert("❌ Error al guardar los datos en la base de operaciones.");
    }
  } catch (err) {
    console.error("❌ Error al enviar datos:", err);
    alert("❌ No se pudo conectar con el servidor.");
  }
}



