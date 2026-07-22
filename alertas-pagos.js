// alertas-pagos.js — Página independiente de alertas de pagos

import { onAuthStateChanged, signOut } from
“https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js”; import {
collection, getDocs, doc, setDoc, addDoc, serverTimestamp } from
“https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js”;

import { auth, db, VENTAS_USERS } from “./firebase-init.js”;

import { $, normalizeEmail, escapeHtml } from “./utils.js”;

import { ACTING_USER_KEY, getRealUser, getEffectiveUser,
clearVendorFilter, clearGroupFilter, isVendedorRole } from “./roles.js”;

import { updateClockDataset, setHeaderState, renderActingUserSwitcher,
bindLayoutButtons, waitForLayoutReady } from “./ui.js”;

const HOME_URL = “home.html”; const ALERTAS_PAGOS_COLLECTION =
“ventas_alertas_pagos”; const ALERTAS_PAGOS_HISTORIAL_COLLECTION =
“ventas_alertas_pagos_historial”;

const state = { gruposVentas: [], gruposOperacionByNumero: new Map(),
alertas: [], alertasScope: [], alertasSortKey: “fechaViaje”,
alertasSortDir: “asc”, ultimaActualizacion: null };

/* ========================================================= HELPERS
========================================================= */

function normalizeLoose(value = ““) { return String(value ??”“)
.normalize(”NFD”) .replace(/[300-36f]/g, ““) .toLowerCase() .trim(); }

function timestampLikeToDate(value) { if (!value) return null;

if (value instanceof Date) { return Number.isNaN(value.getTime()) ? null
: value; }

if (typeof value?.toDate === “function”) { const d = value.toDate();
return Number.isNaN(d?.getTime?.()) ? null : d; }

if (typeof value === “object” && typeof value.seconds === “number”) {
const d = new Date(value.seconds * 1000); return
Number.isNaN(d.getTime()) ? null : d; }

if (typeof value === “number”) { const d = new Date(value); return
Number.isNaN(d.getTime()) ? null : d; }

if (typeof value === “string”) { const d = new Date(value); if
(!Number.isNaN(d.getTime())) return d;

    const m = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?$/);

    if (m) {
      let year = Number(m[3]);
      if (year < 100) year += 2000;

      const parsed = new Date(
        year,
        Number(m[2]) - 1,
        Number(m[1]),
        Number(m[4] || 0),
        Number(m[5] || 0)
      );

      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

}

return null; }

function formatDate(value) { const d = timestampLikeToDate(value); if
(!d) return “Sin fecha”;

return d.toLocaleString(“es-CL”, { day: “2-digit”, month: “2-digit”,
year: “numeric”, hour: “2-digit”, minute: “2-digit”, hour12: false }); }

function getRowId(row = {}) { return String(row.idGrupo || row.id ||
““).trim(); }

function getNumeroNegocio(row = {}) { return String( row.numeroNegocio
|| row?.ficha?.numeroNegocio || “” ).trim(); }

function getRowVendorEmail(row = {}) { return
normalizeEmail(row.vendedoraCorreo || row.creadoPorCorreo || ““); }

function getRowsForCurrentScope() { const effectiveUser =
getEffectiveUser(); if (!effectiveUser) return [];

if (isVendedorRole(effectiveUser)) { const email =
normalizeEmail(effectiveUser.email || ““); return
state.gruposVentas.filter( (row) => getRowVendorEmail(row) === email );
}

return state.gruposVentas; }

function setText(id, value) { const el = $(id); if (el) el.textContent =
String(value); }

function formatoMontoPago(value, moneda = ““) { const currency =
String(moneda ||”“).toUpperCase();

if (currency === “USD” || currency === “EUR”) { return Number(value ||
0).toLocaleString(“es-CL”, { style: “currency”, currency,
maximumFractionDigits: 0 }); }

return Number(value || 0).toLocaleString(“es-CL”, {
maximumFractionDigits: 0 }); }

function obtenerAnoOperativo() { const hoy = new Date(); return
hoy.getMonth() < 2 ? hoy.getFullYear() - 1 : hoy.getFullYear(); }

function getPrioridadPagoKey(alerta = {}) { const tipo =
String(alerta.tipo || ““);

if ( tipo === “persona_sin_pagos_o_sin_inscripcion” || tipo ===
“persona_atrasada_2_mas_cuotas” || tipo === “persona_muy_atrasada_50” ||
tipo === “grupo_debe_mas_50” || tipo ===
“grupo_10_mas_atrasados_2_cuotas” ) { return “critica”; }

if ( tipo === “persona_pago_bajo” || tipo === “persona_atrasada_1_cuota”
|| tipo === “grupo_no_va_al_dia” ) { return “alta”; }

return “media”; }

function getPrioridadPagoLabel(alerta = {}) { const key =
getPrioridadPagoKey(alerta);

if (key === “critica”) return “Crítica”; if (key === “alta”) return
“Alta”; if (key === “media”) return “Media”; return “Baja”; }

function getZonaDestinoPago(destino = ““) { const d =
normalizeLoose(destino);

if ( d.includes(“sur de chile y bariloche”) || d.includes(“norte de
chile”) || d.includes(“sur de chile”) ) { return “Chile”; }

if (d.includes(“bariloche”)) return “Argentina”;

if (d.includes(“camboriu”) || d.includes(“brasil”)) { return “Brasil”; }

return “Otros”; }

