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

  reglasGlobales: new Map(),
  reglasDestino: new Map(),

  seguimiento: null,
  resultados: {},
  comentarios: {
    positivos: [],
    mejoras: [],
    generales: []
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

function extraerActividadesGrupo(grupo) {
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
    .forEach(([fechaRaw, raw]) => {
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

      items.forEach((item, index) => {
        if (!item) return;

        const nombre =
          cleanText(
            item.actividad ||
            item.servicio ||
            item.nombre ||
            item.titulo ||
            ""
          );

        if (!nombre) return;

        const actividadSlug =
          slug(nombre);

        /*
          Una misma actividad se pregunta una sola vez,
          aunque aparezca repetida en varios días.
        */
        if (
          vistos.has(actividadSlug)
        ) {
          return;
        }

        vistos.add(actividadSlug);

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
            "sin_configurar",

          origenRegla:
            "sin_configurar",

          guardarEn:
            "grupo",

          orden:
            actividades.length +
            index
        });
      });
    });

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
      ).map(item => [
        slug(
          item.slug ||
          item.nombre
        ),
        item
      ])
    );

  return actividades.map(item => {
    const key =
      item.slug;

    const grupoRegla =
      configuracionGrupo.get(key);

    if (grupoRegla) {
      return {
        ...item,
        ...grupoRegla,
        slug: key,
        origenRegla:
          grupoRegla.origenRegla ||
          "grupo",
        guardarEn: "grupo"
      };
    }

    const destinoRegla =
      state.reglasDestino.get(key);

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
      state.reglasGlobales.get(key);

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

    return item;
  });
}

/* =========================================================
   HOTELES
========================================================= */

async function cargarHoteles(grupo) {
  const asignaciones = [];

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

    snap.forEach(d => {
      asignaciones.push({
        id: d.id,
        ...d.data()
      });
    });
  } catch (error) {
    console.warn(
      "Búsqueda hotel por grupoId",
      error
    );
  }

  if (
    !asignaciones.length &&
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

      snap.forEach(d => {
        asignaciones.push({
          id: d.id,
          ...d.data()
        });
      });
    } catch (error) {
      console.warn(
        "Búsqueda hotel por negocio",
        error
      );
    }
  }

  const hoteles = [];
  const vistos = new Set();

  for (const asignacion of asignaciones) {
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
            id: snap.id,
            ...snap.data()
          };
        }
      } catch {
        hotelData = null;
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

    if (vistos.has(key)) {
      continue;
    }

    vistos.add(key);

    hoteles.push({
      id:
        `hotel_${slug(key)}`,

      nombre,

      proveedor:
        nombre,

      tipo:
        "hotel",

      checkIn:
        toISO(
          asignacion.checkIn
        ),

      checkOut:
        toISO(
          asignacion.checkOut
        ),

      obligatorio: true
    });
  }

  return hoteles;
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

