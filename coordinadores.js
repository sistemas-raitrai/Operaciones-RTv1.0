// coordinadores.js

import { app, db } from './firebase-init.js';
import {
  collection, getDocs, doc, setDoc, addDoc, updateDoc, deleteDoc
} from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';

// ========== VARIABLES GLOBALES ==========
let coordinadores = [];
let grupos = [];
let asignaciones = {}; // {numeroNegocio: {coordinadorId, alerta, sugeridoId}}

// ========== UTILIDADES DE FECHA ==========
function diasEntre(f1, f2) {
  // Devuelve la cantidad de días entre dos fechas (inclusive)
  const a = new Date(f1), b = new Date(f2);
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function fechasSeSuperponen(inicioA, finA, inicioB, finB) {
  return !(new Date(finA) < new Date(inicioB) || new Date(finB) < new Date(inicioA));
}

function fechaEnRangos(fechaInicio, fechaFin, rangos) {
  return rangos.some(r =>
    new Date(fechaInicio) >= new Date(r.inicio) &&
    new Date(fechaFin) <= new Date(r.fin)
  );
}

// ========== 1. CARGA COORDINADORES ==========
async function cargarCoordinadores() {
  coordinadores = [];
  const snap = await getDocs(collection(db, 'coordinadores'));
  snap.forEach(doc => {
    let d = doc.data();
    d.id = doc.id;
    if (!d.fechasDisponibles) d.fechasDisponibles = [];
    coordinadores.push(d);
  });
  renderCoordinadores();
}

// ========== 2. CARGA GRUPOS ==========
async function cargarGrupos() {
  grupos = [];
  const snap = await getDocs(collection(db, 'grupos'));
  snap.forEach(doc => {
    let d = doc.data();
    d.id = doc.id;
    d.numeroNegocio = d.numeroNegocio || doc.id;
    d.aliasGrupo = d.aliasGrupo || limpiarAlias(d.nombreGrupo || "");
    grupos.push(d);
  });
  grupos.sort((a, b) => new Date(a.fechaInicio) - new Date(b.fechaInicio));
  renderGrupos();
}

// ========== 3. SUGERENCIA AUTOMÁTICA ==========
function calcularAsignacionesSugeridas() {
  // 1. Ordena grupos por fecha
  const gruposOrdenados = grupos.slice().sort((a, b) => new Date(a.fechaInicio) - new Date(b.fechaInicio));
  const asig = {}; // {numeroNegocio: {coordinadorId, alerta, sugeridoId}}
  let ocupacionCoordinadores = {}; // {coordinadorId: [{inicio, fin}]}

  gruposOrdenados.forEach(grupo => {
    let mejor = null, minHueco = 9999;
    let alerta = "";

    coordinadores.forEach(coord => {
      // ¿Disponible en ese rango?
      if (!fechaEnRangos(grupo.fechaInicio, grupo.fechaFin, coord.fechasDisponibles)) return;

      // ¿Ya asignado en viaje solapado?
      let tieneSolape = (ocupacionCoordinadores[coord.id] || []).some(asig =>
        fechasSeSuperponen(grupo.fechaInicio, grupo.fechaFin, asig.inicio, asig.fin)
      );
      if (tieneSolape) return;

      // ¿Cuántos días libres entre último viaje y este?
      let prevViaje = (ocupacionCoordinadores[coord.id] || []).slice(-1)[0];
      let hueco = prevViaje ? (diasEntre(prevViaje.fin, grupo.fechaInicio) - 1) : 999;
      if (hueco === 0) alerta = "Sin día de descanso entre viajes";
      if (hueco < 0) return; // No puede viajar antes de terminar otro

      if (hueco < minHueco) {
        mejor = coord;
        minHueco = hueco;
      }
    });

    let sugeridoId = mejor ? mejor.id : null;
    asig[grupo.numeroNegocio] = {
      coordinadorId: sugeridoId,
      alerta: (minHueco === 0) ? "⚠️ Sin día de descanso" : "",
      sugeridoId
    };
    // Marcar ocupación virtual
    if (sugeridoId) {
      if (!ocupacionCoordinadores[sugeridoId]) ocupacionCoordinadores[sugeridoId] = [];
      ocupacionCoordinadores[sugeridoId].push({inicio: grupo.fechaInicio, fin: grupo.fechaFin});
    }
  });

  asignaciones = asig;
}

// ========== 4. RENDER COORDINADORES ==========
function renderCoordinadores() {
  const tbody = document.querySelector("#tabla-coords tbody");
  tbody.innerHTML = "";
  coordinadores.forEach(coord => {
    const fila = document.createElement("tr");
    fila.innerHTML = `
      <td><input type="text" value="${coord.nombre||''}" data-campo="nombre" data-id="${coord.id}" required style="width:110px"></td>
      <td><input type="text" value="${coord.rut||''}" data-campo="rut" data-id="${coord.id}" style="width:95px"></td>
      <td><input type="email" value="${coord.correo||''}" data-campo="correo" data-id="${coord.id}" style="width:135px"></td>
      <td>
        <div class="rangos-fecha" data-id="${coord.id}">
          ${coord.fechasDisponibles.map((r, i) =>
            `<div>
              <input class="picker-range" type="text" data-campo="fechas" data-idx="${i}" data-id="${coord.id}" value="${r.inicio} a ${r.fin}" readonly>
              <button class="small-btn" data-action="borrar-fecha" data-id="${coord.id}" data-idx="${i}">❌</button>
            </div>`).join("")}
          <button class="small-btn" data-action="agregar-fecha" data-id="${coord.id}">+ Rango</button>
        </div>
      </td>
      <td>
        <button class="small-btn" data-action="guardar-coord" data-id="${coord.id}">💾</button>
        <button class="small-btn" data-action="eliminar-coord" data-id="${coord.id}">🗑️</button>
      </td>
    `;
    tbody.appendChild(fila);
  });

  // Listeners para campos editables y rangos de fechas
  document.querySelectorAll("input[data-campo]").forEach(inp => {
    inp.addEventListener("change", async e => {
      const id = inp.dataset.id, campo = inp.dataset.campo, valor = inp.value;
      let coord = coordinadores.find(c => c.id === id);
      if (!coord) return;
      if (campo === "fechas") return; // se gestiona aparte
      coord[campo] = valor;
    });
  });

  // Guardar/eliminar coordinador
  document.querySelectorAll("button[data-action='guardar-coord']").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      let coord = coordinadores.find(c => c.id === id);
      await setDoc(doc(db, "coordinadores", id), {
        nombre: coord.nombre,
        rut: coord.rut,
        correo: coord.correo,
        fechasDisponibles: coord.fechasDisponibles
      });
      cargarCoordinadores();
    };
  });
  document.querySelectorAll("button[data-action='eliminar-coord']").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm("¿Eliminar este coordinador?")) return;
      await deleteDoc(doc(db, "coordinadores", btn.dataset.id));
      cargarCoordinadores();
    };
  });

  // Rangos de fechas disponibles (flatpickr)
  document.querySelectorAll("button[data-action='agregar-fecha']").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      let coord = coordinadores.find(c => c.id === id);
      coord.fechasDisponibles = coord.fechasDisponibles || [];
      coord.fechasDisponibles.push({inicio: '', fin: ''});
      renderCoordinadores();
      setTimeout(() => iniciarPickersFechas(), 50);
    };
  });
  document.querySelectorAll("button[data-action='borrar-fecha']").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id, idx = parseInt(btn.dataset.idx,10);
      let coord = coordinadores.find(c => c.id === id);
      coord.fechasDisponibles.splice(idx,1);
      renderCoordinadores();
      setTimeout(() => iniciarPickersFechas(), 50);
    };
  });
  iniciarPickersFechas();
}