function buildSearchText(obj = {}) { let text = ““;

function extract(value) { if (value === null || value === undefined)
return;

    if (value instanceof Date) {
      text += " " + value.toISOString();
      return;
    }

    if (typeof value?.toDate === "function") {
      text += " " + value.toDate().toISOString();
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(extract);
      return;
    }

    if (typeof value === "object") {
      Object.values(value).forEach(extract);
      return;
    }

    text += " " + String(value);

}

extract(obj); return normalizeLoose(text); }

/* ========================================================= FECHA DE
VIAJE ========================================================= */

function getFechaViajeConfirmadaOperacion(numeroNegocio = ““) { const
numero = String(numeroNegocio ||”“).trim(); if (!numero) return null;

const grupoOp = state.gruposOperacionByNumero.get(numero); if (!grupoOp)
return null; if (grupoOp.fechasConfirmadasDesdeHoteles !== true) return
null;

return timestampLikeToDate(grupoOp.fechaInicio); }

function getFechaViajeOrdenAlertaPago(alerta = {}) { const fecha =
getFechaViajeConfirmadaOperacion(alerta.numeroNegocio); return fecha ?
fecha.getTime() : Number.MAX_SAFE_INTEGER; }

function formatFechaViajeAlertaPago(alerta = {}) { const fecha =
getFechaViajeConfirmadaOperacion(alerta.numeroNegocio);

if (!fecha) return “-”;

return fecha.toLocaleDateString(“es-CL”, { day: “2-digit”, month:
“2-digit”, year: “numeric” }); }

/* ========================================================= CARGA
========================================================= */

async function cargarPaginaAlertasPagos() { const loading =
$(“alertas-pagos-loading”); const app = $(“alertas-pagos-app”);

if (loading) loading.hidden = false; if (app) app.hidden = true;

try { const [ gruposVentasSnap, gruposOperacionSnap, alertasSnap ] =
await Promise.all([ getDocs(collection(db, “ventas_cotizaciones”)),
getDocs(collection(db, “grupos”)), getDocs(collection(db,
ALERTAS_PAGOS_COLLECTION)) ]);

    state.gruposVentas = gruposVentasSnap.docs.map((docSnap) => ({
      id: docSnap.id,
      idGrupo: docSnap.data()?.idGrupo || docSnap.id,
      ...(docSnap.data() || {})
    }));

    state.gruposOperacionByNumero = new Map();

    gruposOperacionSnap.docs.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const numero = String(data.numeroNegocio || "").trim();
      if (!numero) return;

      state.gruposOperacionByNumero.set(numero, {
        id: docSnap.id,
        ...data
      });
    });

    state.alertas = alertasSnap.docs
      .map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data()
      }))
      .filter((row) => row.activa !== false);

    state.ultimaActualizacion =
      state.alertas
        .map((row) => timestampLikeToDate(row.actualizadoAt))
        .filter(Boolean)
        .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    const scopedRows = getRowsForCurrentScope();
    const scopedIds = new Set(scopedRows.map(getRowId).filter(Boolean));
    const scopedNumeros = new Set(scopedRows.map(getNumeroNegocio).filter(Boolean));

    state.alertasScope = state.alertas.filter((alerta) => {
      const idGrupo = String(alerta.idGrupo || "").trim();
      const numeroNegocio = String(alerta.numeroNegocio || "").trim();

      return scopedIds.has(idGrupo) || scopedNumeros.has(numeroNegocio);
    });

    renderFechaActualizacion();
    renderFiltros();
    renderChips();
    refrescarListado();

    if (loading) loading.hidden = true;
    if (app) app.hidden = false;

} catch (error) { console.error(“Error cargando alertas de pagos:”,
error);

    if (loading) {
      loading.innerHTML = `
        <div style="color:#9f1d1d;">
          No se pudieron cargar las alertas de pagos.<br>
          ${escapeHtml(error.message || "Error desconocido")}
        </div>
      `;
    }

} }

function renderFechaActualizacion() { setText(
“alertas-pagos-actualizado”, state.ultimaActualizacion ?
Última actualización: ${formatDate(state.ultimaActualizacion)} : “Última
actualización: sin registro” ); }

/* ========================================================= FILTROS
========================================================= */

function renderFiltros() { const anoOperativo =
String(obtenerAnoOperativo());

const anos = […new Set( state.alertasScope .map((r) => String(r.anoViaje
|| ““).trim()) .filter(Boolean) )].sort();

const vendedores = […new Map( state.alertasScope .map((r) => [
normalizeEmail(r.vendedoraCorreo || ““), r.vendedor || r.vendedoraCorreo
||”Sin vendedor” ]) .filter(([email]) => email) ).entries()];

const monedas = […new Set( state.alertasScope .map((r) =>
String(r.moneda || ““).trim()) .filter(Boolean) )].sort();

$(“filtro-alerta-pago-ano”).innerHTML =
<option value="">Todos los años</option>     ${anos.map((a) => <option
value=“${escapeHtml(a)}” ${String(a) === anoOperativo ? “selected” :
““}> ${escapeHtml(a)} ).join("")};

$(“filtro-alerta-pago-vendedor”).innerHTML =
<option value="">Todos los vendedores</option>     ${vendedores.map(([email, nombre]) =>
${escapeHtml(nombre)} ).join("")};

$(“filtro-alerta-pago-moneda”).innerHTML =
<option value="">Todas las monedas</option>     ${monedas.map((m) =>
${escapeHtml(m)} ).join("")};

$(“filtro-alerta-pago-destino”).innerHTML =
<option value="">Todos los destinos</option>     <option value="Chile">Chile</option>     <option value="Argentina">Argentina</option>     <option value="Brasil">Brasil</option>     <option value="Otros">Otros</option>;
}

