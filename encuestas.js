// encuestas.js
// Gestión interna de encuestas de viaje

import {
  auth,
  db
} from "./firebase-init.js";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  query,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js";

/* =========================================================
   URLS CLOUD FUNCTIONS

   Estas URLs corresponden al proyecto sist-op-rt.
   Después del despliegue verificaremos que Firebase haya
   entregado exactamente estos dominios.
========================================================= */

const FUNCTION_URLS = Object.freeze({
  guardar:
    "https://guardarencuestaviaje-r3llfis4wa-tl.a.run.app",

  publicar:
    "https://publicarencuestaviaje-r3llfis4wa-tl.a.run.app",

  actualizar:
    "https://actualizarencuestaviaje-r3llfis4wa-tl.a.run.app",

  reiniciar:
    "https://reiniciarencuestaviaje-r3llfis4wa-tl.a.run.app",

  cambiarEstado:
    "https://cambiarestadoencuestaviaje-r3llfis4wa-tl.a.run.app",

  gestion:
    "https://obtenergestionencuestaviaje-r3llfis4wa-tl.a.run.app"
});

/* =========================================================
   ESTADO
========================================================= */

const state = {
  grupos: [],
  encuestas: [],
  filas: [],

  grupoActual: null,
  encuestaActual: null,

  actividades: [],
  hoteles: [],
  transportes: [],
  coordinadores: [],

  modalidadCoordinadorPendiente:
    "obligatoria",

  asistenciaMedica: {
    modalidad:
      "obligatoria"
  },

  reglasGlobales: new Map(),
  reglasDestino: new Map(),

  seguimiento: null,
  resultados: {},
  comentarios: {
    positivos: [],
    mejoras: [],
    generales: []
  },
  resultadosAsistenciaMedica: {
    utilizaron: 0,
    evaluaron: 0,
    puntuaciones: {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0
    },
    total: 0,
    suma: 0,
    promedio: 0,
    comentarios: []
  }  
};

/* =========================================================
   DOM
========================================================= */

const $ = id =>
  document.getElementById(id);

const tbodyEncuestas =
  $("tbodyEncuestas");

const modalEncuesta =
  $("modalEncuesta");

const modalConfigGlobal =
  $("modalConfigGlobal");

/* =========================================================
   UTILIDADES
========================================================= */