// Flatpickr: selector rango de fechas
function iniciarPickersFechas() {
  document.querySelectorAll(".picker-range").forEach(inp => {
    if (inp._flatpickr) inp._flatpickr.destroy();
    flatpickr(inp, {
      mode: "range",
      dateFormat: "Y-m-d",
      onClose: (selDates, str, inst) => {
        if (selDates.length === 2) {
          const [inicio, fin] = selDates.map(d=>d.toISOString().split("T")[0]);
          const id = inp.dataset.id, idx = parseInt(inp.dataset.idx,10);
          let coord = coordinadores.find(c => c.id === id);
          coord.fechasDisponibles[idx] = {inicio, fin};
          inp.value = `${inicio} a ${fin}`;
        }
      }
    });
  });
}

// ========== 5. RENDER GRUPOS Y ASIGNACIONES ==========
function renderGrupos() {
  calcularAsignacionesSugeridas();
  const tbody = document.querySelector("#tabla-grupos tbody");
  tbody.innerHTML = "";
  grupos.forEach(grupo => {
    let asig = asignaciones[grupo.numeroNegocio] || {};
    // Opciones de coordinador filtradas
    const opciones = coordinadores.map(coord => {
      const disponible = fechaEnRangos(grupo.fechaInicio, grupo.fechaFin, coord.fechasDisponibles);
      // ¿Ya asignado a otro grupo solapado?
      const ocupado = Object.entries(asignaciones).some(([num, a]) =>
        a.coordinadorId === coord.id &&
        num !== grupo.numeroNegocio &&
        fechasSeSuperponen(
          grupo.fechaInicio, grupo.fechaFin,
          grupos.find(g => g.numeroNegocio===num).fechaInicio,
          grupos.find(g => g.numeroNegocio===num).fechaFin
        )
      );
      let label = coord.nombre;
      if (!disponible) label += " (No disponible)";
      if (ocupado) label += " (Asignado)";
      return `<option value="${coord.id}" 
          ${!disponible ? 'disabled' : ''} 
          ${ocupado ? 'disabled' : ''} 
          ${asig.coordinadorId === coord.id ? 'selected' : ''}
        >${label}</option>`;
    }).join("");
    let alerta = asig.alerta || '';
    tbody.innerHTML += `
      <tr>
        <td>
          <input type="text" value="${grupo.aliasGrupo||''}" data-aliased="${grupo.numeroNegocio}" style="width:115px;">
        </td>
        <td>
          ${grupo.fechaInicio} a ${grupo.fechaFin}
        </td>
        <td>
          ${asig.sugeridoId ? coordinadores.find(c=>c.id===asig.sugeridoId)?.nombre : "(Ninguno)"}
        </td>
        <td>
          <select data-asig="${grupo.numeroNegocio}">
            <option value="">(Seleccionar)</option>
            ${opciones}
          </select>
        </td>
        <td>
          <span class="alerta">${alerta}</span>
        </td>
      </tr>
    `;
  });
  // Alias editables
  document.querySelectorAll("input[data-aliased]").forEach(inp => {
    inp.addEventListener("change", e => {
      let grupo = grupos.find(g => g.numeroNegocio === inp.dataset.aliased);
      grupo.aliasGrupo = inp.value;
    });
  });
  // Asignación manual
  document.querySelectorAll("select[data-asig]").forEach(sel => {
    sel.onchange = () => {
      const num = sel.dataset.asig, val = sel.value;
      asignaciones[num].coordinadorId = val || null;
      renderGrupos(); // recalcular alertas y restricciones
    };
    // Si hay un valor preasignado, cargarlo
    let grupo = grupos.find(g=>g.numeroNegocio===sel.dataset.asig);
    if(grupo.coordinador) sel.value = grupo.coordinador;
  });
}