function getTiposAlertasPagosUI() { return { individuales: [
[“todas_individuales”, “Todas las individuales”],
[“persona_sin_pagos_o_sin_inscripcion”, “Nunca pagó / inscripción”],
[“persona_pago_bajo”, “Pago <550”], [“persona_atrasada_1_cuota”, “1
cuota atrasada”], [“persona_atrasada_2_mas_cuotas”, “2+ cuotas
atrasadas”], [“persona_muy_atrasada_50”, “Muy atrasado 50%+”] ],
grupales: [ [“todas_grupales”, “Todas las grupales”],
[“grupo_debe_mas_50”, “Grupo debe 50%+”],
[“grupo_10_mas_atrasados_2_cuotas”, “10+ con 2 cuotas”],
[“grupo_no_va_al_dia”, “Grupo no va al día”],
[“grupo_liberados_parciales”, “Liberados parciales”],
[“grupo_saldo_a_favor”, “Saldo a favor”] ] }; }

function renderChips() { const tipos = getTiposAlertasPagosUI();

const renderLista = (items, categoria) => items.map(([tipo, label],
index) =>
<button       type="button"       class="pagos-chip ${categoria === "grupo" ? "is-group" : ""} ${categoria === "persona" && index === 0 ? "is-active" : ""}"       data-tipo-alerta-pago="${escapeHtml(tipo)}"     >       ${escapeHtml(label)}     </button>).join(““);

$(“chips-alertas-pagos”).innerHTML = `

      <div class="pagos-chip-title">Alertas individuales</div>
      <div class="pagos-chip-list">
        ${renderLista(tipos.individuales, "persona")}
      </div>
    </div>

    <div class="pagos-chip-box is-group">
      <div class="pagos-chip-title">Alertas grupales</div>
      <div class="pagos-chip-list">
        ${renderLista(tipos.grupales, "grupo")}
      </div>
    </div>

`; }

function getTipoActivo() { return
document.querySelector(“.pagos-chip.is-active”) ?.dataset.tipoAlertaPago
|| ““; }

function filtrarAlertasPagos() { const ano =
$(“filtro-alerta-pago-ano”)?.value || ““; const vendedor =
$(”filtro-alerta-pago-vendedor”)?.value || ““; const moneda =
$(”filtro-alerta-pago-moneda”)?.value || ““; const destino =
$(”filtro-alerta-pago-destino”)?.value || ““; const prioridad =
$("filtro-alerta-pago-prioridad")?.value || "";
  const q = normalizeLoose($(”filtro-alerta-pago-buscar”)?.value || ““);
const tipoActivo = getTipoActivo();

return state.alertasScope.filter((row) => { if (ano &&
String(row.anoViaje || ““) !== ano) return false;

    if (
      vendedor &&
      normalizeEmail(row.vendedoraCorreo || "") !== vendedor
    ) {
      return false;
    }

    if (moneda && String(row.moneda || "") !== moneda) return false;
    if (destino && getZonaDestinoPago(row.destino) !== destino) return false;
    if (prioridad && getPrioridadPagoKey(row) !== prioridad) return false;

    if (tipoActivo === "__todas_individuales__") {
      if (row.categoriaAlerta !== "persona") return false;
    } else if (tipoActivo === "__todas_grupales__") {
      if (row.categoriaAlerta !== "grupo") return false;
    } else if (tipoActivo && String(row.tipo || "") !== tipoActivo) {
      return false;
    }

    if (q && !buildSearchText(row).includes(q)) return false;

    return true;

}); }

/* ========================================================= ORDEN
========================================================= */

function getValorOrden(row = {}, key = ““) { if (key ===”fechaViaje”)
return getFechaViajeOrdenAlertaPago(row); if (key === “participante”)
return normalizeLoose(row.participante || row.grupo || ““); if (key
===”grupo”) return normalizeLoose(row.grupo || ““); if (key ===”ano”)
return Number(row.anoViaje || 0); if (key === “vendedor”) return
normalizeLoose(row.vendedor || ““); if (key ===”razon”) return
normalizeLoose(row.label || row.tipo || ““); if (key ===”pagado”) return
Number(row.totalPagado || row.totalPagadoGrupo || 0); if (key ===
“total”) return Number(row.totalDebe || row.totalViajeGrupo ||
row.totalDebeGrupo || 0); if (key === “saldo”) return
Number(row.saldoPendiente || row.saldoPendienteGrupo || 0); if (key ===
“ultimoPago”) { const d = timestampLikeToDate(row.ultimoPagoFecha);
return d ? d.getTime() : 0; } if (key === “estado”) return
row.contactado === true ? 1 : 0;

return ““; }