function construirTransportes(vuelos) {
  const resultados = [];
  const vistos = new Set();

  function agregar(item) {
    const key =
      [
        item.tipo,
        item.nombre,
        item.fecha
      ].join("|");

    if (
      vistos.has(key)
    ) {
      return;
    }

    vistos.add(key);

    resultados.push({
      id:
        `transporte_${slug(key)}`,

      ...item,

      obligatorio: true
    });
  }

  vuelos.forEach(vuelo => {
    const tipoTransporte =
      normalizarTexto(
        vuelo.tipoTransporte ||
        "aereo"
      );

    const proveedor =
      cleanText(
        vuelo.proveedor ||
        vuelo.aerolinea ||
        vuelo.empresa ||
        ""
      );

    const esTransfer =
      vuelo.isTransfer === true;

    /*
      La encuesta se entrega el penúltimo día.
      Solo cargamos la ida y traslados que ya pudieron ocurrir.
      La vuelta se excluye de esta primera encuesta.
    */
    if (
      Array.isArray(vuelo.tramos) &&
      vuelo.tramos.length
    ) {
      vuelo.tramos.forEach(tramo => {
        const tipoTramo =
          normalizarTexto(
            tramo.tipoTramo
          );

        if (
          tipoTramo === "vuelta"
        ) {
          return;
        }

        const fecha =
          toISO(
            tramo.fechaIda
          );

        if (!fecha) return;

        const empresa =
          cleanText(
            tramo.aerolinea ||
            proveedor
          );

        const ruta =
          [
            tramo.origen ||
            vuelo.origen,
            tramo.destino ||
            vuelo.destino
          ]
            .filter(Boolean)
            .join(" → ");

        agregar({
          tipo:
            esTransfer
              ? "traslado"
              : "aereo",

          nombre:
            [
              esTransfer
                ? "Traslado de ida"
                : "Vuelo de ida",
              empresa,
              ruta
            ]
              .filter(Boolean)
              .join(" · "),

          proveedor:
            empresa,

          fecha
        });
      });

      return;
    }

    const fechaIda =
      toISO(vuelo.fechaIda);

    if (!fechaIda) {
      return;
    }

    const ruta =
      [
        vuelo.origen,
        vuelo.destino
      ]
        .filter(Boolean)
        .join(" → ");

    let tipo =
      "aereo";

    let titulo =
      "Vuelo de ida";

    if (esTransfer) {
      tipo = "traslado";
      titulo =
        "Traslado de ida";
    } else if (
      tipoTransporte === "terrestre"
    ) {
      tipo = "terrestre";
      titulo =
        "Transporte terrestre de ida";
    }

    agregar({
      tipo,

      nombre:
        [
          titulo,
          proveedor,
          ruta
        ]
          .filter(Boolean)
          .join(" · "),

      proveedor,

      fecha:
        fechaIda
    });
  });

  return resultados;
}

/* =========================================================
   COORDINADORES
========================================================= */

async function cargarCoordinadores(grupo) {
  let ids =
    Array.isArray(
      grupo.coordinadorIds
    )
      ? grupo.coordinadorIds
          .map(cleanText)
          .filter(Boolean)
      : [];

  if (
    !ids.length &&
    grupo.coordinadorId
  ) {
    ids = [
      cleanText(
        grupo.coordinadorId
      )
    ];
  }

  const coordinadores = [];
  const vistos = new Set();

  for (const id of ids) {
    try {
      const snap =
        await getDoc(
          doc(
            db,
            "coordinadores",
            id
          )
        );

      if (!snap.exists()) {
        continue;
      }

      const data =
        snap.data() || {};

      coordinadores.push({
        id:
          `coordinador_${snap.id}`,

        nombre:
          cleanText(
            data.nombre ||
            data.nombreCompleto ||
            snap.id
          ),

        tipo:
          "coordinador",

        obligatorio: true
      });

      vistos.add(
        normalizarTexto(
          data.nombre ||
          data.nombreCompleto
        )
      );
    } catch {
      // Se aplica respaldo por nombre.
    }
  }

  const nombresLegacy = [
    ...(Array.isArray(grupo.coordinadores)
      ? grupo.coordinadores
      : []),

    grupo.coordinador
  ]
    .map(item =>
      typeof item === "object"
        ? cleanText(
            item.nombre ||
            item.name
          )
        : cleanText(item)
    )
    .filter(Boolean);

  nombresLegacy.forEach(nombre => {
    const key =
      normalizarTexto(nombre);

    if (
      vistos.has(key)
    ) {
      return;
    }

    vistos.add(key);

    coordinadores.push({
      id:
        `coordinador_${slug(nombre)}`,

      nombre,

      tipo:
        "coordinador",

      obligatorio: true
    });
  });

  return coordinadores;
}

/* =========================================================
   ABRIR GESTIÓN
========================================================= */

