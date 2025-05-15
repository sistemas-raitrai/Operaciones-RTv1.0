// ✅ Configuración general
const sheetURL = 'https://script.google.com/macros/s/AKfycbzuyexFe0dUTBNtRLPL9NDdt8-elJH5gk2O_yb0vsdpTWTgx_E0R0UnPsIGzRhzTjf1JA/exec';

// ✅ Mapeo de campos
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

// ✅ Forzar mayúsculas en todos los campos
Object.values(campos).forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("input", e => {
      e.target.value = e.target.value.toUpperCase();
    });
  }
});

// ✅ Cargar y asignar datos
async function cargarNumeroNegocio() {
  const res = await fetch(sheetURL);
  const datos = await res.json();
  console.log("🔍 Ejemplo de fila:", datos[0]);
  const lista = document.getElementById("negocioList");
  const inputNegocio = document.getElementById("numeroNegocio");

  // 🔄 Rellenar datalist
  datos.forEach(fila => {
    if (fila.numeroNegocio) {
      const opt = document.createElement("option");
      opt.value = fila.numeroNegocio;
      lista.appendChild(opt);
    }
  });

  function cargarDatosGrupo() {
    const fila = datos.find(r =>
      r.numeroNegocio !== undefined &&
      String(r.numeroNegocio).trim() === String(inputNegocio.value).trim()
    );

    if (!fila) {
      console.warn("⚠️ No se encontró el número de negocio:", inputNegocio.value);
      for (const campo in campos) {
        if (campo !== 'numeroNegocio') {
          const input = document.getElementById(campos[campo]);
          if (input) input.value = '';
        }
      }
      return;
    }

    console.log("Fila seleccionada:", fila);
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

        // ✅ Limpiar HTML
        if (["autorizacion", "fechaDeViaje", "observaciones"].includes(campo)) {
          const tempDiv = document.createElement("div");
          tempDiv.innerHTML = valor;
          valor = tempDiv.textContent || tempDiv.innerText || "";
        }

        input.value = valor !== undefined ? String(valor) : '';
      }
    }
  }

  inputNegocio.addEventListener("change", cargarDatosGrupo);
  inputNegocio.addEventListener("input", cargarDatosGrupo);
}

// ✅ Guardar y volver
function guardarYVolver() {
  guardarDatos(false);
  setTimeout(() => {
    window.history.back();
  }, 1000);
}

// ✅ Inicialización principal
cargarNumeroNegocio();