function ordenarAlertas(rows = []) { const factor = state.alertasSortDir
=== “asc” ? 1 : -1;

return […rows].sort((a, b) => { const va = getValorOrden(a,
state.alertasSortKey); const vb = getValorOrden(b,
state.alertasSortKey);

    if (typeof va === "number" && typeof vb === "number") {
      return (va - vb) * factor;
    }

    return String(va).localeCompare(String(vb), "es", {
      sensitivity: "base",
      numeric: true
    }) * factor;

}); }

function iconoOrden(key) { if (state.alertasSortKey !== key) return “↕”;
return state.alertasSortDir === “asc” ? “▲” : “▼”; }

function thOrden(label, key, align = “left”) { return
<th data-sort="${escapeHtml(key)}" style="text-align:${align};">       ${escapeHtml(label)}       <span style="font-size:10px; margin-left:4px;">${iconoOrden(key)}</span>     </th>;
}

/* ========================================================= RESUMEN Y
TABLA ========================================================= */

function renderResumen(rows = []) { const personas = rows.filter((r) =>
r.categoriaAlerta === “persona”); const grupos = rows.filter((r) =>
r.categoriaAlerta === “grupo”); const contactados = rows.filter((r) =>
r.contactado === true);

$("resumen-alertas-pagos").innerHTML = `
    <div class="pagos-summary-card">
      <strong>${rows.length} Total alertas

    <div class="pagos-summary-card">
      <strong>${personas.length}</strong><br>
      <span>Personas</span>
    </div>

    <div class="pagos-summary-card">
      <strong>${grupos.length}</strong><br>
      <span>Grupos</span>
    </div>

    <div class="pagos-summary-card is-green">
      <strong>${contactados.length}</strong><br>
      <span>Contactados</span>
    </div>

`; }

function getResumenCuotasTablaPago(alerta = {}) { const cantidad =
Number(alerta.cantidadCuotas || 0); if (!cantidad) return ““;

const pagadas = Number( alerta.cuotasPagadasEstimadas ??
alerta.cuotasCubiertas ?? 0 );

const vencidas = Number(alerta.cuotasVencidas || 0); const atrasadas =
Math.ceil(Number(alerta.cuotasAtrasadas || 0));

return atrasadas > 0 ?
Pagos equivalentes a ${pagadas.toFixed(1)} de ${cantidad} · Debería ir en ${vencidas} · ${atrasadas} atrasada${atrasadas === 1 ? "" : "s"}
:
Pagos equivalentes a ${pagadas.toFixed(1)} de ${cantidad} · Debería ir en ${vencidas};
}

function refrescarListado() { const filtradas =
ordenarAlertas(filtrarAlertasPagos());

renderResumen(filtradas); renderTabla(filtradas); }