async function abrirGestionGrupo(grupoId) {
  const grupo =
    state.grupos.find(
      item =>
        item.id === grupoId
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

    state.seguimiento = null;
    state.resultados = {};
    state.comentarios = {
      positivos: [],
      mejoras: [],
      generales: []
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
      hoteles,
      vuelos,
      coordinadores
    ] = await Promise.all([
      cargarHoteles(grupo),
      cargarVuelosGrupo(grupo),
      cargarCoordinadores(grupo)
    ]);

    state.hoteles =
      state.encuestaActual?.hoteles ||
      hoteles;

    state.transportes =
      state.encuestaActual?.transportes ||
      construirTransportes(vuelos);

    state.coordinadores =
      state.encuestaActual?.coordinadores ||
      coordinadores;

    configurarModalGrupo();

    modalEncuesta
      .classList.add("open");

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
    console.error(error);

    progressError(error);

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

  if (!state.actividades.length) {
    tbody.innerHTML = `
      <tr>
        <td
          colspan="6"
          class="enc-empty"
        >
          El grupo no tiene actividades registradas en el itinerario.
        </td>
      </tr>
    `;

    return;
  }

  tbody.innerHTML =
    state.actividades
      .map((item, index) => `
        <tr data-index="${index}">

          <td>
            ${formatDate(item.fecha)}
          </td>

          <td>
            <strong>
              ${escapeHtml(item.nombre)}
            </strong>
          </td>

          <td>
            ${escapeHtml(item.proveedor || "—")}
          </td>

          <td>
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
          </td>

          <td>
            <span class="enc-origin">
              ${escapeHtml(item.origenRegla || "—")}
            </span>
          </td>

          <td>
            <select class="actividadGuardarEn">

              <option
                value="grupo"
                ${
                  item.guardarEn === "grupo"
                    ? "selected"
                    : ""
                }
              >
                Solo este grupo
              </option>

              <option
                value="destino"
                ${
                  item.guardarEn === "destino"
                    ? "selected"
                    : ""
                }
              >
                ${escapeHtml(getDestino(state.grupoActual) || "Destino")}
              </option>

              <option
                value="global"
                ${
                  item.guardarEn === "global"
                    ? "selected"
                    : ""
                }
              >
                Todos los destinos
              </option>

            </select>
          </td>

        </tr>
      `)
      .join("");

  tbody
    .querySelectorAll("tr")
    .forEach(tr => {
      const index =
        Number(
          tr.dataset.index
        );

      const modalidad =
        tr.querySelector(
          ".actividadModalidad"
        );

      const guardarEn =
        tr.querySelector(
          ".actividadGuardarEn"
        );

      modalidad.addEventListener(
        "change",
        () => {
          state.actividades[index]
            .modalidad =
            modalidad.value;

          /*
            Al modificar una regla heredada, por defecto
            pasa a ser una excepción de este grupo.
          */
          if (
            state.actividades[index]
              .origenRegla !== "grupo"
          ) {
            guardarEn.value =
              "grupo";

            state.actividades[index]
              .guardarEn =
              "grupo";
          }

          state.actividades[index]
            .origenRegla =
            guardarEn.value;

          actualizarResumenPreguntas();
        }
      );

      guardarEn.addEventListener(
        "change",
        () => {
          state.actividades[index]
            .guardarEn =
            guardarEn.value;

          state.actividades[index]
            .origenRegla =
            guardarEn.value;
        }
      );
    });
}

function actualizarResumenPreguntas() {
  const obligatorias =
    state.actividades.filter(
      x =>
        x.modalidad ===
        "obligatoria"
    ).length;

  const aleatorias =
    state.actividades.filter(
      x =>
        x.modalidad ===
        "aleatoria"
    ).length;

  const excluidas =
    state.actividades.filter(
      x =>
        x.modalidad ===
        "excluida"
    ).length;

  const sinConfigurar =
    state.actividades.filter(
      x =>
        x.modalidad ===
        "sin_configurar"
    ).length;

  $("cantidadObligatorias").textContent =
    obligatorias;

  $("cantidadAleatorias").textContent =
    aleatorias;

  $("cantidadExcluidas").textContent =
    excluidas;

  $("cantidadSinConfigurar").textContent =
    sinConfigurar;

  const cantidadSolicitada =
    Math.max(
      0,
      Number(
        $("cantidadAleatorias")
          ?.closest(".enc-follow-card")
      )
    );

  const cantidadPorPersona =
    Math.max(
      0,
      Number(
        document
          .querySelector(
            "#panel-configuracion input#cantidadAleatorias"
          )
          ?.value ||
        0
      )
    );

  const aleatoriasReales =
    Math.min(
      cantidadPorPersona,
      aleatorias
    );

  const total =
    obligatorias +
    aleatoriasReales +
    state.hoteles.length +
    state.transportes.length +
    state.coordinadores.length +
    1;

  $("resumenCargaPasajero").textContent =
    sinConfigurar
      ? `Quedan ${sinConfigurar} actividades sin configurar. No se puede publicar todavía.`
      : `Cada pasajero responderá aproximadamente ${total} evaluaciones: ${obligatorias} actividades obligatorias, ${aleatoriasReales} aleatorias y los servicios generales del grupo.`;
}

/* =========================================================
   SERVICIOS
========================================================= */

function renderListaServicio(
  containerId,
  lista
) {
  const container =
    $(containerId);

  if (!lista.length) {
    container.innerHTML = `
      <div class="enc-empty">
        Sin información registrada.
      </div>
    `;

    return;
  }

  container.innerHTML =
    lista.map(item => `
      <div class="enc-result-card">
        <strong>
          ${escapeHtml(item.nombre)}
        </strong>

        ${
          item.proveedor
            ? `
              <div class="enc-muted">
                ${escapeHtml(item.proveedor)}
              </div>
            `
            : ""
        }

        ${
          item.fecha
            ? `
              <div class="enc-muted">
                ${formatDate(item.fecha)}
              </div>
            `
            : ""
        }
      </div>
    `).join("");
}

function renderServicios() {
  renderListaServicio(
    "listaHoteles",
    state.hoteles
  );

  renderListaServicio(
    "listaTransportes",
    state.transportes
  );

  renderListaServicio(
    "listaCoordinadores",
    state.coordinadores
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
      modalidad ===
      "sin_configurar"
    ) {
      continue;
    }

    const key =
      actividad.slug ||
      slug(actividad.nombre);

    const data = {
      nombre:
        actividad.nombre,

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

  if (operaciones) {
    await batch.commit();
  }
}

/* =========================================================
   GUARDAR BORRADOR
========================================================= */

function construirPayloadEncuesta() {
  const grupo =
    state.grupoActual;

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
      getNumeroNegocio(grupo),

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
      getDestino(grupo),

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
          document
            .querySelector(
              "#panel-configuracion input#cantidadAleatorias"
            )
            ?.value ||
          0
        )
      ),

    actividades:
      state.actividades.map(
        item => ({
          id: item.id,
          slug: item.slug,
          nombre: item.nombre,
          fecha: item.fecha,
          horaInicio:
            item.horaInicio,
          proveedor:
            item.proveedor,
          modalidad:
            item.modalidad,
          origenRegla:
            item.guardarEn ||
            item.origenRegla ||
            "grupo"
        })
      ),

    hoteles:
      state.hoteles,

    transportes:
      state.transportes,

    coordinadores:
      state.coordinadores
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

  const publicada =
    ["activa", "programada"]
      .includes(estado);

  $("btnGuardarBorrador")
    .classList.toggle(
      "hidden",
      publicada
    );

  $("btnPublicarEncuesta")
    .classList.toggle(
      "hidden",
      publicada
    );

  $("btnCerrarEncuesta")
    .classList.toggle(
      "hidden",
      !publicada
    );

  $("btnReabrirEncuesta")
    .classList.toggle(
      "hidden",
      estado !== "cerrada"
    );
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
    filtro === "estudiante" ||
    filtro === "adulto"
  ) {
    participantes =
      participantes.filter(
        x =>
          x.tipoPasajero ===
          filtro
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

function getPreguntaNombre(preguntaId) {
  if (
    preguntaId ===
    "general:viaje"
  ) {
    return "Evaluación general del viaje";
  }

  const [
    tipo,
    id
  ] = preguntaId.split(":");

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
    listas[tipo]?.find(
      x => x.id === id
    );

  return item?.nombre ||
    preguntaId;
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
        ([preguntaId, data]) => `
          <div class="enc-result-card">

            <h5>
              ${escapeHtml(getPreguntaNombre(preguntaId))}
            </h5>

            <div class="enc-result-grid">

              ${resultadoCelda(
                "Muy bueno",
                data.muy_bueno
              )}

              ${resultadoCelda(
                "Bueno",
                data.bueno
              )}

              ${resultadoCelda(
                "Regular",
                data.regular
              )}

              ${resultadoCelda(
                "Malo",
                data.malo
              )}

              ${resultadoCelda(
                "Total",
                data.total
              )}

            </div>

          </div>
        `
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
              "sin_configurar"
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