function cleanText(value = "") {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizarTexto(value = "") {
  return cleanText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function slug(value = "") {
  return normalizarTexto(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 150);
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toISO(value) {
  if (!value) {
    return "";
  }

  if (
    typeof value === "object" &&
    typeof value.toDate === "function"
  ) {
    return value
      .toDate()
      .toISOString()
      .slice(0, 10);
  }

  if (
    typeof value === "object" &&
    typeof value.seconds === "number"
  ) {
    return new Date(
      value.seconds * 1000
    )
      .toISOString()
      .slice(0, 10);
  }

  const texto =
    cleanText(value);

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(texto)
  ) {
    return texto;
  }

  if (
    /^\d{2}-\d{2}-\d{4}$/.test(texto)
  ) {
    const [d, m, y] =
      texto.split("-");

    return `${y}-${m}-${d}`;
  }

  const fecha =
    new Date(texto);

  if (
    Number.isNaN(
      fecha.getTime()
    )
  ) {
    return "";
  }

  return fecha
    .toISOString()
    .slice(0, 10);
}

function formatDate(value) {
  const iso =
    toISO(value);

  if (!iso) {
    return "—";
  }

  const [y, m, d] =
    iso.split("-").map(Number);

  return new Date(
    y,
    m - 1,
    d
  ).toLocaleDateString(
    "es-CL",
    {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    }
  );
}

function fechaHoraLocalInput(value) {
  if (!value) {
    return "";
  }

  const fecha =
    typeof value?.toDate === "function"
      ? value.toDate()
      : new Date(value);

  if (
    Number.isNaN(
      fecha.getTime()
    )
  ) {
    return "";
  }

  const local =
    new Date(
      fecha.getTime() -
      fecha.getTimezoneOffset() * 60000
    );

  return local
    .toISOString()
    .slice(0, 16);
}

function sumarDiasISO(iso, dias) {
  if (!iso) {
    return "";
  }

  const fecha =
    new Date(`${iso}T12:00:00`);

  fecha.setDate(
    fecha.getDate() +
    Number(dias || 0)
  );

  return fecha
    .toISOString()
    .slice(0, 10);
}

function getNombreGrupo(grupo = {}) {
  return cleanText(
    grupo.nombreGrupo ||
    grupo.aliasGrupo ||
    [
      grupo.colegio ||
      grupo.cliente ||
      "",
      grupo.curso ||
      grupo.subgrupo ||
      ""
    ]
      .filter(Boolean)
      .join(" ") ||
    grupo.numeroNegocio ||
    grupo.id
  );
}

function getNumeroNegocio(grupo = {}) {
  return cleanText(
    grupo.numeroNegocio ||
    grupo.negocio_id ||
    grupo.numero ||
    ""
  );
}

function getDestino(grupo = {}) {
  return cleanText(
    grupo.destinoPrincipal ||
    grupo.destino ||
    ""
  );
}

function getEstadoEfectivo(encuesta = null) {
  if (!encuesta) {
    return "sin_crear";
  }

  const estado =
    normalizarTexto(
      encuesta.estado ||
      "borrador"
    );

  if (
    estado === "borrador" ||
    estado === "cerrada" ||
    estado === "anulada"
  ) {
    return estado;
  }

  const ahora =
    Date.now();

  const desde =
    encuesta.disponibleDesde?.toDate?.() ||
    (
      encuesta.disponibleDesde
        ? new Date(encuesta.disponibleDesde)
        : null
    );

  const hasta =
    encuesta.disponibleHasta?.toDate?.() ||
    (
      encuesta.disponibleHasta
        ? new Date(encuesta.disponibleHasta)
        : null
    );

  if (
    desde &&
    desde.getTime() > ahora
  ) {
    return "programada";
  }

  if (
    hasta &&
    hasta.getTime() < ahora
  ) {
    return "cerrada";
  }

  return estado || "activa";
}

function estadoLabel(estado = "") {
  const labels = {
    sin_crear: "Sin crear",
    borrador: "Borrador",
    programada: "Programada",
    activa: "Activa",
    cerrada: "Cerrada",
    anulada: "Anulada"
  };

  return labels[estado] || estado;
}

function mostrarMensaje(
  tipo,
  mensaje
) {
  const box =
    $("encMensaje");

  if (!box) return;

  box.className =
    `enc-alert ${tipo} open`;

  box.textContent =
    mensaje;
}

function ocultarMensaje() {
  const box =
    $("encMensaje");

  if (!box) return;

  box.className =
    "enc-alert";

  box.textContent =
    "";
}

function mostrarModalMensaje(
  tipo,
  mensaje
) {
  const box =
    $("modalMensaje");

  if (!box) return;

  box.className =
    `enc-alert ${tipo} open`;

  box.textContent =
    mensaje;
}

function ocultarModalMensaje() {
  const box =
    $("modalMensaje");

  if (!box) return;

  box.className =
    "enc-alert";

  box.textContent =
    "";
}

function setProgress(texto = "") {
  const el =
    $("encProgress");

  if (el) {
    el.textContent = texto;
  }
}

function progressSet(
  porcentaje,
  titulo,
  detalle = ""
) {
  setProgress(detalle || titulo);

  if (window.RaiProgress) {
    window.RaiProgress.set(
      porcentaje,
      titulo,
      detalle
    );
  }
}

function progressOk(detalle = "") {
  setProgress("");

  if (window.RaiProgress) {
    window.RaiProgress.ok(
      detalle ||
      "Proceso terminado."
    );
  }
}

function progressError(error) {
  setProgress("");

  if (window.RaiProgress) {
    window.RaiProgress.error(error);
  }
}

function fillSelect(
  element,
  values,
  placeholder = "Todos"
) {
  if (!element) {
    return;
  }

  const actual =
    element.value;

  element.innerHTML =
    `<option value="">${escapeHtml(placeholder)}</option>`;

  values.forEach(value => {
    const option =
      document.createElement("option");

    option.value =
      value;

    option.textContent =
      value;

    element.appendChild(option);
  });

  if (
    values.includes(actual)
  ) {
    element.value = actual;
  }
}

/* =========================================================
   LLAMADAS AL BACKEND
========================================================= */

async function getAuthToken() {
  const user =
    auth.currentUser;

  if (!user) {
    throw new Error(
      "Debe iniciar sesión nuevamente."
    );
  }

  return user.getIdToken();
}

async function postInterno(url, body = {}) {
  const token =
    await getAuthToken();

  const response =
    await fetch(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${token}`
        },

        body:
          JSON.stringify(body)
      }
    );

  let data = null;

  try {
    data =
      await response.json();
  } catch {
    data = null;
  }

  if (
    !response.ok ||
    !data?.ok
  ) {
    const detalle =
      Array.isArray(data?.errores)
        ? ` ${data.errores.join(" ")}`
        : "";

    throw new Error(
      `${data?.message || "La operación no pudo completarse."}${detalle}`
    );
  }

  return data;
}

/* =========================================================
   CARGA GENERAL
========================================================= */

async function cargarDatosBase() {
  progressSet(
    10,
    "Cargando encuestas...",
    "Leyendo grupos y encuestas"
  );

  const [
    gruposSnap,
    encuestasSnap
  ] = await Promise.all([
    getDocs(
      collection(db, "grupos")
    ),

    getDocs(
      collection(
        db,
        "encuestas_viaje"
      )
    )
  ]);

  state.grupos =
    gruposSnap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

  state.encuestas =
    encuestasSnap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

  const anos =
    [...new Set(
      state.grupos
        .map(g =>
          cleanText(g.anoViaje)
        )
        .filter(Boolean)
    )].sort();

  const destinos =
    [...new Set(
      state.grupos
        .map(getDestino)
        .filter(Boolean)
    )].sort(
      (a, b) =>
        a.localeCompare(b, "es")
    );

  fillSelect(
    $("fAno"),
    anos
  );

  fillSelect(
    $("fDestino"),
    destinos
  );

  fillSelect(
    $("configDestino"),
    destinos,
    "Seleccionar"
  );

  progressOk(
    "Información de encuestas cargada."
  );
}

function getEncuestaGrupo(grupoId) {
  const candidatas =
    state.encuestas
      .filter(
        encuesta =>
          cleanText(
            encuesta.grupoDocId
          ) === cleanText(grupoId)
      )
      .sort((a, b) => {
        const va =
          Number(a.version || 1);

        const vb =
          Number(b.version || 1);

        return vb - va;
      });

  return candidatas[0] || null;
}

/* =========================================================
   BÚSQUEDA Y TABLA
========================================================= */

function buscar() {
  ocultarMensaje();

  const textoGrupo =
    normalizarTexto(
      $("fGrupo")?.value
    );

  const codigo =
    normalizarTexto(
      $("fCodigo")?.value
    );

  const ano =
    cleanText(
      $("fAno")?.value
    );

  const destino =
    cleanText(
      $("fDestino")?.value
    );

  const estadoFiltro =
    cleanText(
      $("fEstado")?.value
    );

  const fechaDesde =
    toISO(
      $("fFechaInicio")?.value
    );

  const filas =
    state.grupos
      .map(grupo => {
        const encuesta =
          getEncuestaGrupo(
            grupo.id
          );

        return {
          grupo,
          encuesta,
          estado:
            getEstadoEfectivo(
              encuesta
            )
        };
      })
      .filter(({ grupo, estado }) => {
        if (
          textoGrupo &&
          !normalizarTexto(
            [
              getNombreGrupo(grupo),
              grupo.colegio,
              grupo.curso,
              grupo.aliasGrupo,
              grupo.nombreGrupo
            ]
              .filter(Boolean)
              .join(" ")
          ).includes(textoGrupo)
        ) {
          return false;
        }

        if (
          codigo &&
          !normalizarTexto(
            [
              getNumeroNegocio(grupo),
              grupo.id
            ].join(" ")
          ).includes(codigo)
        ) {
          return false;
        }

        if (
          ano &&
          cleanText(
            grupo.anoViaje
          ) !== ano
        ) {
          return false;
        }

        if (
          destino &&
          getDestino(grupo) !== destino
        ) {
          return false;
        }

        if (
          estadoFiltro &&
          estado !== estadoFiltro
        ) {
          return false;
        }

        if (
          fechaDesde &&
          toISO(grupo.fechaInicio) <
          fechaDesde
        ) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        const fa =
          toISO(
            a.grupo.fechaInicio
          ) || "9999-12-31";

        const fb =
          toISO(
            b.grupo.fechaInicio
          ) || "9999-12-31";

        if (fa !== fb) {
          return fa.localeCompare(fb);
        }

        return getNombreGrupo(a.grupo)
          .localeCompare(
            getNombreGrupo(b.grupo),
            "es"
          );
      });

  state.filas =
    filas;

  renderTabla(filas);
  actualizarKpis(filas);
}

function actualizarKpis(filas) {
  const activas =
    filas.filter(
      x => x.estado === "activa"
    ).length;

  const programadas =
    filas.filter(
      x => x.estado === "programada"
    ).length;

  const totalRespuestas =
    filas.reduce(
      (acc, x) =>
        acc +
        Number(
          x.encuesta
            ?.totalRespuestas ||
          0
        ),
      0
    );

  const totalParticipantes =
    filas.reduce(
      (acc, x) =>
        acc +
        Number(
          x.encuesta
            ?.totalParticipantes ||
          0
        ),
      0
    );

  const porcentaje =
    totalParticipantes
      ? Math.round(
          (
            totalRespuestas /
            totalParticipantes
          ) * 1000
        ) / 10
      : 0;

  $("kpiGrupos").textContent =
    filas.length;

  $("kpiActivas").textContent =
    activas;

  $("kpiProgramadas").textContent =
    programadas;

  $("kpiRespuestas").textContent =
    totalRespuestas;

  $("kpiAvance").textContent =
    `${porcentaje}%`;
}

function renderTabla(filas) {
  if (!tbodyEncuestas) {
    return;
  }

  if (!filas.length) {
    tbodyEncuestas.innerHTML = `
      <tr>
        <td
          colspan="9"
          class="enc-empty"
        >
          No se encontraron grupos con los filtros seleccionados.
        </td>
      </tr>
    `;

    $("countHint").textContent =
      "0 grupos encontrados.";

    return;
  }

  tbodyEncuestas.innerHTML =
    filas.map(({ grupo, encuesta, estado }) => {
      const total =
        Number(
          encuesta
            ?.totalParticipantes ||
          0
        );

      const respondieron =
        Number(
          encuesta
            ?.totalRespuestas ||
          0
        );

      const porcentaje =
        total
          ? Math.min(
              100,
              Math.round(
                respondieron /
                total *
                1000
              ) / 10
            )
          : 0;

      const accion =
        encuesta
          ? "Gestionar"
          : "Crear";

      return `
        <tr data-grupo-id="${escapeHtml(grupo.id)}">

          <td>
            ${formatDate(grupo.fechaInicio)}
          </td>

          <td>
            ${escapeHtml(grupo.anoViaje || "—")}
          </td>

          <td>
            <strong>
              ${escapeHtml(getNombreGrupo(grupo))}
            </strong>
          </td>

          <td>
            ${escapeHtml(getNumeroNegocio(grupo) || "—")}
          </td>

          <td>
            ${escapeHtml(getDestino(grupo) || "—")}
          </td>

          <td>
            <span class="enc-badge ${escapeHtml(estado)}">
              ${escapeHtml(estadoLabel(estado))}
            </span>
          </td>

          <td>
            ${respondieron} de ${total}
          </td>

          <td>
            <div class="enc-progress-track">
              <div
                class="enc-progress-value"
                style="width:${porcentaje}%"
              ></div>
            </div>

            <div class="enc-progress-label">
              ${porcentaje}%
            </div>
          </td>

          <td class="right">
            <div class="enc-actions">
              <button
                type="button"
                class="enc-btn primary small btnGestionarEncuesta"
              >
                ${accion}
              </button>
            </div>
          </td>

        </tr>
      `;
    }).join("");

  $("countHint").textContent =
    `${filas.length} grupo(s) encontrados.`;

  $("ultimaActualizacion").textContent =
    `Actualizado: ${
      new Date().toLocaleTimeString(
        "es-CL",
        {
          hour: "2-digit",
          minute: "2-digit"
        }
      )
    }`;

  tbodyEncuestas
    .querySelectorAll(
      ".btnGestionarEncuesta"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        async event => {
          const tr =
            event.currentTarget
              .closest("tr");

          const grupoId =
            tr?.dataset?.grupoId;

          if (!grupoId) {
            return;
          }

          await abrirGestionGrupo(
            grupoId
          );
        }
      );
    });
}

/* =========================================================
   ITINERARIO Y ACTIVIDADES
========================================================= */

function comienzaConPalabra(
  textoNormalizado,
  prefijo
) {
  return (
    textoNormalizado === prefijo ||
    textoNormalizado.startsWith(
      `${prefijo} `
    ) ||
    textoNormalizado.startsWith(
      `${prefijo}:`
    ) ||
    textoNormalizado.startsWith(
      `${prefijo} -`
    ) ||
    textoNormalizado.startsWith(
      `${prefijo} –`
    )
  );
}

function getMotivoOmisionAutomatica(
  nombre = ""
) {
  const texto =
    normalizarTexto(nombre);

  if (!texto) {
    return "";
  }

  const comidasHotel = [
    "desayuno hotel",
    "desayuno en hotel",
    "desayuno en el hotel",

    "almuerzo hotel",
    "almuerzo en hotel",
    "almuerzo en el hotel",

    "cena hotel",
    "cena en hotel",
    "cena en el hotel"
  ];

  if (
    comidasHotel.some(
      prefijo =>
        comienzaConPalabra(
          texto,
          prefijo
        )
    )
  ) {
    return (
      "Se evaluará dentro de la pregunta " +
      "de comidas del hotel."
    );
  }

  if (
    comienzaConPalabra(
      texto,
      "traslado"
    )
  ) {
    return (
      "Se evaluará dentro de la pregunta " +
      "general de transporte."
    );
  }

  if (
    comienzaConPalabra(
      texto,
      "salida"
    )
  ) {
    return (
      "Es un registro operativo y no corresponde " +
      "a una evaluación independiente."
    );
  }

  if (
    comienzaConPalabra(
      texto,
      "viaje a"
    )
  ) {
    return (
      "Es un registro operativo del desplazamiento " +
      "y no corresponde a una evaluación independiente."
    );
  }

  return "";
}

function esActividadOmitidaAutomaticamente(
  nombre = ""
) {
  return !!getMotivoOmisionAutomatica(
    nombre
  );
}

function extraerActividadesGrupo(
  grupo
) {
  const itinerario =
    grupo?.itinerario &&
    typeof grupo.itinerario === "object"
      ? grupo.itinerario
      : {};

  const actividades = [];
  const vistos = new Set();

  Object.entries(itinerario)
    .sort(
      ([a], [b]) =>
        toISO(a).localeCompare(
          toISO(b)
        )
    )
    .forEach(
      ([fechaRaw, raw]) => {
        const fecha =
          toISO(fechaRaw);

        const items =
          Array.isArray(raw)
            ? raw
            : (
                raw &&
                typeof raw === "object"
                  ? Object.values(raw)
                  : []
              );

        items.forEach(
          (item, index) => {
            if (!item) {
              return;
            }

            const nombre =
              cleanText(
                item.actividad ||
                item.servicio ||
                item.nombre ||
                item.titulo ||
                ""
              );

            if (!nombre) {
              return;
            }

            const actividadSlug =
              slug(nombre);

            if (
              !actividadSlug ||
              vistos.has(
                actividadSlug
              )
            ) {
              return;
            }

            vistos.add(
              actividadSlug
            );

            const motivoOmision =
              getMotivoOmisionAutomatica(
                nombre
              );

            const omitida =
              !!motivoOmision;

            actividades.push({
              id:
                cleanText(item.id) ||
                `actividad_${actividadSlug}`,

              slug:
                actividadSlug,

              nombre,

              fecha,

              horaInicio:
                cleanText(
                  item.horaInicio ||
                  item.hora ||
                  ""
                ),

              proveedor:
                cleanText(
                  item.proveedor ||
                  ""
                ),

              modalidad:
                omitida
                  ? "omitida_automatica"
                  : "sin_configurar",

              origenRegla:
                omitida
                  ? "automatica"
                  : "sin_configurar",

              guardarEn:
                omitida
                  ? "ninguno"
                  : "grupo",

              omitidaAutomaticamente:
                omitida,

              motivoOmision,

              orden:
                actividades.length +
                index
            });
          }
        );
      }
    );

  return actividades;
}

async function cargarProveedoresActividades(
  grupo,
  actividades
) {
  const destino =
    getDestino(grupo)
      .toUpperCase();

  const destinos = [];

  if (
    destino.includes("BRASIL")
  ) {
    destinos.push("BRASIL");
  }

  if (
    destino.includes("BARILOCHE")
  ) {
    destinos.push("BARILOCHE");
  }

  if (
    destino.includes("SUR DE CHILE")
  ) {
    destinos.push("SUR DE CHILE");
  }

  if (
    destino.includes("NORTE DE CHILE")
  ) {
    destinos.push("NORTE DE CHILE");
  }

  if (!destinos.length && destino) {
    destinos.push(destino);
  }

  const catalogo =
    new Map();

  for (const destinoKey of destinos) {
    try {
      const snap =
        await getDocs(
          collection(
            db,
            "Servicios",
            destinoKey,
            "Listado"
          )
        );

      snap.forEach(d => {
        const data =
          d.data() || {};

        const nombres = [
          data.servicio,
          data.nombre,
          d.id,
          ...(Array.isArray(data.aliases)
            ? data.aliases
            : [])
        ];

        nombres.forEach(nombre => {
          const key =
            slug(nombre);

          if (key) {
            catalogo.set(
              key,
              data
            );
          }
        });
      });
    } catch (error) {
      console.warn(
        "No se pudo leer catálogo",
        destinoKey,
        error
      );
    }
  }

  return actividades.map(item => {
    const catalogoItem =
      catalogo.get(item.slug);

    return {
      ...item,

      proveedor:
        item.proveedor ||
        cleanText(
          catalogoItem?.proveedor
        )
    };
  });
}

/* =========================================================
   REGLAS GLOBAL / DESTINO
========================================================= */

async function cargarReglas(
  destino
) {
  state.reglasGlobales =
    new Map();

  state.reglasDestino =
    new Map();

  try {
    const globalSnap =
      await getDocs(
        collection(
          db,
          "encuestas_config",
          "global",
          "actividades"
        )
      );

    globalSnap.forEach(d => {
      state.reglasGlobales.set(
        d.id,
        {
          id: d.id,
          ...d.data()
        }
      );
    });
  } catch (error) {
    console.warn(
      "No se pudieron cargar reglas globales",
      error
    );
  }

  const destinoSlug =
    slug(destino);

  if (!destinoSlug) {
    return;
  }

  try {
    const destinoSnap =
      await getDocs(
        collection(
          db,
          "encuestas_config_destinos",
          destinoSlug,
          "actividades"
        )
      );

    destinoSnap.forEach(d => {
      state.reglasDestino.set(
        d.id,
        {
          id: d.id,
          ...d.data()
        }
      );
    });
  } catch (error) {
    console.warn(
      "No se pudieron cargar reglas de destino",
      error
    );
  }
}

function aplicarReglas(
  actividades,
  encuesta
) {
  const configuracionGrupo =
    new Map(
      (
        encuesta?.actividades ||
        []
      )
        .filter(
          item =>
            (
              item.origenRegla ===
                "grupo" ||
              item.guardarEn ===
                "grupo"
            )
        )
        .map(
          item => [
            slug(
              item.slug ||
              item.nombre
            ),
            item
          ]
        )
    );

  return actividades.map(
    item => {
      /*
        Las omisiones automáticas tienen prioridad
        sobre cualquier regla antigua guardada.
      */
      if (
        item.omitidaAutomaticamente
      ) {
        return {
          ...item,
          modalidad:
            "omitida_automatica",
          origenRegla:
            "automatica",
          guardarEn:
            "ninguno"
        };
      }

      const key =
        item.slug;

      const grupoRegla =
        configuracionGrupo.get(
          key
        );

      if (grupoRegla) {
        return {
          ...item,
          ...grupoRegla,
          slug: key,
          omitidaAutomaticamente:
            false,
          motivoOmision: "",
          origenRegla:
            "grupo",
          guardarEn:
            "grupo"
        };
      }

      const destinoRegla =
        state.reglasDestino.get(
          key
        );

      if (destinoRegla) {
        return {
          ...item,
          modalidad:
            destinoRegla.modalidad,
          origenRegla:
            "destino",
          guardarEn:
            "destino"
        };
      }

      const globalRegla =
        state.reglasGlobales.get(
          key
        );

      if (globalRegla) {
        return {
          ...item,
          modalidad:
            globalRegla.modalidad,
          origenRegla:
            "global",
          guardarEn:
            "global"
        };
      }

      return {
        ...item,
        modalidad:
          "sin_configurar",
        origenRegla:
          "sin_configurar",
        guardarEn:
          "grupo"
      };
    }
  );
}

/* =========================================================
   HOTELES
========================================================= */

async function cargarHoteles(
  grupo
) {
  const asignacionesMap =
    new Map();

  function agregarAsignaciones(
    snap
  ) {
    snap.forEach(
      documento => {
        asignacionesMap.set(
          documento.id,
          {
            id:
              documento.id,
            ...documento.data()
          }
        );
      }
    );
  }

  try {
    const snap =
      await getDocs(
        query(
          collection(
            db,
            "hotelAssignments"
          ),
          where(
            "grupoId",
            "==",
            grupo.id
          )
        )
      );

    agregarAsignaciones(
      snap
    );
  } catch (error) {
    console.warn(
      "Búsqueda hotel por grupoId",
      error
    );
  }

  if (
    !asignacionesMap.size &&
    getNumeroNegocio(grupo)
  ) {
    try {
      const snap =
        await getDocs(
          query(
            collection(
              db,
              "hotelAssignments"
            ),
            where(
              "grupoNumero",
              "==",
              getNumeroNegocio(grupo)
            )
          )
        );

      agregarAsignaciones(
        snap
      );
    } catch (error) {
      console.warn(
        "Búsqueda hotel por negocio",
        error
      );
    }
  }

  const hotelesAgrupados =
    new Map();

  for (
    const asignacion of
    asignacionesMap.values()
  ) {
    let hotelData = null;

    const hotelId =
      cleanText(
        asignacion.hotelId ||
        asignacion.hotelDocId ||
        asignacion.hotel?.id ||
        ""
      );

    if (hotelId) {
      try {
        const snap =
          await getDoc(
            doc(
              db,
              "hoteles",
              hotelId
            )
          );

        if (snap.exists()) {
          hotelData = {
            id:
              snap.id,
            ...snap.data()
          };
        }
      } catch (error) {
        console.warn(
          "No se pudo leer hotel",
          hotelId,
          error
        );
      }
    }

    const nombre =
      cleanText(
        asignacion.hotelNombre ||
        asignacion.nombre ||
        hotelData?.nombre ||
        "Hotel"
      );

    const key =
      hotelId ||
      slug(nombre);

    const checkIn =
      toISO(
        asignacion.checkIn
      );

    const checkOut =
      toISO(
        asignacion.checkOut
      );

    const anterior =
      hotelesAgrupados.get(
        key
      );

    if (!anterior) {
      hotelesAgrupados.set(
        key,
        {
          key,
          hotelId,
          nombre,
          checkIn,
          checkOut
        }
      );

      continue;
    }

    if (
      checkIn &&
      (
        !anterior.checkIn ||
        checkIn < anterior.checkIn
      )
    ) {
      anterior.checkIn =
        checkIn;
    }

    if (
      checkOut &&
      (
        !anterior.checkOut ||
        checkOut > anterior.checkOut
      )
    ) {
      anterior.checkOut =
        checkOut;
    }
  }

  const preguntas = [];

  hotelesAgrupados.forEach(
    hotel => {
      let noches = 0;

      if (
        hotel.checkIn &&
        hotel.checkOut
      ) {
        noches =
          Math.max(
            0,
            Math.round(
              (
                new Date(
                  `${hotel.checkOut}T12:00:00`
                ) -
                new Date(
                  `${hotel.checkIn}T12:00:00`
                )
              ) /
              86400000
            )
          );
      }

      const baseSlug =
        slug(
          hotel.hotelId ||
          hotel.nombre
        );

      preguntas.push({
        id:
          `hotel_experiencia_${baseSlug}`,

        nombre:
          hotel.nombre,

        tipo:
          "hotel",

        subtipo:
          "experiencia_general",

        checkIn:
          hotel.checkIn,

        checkOut:
          hotel.checkOut,

        fechaInicio:
          hotel.checkIn,

        fechaFin:
          hotel.checkOut,

        noches,

        obligatorio: true
      });

      preguntas.push({
        id:
          `hotel_alimentacion_${baseSlug}`,

        nombre:
          hotel.nombre,

        tipo:
          "hotel",

        subtipo:
          "alimentacion",

        checkIn:
          hotel.checkIn,

        checkOut:
          hotel.checkOut,

        fechaInicio:
          hotel.checkIn,

        fechaFin:
          hotel.checkOut,

        noches,

        recordatorio:
          "Desayunos, almuerzos y cenas durante la estadía",

        obligatorio: true
      });
    }
  );

  return preguntas;
}

/* =========================================================
   TRANSPORTES
========================================================= */

async function cargarVuelosGrupo(grupo) {
  const encontrados =
    new Map();

  const agregar = snap => {
    snap.forEach(d => {
      encontrados.set(
        d.id,
        {
          id: d.id,
          ...d.data()
        }
      );
    });
  };

  const candidatos = [
    ["grupoIds", "array-contains", grupo.id],
    ["grupoId", "==", grupo.id],
    ["grupoDocId", "==", grupo.id]
  ];

  const numeroNegocio =
    getNumeroNegocio(grupo);

  if (numeroNegocio) {
    candidatos.push(
      [
        "grupoNumero",
        "==",
        numeroNegocio
      ]
    );

    const numero =
      Number(numeroNegocio);

    if (
      Number.isFinite(numero)
    ) {
      candidatos.push(
        [
          "grupoNumero",
          "==",
          numero
        ]
      );
    }
  }

  for (const [
    campo,
    operador,
    valor
  ] of candidatos) {
    try {
      const snap =
        await getDocs(
          query(
            collection(db, "vuelos"),
            where(
              campo,
              operador,
              valor
            )
          )
        );

      agregar(snap);
    } catch {
      // Compatibilidad con estructuras antiguas.
    }
  }

  return [...encontrados.values()];
}

function construirTransportes(
  vuelos
) {
  const lista =
    Array.isArray(vuelos)
      ? vuelos
      : [];

  const piernasAereas = [];
  let existeAereo = false;
  let existeTerrestrePrincipal = false;

  function esVerdadero(
    value
  ) {
    return (
      value === true ||
      value === 1 ||
      cleanText(value)
        .toLowerCase() ===
        "true"
    );
  }

  function agregarPiernaAerea({
    aerolinea,
    sentido,
    fecha
  }) {
    piernasAereas.push({
      aerolinea:
        cleanText(aerolinea) ||
        "Aerolínea",

      sentido:
        normalizarTexto(sentido),

      fecha:
        toISO(fecha)
    });
  }

  lista.forEach(
    vuelo => {
      const esTransfer =
        esVerdadero(
          vuelo.isTransfer
        ) ||
        [
          "ida",
          "vuelta",
          "ida+vuelta"
        ].includes(
          normalizarTexto(
            vuelo.transferLeg
          )
        );

      /*
        Los transfers no se convierten en preguntas
        individuales. Quedarán representados por
        BUSES DURANTE EL VIAJE.
      */
      if (esTransfer) {
        return;
      }

      const tipoTransporte =
        normalizarTexto(
          vuelo.tipoTransporte ||
          "aereo"
        );

      if (
        tipoTransporte &&
        tipoTransporte !== "aereo"
      ) {
        existeTerrestrePrincipal =
          true;

        return;
      }

      existeAereo = true;

      const proveedorPrincipal =
        cleanText(
          vuelo.proveedor ||
          vuelo.aerolinea ||
          vuelo.empresa ||
          ""
        );

      if (
        Array.isArray(
          vuelo.tramos
        ) &&
        vuelo.tramos.length
      ) {
        vuelo.tramos.forEach(
          tramo => {
            const aerolinea =
              cleanText(
                tramo.aerolinea ||
                tramo.proveedor ||
                proveedorPrincipal
              );

            const tipoTramo =
              normalizarTexto(
                tramo.tipoTramo
              );

            const fechaIda =
              toISO(
                tramo.fechaIda
              );

            const fechaVuelta =
              toISO(
                tramo.fechaVuelta
              );

            if (
              tipoTramo === "ida" ||
              tipoTramo === "ida+vuelta" ||
              (
                !tipoTramo &&
                fechaIda
              )
            ) {
              agregarPiernaAerea({
                aerolinea,
                sentido:
                  "ida",
                fecha:
                  fechaIda
              });
            }

            if (
              tipoTramo === "vuelta" ||
              tipoTramo === "ida+vuelta" ||
              (
                !tipoTramo &&
                fechaVuelta
              )
            ) {
              agregarPiernaAerea({
                aerolinea,
                sentido:
                  "vuelta",
                fecha:
                  fechaVuelta
              });
            }
          }
        );

        return;
      }

      if (
        toISO(
          vuelo.fechaIda
        )
      ) {
        agregarPiernaAerea({
          aerolinea:
            proveedorPrincipal,
          sentido:
            "ida",
          fecha:
            vuelo.fechaIda
        });
      }

      if (
        toISO(
          vuelo.fechaVuelta
        )
      ) {
        agregarPiernaAerea({
          aerolinea:
            proveedorPrincipal,
          sentido:
            "vuelta",
          fecha:
            vuelo.fechaVuelta
        });
      }
    }
  );

  const resultados = [];

  if (existeAereo) {
    const aerolineas =
      new Map();

    piernasAereas.forEach(
      pierna => {
        const key =
          slug(
            pierna.aerolinea
          ) ||
          "aerolinea";

        if (
          !aerolineas.has(key)
        ) {
          aerolineas.set(
            key,
            {
              key,
              nombre:
                pierna.aerolinea,
              sentidos:
                new Set(),
              fechas:
                []
            }
          );
        }

        const registro =
          aerolineas.get(key);

        if (pierna.sentido) {
          registro.sentidos.add(
            pierna.sentido
          );
        }

        if (pierna.fecha) {
          registro.fechas.push(
            pierna.fecha
          );
        }
      }
    );

    /*
      Si no se detectó la aerolínea, igualmente
      generamos una evaluación aérea general.
    */
    if (!aerolineas.size) {
      aerolineas.set(
        "aerolinea",
        {
          key:
            "aerolinea",
          nombre:
            "Aerolínea",
          sentidos:
            new Set([
              "ida",
              "vuelta"
            ]),
          fechas: []
        }
      );
    }

    aerolineas.forEach(
      aerolinea => {
        const tieneIda =
          aerolinea.sentidos.has(
            "ida"
          );

        const tieneVuelta =
          aerolinea.sentidos.has(
            "vuelta"
          );

        let subtipo =
          "aereo_general";

        let nombre =
          `Vuelos con ${aerolinea.nombre}`;

        let recordatorio =
          "Experiencia con la aerolínea";

        if (
          tieneIda &&
          tieneVuelta
        ) {
          subtipo =
            "ida_y_vuelta";

          nombre =
            `Vuelos con ${aerolinea.nombre}`;

          recordatorio =
            "Viaje de ida y regreso";
        } else if (tieneIda) {
          subtipo =
            "vuelo_ida";

          nombre =
            `Vuelo de ida con ${aerolinea.nombre}`;

          recordatorio =
            "Viaje de ida";
        } else if (tieneVuelta) {
          subtipo =
            "vuelo_regreso";

          nombre =
            `Vuelo de regreso con ${aerolinea.nombre}`;

          recordatorio =
            "Viaje de regreso";
        }

        resultados.push({
          id:
            `transporte_aereo_${aerolinea.key}`,

          tipo:
            "aereo",

          subtipo,

          nombre,

          aerolinea:
            aerolinea.nombre,

          fecha:
            aerolinea.fechas
              .filter(Boolean)
              .sort()[0] ||
            "",

          recordatorio,

          obligatorio: true
        });
      }
    );

    /*
      En todo viaje aéreo agregamos la evaluación
      general de los buses internos.
    */
    resultados.push({
      id:
        "transporte_buses_durante_viaje",

      tipo:
        "bus",

      subtipo:
        "buses_durante_viaje",

      nombre:
        "Buses durante el viaje",

      recordatorio:
        "Traslados realizados en el destino",

      obligatorio: true
    });

    return resultados;
  }

  if (
    existeTerrestrePrincipal
  ) {
    resultados.push({
      id:
        "transporte_bus_principal",

      tipo:
        "terrestre",

      subtipo:
        "bus_principal",

      nombre:
        "Bus principal",

      recordatorio:
        "Viaje de ida, recorrido principal y regreso",

      obligatorio: true
    });
  }

  return resultados;
}

/* =========================================================
   COORDINADORES
========================================================= */

async function cargarCoordinadores(
  grupo = {}
) {
  const grupoSeguro =
    grupo &&
    typeof grupo === "object"
      ? grupo
      : {};

  let ids =
    Array.isArray(
      grupoSeguro.coordinadorIds
    )
      ? grupoSeguro
          .coordinadorIds
          .map(
            item =>
              cleanText(item)
          )
          .filter(Boolean)
      : [];

  if (
    !ids.length &&
    cleanText(
      grupoSeguro.coordinadorId
    )
  ) {
    ids = [
      cleanText(
        grupoSeguro.coordinadorId
      )
    ];
  }

  /*
    Evitamos consultar dos veces un mismo ID.
  */
  ids = [
    ...new Set(ids)
  ];

  const coordinadores =
    [];

  const vistos =
    new Set();

  for (
    const id of
    ids
  ) {
    try {
      const snap =
        await getDoc(
          doc(
            db,
            "coordinadores",
            id
          )
        );

      if (
        !snap.exists()
      ) {
        continue;
      }

      const data =
        snap.data() ||
        {};

      const nombre =
        cleanText(
          data.nombre ||
          data.nombreCompleto ||
          data.name ||
          snap.id
        );

      if (!nombre) {
        continue;
      }

      const key =
        normalizarTexto(
          nombre
        );

      if (
        vistos.has(key)
      ) {
        continue;
      }

      vistos.add(
        key
      );

      coordinadores.push({
        id:
          `coordinador_${snap.id}`,

        coordinadorId:
          snap.id,

        idOriginal:
          snap.id,

        nombre,

        tipo:
          "coordinador",

        subtipo:
          "coordinador",

        modalidad:
          "obligatoria",

        obligatorio:
          true
      });

    } catch (error) {
      console.warn(
        "No se pudo leer el coordinador",
        id,
        error
      );
    }
  }

  /*
    Compatibilidad con estructuras antiguas donde
    se guardaba el coordinador completo o solamente
    su nombre dentro del documento del grupo.

    Primero eliminamos null, undefined y strings vacíos.
  */
  const valoresLegacy = [
    ...(
      Array.isArray(
        grupoSeguro.coordinadores
      )
        ? grupoSeguro.coordinadores
        : []
    ),

    grupoSeguro.coordinador
  ].filter(
    item =>
      item !== null &&
      item !== undefined &&
      (
        typeof item === "object" ||
        cleanText(item)
      )
  );

  const nombresLegacy =
    valoresLegacy
      .map(
        item => {
          if (
            item &&
            typeof item ===
              "object"
          ) {
            return cleanText(
              item.nombre ||
              item.nombreCompleto ||
              item.name ||
              ""
            );
          }

          return cleanText(
            item
          );
        }
      )
      .filter(Boolean);

  nombresLegacy.forEach(
    nombre => {
      const key =
        normalizarTexto(
          nombre
        );

      if (
        !key ||
        vistos.has(key)
      ) {
        return;
      }

      vistos.add(
        key
      );

      coordinadores.push({
        id:
          `coordinador_${slug(nombre)}`,

        coordinadorId:
          "",

        idOriginal:
          "",

        nombre,

        tipo:
          "coordinador",

        subtipo:
          "coordinador",

        modalidad:
          "obligatoria",

        obligatorio:
          true
      });
    }
  );

  /*
    Si no existe ninguna asignación, devolvemos [].
    Esto NO es un error y NO bloquea la encuesta.
  */
  return coordinadores;
}

/* =========================================================
   ABRIR GESTIÓN
========================================================= */

function normalizarModalidadServicio(
  value = ""
) {
  return normalizarTexto(value) ===
    "excluida"
      ? "excluida"
      : "obligatoria";
}

function prepararServicioEvaluable(
  item = {},
  modalidadDefault =
    "obligatoria"
) {
  const modalidad =
    normalizarModalidadServicio(
      item.modalidad ||
      (
        item.obligatorio === false
          ? "excluida"
          : modalidadDefault
      )
    );

  return {
    ...item,

    modalidad,

    obligatorio:
      modalidad ===
      "obligatoria"
  };
}

function getClaveServicio(
  item = {}
) {
  const id =
    cleanText(
      item.id
    );

  if (id) {
    return id;
  }

  return [
    slug(item.tipo),
    slug(item.subtipo),
    slug(item.nombre)
  ]
    .filter(Boolean)
    .join("|");
}

function getClaveAlternativaServicio(
  item = {}
) {
  return [
    slug(item.tipo),
    slug(item.subtipo),
    slug(item.nombre)
  ]
    .filter(Boolean)
    .join("|");
}

function combinarServiciosDetectados(
  detectados = [],
  guardados = []
) {
  const configuracionPorId =
    new Map();

  const configuracionPorNombre =
    new Map();

  (
    Array.isArray(guardados)
      ? guardados
      : []
  ).forEach(
    item => {
      const preparado =
        prepararServicioEvaluable(
          item
        );

      const keyId =
        getClaveServicio(
          preparado
        );

      const keyNombre =
        getClaveAlternativaServicio(
          preparado
        );

      if (keyId) {
        configuracionPorId.set(
          keyId,
          preparado
        );
      }

      if (keyNombre) {
        configuracionPorNombre.set(
          keyNombre,
          preparado
        );
      }
    }
  );

  const resultado =
    (
      Array.isArray(detectados)
        ? detectados
        : []
    ).map(
      item => {
        const keyId =
          getClaveServicio(
            item
          );

        const keyNombre =
          getClaveAlternativaServicio(
            item
          );

        const guardado =
          configuracionPorId.get(
            keyId
          ) ||
          configuracionPorNombre.get(
            keyNombre
          );

        return prepararServicioEvaluable({
          ...item,

          modalidad:
            guardado?.modalidad ||
            item.modalidad,

          obligatorio:
            guardado
              ? guardado.obligatorio
              : item.obligatorio
        });
      }
    );

  const vistos =
    new Set(
      resultado.flatMap(
        item => [
          getClaveServicio(item),
          getClaveAlternativaServicio(
            item
          )
        ].filter(Boolean)
      )
    );

  /*
    Conservamos elementos históricos que ya estaban
    guardados solamente cuando no existe un equivalente
    actualmente detectado.
  */
  (
    Array.isArray(guardados)
      ? guardados
      : []
  ).forEach(
    item => {
      const keyId =
        getClaveServicio(
          item
        );

      const keyNombre =
        getClaveAlternativaServicio(
          item
        );

      if (
        vistos.has(keyId) ||
        vistos.has(keyNombre)
      ) {
        return;
      }

      resultado.push(
        prepararServicioEvaluable(
          item
        )
      );

      if (keyId) {
        vistos.add(keyId);
      }

      if (keyNombre) {
        vistos.add(keyNombre);
      }
    }
  );

  return resultado;
}

function contarServiciosPorModalidad(
  lista = [],
  modalidad = "obligatoria"
) {
  return (
    Array.isArray(lista)
      ? lista
      : []
  ).filter(
    item =>
      normalizarModalidadServicio(
        item.modalidad ||
        (
          item.obligatorio === false
            ? "excluida"
            : "obligatoria"
        )
      ) === modalidad
  ).length;
}

async function abrirGestionGrupo(
  grupoId
) {
  const grupo =
    state.grupos.find(
      item =>
        item.id ===
        grupoId
    );

  if (!grupo) {
    return;
  }

  try {
    progressSet(
      10,
      "Preparando encuesta...",
      "Leyendo actividades y servicios"
    );

    state.grupoActual =
      grupo;

    state.encuestaActual =
      getEncuestaGrupo(
        grupo.id
      );

    state.seguimiento =
      null;

    state.resultados =
      {};

    state.comentarios = {
      positivos: [],
      mejoras: [],
      generales: []
    };

    state.modalidadCoordinadorPendiente =
      normalizarModalidadServicio(
        state.encuestaActual
          ?.modalidadCoordinadorPendiente ||
        "obligatoria"
      );

    state.asistenciaMedica = {
      modalidad:
        normalizarModalidadServicio(
          state.encuestaActual
            ?.asistenciaMedica
            ?.modalidad ||
          "obligatoria"
        )
    };

    await cargarReglas(
      getDestino(grupo)
    );

    let actividades =
      extraerActividadesGrupo(
        grupo
      );

    actividades =
      await cargarProveedoresActividades(
        grupo,
        actividades
      );

    state.actividades =
      aplicarReglas(
        actividades,
        state.encuestaActual
      );

    const [
      hotelesDetectados,
      vuelos,
      coordinadoresDetectados
    ] = await Promise.all([
      cargarHoteles(grupo),
      cargarVuelosGrupo(grupo),
      cargarCoordinadores(grupo)
    ]);

    const transportesDetectados =
      construirTransportes(
        vuelos
      );

    state.hoteles =
      combinarServiciosDetectados(
        hotelesDetectados,
        state.encuestaActual
          ?.hoteles ||
        []
      );

    state.transportes =
      combinarServiciosDetectados(
        transportesDetectados,
        state.encuestaActual
          ?.transportes ||
        []
      );

    const tieneRespuestas =
      Number(
        state.encuestaActual
          ?.totalRespuestas ||
        0
      ) > 0;

    /*
      Mientras no haya respuestas usamos la asignación
      vigente. Cuando ya existen respuestas mantenemos
      la fotografía guardada para no mezclar resultados
      de coordinadores diferentes.
    */
    state.coordinadores =
      tieneRespuestas
        ? combinarServiciosDetectados(
            state.encuestaActual
              ?.coordinadores ||
            [],
            state.encuestaActual
              ?.coordinadores ||
            []
          )
        : combinarServiciosDetectados(
            coordinadoresDetectados,
            state.encuestaActual
              ?.coordinadores ||
            []
          );

    /*
      Un coordinador nuevo usa la modalidad definida
      cuando aún no existía una asignación.
    */
    state.coordinadores =
      state.coordinadores.map(
        item =>
          prepararServicioEvaluable(
            item,
            state
              .modalidadCoordinadorPendiente
          )
      );

    configurarModalGrupo();

    modalEncuesta
      .classList.add(
        "open"
      );

    modalEncuesta
      .setAttribute(
        "aria-hidden",
        "false"
      );

    if (
      state.encuestaActual
    ) {
      await cargarGestionActual();
    }

    progressOk(
      "Encuesta preparada."
    );

  } catch (error) {
    console.error(
      error
    );

    progressError(
      error
    );

    mostrarMensaje(
      "error",
      error.message ||
      "No fue posible preparar la encuesta."
    );
  }
}

function configurarModalGrupo() {
  const grupo =
    state.grupoActual;

  const encuesta =
    state.encuestaActual;

  const estado =
    getEstadoEfectivo(encuesta);

  $("modalEncuestaTitulo").textContent =
    encuesta
      ? "Gestionar encuesta"
      : "Crear encuesta";

  $("modalEncuestaSubtitulo").textContent =
    getNombreGrupo(grupo);

  $("resumenGrupo").textContent =
    getNombreGrupo(grupo);

  $("resumenNegocio").textContent =
    getNumeroNegocio(grupo) ||
    "—";

  $("resumenDestino").textContent =
    getDestino(grupo) ||
    "—";

  $("resumenInicio").textContent =
    formatDate(
      grupo.fechaInicio
    );

  $("resumenFin").textContent =
    formatDate(
      grupo.fechaFin
    );

  $("resumenEstado").innerHTML = `
    <span class="enc-badge ${escapeHtml(estado)}">
      ${escapeHtml(estadoLabel(estado))}
    </span>
  `;

  $("cantidadAleatorias").value =
    Number(
      encuesta
        ?.cantidadAleatoriasPorPersona ??
      3
    );

  const fechaInicio =
    toISO(
      grupo.fechaInicio
    );

  const fechaFin =
    toISO(
      grupo.fechaFin
    );

  /*
    Apertura automática sugerida:
    penúltimo día a las 08:00.
  */
  const aperturaSugerida =
    fechaFin
      ? `${sumarDiasISO(fechaFin, -1)}T08:00`
      : "";

  /*
    Cierre sugerido:
    dos días después del regreso, a las 23:59.
  */
  const cierreSugerido =
    fechaFin
      ? `${sumarDiasISO(fechaFin, 2)}T23:59`
      : "";

  $("disponibleDesde").value =
    fechaHoraLocalInput(
      encuesta?.disponibleDesde
    ) ||
    aperturaSugerida;

  $("disponibleHasta").value =
    fechaHoraLocalInput(
      encuesta?.disponibleHasta
    ) ||
    cierreSugerido;

  const enlace =
    encuesta?.tokenPublico
      ? construirEnlacePublico(
          encuesta.tokenPublico
        )
      : "";

  $("enlaceEncuesta").value =
    enlace;

  $("btnCopiarEnlace").disabled =
    !enlace;

  $("btnAbrirEnlace").disabled =
    !enlace;

  renderActividades();
  renderServicios();
  actualizarResumenPreguntas();
  actualizarBotonesEstado();
  activarPanel("configuracion");
}

function construirEnlacePublico(token) {
  const url =
    new URL(
      "./encuesta.html",
      window.location.href
    );

  url.searchParams.set(
    "token",
    token
  );

  return url.toString();
}

/* =========================================================
   ACTIVIDADES
========================================================= */

function renderActividades() {
  const tbody =
    $("tbodyActividades");

  if (
    !state.actividades.length
  ) {
    tbody.innerHTML = `
      <tr>
        <td
          colspan="6"
          class="enc-empty"
        >
          El grupo no tiene actividades registradas
          en el itinerario.
        </td>
      </tr>
    `;

    return;
  }

  tbody.innerHTML =
    state.actividades
      .map(
        (item, index) => {
          const omitida =
            item.modalidad ===
              "omitida_automatica" ||
            item.omitidaAutomaticamente;

          return `
            <tr
              data-index="${index}"
              class="${
                omitida
                  ? "enc-activity-omitted"
                  : ""
              }"
            >

              <td>
                ${formatDate(item.fecha)}
              </td>

              <td>
                <strong>
                  ${escapeHtml(
                    cleanText(
                      item.nombre
                    ).toUpperCase()
                  )}
                </strong>

                ${
                  omitida &&
                  item.motivoOmision
                    ? `
                      <div class="enc-origin">
                        ${escapeHtml(item.motivoOmision)}
                      </div>
                    `
                    : ""
                }
              </td>

              <td>
                ${escapeHtml(item.proveedor || "—")}
              </td>

              <td>
                ${
                  omitida
                    ? `
                      <span class="enc-auto-rule">
                        Omitida automáticamente
                      </span>
                    `
                    : `
                      <select class="actividadModalidad">

                        <option
                          value="sin_configurar"
                          ${
                            item.modalidad ===
                            "sin_configurar"
                              ? "selected"
                              : ""
                          }
                        >
                          Sin configurar
                        </option>

                        <option
                          value="obligatoria"
                          ${
                            item.modalidad ===
                            "obligatoria"
                              ? "selected"
                              : ""
                          }
                        >
                          Obligatoria
                        </option>

                        <option
                          value="aleatoria"
                          ${
                            item.modalidad ===
                            "aleatoria"
                              ? "selected"
                              : ""
                          }
                        >
                          Aleatoria
                        </option>

                        <option
                          value="excluida"
                          ${
                            item.modalidad ===
                            "excluida"
                              ? "selected"
                              : ""
                          }
                        >
                          Excluida
                        </option>

                      </select>
                    `
                }
              </td>

              <td>
                <span class="enc-origin">
                  ${
                    omitida
                      ? "Automática"
                      : escapeHtml(
                          item.origenRegla ||
                          "—"
                        )
                  }
                </span>
              </td>

              <td>
                ${
                  omitida
                    ? `
                      <span class="enc-origin">
                        No requiere configuración
                      </span>
                    `
                    : `
                      <select class="actividadGuardarEn">

                        <option
                          value="grupo"
                          ${
                            item.guardarEn ===
                            "grupo"
                              ? "selected"
                              : ""
                          }
                        >
                          Solo este grupo
                        </option>

                        <option
                          value="destino"
                          ${
                            item.guardarEn ===
                            "destino"
                              ? "selected"
                              : ""
                          }
                        >
                          ${
                            escapeHtml(
                              getDestino(
                                state.grupoActual
                              ) ||
                              "Destino"
                            )
                          }
                        </option>

                        <option
                          value="global"
                          ${
                            item.guardarEn ===
                            "global"
                              ? "selected"
                              : ""
                          }
                        >
                          Todos los destinos
                        </option>

                      </select>
                    `
                }
              </td>

            </tr>
          `;
        }
      )
      .join("");

  tbody
    .querySelectorAll(
      "tr[data-index]"
    )
    .forEach(
      tr => {
        const index =
          Number(
            tr.dataset.index
          );

        const item =
          state.actividades[index];

        if (
          !item ||
          item.omitidaAutomaticamente
        ) {
          return;
        }

        const modalidad =
          tr.querySelector(
            ".actividadModalidad"
          );

        const guardarEn =
          tr.querySelector(
            ".actividadGuardarEn"
          );

        modalidad?.addEventListener(
          "change",
          () => {
            item.modalidad =
              modalidad.value;

            /*
              Si el usuario cambia una regla heredada,
              inicialmente la consideramos excepción
              particular del grupo.
            */
            if (
              item.origenRegla !==
              "grupo"
            ) {
              guardarEn.value =
                "grupo";

              item.guardarEn =
                "grupo";
            }

            item.origenRegla =
              item.guardarEn;

            actualizarResumenPreguntas();
          }
        );

        guardarEn?.addEventListener(
          "change",
          () => {
            item.guardarEn =
              guardarEn.value;

            item.origenRegla =
              guardarEn.value;
          }
        );
      }
    );
}

function actualizarResumenPreguntas() {
  const obligatorias =
    state.actividades.filter(
      item =>
        item.modalidad ===
        "obligatoria"
    ).length;

  const aleatorias =
    state.actividades.filter(
      item =>
        item.modalidad ===
        "aleatoria"
    ).length;

  const excluidas =
    state.actividades.filter(
      item =>
        item.modalidad ===
        "excluida"
    ).length;

  const sinConfigurar =
    state.actividades.filter(
      item =>
        item.modalidad ===
          "sin_configurar"
    ).length;

  const omitidas =
    state.actividades.filter(
      item =>
        item.modalidad ===
          "omitida_automatica" ||
        item.omitidaAutomaticamente
    ).length;

  $("cantidadObligatorias").textContent =
    obligatorias;

  $("cantidadAleatoriasDetectadas").textContent =
    aleatorias;

  $("cantidadExcluidas").textContent =
    excluidas;

  $("cantidadSinConfigurar").textContent =
    sinConfigurar;

  if (
    $("cantidadOmitidas")
  ) {
    $("cantidadOmitidas").textContent =
      omitidas;
  }

  const cantidadPorPersona =
    Math.max(
      0,
      Number(
        $("cantidadAleatorias")
          ?.value ||
        0
      )
    );

  const aleatoriasReales =
    Math.min(
      cantidadPorPersona,
      aleatorias
    );

  const hotelesIncluidos =
    contarServiciosPorModalidad(
      state.hoteles,
      "obligatoria"
    );

  const transportesIncluidos =
    contarServiciosPorModalidad(
      state.transportes,
      "obligatoria"
    );

  const coordinadoresIncluidos =
    contarServiciosPorModalidad(
      state.coordinadores,
      "obligatoria"
    );

  const asistenciaIncluida =
    state.asistenciaMedica
      .modalidad ===
      "obligatoria";

  /*
    Preguntas fijas para todos:

    - 1 evaluación general del viaje.
    - Actividades obligatorias.
    - Actividades aleatorias asignadas.
    - Hoteles y alimentación.
    - Transportes.
    - Coordinadores.
    - 1 pregunta inicial de asistencia médica,
      cuando está incluida.

    La evaluación de la atención médica es
    condicional y no se suma como pregunta fija.
  */
  const evaluacionGeneral =
    1;

  const preguntasAsistencia =
    asistenciaIncluida
      ? 1
      : 0;

  const total =
    evaluacionGeneral +
    obligatorias +
    aleatoriasReales +
    hotelesIncluidos +
    transportesIncluidos +
    coordinadoresIncluidos +
    preguntasAsistencia;

  if (sinConfigurar) {
    $("resumenCargaPasajero").textContent =
      (
        `Quedan ${sinConfigurar} actividades sin configurar. ` +
        `Se omitieron automáticamente ${omitidas}. ` +
        "No se puede publicar todavía."
      );

    return;
  }

  const desglose = [
    `${evaluacionGeneral} evaluación general`,

    `${obligatorias} ${
      obligatorias === 1
        ? "actividad obligatoria"
        : "actividades obligatorias"
    }`,

    `${aleatoriasReales} ${
      aleatoriasReales === 1
        ? "actividad aleatoria"
        : "actividades aleatorias"
    }`,

    `${hotelesIncluidos} ${
      hotelesIncluidos === 1
        ? "evaluación de hotel o alimentación"
        : "evaluaciones de hotel o alimentación"
    }`,

    `${transportesIncluidos} ${
      transportesIncluidos === 1
        ? "evaluación de transporte"
        : "evaluaciones de transporte"
    }`,

    `${coordinadoresIncluidos} ${
      coordinadoresIncluidos === 1
        ? "evaluación de coordinación"
        : "evaluaciones de coordinación"
    }`,

    `${preguntasAsistencia} ${
      preguntasAsistencia === 1
        ? "pregunta inicial de asistencia médica"
        : "preguntas de asistencia médica"
    }`
  ];

  $("resumenCargaPasajero").textContent =
    (
      `Cada pasajero responderá inicialmente ${total} preguntas: ` +
      `${desglose.join(", ")}. ` +
      (
        asistenciaIncluida
          ? "Si utilizó la asistencia médica y desea evaluarla, se habilitará la evaluación de la atención recibida."
          : "La asistencia médica está excluida."
      )
    );
}

/* =========================================================
   SERVICIOS
========================================================= */

function renderListaServicio(
  containerId,
  lista,
  categoria = ""
) {
  const container =
    $(containerId);

  const elementos =
    Array.isArray(lista)
      ? lista
      : [];

  if (!elementos.length) {
    container.innerHTML = `
      <div class="enc-empty">
        Sin información registrada.
      </div>
    `;

    return;
  }

  container.innerHTML =
    elementos
      .map(
        (item, index) => {
          const nombreBase =
            cleanText(
              item.nombre ||
              "—"
            );

          const subtipo =
            normalizarTexto(
              item.subtipo ||
              ""
            );

          let nombreMostrar =
            nombreBase;

          if (
            categoria ===
            "hotel"
          ) {
            nombreMostrar =
              (
                subtipo.includes(
                  "aliment"
                ) ||
                subtipo.includes(
                  "comida"
                )
              )
                ? `COMIDAS EN ${nombreBase}`
                : `EXPERIENCIA GENERAL EN ${nombreBase}`;
          }

          if (
            categoria ===
            "coordinador"
          ) {
            nombreMostrar =
              `COORDINACIÓN DE ${nombreBase}`;
          }

          return `
            <div
              class="enc-result-card enc-service-config"
              data-service-index="${index}"
            >

              <div>
                <strong class="enc-service-name">
                  ${escapeHtml(
                    nombreMostrar
                      .toUpperCase()
                  )}
                </strong>

                ${
                  item.recordatorio
                    ? `
                      <div class="enc-muted">
                        ${escapeHtml(
                          item.recordatorio
                        )}
                      </div>
                    `
                    : ""
                }

                ${
                  item.fechaInicio ||
                  item.checkIn
                    ? `
                      <div class="enc-muted">
                        ${
                          formatDate(
                            item.fechaInicio ||
                            item.checkIn
                          )
                        }
                        ${
                          item.fechaFin ||
                          item.checkOut
                            ? ` al ${
                                formatDate(
                                  item.fechaFin ||
                                  item.checkOut
                                )
                              }`
                            : ""
                        }
                      </div>
                    `
                    : ""
                }
              </div>

              <select
                class="servicioModalidad"
                aria-label="Modalidad de ${escapeHtml(nombreMostrar)}"
              >
                <option
                  value="obligatoria"
                  ${
                    normalizarModalidadServicio(
                      item.modalidad
                    ) ===
                    "obligatoria"
                      ? "selected"
                      : ""
                  }
                >
                  Obligatoria
                </option>

                <option
                  value="excluida"
                  ${
                    normalizarModalidadServicio(
                      item.modalidad
                    ) ===
                    "excluida"
                      ? "selected"
                      : ""
                  }
                >
                  Excluida
                </option>
              </select>

            </div>
          `;
        }
      )
      .join("");

  container
    .querySelectorAll(
      "[data-service-index]"
    )
    .forEach(
      card => {
        const index =
          Number(
            card.dataset
              .serviceIndex
          );

        const select =
          card.querySelector(
            ".servicioModalidad"
          );

        select?.addEventListener(
          "change",
          () => {
            const item =
              elementos[index];

            if (!item) {
              return;
            }

            item.modalidad =
              normalizarModalidadServicio(
                select.value
              );

            item.obligatorio =
              item.modalidad ===
              "obligatoria";

            actualizarResumenPreguntas();
          }
        );
      }
    );
}

function renderServicios() {
  const sinCoordinadores =
    !state.coordinadores.length;

  $("avisoCoordinadorPendiente")
    ?.classList.toggle(
      "open",
      sinCoordinadores
    );

  $("configCoordinadorPendiente")
    ?.classList.toggle(
      "hidden",
      !sinCoordinadores
    );

  if (
    $("modalidadCoordinadorPendiente")
  ) {
    $("modalidadCoordinadorPendiente")
      .value =
      state
        .modalidadCoordinadorPendiente;
  }

  if (
    $("modalidadAsistenciaMedica")
  ) {
    $("modalidadAsistenciaMedica")
      .value =
      state.asistenciaMedica
        .modalidad;
  }

  renderListaServicio(
    "listaHoteles",
    state.hoteles,
    "hotel"
  );

  renderListaServicio(
    "listaTransportes",
    state.transportes,
    "transporte"
  );

  renderListaServicio(
    "listaCoordinadores",
    state.coordinadores,
    "coordinador"
  );
}

/* =========================================================
   GUARDAR REGLAS
========================================================= */

async function guardarReglasSeleccionadas() {
  const batch =
    writeBatch(db);

  let operaciones = 0;

  for (
    const actividad of
    state.actividades
  ) {
    const modalidad =
      actividad.modalidad;

    if (
      actividad.omitidaAutomaticamente ||
      modalidad ===
        "omitida_automatica" ||
      modalidad ===
        "sin_configurar"
    ) {
      continue;
    }

    const key =
      actividad.slug ||
      slug(
        actividad.nombre
      );

    const data = {
      nombre:
        actividad.nombre,

      slug:
        key,

      modalidad,

      actualizadoEn:
        new Date().toISOString(),

      destino:
        getDestino(
          state.grupoActual
        )
    };

    if (
      actividad.guardarEn ===
      "global"
    ) {
      batch.set(
        doc(
          db,
          "encuestas_config",
          "global",
          "actividades",
          key
        ),
        data,
        {
          merge: true
        }
      );

      operaciones += 1;
    }

    if (
      actividad.guardarEn ===
      "destino"
    ) {
      batch.set(
        doc(
          db,
          "encuestas_config_destinos",
          slug(
            getDestino(
              state.grupoActual
            )
          ),
          "actividades",
          key
        ),
        data,
        {
          merge: true
        }
      );

      operaciones += 1;
    }
  }

  if (operaciones > 0) {
    await batch.commit();
  }
}

/* =========================================================
   GUARDAR BORRADOR
========================================================= */

function construirPayloadEncuesta() {
  const grupo =
    state.grupoActual;

  const actividadesEvaluables =
    state.actividades.map(
      item => ({
        id:
          item.id,

        slug:
          item.slug,

        nombre:
          item.nombre,

        fecha:
          item.fecha,

        horaInicio:
          item.horaInicio,

        proveedor:
          item.proveedor,

        modalidad:
          item.modalidad,

        origenRegla:
          item.guardarEn ||
          item.origenRegla ||
          "grupo",

        guardarEn:
          item.guardarEn ||
          "grupo",

        omitidaAutomaticamente:
          !!item
            .omitidaAutomaticamente,

        motivoOmision:
          item.motivoOmision ||
          ""
      })
    );

  const excepcionesGrupo =
    actividadesEvaluables.filter(
      item =>
        item.guardarEn ===
          "grupo" &&
        !item
          .omitidaAutomaticamente &&
        item.modalidad !==
          "sin_configurar"
    );

  const prepararLista =
    lista =>
      (
        Array.isArray(lista)
          ? lista
          : []
      ).map(
        item =>
          prepararServicioEvaluable(
            item
          )
      );

  return {
    encuestaId:
      state.encuestaActual?.id ||
      "",

    grupoDocId:
      grupo.id,

    idGrupoVentas:
      cleanText(
        state.encuestaActual
          ?.idGrupoVentas ||
        grupo.idGrupoVentas ||
        grupo.idGrupo ||
        ""
      ),

    numeroNegocio:
      getNumeroNegocio(
        grupo
      ),

    colegio:
      cleanText(
        grupo.colegio ||
        grupo.cliente
      ),

    curso:
      cleanText(
        grupo.curso ||
        grupo.subgrupo
      ),

    destino:
      getDestino(
        grupo
      ),

    programa:
      cleanText(
        grupo.programa
      ),

    anoViaje:
      grupo.anoViaje ||
      "",

    fechaInicio:
      toISO(
        grupo.fechaInicio
      ),

    fechaFin:
      toISO(
        grupo.fechaFin
      ),

    cantidadAleatoriasPorPersona:
      Math.max(
        0,
        Number(
          $("cantidadAleatorias")
            ?.value ||
          0
        )
      ),

    actividades:
      actividadesEvaluables,

    excepcionesActividades:
      excepcionesGrupo,

    hoteles:
      prepararLista(
        state.hoteles
      ),

    transportes:
      prepararLista(
        state.transportes
      ),

    coordinadores:
      prepararLista(
        state.coordinadores
      ),

    modalidadCoordinadorPendiente:
      state
        .modalidadCoordinadorPendiente,

    asistenciaMedica: {
      modalidad:
        state.asistenciaMedica
          .modalidad
    },

    escalaEvaluacion: {
      minimo: 1,
      maximo: 5,

      etiquetas: {
        1: "Muy malo",
        2: "Malo",
        3: "Regular",
        4: "Bueno",
        5: "Excelente"
      }
    }
  };
}

async function guardarBorrador() {
  try {
    ocultarModalMensaje();

    progressSet(
      20,
      "Guardando encuesta...",
      "Guardando configuración"
    );

    const payload =
      construirPayloadEncuesta();

    await guardarReglasSeleccionadas();

    const respuesta =
      await postInterno(
        FUNCTION_URLS.guardar,
        payload
      );

    const encuestaSnap =
      await getDoc(
        doc(
          db,
          "encuestas_viaje",
          respuesta.encuestaId
        )
      );

    state.encuestaActual =
      encuestaSnap.exists()
        ? {
            id:
              encuestaSnap.id,
            ...encuestaSnap.data()
          }
        : {
            id:
              respuesta.encuestaId,
            ...payload,
            estado:
              "borrador"
          };

    reemplazarEncuestaState(
      state.encuestaActual
    );

    configurarModalGrupo();

    mostrarModalMensaje(
      "ok",
      "El borrador fue guardado correctamente."
    );

    progressOk(
      "Borrador guardado."
    );

    buscar();

    return state.encuestaActual;

  } catch (error) {
    console.error(error);

    progressError(error);

    mostrarModalMensaje(
      "error",
      error.message
    );

    throw error;
  }
}

function reemplazarEncuestaState(encuesta) {
  state.encuestas =
    state.encuestas.filter(
      item =>
        item.id !== encuesta.id
    );

  state.encuestas.push(
    encuesta
  );
}

async function refrescarEncuestaActual() {
  if (
    !state.encuestaActual?.id
  ) {
    return null;
  }

  const snap =
    await getDoc(
      doc(
        db,
        "encuestas_viaje",
        state.encuestaActual.id
      )
    );

  if (!snap.exists()) {
    return null;
  }

  state.encuestaActual = {
    id: snap.id,
    ...snap.data()
  };

  reemplazarEncuestaState(
    state.encuestaActual
  );

  return state.encuestaActual;
}

/* =========================================================
   PUBLICAR
========================================================= */

async function publicarEncuesta() {
  try {
    const sinConfigurar =
      state.actividades.filter(
        item =>
          item.modalidad ===
          "sin_configurar"
      );

    if (sinConfigurar.length) {
      mostrarModalMensaje(
        "error",
        `Debes configurar las ${sinConfigurar.length} actividades pendientes antes de publicar.`
      );

      activarPanel(
        "actividades"
      );

      return;
    }

    const aleatorias =
      state.actividades.filter(
        item =>
          item.modalidad ===
          "aleatoria"
      ).length;

    const cantidad =
      Number(
        document
          .querySelector(
            "#panel-configuracion input#cantidadAleatorias"
          )
          ?.value ||
        0
      );

    if (cantidad > aleatorias) {
      mostrarModalMensaje(
        "error",
        `Solicitaste ${cantidad} actividades aleatorias por persona, pero solamente hay ${aleatorias} disponibles.`
      );

      return;
    }

    if (
      !confirm(
        "¿Publicar esta encuesta y preparar toda la nómina del grupo?"
      )
    ) {
      return;
    }

    let encuesta =
      state.encuestaActual;

    if (!encuesta) {
      encuesta =
        await guardarBorrador();
    }

    progressSet(
      55,
      "Publicando encuesta...",
      "Preparando participantes de la nómina"
    );

    const respuesta =
      await postInterno(
        FUNCTION_URLS.publicar,
        {
          encuestaId:
            encuesta.id,

          disponibleDesde:
            $("disponibleDesde")
              .value
              ? new Date(
                  $("disponibleDesde").value
                ).toISOString()
              : "",

          disponibleHasta:
            $("disponibleHasta")
              .value
              ? new Date(
                  $("disponibleHasta").value
                ).toISOString()
              : ""
        }
      );

    const snap =
      await getDoc(
        doc(
          db,
          "encuestas_viaje",
          encuesta.id
        )
      );

    state.encuestaActual = {
      id: snap.id,
      ...snap.data()
    };

    reemplazarEncuestaState(
      state.encuestaActual
    );

    configurarModalGrupo();
    await cargarGestionActual();

    mostrarModalMensaje(
      "ok",
      `Encuesta ${estadoLabel(respuesta.estado).toLowerCase()}. Nómina habilitada: ${respuesta.resumenNomina.totalHabilitados}.`
    );

    progressOk(
      "Encuesta publicada."
    );

    buscar();

  } catch (error) {
    console.error(error);

    progressError(error);

    mostrarModalMensaje(
      "error",
      error.message
    );
  }
}

async function guardarCambiosEncuesta() {
  if (
    !state.encuestaActual?.id
  ) {
    return;
  }

  try {
    ocultarModalMensaje();

    const disponibleDesdeRaw =
      $("disponibleDesde")?.value ||
      "";

    const disponibleHastaRaw =
      $("disponibleHasta")?.value ||
      "";

    if (
      !disponibleDesdeRaw
    ) {
      mostrarModalMensaje(
        "error",
        "Debes indicar la fecha y hora de apertura."
      );

      return;
    }

    if (
      disponibleHastaRaw &&
      new Date(disponibleHastaRaw).getTime() <=
      new Date(disponibleDesdeRaw).getTime()
    ) {
      mostrarModalMensaje(
        "error",
        "La fecha de cierre debe ser posterior a la fecha de apertura."
      );

      return;
    }

    const sinConfigurar =
      state.actividades.filter(
        item =>
          item.modalidad ===
          "sin_configurar"
      );

    if (sinConfigurar.length) {
      mostrarModalMensaje(
        "error",
        `Existen ${sinConfigurar.length} actividades sin configurar.`
      );

      activarPanel(
        "actividades"
      );

      return;
    }

    const aleatoriasDisponibles =
      state.actividades.filter(
        item =>
          item.modalidad ===
          "aleatoria"
      ).length;

    const cantidadAleatorias =
      Math.max(
        0,
        Number(
          $("cantidadAleatorias")?.value ||
          0
        )
      );

    if (
      cantidadAleatorias >
      aleatoriasDisponibles
    ) {
      mostrarModalMensaje(
        "error",
        `Solicitaste ${cantidadAleatorias} actividades aleatorias, pero solamente existen ${aleatoriasDisponibles}.`
      );

      return;
    }

    progressSet(
      35,
      "Guardando cambios...",
      "Actualizando configuración de la encuesta"
    );

    await guardarReglasSeleccionadas();

    const payload =
      construirPayloadEncuesta();

    const respuesta =
      await postInterno(
        FUNCTION_URLS.actualizar,
        {
          ...payload,

          encuestaId:
            state.encuestaActual.id,

          disponibleDesde:
            new Date(
              disponibleDesdeRaw
            ).toISOString(),

          disponibleHasta:
            disponibleHastaRaw
              ? new Date(
                  disponibleHastaRaw
                ).toISOString()
              : ""
        }
      );

    await refrescarEncuestaActual();

    configurarModalGrupo();

    if (
      respuesta.configuracionBloqueada ===
      true
    ) {
      mostrarModalMensaje(
        "ok",
        "Las fechas fueron actualizadas. Las preguntas no se modificaron porque la encuesta ya tiene respuestas."
      );
    } else {
      mostrarModalMensaje(
        "ok",
        respuesta.estado === "activa"
          ? "Cambios guardados. La encuesta está activa."
          : "Los cambios fueron guardados correctamente."
      );
    }

    await cargarGestionActual();

    progressOk(
      "Cambios guardados."
    );

    buscar();

  } catch (error) {
    console.error(error);

    progressError(error);

    mostrarModalMensaje(
      "error",
      error.message ||
      "No fue posible guardar los cambios."
    );
  }
}

async function reiniciarEncuesta() {
  if (
    !state.encuestaActual?.id
  ) {
    return;
  }

  const clave =
    prompt(
      "Esta acción eliminará todas las respuestas y dejará nuevamente a toda la nómina como pendiente.\n\nIngresa la clave para continuar:"
    );

  if (clave === null) {
    return;
  }

  const confirmacion =
    prompt(
      "Para confirmar definitivamente, escribe REINICIAR:"
    );

  if (
    cleanText(confirmacion)
      .toUpperCase() !==
    "REINICIAR"
  ) {
    mostrarModalMensaje(
      "error",
      "El reinicio fue cancelado porque la confirmación no coincide."
    );

    return;
  }

  try {
    progressSet(
      30,
      "Reiniciando encuesta...",
      "Eliminando respuestas y restaurando participantes"
    );

    const respuesta =
      await postInterno(
        FUNCTION_URLS.reiniciar,
        {
          encuestaId:
            state.encuestaActual.id,

          clave,

          confirmacion:
            "REINICIAR"
        }
      );

    await refrescarEncuestaActual();
    await cargarGestionActual();

    configurarModalGrupo();

    mostrarModalMensaje(
      "ok",
      `Encuesta reiniciada. Se eliminaron ${respuesta.respuestasEliminadas} respuestas y ${respuesta.participantesRestaurados} integrantes quedaron pendientes.`
    );

    progressOk(
      "Encuesta reiniciada."
    );

    buscar();

  } catch (error) {
    console.error(error);

    progressError(error);

    mostrarModalMensaje(
      "error",
      error.message ||
      "No fue posible reiniciar la encuesta."
    );
  }
}

/* =========================================================
   CERRAR / REABRIR
========================================================= */

async function cambiarEstado(estado) {
  if (
    !state.encuestaActual
  ) {
    return;
  }

  const mensaje =
    estado === "cerrada"
      ? "¿Cerrar la encuesta? El enlace dejará de aceptar respuestas."
      : "¿Reabrir la encuesta para quienes todavía están pendientes?";

  if (!confirm(mensaje)) {
    return;
  }

  try {
    progressSet(
      40,
      "Actualizando encuesta...",
      "Cambiando estado"
    );

    await postInterno(
      FUNCTION_URLS.cambiarEstado,
      {
        encuestaId:
          state.encuestaActual.id,

        estado
      }
    );

    state.encuestaActual = {
      ...state.encuestaActual,
      estado
    };

    reemplazarEncuestaState(
      state.encuestaActual
    );

    configurarModalGrupo();

    mostrarModalMensaje(
      "ok",
      estado === "cerrada"
        ? "La encuesta fue cerrada."
        : "La encuesta fue reabierta."
    );

    progressOk(
      "Estado actualizado."
    );

    buscar();

  } catch (error) {
    console.error(error);

    progressError(error);

    mostrarModalMensaje(
      "error",
      error.message
    );
  }
}

function actualizarBotonesEstado() {
  const estado =
    getEstadoEfectivo(
      state.encuestaActual
    );

  const existeEncuesta =
    !!state.encuestaActual?.id;

  const esBorrador =
    estado === "borrador" ||
    estado === "sin_crear";

  const estaPublicada =
    estado === "activa" ||
    estado === "programada";

  const estaCerrada =
    estado === "cerrada";

  const estaAnulada =
    estado === "anulada";

  $("btnGuardarBorrador")
    ?.classList.toggle(
      "hidden",
      !esBorrador
    );

  $("btnPublicarEncuesta")
    ?.classList.toggle(
      "hidden",
      !esBorrador
    );

  $("btnGuardarCambios")
    ?.classList.toggle(
      "hidden",
      !existeEncuesta ||
      esBorrador ||
      estaAnulada
    );

  $("btnCerrarEncuesta")
    ?.classList.toggle(
      "hidden",
      !estaPublicada
    );

  $("btnReabrirEncuesta")
    ?.classList.toggle(
      "hidden",
      !estaCerrada
    );

  $("btnReiniciarEncuesta")
    ?.classList.toggle(
      "hidden",
      !existeEncuesta ||
      esBorrador ||
      estaAnulada
    );

  /*
    Si ya existen respuestas, las fechas continúan
    editables, pero el backend protegerá las preguntas.
  */
  const tieneRespuestas =
    Number(
      state.encuestaActual
        ?.totalRespuestas ||
      0
    ) > 0;

  $("cantidadAleatorias").disabled =
    tieneRespuestas;

  document
    .querySelectorAll(
      ".actividadModalidad, .actividadGuardarEn"
    )
    .forEach(element => {
      element.disabled =
        tieneRespuestas;
    });

  document
    .querySelectorAll(
      ".servicioModalidad"
    )
    .forEach(
      element => {
        element.disabled =
          tieneRespuestas;
      }
    );

  if (
    $("modalidadCoordinadorPendiente")
  ) {
    $("modalidadCoordinadorPendiente")
      .disabled =
      tieneRespuestas;
  }

  if (
    $("modalidadAsistenciaMedica")
  ) {
    $("modalidadAsistenciaMedica")
      .disabled =
      tieneRespuestas;
  }
}

/* =========================================================
   SEGUIMIENTO Y RESULTADOS
========================================================= */

async function cargarGestionActual() {
  if (
    !state.encuestaActual?.id
  ) {
    return;
  }

  try {
    const respuesta =
      await postInterno(
        FUNCTION_URLS.gestion,
        {
          encuestaId:
            state.encuestaActual.id
        }
      );

    state.seguimiento =
      respuesta.seguimiento;

    state.resultados =
      respuesta.resultados || {};

    state.resultadosAsistenciaMedica =
      respuesta.asistenciaMedica || {
        utilizaron: 0,
        evaluaron: 0,
        puntuaciones: {
          1: 0,
          2: 0,
          3: 0,
          4: 0,
          5: 0
        },
        total: 0,
        suma: 0,
        promedio: 0,
        comentarios: []
      };

    state.comentarios =
      respuesta.comentarios || {
        positivos: [],
        mejoras: [],
        generales: []
      };

    state.encuestaActual = {
      ...state.encuestaActual,
      ...respuesta.encuesta
    };

    reemplazarEncuestaState(
      state.encuestaActual
    );

    renderSeguimiento();
    renderResultados();

  } catch (error) {
    console.error(
      "No se pudo cargar seguimiento",
      error
    );

    mostrarModalMensaje(
      "error",
      error.message
    );
  }
}

function renderSeguimiento() {
  const seguimiento =
    state.seguimiento || {
      total: 0,
      respondieron: 0,
      pendientes: 0,
      porcentaje: 0,
      participantes: []
    };

  $("seguimientoTotal").textContent =
    seguimiento.total || 0;

  $("seguimientoRespondieron").textContent =
    seguimiento.respondieron || 0;

  $("seguimientoPendientes").textContent =
    seguimiento.pendientes || 0;

  $("seguimientoPorcentaje").textContent =
    `${seguimiento.porcentaje || 0}%`;

  const filtro =
    $("filtroSeguimiento")?.value ||
    "";

  let participantes =
    seguimiento.participantes ||
    [];

  if (filtro === "respondida") {
    participantes =
      participantes.filter(
        x => x.respondio
      );
  }

  if (filtro === "pendiente") {
    participantes =
      participantes.filter(
        x => !x.respondio
      );
  }

  if (
    [
      "estudiante",
      "adulto",
      "profesor"
    ].includes(
      filtro
    )
  ) {
    participantes =
      participantes.filter(
        participante =>
          normalizarTexto(
            participante.tipoPasajero
          ) === filtro
      );
  }

  const tbody =
    $("tbodySeguimiento");

  if (!participantes.length) {
    tbody.innerHTML = `
      <tr>
        <td
          colspan="4"
          class="enc-empty"
        >
          No hay pasajeros para el filtro seleccionado.
        </td>
      </tr>
    `;

    return;
  }

  tbody.innerHTML =
    participantes.map(item => `
      <tr>

        <td>
          <strong>
            ${escapeHtml(item.nombre || "—")}
          </strong>
        </td>

        <td>
          ${escapeHtml(
            String(
              item.documentoNormalizado ||
              ""
            )
              .replace(/^RUT_/, "")
          )}
        </td>

        <td>
          ${escapeHtml(
            item.tipoPasajero ||
            "—"
          )}
        </td>

        <td>
          ${
            item.respondio
              ? `
                <span class="enc-badge activa">
                  Respondida
                </span>
              `
              : `
                <span class="enc-badge programada">
                  Pendiente
                </span>
              `
          }
        </td>

      </tr>
    `).join("");
}

function getPreguntaNombre(
  preguntaId
) {
  if (
    preguntaId ===
    "general:viaje"
  ) {
    return (
      "EVALUACIÓN GENERAL DEL VIAJE"
    );
  }

  const separador =
    preguntaId.indexOf(":");

  const tipo =
    separador >= 0
      ? preguntaId.slice(
          0,
          separador
        )
      : "";

  const id =
    separador >= 0
      ? preguntaId.slice(
          separador + 1
        )
      : preguntaId;

  const listas = {
    actividad:
      state.actividades,

    hotel:
      state.hoteles,

    transporte:
      state.transportes,

    coordinador:
      state.coordinadores
  };

  const item =
    listas[tipo]
      ?.find(
        registro =>
          registro.id === id ||
          registro.preguntaId ===
            preguntaId
      );

  if (!item) {
    return cleanText(
      preguntaId
    ).toUpperCase();
  }

  const nombre =
    cleanText(
      item.nombre
    );

  const subtipo =
    normalizarTexto(
      item.subtipo
    );

  if (
    tipo === "hotel" &&
    (
      subtipo.includes(
        "aliment"
      ) ||
      subtipo.includes(
        "comida"
      )
    )
  ) {
    return (
      `COMIDAS EN ${nombre}`
    ).toUpperCase();
  }

  if (
    tipo === "hotel"
  ) {
    return (
      `EXPERIENCIA GENERAL EN ${nombre}`
    ).toUpperCase();
  }

  if (
    tipo === "coordinador"
  ) {
    return (
      `COORDINACIÓN DE ${nombre}`
    ).toUpperCase();
  }

  return (
    nombre ||
    preguntaId
  ).toUpperCase();
}

function renderResultadosAsistenciaMedica() {
  const section =
    $("resultadosAsistenciaMedica");

  if (!section) {
    return;
  }

  const configuracionIncluida =
    state.asistenciaMedica
      ?.modalidad ===
    "obligatoria";

  const data =
    state.resultadosAsistenciaMedica ||
    {};

  const tieneDatos =
    Number(
      data.utilizaron ||
      0
    ) > 0 ||
    Number(
      data.evaluaron ||
      0
    ) > 0 ||
    (
      Array.isArray(
        data.comentarios
      ) &&
      data.comentarios.length >
      0
    );

  section.classList.toggle(
    "hidden",
    !configuracionIncluida &&
    !tieneDatos
  );

  if (
    $("asistenciaUtilizaron")
  ) {
    $("asistenciaUtilizaron")
      .textContent =
      Number(
        data.utilizaron ||
        0
      );
  }

  if (
    $("asistenciaEvaluaron")
  ) {
    $("asistenciaEvaluaron")
      .textContent =
      Number(
        data.evaluaron ||
        0
      );
  }

  if (
    $("asistenciaPromedio")
  ) {
    $("asistenciaPromedio")
      .textContent =
      Number(
        data.evaluaron ||
        0
      )
        ? `${
            Number(
              data.promedio ||
              0
            ).toFixed(2)
          } ★`
        : "—";
  }

  const distribucion =
    $("distribucionAsistencia");

  if (
    distribucion
  ) {
    distribucion.innerHTML =
      [1, 2, 3, 4, 5]
        .map(
          valor => `
            <div class="enc-result-value">
              <strong>
                ${
                  Number(
                    data
                      .puntuaciones
                      ?.[valor] ||
                    0
                  )
                }
              </strong>

              <span>
                ${valor} ${
                  valor === 1
                    ? "estrella"
                    : "estrellas"
                }
              </span>
            </div>
          `
        )
        .join("");
  }

  renderComentarios(
    "comentariosAsistencia",
    data.comentarios ||
    []
  );
}

function renderResultados() {
  const container =
    $("listaResultados");

  const entries =
    Object.entries(
      state.resultados ||
      {}
    );

  if (!entries.length) {
    container.className =
      "enc-empty";

    container.textContent =
      "Todavía no existen respuestas.";
  } else {
    container.className = "";

    container.innerHTML =
      entries.map(
        ([preguntaId, dataRaw]) => {
          const data =
            dataRaw ||
            {};

          /*
            Compatibilidad:
            - Backend nuevo: data["1"] ... data["5"]
            - Backend alternativo: data.puntuaciones
            - Respuestas antiguas de cuatro opciones
          */
          const puntuaciones =
            data.puntuaciones ||
            {};

          const valor1 =
            Number(
              puntuaciones["1"] ??
              data["1"] ??
              data.uno ??
              data.muy_malo ??
              0
            );

          const valor2 =
            Number(
              puntuaciones["2"] ??
              data["2"] ??
              data.dos ??
              data.malo ??
              0
            );

          const valor3 =
            Number(
              puntuaciones["3"] ??
              data["3"] ??
              data.tres ??
              data.regular ??
              0
            );

          const valor4 =
            Number(
              puntuaciones["4"] ??
              data["4"] ??
              data.cuatro ??
              data.bueno ??
              0
            );

          const valor5 =
            Number(
              puntuaciones["5"] ??
              data["5"] ??
              data.cinco ??
              data.excelente ??
              data.muy_bueno ??
              0
            );

          const total =
            Number(
              data.total
            ) ||
            (
              valor1 +
              valor2 +
              valor3 +
              valor4 +
              valor5
            );

          const promedioCalculado =
            total
              ? (
                  (
                    valor1 * 1 +
                    valor2 * 2 +
                    valor3 * 3 +
                    valor4 * 4 +
                    valor5 * 5
                  ) /
                  total
                )
              : 0;

          const promedio =
            Number(
              data.promedio ??
              promedioCalculado
            );

          return `
            <div class="enc-result-card">

              <h5>
                ${escapeHtml(
                  getPreguntaNombre(
                    preguntaId
                  )
                )}
              </h5>

              <div class="enc-stars-summary">
                ${
                  promedio
                    ? `${promedio.toFixed(1)} ★`
                    : "Sin promedio"
                }
              </div>

              <div class="enc-result-grid">

                ${resultadoCelda(
                  "1 estrella",
                  valor1
                )}

                ${resultadoCelda(
                  "2 estrellas",
                  valor2
                )}

                ${resultadoCelda(
                  "3 estrellas",
                  valor3
                )}

                ${resultadoCelda(
                  "4 estrellas",
                  valor4
                )}

                ${resultadoCelda(
                  "5 estrellas",
                  valor5
                )}

                ${resultadoCelda(
                  "Total",
                  total
                )}

              </div>

            </div>
          `;
        }
      ).join("");
  }

  renderComentarios(
    "comentariosPositivos",
    state.comentarios
      ?.positivos
  );

  renderComentarios(
    "comentariosMejoras",
    state.comentarios
      ?.mejoras
  );

  renderComentarios(
    "comentariosGenerales",
    state.comentarios
      ?.generales
  );

  renderResultadosAsistenciaMedica();
}

function resultadoCelda(
  label,
  value
) {
  return `
    <div class="enc-result-value">
      <strong>
        ${Number(value || 0)}
      </strong>

      <span>
        ${escapeHtml(label)}
      </span>
    </div>
  `;
}

function renderComentarios(
  containerId,
  comentarios
) {
  const container =
    $(containerId);

  const lista =
    Array.isArray(comentarios)
      ? comentarios.filter(Boolean)
      : [];

  if (!lista.length) {
    container.className =
      "enc-empty";

    container.textContent =
      "Sin comentarios.";

    return;
  }

  container.className = "";

  container.innerHTML =
    lista.map(
      comentario => `
        <div class="enc-comment">
          ${escapeHtml(comentario)}
        </div>
      `
    ).join("");
}

/* =========================================================
   PESTAÑAS Y MODALES
========================================================= */

function activarPanel(nombre) {
  document
    .querySelectorAll(".enc-tab")
    .forEach(tab => {
      tab.classList.toggle(
        "active",
        tab.dataset.panel === nombre
      );
    });

  document
    .querySelectorAll(".enc-panel")
    .forEach(panel => {
      panel.classList.toggle(
        "active",
        panel.id ===
        `panel-${nombre}`
      );
    });

  if (
    nombre === "seguimiento"
  ) {
    renderSeguimiento();
  }

  if (
    nombre === "resultados"
  ) {
    renderResultados();
  }
}

function cerrarModalEncuesta() {
  modalEncuesta
    .classList.remove("open");

  modalEncuesta
    .setAttribute(
      "aria-hidden",
      "true"
    );
}

/* =========================================================
   CONFIGURACIÓN GLOBAL
========================================================= */

async function abrirConfigGlobal() {
  modalConfigGlobal
    .classList.add("open");

  modalConfigGlobal
    .setAttribute(
      "aria-hidden",
      "false"
    );

  await renderConfigGlobal();
}

function cerrarConfigGlobal() {
  modalConfigGlobal
    .classList.remove("open");

  modalConfigGlobal
    .setAttribute(
      "aria-hidden",
      "true"
    );
}

async function getReglasNivelActual() {
  const nivel =
    $("configNivel").value;

  if (nivel === "global") {
    const snap =
      await getDocs(
        collection(
          db,
          "encuestas_config",
          "global",
          "actividades"
        )
      );

    return snap.docs.map(d => ({
      id: d.id,
      nivel: "global",
      ...d.data()
    }));
  }

  const destino =
    $("configDestino").value;

  if (!destino) {
    return [];
  }

  const snap =
    await getDocs(
      collection(
        db,
        "encuestas_config_destinos",
        slug(destino),
        "actividades"
      )
    );

  return snap.docs.map(d => ({
    id: d.id,
    nivel: "destino",
    destino,
    ...d.data()
  }));
}

async function renderConfigGlobal() {
  const tbody =
    $("tbodyConfigGlobal");

  const buscarTexto =
    normalizarTexto(
      $("configBuscarActividad")
        .value
    );

  const reglas =
    (await getReglasNivelActual())
      .filter(
        item =>
          !buscarTexto ||
          normalizarTexto(
            item.nombre
          ).includes(buscarTexto)
      )
      .sort(
        (a, b) =>
          cleanText(a.nombre)
            .localeCompare(
              cleanText(b.nombre),
              "es"
            )
      );

  if (!reglas.length) {
    tbody.innerHTML = `
      <tr>
        <td
          colspan="5"
          class="enc-empty"
        >
          No existen reglas configuradas para esta selección.
        </td>
      </tr>
    `;

    return;
  }

  tbody.innerHTML =
    reglas.map(item => `
      <tr>

        <td>
          <strong>
            ${escapeHtml(item.nombre)}
          </strong>
        </td>

        <td>
          ${escapeHtml(item.destino || "Todos")}
        </td>

        <td>
          ${escapeHtml(estadoModalidadLabel(item.modalidad))}
        </td>

        <td>
          ${escapeHtml(item.actualizadoEn || "—")}
        </td>

        <td class="right">
          <button
            type="button"
            class="enc-btn secondary small btnEditarRegla"
            data-id="${escapeHtml(item.id)}"
          >
            Editar
          </button>
        </td>

      </tr>
    `).join("");

  tbody
    .querySelectorAll(
      ".btnEditarRegla"
    )
    .forEach(button => {
      button.addEventListener(
        "click",
        async () => {
          const regla =
            reglas.find(
              item =>
                item.id ===
                button.dataset.id
            );

          if (regla) {
            await editarRegla(
              regla
            );
          }
        }
      );
    });
}

function estadoModalidadLabel(value) {
  return {
    obligatoria: "Obligatoria",
    aleatoria: "Aleatoria",
    excluida: "Excluida"
  }[value] || value;
}

async function nuevaRegla() {
  const nombre =
    prompt(
      "Nombre exacto de la actividad:"
    );

  if (!cleanText(nombre)) {
    return;
  }

  const modalidad =
    prompt(
      "Escribe: obligatoria, aleatoria o excluida"
    );

  const valor =
    normalizarTexto(
      modalidad
    );

  if (
    ![
      "obligatoria",
      "aleatoria",
      "excluida"
    ].includes(valor)
  ) {
    alert(
      "La modalidad no es válida."
    );

    return;
  }

  await guardarReglaManual(
    cleanText(nombre),
    valor
  );

  await renderConfigGlobal();
}

async function editarRegla(regla) {
  const modalidad =
    prompt(
      "Nueva modalidad: obligatoria, aleatoria o excluida",
      regla.modalidad
    );

  const valor =
    normalizarTexto(
      modalidad
    );

  if (
    ![
      "obligatoria",
      "aleatoria",
      "excluida"
    ].includes(valor)
  ) {
    return;
  }

  await guardarReglaManual(
    regla.nombre,
    valor
  );

  await renderConfigGlobal();
}

async function guardarReglaManual(
  nombre,
  modalidad
) {
  const nivel =
    $("configNivel").value;

  let referencia = null;
  let destino = "";

  if (nivel === "global") {
    referencia =
      doc(
        db,
        "encuestas_config",
        "global",
        "actividades",
        slug(nombre)
      );
  } else {
    destino =
      $("configDestino").value;

    if (!destino) {
      alert(
        "Selecciona un destino."
      );

      return;
    }

    referencia =
      doc(
        db,
        "encuestas_config_destinos",
        slug(destino),
        "actividades",
        slug(nombre)
      );
  }

  await setDoc(
    referencia,
    {
      nombre,
      modalidad,
      destino,
      actualizadoEn:
        new Date().toISOString()
    },
    {
      merge: true
    }
  );
}

/* =========================================================
   EVENTOS
========================================================= */

function conectarEventos() {
  $("btnBuscar")
    ?.addEventListener(
      "click",
      buscar
    );

  $("btnActualizar")
    ?.addEventListener(
      "click",
      async () => {
        await cargarDatosBase();
        buscar();
      }
    );

  $("btnLimpiar")
    ?.addEventListener(
      "click",
      () => {
        [
          "fGrupo",
          "fCodigo",
          "fAno",
          "fDestino",
          "fEstado",
          "fFechaInicio"
        ].forEach(id => {
          if ($(id)) {
            $(id).value = "";
          }
        });

        buscar();
      }
    );

  [
    "fGrupo",
    "fCodigo"
  ].forEach(id => {
    $(id)?.addEventListener(
      "keyup",
      event => {
        if (
          event.key === "Enter"
        ) {
          buscar();
        }
      }
    );
  });

  document
    .querySelectorAll(".enc-tab")
    .forEach(tab => {
      tab.addEventListener(
        "click",
        () => {
          activarPanel(
            tab.dataset.panel
          );
        }
      );
    });

  $("btnCerrarModalEncuesta")
    ?.addEventListener(
      "click",
      cerrarModalEncuesta
    );

  $("btnCerrarModalAbajo")
    ?.addEventListener(
      "click",
      cerrarModalEncuesta
    );

  modalEncuesta
    ?.addEventListener(
      "click",
      event => {
        if (
          event.target ===
          modalEncuesta
        ) {
          cerrarModalEncuesta();
        }
      }
    );

  $("btnGuardarBorrador")
    ?.addEventListener(
      "click",
      guardarBorrador
    );

  $("btnPublicarEncuesta")
    ?.addEventListener(
      "click",
      publicarEncuesta
    );

  $("btnGuardarCambios")
    ?.addEventListener(
      "click",
      guardarCambiosEncuesta
    );

  $("btnReiniciarEncuesta")
    ?.addEventListener(
      "click",
      reiniciarEncuesta
    );

  $("btnCerrarEncuesta")
    ?.addEventListener(
      "click",
      () =>
        cambiarEstado(
          "cerrada"
        )
    );

  $("btnReabrirEncuesta")
    ?.addEventListener(
      "click",
      () =>
        cambiarEstado(
          "activa"
        )
    );

  $("btnCopiarEnlace")
    ?.addEventListener(
      "click",
      async () => {
        const enlace =
          $("enlaceEncuesta").value;

        if (!enlace) return;

        await navigator
          .clipboard
          .writeText(enlace);

        mostrarModalMensaje(
          "ok",
          "Enlace copiado."
        );
      }
    );

  $("btnAbrirEnlace")
    ?.addEventListener(
      "click",
      () => {
        const enlace =
          $("enlaceEncuesta").value;

        if (enlace) {
          window.open(
            enlace,
            "_blank",
            "noopener"
          );
        }
      }
    );

  document
    .querySelector(
      "#panel-configuracion input#cantidadAleatorias"
    )
    ?.addEventListener(
      "input",
      actualizarResumenPreguntas
    );

  $("btnAplicarAleatoriaTodas")
    ?.addEventListener(
      "click",
      () => {
        state.actividades =
          state.actividades.map(
            item =>
              item.modalidad ===
                "sin_configurar" &&
              !item.omitidaAutomaticamente
                ? {
                    ...item,
        
                    modalidad:
                      "aleatoria",
        
                    origenRegla:
                      "grupo",
        
                    guardarEn:
                      "grupo"
                  }
                : item
          );
        
        renderActividades();
        actualizarResumenPreguntas();
      }
    );

  $("filtroSeguimiento")
    ?.addEventListener(
      "change",
      renderSeguimiento
    );

  $("btnConfigGlobal")
    ?.addEventListener(
      "click",
      abrirConfigGlobal
    );

  $("btnCerrarConfigGlobal")
    ?.addEventListener(
      "click",
      cerrarConfigGlobal
    );

  $("btnCerrarConfigGlobalAbajo")
    ?.addEventListener(
      "click",
      cerrarConfigGlobal
    );

  modalConfigGlobal
    ?.addEventListener(
      "click",
      event => {
        if (
          event.target ===
          modalConfigGlobal
        ) {
          cerrarConfigGlobal();
        }
      }
    );

  $("configNivel")
    ?.addEventListener(
      "change",
      async () => {
        const esDestino =
          $("configNivel").value ===
          "destino";

        $("configDestinoWrap")
          .classList.toggle(
            "hidden",
            !esDestino
          );

        await renderConfigGlobal();
      }
    );

  $("configDestino")
    ?.addEventListener(
      "change",
      renderConfigGlobal
    );

  $("configBuscarActividad")
    ?.addEventListener(
      "input",
      renderConfigGlobal
    );

  $("btnNuevaRegla")
    ?.addEventListener(
      "click",
      nuevaRegla
    );

  $("modalidadCoordinadorPendiente")
    ?.addEventListener(
      "change",
      event => {
        state
          .modalidadCoordinadorPendiente =
          normalizarModalidadServicio(
            event.target.value
          );

        actualizarResumenPreguntas();
      }
    );

  $("modalidadAsistenciaMedica")
    ?.addEventListener(
      "change",
      event => {
        state.asistenciaMedica = {
          modalidad:
            normalizarModalidadServicio(
              event.target.value
            )
        };

        actualizarResumenPreguntas();
      }
    );
}

/* =========================================================
   INICIO
========================================================= */

async function init() {
  try {
    conectarEventos();

    await cargarDatosBase();

    /*
      Dejamos el año actual seleccionado si existe.
    */
    const anoActual =
      String(
        new Date().getFullYear()
      );

    const selectAno =
      $("fAno");

    if (
      selectAno &&
      [...selectAno.options]
        .some(
          option =>
            option.value ===
            anoActual
        )
    ) {
      selectAno.value =
        anoActual;
    }

    buscar();

  } catch (error) {
    console.error(error);

    progressError(error);

    mostrarMensaje(
      "error",
      error.message ||
      "No fue posible iniciar Gestión de Encuestas."
    );
  }
}

document.addEventListener(
  "DOMContentLoaded",
  () => {
    init();
  }
);