function renderTabla(rows = []) { const cont =
$(“contenedor-alertas-pagos-listado”);

if (!rows.length) { cont.innerHTML =
<div class="pagos-empty">No hay alertas para mostrar.</div>; return; }

cont.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>#</th>
            ${thOrden("Participante / Grupo", "participante")}
            ${thOrden("Grupo", "grupo")}
            ${thOrden("Año", "ano")}
            ${thOrden("Fecha viaje", "fechaViaje")}
            ${thOrden("Vendedor", "vendedor")}
            ${thOrden("Razón", "razon")}
            ${thOrden("Total programa", "total", "right")}
            ${thOrden("Pagado", "pagado", "right")}
            ${thOrden("Saldo", "saldo", "right")}
            ${thOrden("Último pago", "ultimoPago")}
            ${thOrden("Estado", "estado")}
          </tr>
        </thead>

        <tbody>
          ${rows.map((alerta, index) => {
            const esPersona = alerta.categoriaAlerta === "persona";
            const nombre = esPersona ? alerta.participante : alerta.grupo;
            const total = esPersona
              ? alerta.totalDebe
              : alerta.totalViajeGrupo || alerta.totalDebeGrupo || alerta.totalDebe;

            const pagado = esPersona
              ? alerta.totalPagado
              : alerta.totalPagadoGrupo;

            return `
              <tr
                data-alerta-id="${escapeHtml(alerta.id)}"
                class="${alerta.contactado === true ? "is-contacted" : ""}"
              >
                <td style="font-weight:900;">${index + 1}</td>

                <td>
                  <strong>${escapeHtml(nombre || "-")}</strong><br>
                  <span style="color:#766b84;">
                    ${escapeHtml(esPersona ? (alerta.responsable || "Sin responsable") : "Alerta de grupo")}
                  </span>
                </td>

                <td>
                  ${escapeHtml(alerta.grupo || "-")}<br>
                  <span style="color:#766b84;">N° ${escapeHtml(alerta.numeroNegocio || "-")}</span>
                </td>

                <td>${escapeHtml(alerta.anoViaje || "-")}</td>
                <td>${escapeHtml(formatFechaViajeAlertaPago(alerta))}</td>
                <td>${escapeHtml(alerta.vendedor || "Sin vendedor")}</td>

                <td style="min-width:210px;">
                  <strong>${escapeHtml(alerta.label || alerta.tipo || "-")}</strong>
                  ${esPersona && getResumenCuotasTablaPago(alerta) ? `
                    <br>
                    <span style="display:inline-block; margin-top:4px; color:#766b84; line-height:1.4;">
                      ${escapeHtml(getResumenCuotasTablaPago(alerta))}
                    </span>
                  ` : ""}
                </td>

                <td style="text-align:right;">
                  ${escapeHtml(formatoMontoPago(total || 0, alerta.moneda))}
                </td>

                <td style="text-align:right;">
                  ${escapeHtml(formatoMontoPago(pagado || 0, alerta.moneda))}
                </td>

                <td style="text-align:right; font-weight:900;">
                  ${escapeHtml(formatoMontoPago(
                    alerta.saldoPendiente || alerta.saldoPendienteGrupo || 0,
                    alerta.moneda
                  ))}
                </td>

                <td>${escapeHtml(alerta.ultimoPagoFecha || "-")}</td>

                <td>
                  ${alerta.contactado === true
                    ? `<span style="color:#1d6a2b; font-weight:900;">Contactado</span>`
                    : `<span style="color:#9f1d1d; font-weight:900;">Pendiente</span>`
                  }
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>

`; }

/* ========================================================= CONTACTO
========================================================= */

function getTextoAvanceCuotasPago(alerta = {}) { const cantidad =
Number(alerta.cantidadCuotas || 0); if (!cantidad) return ““;

const pagadas = Number( alerta.cuotasPagadasEstimadas ??
alerta.cuotasCubiertas ?? 0 );

const vencidas = Number(alerta.cuotasVencidas || 0); const atrasadas =
Math.ceil(Number(alerta.cuotasAtrasadas || 0));

const partes = [
Registra pagos equivalentes a ${pagadas.toFixed(1)} cuotas de ${cantidad}.
];

if (vencidas > 0) {
partes.push(A esta fecha debería ir en la cuota ${vencidas} de ${cantidad}.);
}

if (atrasadas > 0) {
partes.push(Registra ${atrasadas} ${atrasadas === 1 ? "cuota atrasada" : "cuotas atrasadas"}.);
}

return partes.join(” “); }

function getTextoSugeridoPago(alerta = {}) { const responsable =
alerta.responsable || “apoderado/a”; const participante =
alerta.participante || “el/la participante”; const grupo = alerta.grupo
|| “su grupo”; const moneda = alerta.moneda || ““;

const total = formatoMontoPago(alerta.totalDebe, moneda); const pagado =
formatoMontoPago(alerta.totalPagado, moneda); const saldo =
formatoMontoPago(alerta.saldoPendiente, moneda); const textoCuotas =
getTextoAvanceCuotasPago(alerta);

return `Estimado/a ${responsable}:

Junto con saludar, le escribimos respecto del viaje de estudios de
${participante}, correspondiente al grupo ${grupo}.

Según nuestros registros, el valor total del programa es de ${total}.
Actualmente registra pagos por ${pagado}, manteniendo un saldo pendiente
de ${saldo}.

${textoCuotas ? `${textoCuotas}` : ““}Le agradeceríamos revisar esta
información y regularizar las cuotas pendientes. Si existe algún pago
que aún no se encuentre reflejado o requiere revisar su situación, puede
contactarnos para verificarlo.

Saludos cordiales, Turismo Rai Trai`; }

function limpiarTelefonoWhatsapp(value = ““) { let fono = String(value
||”“).replace(//g,”“);

if (!fono) return ““; if (fono.startsWith(”56”)) return fono; if
(fono.startsWith(“9”)) return 56${fono}; if (fono.length === 8) return
569${fono};

return fono; }

function getWhatsappUrl(alerta = {}) { const fono =
limpiarTelefonoWhatsapp(alerta.telefonoResponsable || ““); if (!fono)
return”“;

return
https://wa.me/${encodeURIComponent(fono)}?text=${encodeURIComponent(getTextoSugeridoPago(alerta))};
}

function getGmailUrl(alerta = {}) { const to =
String(alerta.correoResponsable || ““).trim(); if (!to) return”“;

const subject =
Estado de pagos viaje de estudios - ${alerta.participante || alerta.grupo || ""};

return
https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(getTextoSugeridoPago(alerta))};
}

/* ========================================================= DETALLE
========================================================= */

function renderDetalleCuotas(alerta = {}) { const cantidad =
Number(alerta.cantidadCuotas || 0);

if (!cantidad) { return
<div style="margin-top:12px; padding:12px; border-radius:14px; background:#faf8fd; border:1px solid rgba(49,25,75,.10);">         <strong>Plan de cuotas:</strong> Sin información disponible.       </div>;
}

const pagadas = Number( alerta.cuotasPagadasEstimadas ??
alerta.cuotasCubiertas ?? 0 );

return
<div style="margin-top:12px; padding:12px 14px; border-radius:14px; background:#f7f3fb; border:1px solid rgba(49,25,75,.12); color:#3e3550; font-size:14px; line-height:1.6;">       <strong>Plan de pagos</strong><br>       <strong>Cantidad total:</strong> ${escapeHtml(cantidad)} cuotas<br>       <strong>Pagos equivalentes:</strong> ${escapeHtml(pagadas.toFixed(1))} de ${escapeHtml(cantidad)} cuotas<br>       <strong>Cuota esperada:</strong> ${escapeHtml(alerta.cuotasVencidas || 0)} de ${escapeHtml(cantidad)}<br>       <strong>Atraso estimado:</strong> ${escapeHtml(Math.ceil(Number(alerta.cuotasAtrasadas || 0)))} cuota(s)<br>       <strong>Valor referencial cuota:</strong> ${escapeHtml(formatoMontoPago(alerta.valorCuota || 0, alerta.moneda))}     </div>;
}

function renderTablaPersonasGrupo(alerta = {}) { const especiales =
alerta.tipo === “grupo_liberados_parciales” ?
alerta.pasajerosLiberacionParcial : alerta.tipo ===
“grupo_saldo_a_favor” ? alerta.pasajerosSaldoFavor :
alerta.pasajerosConDeudaGrupo;

const rows = Array.isArray(especiales) ? especiales : [];

if (!rows.length) { return
<div class="pagos-empty" style="margin-top:14px;">No hay detalle de personas guardado.</div>;
}

return `
      <table style="min-width:900px;">
        <thead style="background:#f7f3fb; color:#32184f;">
          <tr>
            <th>#</th>
            <th>Participante</th>
            <th>Responsable</th>
            <th>Correo</th>
            <th>Teléfono</th>
            <th style="text-align:right;">Pagado</th>
            <th style="text-align:right;">Saldo</th>
            <th>Último pago</th>
          </tr>
        </thead>

        <tbody>
          ${rows.map((p, index) => `
            <tr style="cursor:default;">
              <td>${index + 1}</td>
              <td><strong>${escapeHtml(p.participante || "-")}</strong><br>${escapeHtml(p.rut || "")}</td>
              <td>${escapeHtml(p.responsable || "-")}</td>
              <td>${escapeHtml(p.correoResponsable || "-")}</td>
              <td>${escapeHtml(p.telefonoResponsable || "-")}</td>
              <td style="text-align:right;">${escapeHtml(formatoMontoPago(p.totalPagado || 0, alerta.moneda))}</td>
              <td style="text-align:right; font-weight:900;">${escapeHtml(formatoMontoPago(p.saldoPendiente || 0, alerta.moneda))}</td>
              <td>${escapeHtml(p.ultimoPagoFecha || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>

`; }

function abrirDetalle(alertaId) { const alerta = state.alertas.find(
(row) => String(row.id) === String(alertaId) );

if (!alerta) return;

const esPersona = alerta.categoriaAlerta === “persona”; const gmailUrl =
esPersona ? getGmailUrl(alerta) : ““; const whatsappUrl = esPersona ?
getWhatsappUrl(alerta) :”“;

setText( “modal-alerta-pago-titulo”, esPersona ? alerta.participante ||
“Detalle alerta” : alerta.grupo || “Detalle alerta” );

setText( “modal-alerta-pago-subtitulo”, alerta.label || alerta.tipo ||
“Alerta de pago” );

$(“modal-alerta-pago-contenido”).innerHTML = `
      <div>
        <div style="color:#3e3550; font-size:14px; line-height:1.6;">
          <strong>Grupo:</strong> ${escapeHtml(alerta.grupo || "-")}<br>
          <strong>N° negocio:</strong> ${escapeHtml(alerta.numeroNegocio || "-")}<br>
          <strong>Año:</strong> ${escapeHtml(alerta.anoViaje || "-")}<br>
          <strong>Destino:</strong> ${escapeHtml(alerta.destino || "-")}<br>
          <strong>Vendedor(a):</strong> ${escapeHtml(alerta.vendedor || "Sin vendedor")}<br>
          <strong>Prioridad:</strong> ${escapeHtml(getPrioridadPagoLabel(alerta))}
        </div>

        ${esPersona ? `
          <div style="margin-top:12px; color:#3e3550; font-size:14px; line-height:1.6;">
            <strong>Responsable:</strong> ${escapeHtml(alerta.responsable || "-")}<br>
            <strong>Correo:</strong> ${escapeHtml(alerta.correoResponsable || "-")}<br>
            <strong>Teléfono:</strong> ${escapeHtml(alerta.telefonoResponsable || "-")}<br>
            <strong>Total programa:</strong> ${escapeHtml(formatoMontoPago(alerta.totalDebe || 0, alerta.moneda))}<br>
            <strong>Total pagado:</strong> ${escapeHtml(formatoMontoPago(alerta.totalPagado || 0, alerta.moneda))}<br>
            <strong>Saldo pendiente:</strong> ${escapeHtml(formatoMontoPago(alerta.saldoPendiente || 0, alerta.moneda))}<br>
            <strong>Último pago:</strong> ${escapeHtml(alerta.ultimoPagoFecha || "Sin registro")}
          </div>

          ${renderDetalleCuotas(alerta)}

          ${alerta.contactado === true ? `
            <div style="margin-top:12px; padding:10px 12px; border-radius:14px; background:#eef8ef; border:1px solid #b9dfc0; color:#1d6a2b; font-size:13px;">
              ✅ Contactado por ${escapeHtml(alerta.contactadoPor || alerta.contactadoPorCorreo || "usuario")}
              el ${escapeHtml(formatDate(alerta.contactadoAt))}.
            </div>
          ` : ""}

          <details open style="margin-top:12px;">
            <summary style="cursor:pointer; font-weight:900;">Texto sugerido</summary>
            <div style="margin-top:8px; white-space:pre-wrap; padding:12px; border-radius:12px; background:#f7f3fb;">
              ${escapeHtml(getTextoSugeridoPago(alerta))}
            </div>
          </details>
        ` : `
          <div style="margin-top:12px; color:#3e3550; font-size:14px; line-height:1.6;">
            <strong>Total viajan:</strong> ${escapeHtml(alerta.totalViajan || 0)}<br>
            <strong>Con deuda:</strong> ${escapeHtml(alerta.totalConDeuda || 0)}<br>
            <strong>% saldo pendiente:</strong> ${escapeHtml(Number(alerta.porcentajeGrupoDebe || 0).toFixed(1))}%<br>
            <strong>Saldo pendiente grupo:</strong> ${escapeHtml(formatoMontoPago(alerta.saldoPendienteGrupo || 0, alerta.moneda))}<br>
            <strong>Total pagado grupo:</strong> ${escapeHtml(formatoMontoPago(alerta.totalPagadoGrupo || 0, alerta.moneda))}
          </div>

          ${renderTablaPersonasGrupo(alerta)}
        `}
      </div>

      <div class="detalle-actions">
        ${gmailUrl ? `<a href="${gmailUrl}" target="_blank" rel="noopener" class="pagos-btn" style="background:#b42318;">Gmail</a>` : ""}
        ${whatsappUrl ? `<a href="${whatsappUrl}" target="_blank" rel="noopener" class="pagos-btn" style="background:#16833a;">WhatsApp</a>` : ""}

        ${esPersona ? `
          <button type="button" class="pagos-btn" data-copy-alerta="${escapeHtml(alerta.id)}">
            Copiar texto
          </button>

          <button type="button" class="pagos-btn is-green" data-contactar-alerta="${escapeHtml(alerta.id)}">
            ${alerta.contactado === true ? "Registrar nuevo contacto" : "Marcar contactado"}
          </button>
        ` : ""}

        <a
          href="grupo.html?id=${encodeURIComponent(String(alerta.idGrupo || "").trim())}"
          target="_blank"
          rel="noopener"
          class="pagos-btn"
        >
          Abrir grupo
        </a>
      </div>
    </div>

`;

const dialog = $(“modal-detalle-alerta-pago”);

if (typeof dialog.showModal === “function”) { if (!dialog.open)
dialog.showModal(); } else { dialog.setAttribute(“open”, “open”); } }

function cerrarDetalle() { const dialog =
$(“modal-detalle-alerta-pago”);

if (typeof dialog.close === “function”) { dialog.close(); } else {
dialog.removeAttribute(“open”); } }

/* ========================================================= ACCIONES
========================================================= */

async function copiarTexto(alertaId) { const alerta =
state.alertas.find( (row) => String(row.id) === String(alertaId) );

if (!alerta) return;

const texto = getTextoSugeridoPago(alerta);

try { await navigator.clipboard.writeText(texto); alert(“Texto
copiado.”); } catch (error) { console.error(“No se pudo copiar:”,
error); alert(texto); } }

async function marcarContactado(alertaId) { const alerta =
state.alertas.find( (row) => String(row.id) === String(alertaId) );

if (!alerta) return;

const ok = confirm( “Antes de marcar como contactado:” + “Recuerda
registrar este contacto también en el historial del Sistema de Pagos.” +
“¿Confirmas que ya lo registraste o que lo registrarás ahora?” );

if (!ok) return;

const nota = prompt(“Nota del contacto realizado:”, ““) ||”“; const user
= getEffectiveUser() || {}; const realUser = getRealUser() || {};

const payload = { …alerta, contactado: true, contactadoAt: new
Date().toISOString(), contactadoPor: user.nombre || user.name ||
user.email || ““, contactadoPorCorreo: normalizeEmail(user.email ||”“),
contactadoRealPorCorreo: normalizeEmail(realUser.email ||”“),
notaContacto: nota, requiereRegistroHistorialPagos: true,
mensajeAviso:”Debe registrar este contacto en historial del Sistema de
Pagos”, actualizadoAt: new Date().toISOString() };

await setDoc( doc(db, ALERTAS_PAGOS_COLLECTION, alerta.id), payload, {
merge: true } );

await addDoc( collection(db, ALERTAS_PAGOS_HISTORIAL_COLLECTION), {
tipo: “contacto_alerta_pago”, fecha: serverTimestamp(), usuario:
user.nombre || user.name || user.email || ““, usuarioCorreo:
normalizeEmail(user.email ||”“), realUsuarioCorreo:
normalizeEmail(realUser.email ||”“), alertaId: alerta.id, numeroNegocio:
alerta.numeroNegocio ||”“, idGrupo: alerta.idGrupo ||”“, rut: alerta.rut
||”“, participante: alerta.participante ||”“, responsable:
alerta.responsable ||”“, correoResponsable: alerta.correoResponsable
||”“, telefonoResponsable: alerta.telefonoResponsable ||”“, nota,
aviso:”Usuario fue advertido de registrar contacto en historial del
Sistema de Pagos” } );

cerrarDetalle(); await cargarPaginaAlertasPagos();
abrirDetalle(alertaId); }

function exportarAlertasXlsx() { const rows =
ordenarAlertas(filtrarAlertasPagos());

if (!rows.length) { alert(“No hay alertas para exportar con los filtros
actuales.”); return; }

const data = rows.map((a, index) => ({ numero: index + 1, categoria:
a.categoriaAlerta || ““, tipo: a.tipo ||”“, razon: a.label ||”“,
participante: a.participante ||”“, responsable: a.responsable ||”“,
correo: a.correoResponsable ||”“, telefono: a.telefonoResponsable ||”“,
grupo: a.grupo ||”“, numeroNegocio: a.numeroNegocio ||”“, anoViaje:
a.anoViaje ||”“, fechaViaje: formatFechaViajeAlertaPago(a), vendedor:
a.vendedor ||”“, moneda: a.moneda ||”“, total: a.totalDebe ||
a.totalViajeGrupo ||”“, pagado: a.totalPagado || a.totalPagadoGrupo
||”“, saldo: a.saldoPendiente || a.saldoPendienteGrupo ||”“,
cantidadCuotas: a.cantidadCuotas ||”“, cuotasVencidas: a.cuotasVencidas
||”“, cuotasPagadasEstimadas: a.cuotasPagadasEstimadas ??
a.cuotasCubiertas ??”“, cuotasAtrasadas: a.cuotasAtrasadas ||”“,
valorCuota: a.valorCuota ||”“, ultimoPagoFecha: a.ultimoPagoFecha ||”“,
contactado: a.contactado ?”Sí” : “No”, contactadoPor: a.contactadoPor ||
a.contactadoPorCorreo || ““, contactadoAt: a.contactadoAt ||”“,
prioridad: getPrioridadPagoLabel(a) }));

const ws = XLSX.utils.json_to_sheet(data); const wb =
XLSX.utils.book_new();

XLSX.utils.book_append_sheet(wb, ws, “Alertas pagos”);

const fecha = new Date().toISOString().slice(0, 10); XLSX.writeFile(wb,
alertas_pagos_${fecha}.xlsx); }

/* ========================================================= EVENTOS
========================================================= */

function bindPageEvents() { [ “filtro-alerta-pago-ano”,
“filtro-alerta-pago-vendedor”, “filtro-alerta-pago-moneda”,
“filtro-alerta-pago-destino”, “filtro-alerta-pago-prioridad”,
“filtro-alerta-pago-buscar” ].forEach((id) => { const el = $(id); if
(!el || el.dataset.bound) return;

    el.dataset.bound = "1";
    el.addEventListener("input", refrescarListado);
    el.addEventListener("change", refrescarListado);

});

$(“btn-exportar-alertas”)?.addEventListener(“click”,
exportarAlertasXlsx);
$(“btn-cerrar-alerta-pago”)?.addEventListener(“click”, cerrarDetalle);

$(“modal-detalle-alerta-pago”)?.addEventListener(“click”, (event) => {
if (event.target === $(“modal-detalle-alerta-pago”)) { cerrarDetalle();
} });

document.addEventListener(“click”, async (event) => { const chip =
event.target.closest(“[data-tipo-alerta-pago]”);

    if (chip) {
      document.querySelectorAll("[data-tipo-alerta-pago]").forEach((btn) => {
        btn.classList.remove("is-active");
      });

      chip.classList.add("is-active");
      refrescarListado();
      return;
    }

    const th = event.target.closest("[data-sort]");

    if (th) {
      const key = th.dataset.sort;

      if (state.alertasSortKey === key) {
        state.alertasSortDir =
          state.alertasSortDir === "asc" ? "desc" : "asc";
      } else {
        state.alertasSortKey = key;
        state.alertasSortDir =
          ["pagado", "saldo", "ano", "ultimoPago", "estado"].includes(key)
            ? "desc"
            : "asc";
      }

      refrescarListado();
      return;
    }

    const row = event.target.closest("[data-alerta-id]");

    if (row) {
      abrirDetalle(row.dataset.alertaId);
      return;
    }

    const copy = event.target.closest("[data-copy-alerta]");

    if (copy) {
      await copiarTexto(copy.dataset.copyAlerta);
      return;
    }

    const contactar = event.target.closest("[data-contactar-alerta]");

    if (contactar) {
      await marcarContactado(contactar.dataset.contactarAlerta);
    }

}); }

/* ========================================================= INIT
========================================================= */

async function renderPantalla() { const realUser = getRealUser(); const
effectiveUser = getEffectiveUser();

if (!realUser || !effectiveUser) { location.href = “login.html”; return;
}

setHeaderState({ realUser, effectiveUser, title: “Alertas de pagos”,
subtitle: “Gestión de pagos” });

renderActingUserSwitcher(VENTAS_USERS); await
cargarPaginaAlertasPagos(); }

async function initPage() { await waitForLayoutReady();

bindLayoutButtons({ homeUrl: HOME_URL,

    onLogout: async () => {
      try {
        sessionStorage.removeItem(ACTING_USER_KEY);
        clearVendorFilter();
        clearGroupFilter();
        await signOut(auth);
        location.href = "login.html";
      } catch (error) {
        alert("Error al cerrar sesión: " + error.message);
      }
    },

    onActAs: async (selectedEmail) => {
      const realUser = getRealUser();

      if (!realUser || realUser.rol !== "admin") return;
      if (!selectedEmail) return;

      sessionStorage.setItem(ACTING_USER_KEY, selectedEmail);
      clearVendorFilter();
      clearGroupFilter();
      await renderPantalla();
    },

    onResetActAs: async () => {
      sessionStorage.removeItem(ACTING_USER_KEY);
      clearVendorFilter();
      clearGroupFilter();
      await renderPantalla();
    }

});

bindPageEvents();

onAuthStateChanged(auth, async (user) => { if (!user) { location.href =
“login.html”; return; }

    await renderPantalla();

});

updateClockDataset(); setInterval(updateClockDataset, 1000); }

initPage();