// ========== 6. BOTONES PRINCIPALES ==========
document.getElementById("btn-add-coord").onclick = async () => {
  let nombre = prompt("Nombre del coordinador:");
  if (!nombre) return;
  let docRef = await addDoc(collection(db,"coordinadores"), {
    nombre, rut:"", correo:"", fechasDisponibles:[]
  });
  cargarCoordinadores();
};

document.getElementById("btn-auto-asignar").onclick = () => {
  calcularAsignacionesSugeridas();
  renderGrupos();
};

document.getElementById("btn-guardar").onclick = async () => {
  // Guarda alias y asignación de coordinador por grupo
  for (let grupo of grupos) {
    await updateDoc(doc(db,"grupos",grupo.id), {
      aliasGrupo: grupo.aliasGrupo,
      coordinador: asignaciones[grupo.numeroNegocio]?.coordinadorId || null
    });
  }
  document.getElementById("msg-guardar").textContent = "✅ Cambios guardados";
  setTimeout(()=>document.getElementById("msg-guardar").textContent="",2000);
};

// ========== 7. EXPORTAR EXCEL (Opcional) ==========
document.getElementById("btn-exportar").onclick = () => {
  // Exportar tabla grupos a CSV para Excel
  let filas = [["Alias Grupo","Fecha Inicio","Fecha Fin","Coordinador"]];
  grupos.forEach(g => {
    let coord = coordinadores.find(c=>c.id===asignaciones[g.numeroNegocio]?.coordinadorId);
    filas.push([
      g.aliasGrupo||"",
      g.fechaInicio, g.fechaFin,
      coord ? coord.nombre : ""
    ]);
  });
  let csv = filas.map(f=>f.map(val=>`"${val}"`).join(",")).join("\n");
  let blob = new Blob([csv],{type:"text/csv"});
  let url = URL.createObjectURL(blob);
  let a = document.createElement("a");
  a.href = url;
  a.download = "asignacion-coordinadores.csv";
  a.click();
  URL.revokeObjectURL(url);
};

// ========== 8. ALIAS SUGERIDO ==========
function limpiarAlias(nombreCompleto) {
  // Remueve año, curso, palabras comunes, etc. (ajusta según tus datos reales)
  return nombreCompleto
    .replace(/\d{4}/g, "")     // quita años
    .replace(/\b(colegio|instituto|escuela|curso|año|de|del|la|el|los)\b/gi, "")
    .replace(/[^\w\s]/g, "")
    .trim();
}

// ========== 9. INICIALIZACIÓN ==========
window.addEventListener("DOMContentLoaded", async () => {
  await cargarCoordinadores();
  await cargarGrupos();
});
