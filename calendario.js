import { db } from "./firebase-init.js"; // ✅ importar db directo

import {
  collection,
  getDocs
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

// Función principal
async function generarTablaCalendario() {
  const gruposSnapshot = await getDocs(collection(db, "grupos"));
  const grupos = [];
  const fechasUnicas = new Set();

  // Procesamos los datos
  gruposSnapshot.forEach(doc => {
    const data = doc.data();
    const numeroNegocio = doc.id;
    const nombreGrupo = data.nombreGrupo || "Sin nombre";
    const itinerario = data.itinerario || {};

    const actividadesPorFecha = {};

    Object.keys(itinerario).forEach(fecha => {
      const actividades = itinerario[fecha];
      if (Array.isArray(actividades)) {
        const textoActividades = actividades.map((act, i) => {
          return `${act.horaInicio || ""}–${act.horaFin || ""} ${act.actividad || ""}`;
        }).join("<br>");
        actividadesPorFecha[fecha] = textoActividades;
        fechasUnicas.add(fecha);
      }
    });

    grupos.push({
      numeroNegocio,
      nombreGrupo,
      actividadesPorFecha
    });
  });

  // Convertimos fechas a array ordenado
  const fechasOrdenadas = Array.from(fechasUnicas).sort();

  // Construimos encabezado de tabla
  const encabezado = document.getElementById("encabezadoCalendario");
  encabezado.innerHTML = `
    <th>Número Negocio</th>
    <th>Nombre Grupo</th>
    ${fechasOrdenadas.map(f => `<th>${f}</th>`).join("")}
  `;

  // Construimos cuerpo de tabla
  const cuerpo = document.getElementById("cuerpoCalendario");
  cuerpo.innerHTML = grupos.map(grupo => {
    return `
      <tr>
        <td>${grupo.numeroNegocio}</td>
        <td>${grupo.nombreGrupo}</td>
        ${fechasOrdenadas.map(f => `<td>${grupo.actividadesPorFecha[f] || ""}</td>`).join("")}
      </tr>
    `;
  }).join("");

  // Activar DataTable
  $('#tablaCalendario').DataTable({
    scrollX: true,
    language: {
      url: '//cdn.datatables.net/plug-ins/1.13.4/i18n/es-ES.json'
    }
  });
}

function formatearFechaBonita(fechaISO) {
  const fecha = new Date(fechaISO);
  const opciones = { day: 'numeric', month: 'long' }; // sin año
  return fecha.toLocaleDateString('es-CL', opciones);
}


// Ejecutar
generarTablaCalendario();
