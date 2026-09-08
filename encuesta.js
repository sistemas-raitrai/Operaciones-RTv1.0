// encuesta.js
// Encuesta pública de viaje.
// No consulta Firestore directamente.
// Toda validación se realiza mediante Cloud Functions.

const FUNCTION_URLS = Object.freeze({
  identificar:
    "https://identificarparticipanteencuesta-r3llfis4wa-tl.a.run.app",

  enviar:
    "https://enviarrespuestaencuesta-r3llfis4wa-tl.a.run.app"
});

const GOOGLE_REVIEW_URL =
  "https://search.google.com/local/writereview?placeid=ChIJYW1DLmTPYpYRM2pq8d2KVZc";

/* =========================================================
   ESTADO
========================================================= */

const state = {
  token: "",
  sesion: "",
  participante: null,
  encuesta: null,
  preguntas: [],

  /*
    Map:
      preguntaId → puntuación 1 a 5
  */
  respuestas: new Map()
};

/* =========================================================
   DOM
========================================================= */

const $ = id =>
  document.getElementById(id);

const pantallaCargando =
  $("pantallaCargando");

const pantallaError =
  $("pantallaError");

const pantallaAcceso =
  $("pantallaAcceso");

const pantallaEncuesta =
  $("pantallaEncuesta");

const pantallaFinal =
  $("pantallaFinal");

const formAcceso =
  $("formAcceso");

const formEncuesta =
  $("formEncuesta");

const rutNumero =
  $("rutNumero");

const rutDv =
  $("rutDv");

const rutHint =
  $("rutHint");

const btnIngresar =
  $("btnIngresar");

const btnEnviarEncuesta =
  $("btnEnviarEncuesta");

const contenedorPreguntas =
  $("contenedorPreguntas");

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
    .toUpperCase();
}

function escapeHtml(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function limpiarRutNumero(value = "") {
  return cleanText(value)
    .replace(/\D/g, "")
    .slice(0, 8);
}

function calcularDvRut(cuerpo = "") {
  const rut =
    limpiarRutNumero(cuerpo);

  if (!rut) {
    return "";
  }

  let suma = 0;
  let multiplo = 2;

  for (
    let i = rut.length - 1;
    i >= 0;
    i--
  ) {
    suma +=
      Number(rut[i]) *
      multiplo;

    multiplo =
      multiplo === 7
        ? 2
        : multiplo + 1;
  }

  const resto =
    11 - (suma % 11);

  if (resto === 11) {
    return "0";
  }

  if (resto === 10) {
    return "K";
  }

  return String(resto);
}

function formatearRutNumero(value = "") {
  const numero =
    limpiarRutNumero(value);

  if (!numero) {
    return "";
  }

  return numero.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    "."
  );
}

function getRutCompleto() {
  const numero =
    limpiarRutNumero(
      rutNumero?.value
    );

  const dv =
    cleanText(
      rutDv?.value
    )
      .toUpperCase()
      .replace(/[^0-9K]/g, "")
      .slice(0, 1);

  if (
    !/^\d{7,8}$/.test(numero)
  ) {
    return "";
  }

  if (
    calcularDvRut(numero) !== dv
  ) {
    return "";
  }

  return `${numero}-${dv}`;
}

function toISODate(value = "") {
  const texto =
    cleanText(value);

  if (!texto) {
    return "";
  }

  if (
    /^\d{4}-\d{2}-\d{2}$/.test(
      texto
    )
  ) {
    return texto;
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

function crearFechaLocal(
  iso = ""
) {
  const fechaISO =
    toISODate(iso);

  if (!fechaISO) {
    return null;
  }

  const partes =
    fechaISO
      .split("-")
      .map(Number);

  if (
    partes.length !== 3 ||
    partes.some(
      parte => !parte
    )
  ) {
    return null;
  }

  const [
    year,
    month,
    day
  ] = partes;

  const fecha =
    new Date(
      year,
      month - 1,
      day,
      12,
      0,
      0
    );

  if (
    Number.isNaN(
      fecha.getTime()
    )
  ) {
    return null;
  }

  return fecha;
}

function formatDateTime(value = "") {
  if (!value) {
    return "";
  }

  const fecha =
    new Date(value);

  if (
    Number.isNaN(
      fecha.getTime()
    )
  ) {
    return "";
  }

  return fecha.toLocaleDateString(
    "es-CL",
    {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }
  );
}

function formatActivityDate(
  value = ""
) {
  const fecha =
    crearFechaLocal(value);

  if (!fecha) {
    return "";
  }

  const texto =
    fecha.toLocaleDateString(
      "es-CL",
      {
        weekday: "long",
        day: "numeric",
        month: "long"
      }
    );

  return texto
    ? texto.charAt(0).toUpperCase() +
      texto.slice(1)
    : "";
}

function getNumeroDiaViaje(
  fechaRaw = ""
) {
  const fechaISO =
    toISODate(fechaRaw);

  const inicioISO =
    toISODate(
      state.encuesta?.fechaInicio ||
      state.encuesta?.inicio ||
      ""
    );

  if (
    !fechaISO ||
    !inicioISO
  ) {
    return 0;
  }

  const fecha =
    crearFechaLocal(fechaISO);

  const inicio =
    crearFechaLocal(inicioISO);

  if (
    !fecha ||
    !inicio
  ) {
    return 0;
  }

  const diferencia =
    Math.round(
      (
        fecha.getTime() -
        inicio.getTime()
      ) /
      86400000
    );

  return diferencia >= 0
    ? diferencia + 1
    : 0;
}

function getDescripcionDiaViaje(
  fechaRaw = ""
) {
  const fechaTexto =
    formatActivityDate(
      fechaRaw
    );

  const numeroDia =
    getNumeroDiaViaje(
      fechaRaw
    );

  const partes = [];

  if (fechaTexto) {
    partes.push(
      fechaTexto
    );
  }

  if (numeroDia > 0) {
    partes.push(
      numeroDia === 1
        ? "Primer día del viaje"
        : `Día ${numeroDia} del viaje`
    );
  }

  return partes.join(" · ");
}

function getDescripcionPuntuacion(
  valor
) {
  const labels = {
    1: "Muy malo",
    2: "Malo",
    3: "Regular",
    4: "Bueno",
    5: "Excelente"
  };

  return labels[
    Number(valor)
  ] || "";
}

function mostrarPantalla(nombre) {
  const pantallas = {
    cargando:
      pantallaCargando,

    error:
      pantallaError,

    acceso:
      pantallaAcceso,

    encuesta:
      pantallaEncuesta,

    final:
      pantallaFinal
  };

  Object.entries(pantallas)
    .forEach(
      ([key, element]) => {
        element?.classList.toggle(
          "hidden",
          key !== nombre
        );
      }
    );

  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });
}

function mostrarErrorGeneral(
  titulo,
  mensaje,
  disponibleDesde = ""
) {
  $("errorTitulo").textContent =
    titulo ||
    "Encuesta no disponible";

  $("errorMensaje").textContent =
    mensaje ||
    "No fue posible abrir esta encuesta.";

  const errorFecha =
    $("errorFecha");

  if (disponibleDesde) {
    const fechaTexto =
      formatDateTime(
        disponibleDesde
      );

    errorFecha.textContent =
      fechaTexto
        ? `Esta encuesta estará disponible desde el ${fechaTexto}.`
        : "La encuesta todavía no se encuentra disponible.";

    errorFecha.classList.remove(
      "hidden"
    );
  } else {
    errorFecha.textContent = "";

    errorFecha.classList.add(
      "hidden"
    );
  }

  mostrarPantalla(
    "error"
  );
}

function mostrarMensajeAcceso(
  mensaje,
  tipo = "error"
) {
  const box =
    $("accesoMensaje");

  if (!box) {
    return;
  }

  box.className =
    `notice ${tipo}`;

  box.textContent =
    mensaje;

  box.classList.remove(
    "hidden"
  );
}

function ocultarMensajeAcceso() {
  const box =
    $("accesoMensaje");

  if (!box) {
    return;
  }

  box.textContent = "";

  box.className =
    "notice error hidden";
}

function setButtonLoading(
  button,
  loading,
  textLoading,
  textNormal
) {
  if (!button) {
    return;
  }

  button.disabled =
    loading;

  button.textContent =
    loading
      ? textLoading
      : textNormal;
}

async function postPublico(
  url,
  body = {}
) {
  let response;

  try {
    response =
      await fetch(
        url,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(body)
        }
      );
  } catch {
    throw {
      status: 0,
      code: "NETWORK_ERROR",
      message:
        "No pudimos conectar con el sistema. Revisa tu conexión a internet e inténtalo nuevamente."
    };
  }

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
    throw {
      status:
        response.status,

      code:
        data?.code ||
        "REQUEST_ERROR",

      message:
        data?.message ||
        "No fue posible completar la operación.",

      disponibleDesde:
        data?.disponibleDesde ||
        ""
    };
  }

  return data;
}

/* =========================================================
   RUT
========================================================= */

function normalizarInputRut() {
  if (
    !rutNumero ||
    !rutDv
  ) {
    return;
  }

  const numero =
    limpiarRutNumero(
      rutNumero.value
    );

  const dv =
    cleanText(
      rutDv.value
    )
      .toUpperCase()
      .replace(/[^0-9K]/g, "")
      .slice(0, 1);

  rutNumero.value =
    formatearRutNumero(
      numero
    );

  rutDv.value =
    dv;

  const completo =
    getRutCompleto();

  const tieneError =
    !!numero &&
    numero.length >= 7 &&
    !!dv &&
    !completo;

  rutNumero.classList.toggle(
    "input-error",
    tieneError
  );

  rutDv.classList.toggle(
    "input-error",
    tieneError
  );

  if (
    !numero ||
    !dv
  ) {
    rutHint.textContent =
      "Ingresa el número y el dígito verificador.";

    return;
  }

  rutHint.textContent =
    completo
      ? "RUT válido ✓"
      : "El RUT ingresado no es válido.";
}

/* =========================================================
   VALIDAR ACCESO
========================================================= */

async function identificarParticipante(
  event
) {
  event.preventDefault();

  ocultarMensajeAcceso();

  const rut =
    getRutCompleto();

  if (!rut) {
    mostrarMensajeAcceso(
      "Debes ingresar un RUT válido."
    );

    rutNumero?.classList.add(
      "input-error"
    );

    rutDv?.classList.add(
      "input-error"
    );

    rutNumero?.focus();

    return;
  }

  if (!state.token) {
    mostrarErrorGeneral(
      "Enlace incompleto",
      "El enlace no contiene el token de la encuesta."
    );

    return;
  }

  setButtonLoading(
    btnIngresar,
    true,
    "Validando...",
    "Ingresar a la encuesta"
  );

  try {
    const respuesta =
      await postPublico(
        FUNCTION_URLS.identificar,
        {
          token:
            state.token,

          rut
        }
      );

    if (
      respuesta.yaRespondio === true
    ) {
      mostrarFinal(
        "¡Muchas gracias!",
        respuesta.message ||
        "Tu participación ya había sido registrada."
      );

      return;
    }

    state.sesion =
      cleanText(
        respuesta.sesion
      );

    state.participante =
      respuesta.participante ||
      {};

    state.encuesta =
      respuesta.encuesta ||
      {};

    state.respuestas =
      new Map();

    construirEncuesta();

    mostrarPantalla(
      "encuesta"
    );
  } catch (error) {
    manejarErrorAcceso(
      error
    );
  } finally {
    setButtonLoading(
      btnIngresar,
      false,
      "Validando...",
      "Ingresar a la encuesta"
    );
  }
}

function manejarErrorAcceso(
  error = {}
) {
  const code =
    error.code ||
    "";

  if (
    code ===
    "ENCUESTA_PROGRAMADA"
  ) {
    mostrarErrorGeneral(
      "Encuesta programada",
      error.message,
      error.disponibleDesde
    );

    return;
  }

  if (
    code ===
    "ENCUESTA_CERRADA"
  ) {
    mostrarErrorGeneral(
      "Encuesta cerrada",
      error.message
    );

    return;
  }

  if (
    code ===
      "ENCUESTA_NO_DISPONIBLE" ||
    code ===
      "ENLACE_INVALIDO"
  ) {
    mostrarErrorGeneral(
      "Encuesta no disponible",
      error.message
    );

    return;
  }

  if (
    code ===
    "RUT_NO_PERTENECE"
  ) {
    mostrarMensajeAcceso(
      "No encontramos este RUT en la nómina correspondiente a este enlace. Revisa el número ingresado."
    );

    return;
  }

  if (
    code ===
    "PASAJERO_NO_HABILITADO"
  ) {
    mostrarMensajeAcceso(
      error.message ||
      "Este pasajero no está habilitado para responder."
    );

    return;
  }

  mostrarMensajeAcceso(
    error.message ||
    "No fue posible validar el acceso."
  );
}

/* =========================================================
   CONSTRUIR CABECERA
========================================================= */

function construirDatosGrupoHTML() {
  const encuesta =
    state.encuesta ||
    {};

  const colegio =
    cleanText(
      encuesta.colegio ||
      encuesta.grupo ||
      ""
    );

  const curso =
    cleanText(
      encuesta.curso ||
      ""
    );

  const destino =
    cleanText(
      encuesta.destino ||
      ""
    );

  if (
    !colegio &&
    !curso &&
    !destino
  ) {
    return `
      <div class="group-main-line">
        <span>VIAJE DE ESTUDIOS</span>
      </div>
    `;
  }

  return `
    <div class="group-main-line">

      ${
        colegio
          ? `
            <span class="group-school">
              ${escapeHtml(colegio)}
            </span>
          `
          : ""
      }

      ${
        curso
          ? `
            <span class="group-course">
              ${escapeHtml(curso)}
            </span>
          `
          : ""
      }

    </div>

    ${
      destino
        ? `
          <div class="group-destination">
            ${escapeHtml(destino)}
          </div>
        `
        : ""
    }
  `;
}

function construirEncuesta() {
  const participante =
    state.participante ||
    {};

  const encuesta =
    state.encuesta ||
    {};

  $("saludoPasajero").textContent =
    participante.nombre
      ? `Hola, ${participante.nombre}`
      : "Hola";

  $("datosEncuesta").innerHTML =
    construirDatosGrupoHTML();

  state.preguntas =
    construirPreguntas(
      encuesta.preguntas ||
      {}
    );

  renderPreguntas();
  actualizarProgreso();
}

/* =========================================================
   CONSTRUIR PREGUNTAS
========================================================= */

function crearPreguntaDesdeItem(
  item = {},
  tipo = "",
  seccion = ""
) {
  const idBase =
    cleanText(
      item.preguntaId ||
      item.id ||
      item.key ||
      item.nombre ||
      ""
    );

  if (!idBase) {
    return null;
  }

  return {
    preguntaId:
      cleanText(
        item.preguntaId
      ) ||
      `${tipo}:${idBase}`,

    /*
      Debe mandar el tipo de la sección:
      actividad, hotel, transporte, etc.
    */
    tipo,

    subtipo:
      cleanText(
        item.subtipo ||
        item.tipoPregunta ||
        item.categoria ||
        item.tipo ||
        ""
      ),

    seccion:
      cleanText(
        item.seccion ||
        seccion
      ) ||
      seccion,

    nombre:
      cleanText(
        item.nombre ||
        item.etiqueta ||
        item.titulo ||
        ""
      ),

    fecha:
      toISODate(
        item.fecha ||
        item.fechaActividad ||
        item.fechaISO ||
        ""
      ),

    fechaInicio:
      toISODate(
        item.fechaInicio ||
        item.checkIn ||
        ""
      ),

    fechaFin:
      toISODate(
        item.fechaFin ||
        item.checkOut ||
        ""
      ),

    noches:
      Number(
        item.noches ||
        0
      ) || 0,

    recordatorio:
      cleanText(
        item.recordatorio ||
        item.meta ||
        item.descripcion ||
        ""
      ),

    obligatoria:
      item.obligatoria !== false &&
      item.obligatorio !== false
  };
}

function construirPreguntas(
  preguntasBackend = {}
) {
  const preguntas = [];

  /*
    La evaluación general siempre es la primera.
    Si el backend ya la entrega, evitamos duplicarla.
  */
  const generalesBackend =
    Array.isArray(
      preguntasBackend.generales
    )
      ? preguntasBackend.generales
      : [];

  if (generalesBackend.length) {
    generalesBackend.forEach(
      item => {
        const pregunta =
          crearPreguntaDesdeItem(
            item,
            "general",
            "Evaluación general"
          );

        if (pregunta) {
          preguntas.push(
            pregunta
          );
        }
      }
    );
  } else {
    preguntas.push({
      preguntaId:
        "general:viaje",

      tipo:
        "general",

      subtipo:
        "viaje_general",

      seccion:
        "Evaluación general",

      nombre:
        "El viaje en general",

      fecha: "",
      fechaInicio: "",
      fechaFin: "",
      noches: 0,
      recordatorio: "",
      obligatoria: true
    });
  }

  function agregarLista(
    lista,
    tipo,
    seccion
  ) {
    (
      Array.isArray(lista)
        ? lista
        : []
    ).forEach(
      item => {
        const pregunta =
          crearPreguntaDesdeItem(
            item,
            tipo,
            seccion
          );

        if (pregunta) {
          preguntas.push(
            pregunta
          );
        }
      }
    );
  }

  agregarLista(
    preguntasBackend.actividades,
    "actividad",
    "Actividades"
  );

  /*
    El backend final podrá entregar hoteles normales
    y alimentación como elementos separados.
  */
  agregarLista(
    preguntasBackend.hoteles,
    "hotel",
    "Hoteles y alimentación"
  );

  agregarLista(
    preguntasBackend.transportes,
    "transporte",
    "Transporte"
  );

  agregarLista(
    preguntasBackend.coordinadores,
    "coordinador",
    "Coordinación"
  );

  /*
    Preguntas específicas para adultos/profesores.
  */
  agregarLista(
    preguntasBackend.organizacion,
    "organizacion",
    "Organización y seguridad"
  );

  /*
    Compatibilidad con un arreglo único futuro.
  */
  agregarLista(
    preguntasBackend.adicionales,
    "adicional",
    "Otras evaluaciones"
  );

  /*
    Eliminamos cualquier duplicado por preguntaId.
  */
  const unicas =
    new Map();

  preguntas.forEach(
    pregunta => {
      if (
        !unicas.has(
          pregunta.preguntaId
        )
      ) {
        unicas.set(
          pregunta.preguntaId,
          pregunta
        );
      }
    }
  );

  return [
    ...unicas.values()
  ];
}

/* =========================================================
   TÍTULOS Y RECORDATORIOS
========================================================= */

function getSubtipoPregunta(
  pregunta = {}
) {
  return normalizarTexto(
    pregunta.subtipo
  );
}

function getNombreEvaluacion(
  pregunta = {}
) {
  const nombre =
    cleanText(
      pregunta.nombre
    );

  const nombreUpper =
    nombre.toUpperCase();

  const subtipo =
    getSubtipoPregunta(
      pregunta
    );

  if (
    pregunta.tipo ===
    "general"
  ) {
    return nombre
      ? nombreUpper
      : "EL VIAJE EN GENERAL";
  }

  if (
    pregunta.tipo ===
    "hotel"
  ) {
    if (
      subtipo.includes("ALIMENT") ||
      subtipo.includes("COMIDA")
    ) {
      if (
        /^ALIMENTACION\s+EN\b/.test(
          normalizarTexto(nombre)
        )
      ) {
        return nombreUpper;
      }

      return nombre
        ? `ALIMENTACIÓN EN ${nombreUpper}`
        : "ALIMENTACIÓN EN EL HOTEL";
    }

    if (
      /^EXPERIENCIA\s+GENERAL\s+EN\b/.test(
        normalizarTexto(nombre)
      )
    ) {
      return nombreUpper;
    }

    return nombre
      ? `EXPERIENCIA GENERAL EN ${nombreUpper}`
      : "EXPERIENCIA GENERAL EN EL HOTEL";
  }

  if (
    pregunta.tipo ===
    "coordinador"
  ) {
    if (
      /^COORDINACION\b/.test(
        normalizarTexto(nombre)
      )
    ) {
      return nombreUpper;
    }

    return nombre
      ? `COORDINACIÓN DE ${nombreUpper}`
      : "COORDINACIÓN DEL VIAJE";
  }

  return nombreUpper;
}

function getRecordatorioHotel(
  pregunta = {}
) {
  if (pregunta.recordatorio) {
    return pregunta.recordatorio;
  }

  const subtipo =
    getSubtipoPregunta(
      pregunta
    );

  if (
    subtipo.includes("ALIMENT") ||
    subtipo.includes("COMIDA")
  ) {
    return "Desayunos, almuerzos y cenas durante la estadía";
  }

  const inicio =
    pregunta.fechaInicio;

  const fin =
    pregunta.fechaFin;

  const diaInicio =
    getNumeroDiaViaje(
      inicio
    );

  const diaFin =
    getNumeroDiaViaje(
      fin
    );

  const noches =
    pregunta.noches ||
    (
      diaInicio > 0 &&
      diaFin > diaInicio
        ? diaFin - diaInicio
        : 0
    );

  if (
    diaInicio === 1 &&
    diaFin > 1
  ) {
    const fechaFinViaje =
      toISODate(
        state.encuesta?.fechaFin ||
        ""
      );

    if (
      fechaFinViaje &&
      fechaFinViaje === fin
    ) {
      return "Todas las noches del viaje";
    }
  }

  if (
    diaInicio > 0 &&
    diaFin > 0
  ) {
    const rango =
      diaInicio === diaFin
        ? `Día ${diaInicio} del viaje`
        : `Del día ${diaInicio} al día ${diaFin}`;

    return noches > 0
      ? `${rango} · ${noches} ${
          noches === 1
            ? "noche"
            : "noches"
        }`
      : rango;
  }

  return "";
}

function getMetaPregunta(
  pregunta = {}
) {
  if (pregunta.recordatorio) {
    return pregunta.recordatorio;
  }

  if (
    pregunta.tipo ===
    "actividad"
  ) {
    return getDescripcionDiaViaje(
      pregunta.fecha
    );
  }

  if (
    pregunta.tipo ===
    "hotel"
  ) {
    return getRecordatorioHotel(
      pregunta
    );
  }

  if (
    pregunta.tipo ===
    "transporte"
  ) {
    const subtipo =
      getSubtipoPregunta(
        pregunta
      );

    if (
      subtipo.includes("BUS_INTERNO") ||
      subtipo.includes("BUSES_DURANTE")
    ) {
      return "Traslados realizados en el destino";
    }

    if (
      subtipo.includes("BUS_PRINCIPAL") ||
      subtipo === "TERRESTRE"
    ) {
      return "Viaje de ida, recorrido principal y regreso";
    }

    if (
      subtipo.includes("IDA_Y_VUELTA") ||
      subtipo.includes("IDA_VUELTA")
    ) {
      return "Viaje de ida y regreso";
    }

    if (
      subtipo === "IDA" ||
      subtipo.includes("VUELO_IDA")
    ) {
      return pregunta.fecha
        ? getDescripcionDiaViaje(
            pregunta.fecha
          )
        : "Viaje de ida";
    }

    if (
      subtipo === "VUELTA" ||
      subtipo.includes("REGRESO")
    ) {
      return pregunta.fecha
        ? getDescripcionDiaViaje(
            pregunta.fecha
          )
        : "Viaje de regreso";
    }

    return pregunta.fecha
      ? getDescripcionDiaViaje(
          pregunta.fecha
        )
      : "";
  }

  return pregunta.fecha
    ? getDescripcionDiaViaje(
        pregunta.fecha
      )
    : "";
}

/* =========================================================
   RENDERIZAR PREGUNTAS
========================================================= */

function renderPreguntas() {
  if (!contenedorPreguntas) {
    return;
  }

  if (
    !state.preguntas.length
  ) {
    contenedorPreguntas.innerHTML = `
      <div class="card center">
        No existen preguntas disponibles.
      </div>
    `;

    return;
  }

  let seccionAnterior = "";

  contenedorPreguntas.innerHTML =
    state.preguntas
      .map(
        (pregunta, index) => {
          let tituloSeccion = "";

          if (
            pregunta.seccion !==
            seccionAnterior
          ) {
            seccionAnterior =
              pregunta.seccion;

            tituloSeccion = `
              <div class="section-title">
                ${escapeHtml(pregunta.seccion)}
              </div>
            `;
          }

          const nombre =
            getNombreEvaluacion(
              pregunta
            );

          const meta =
            getMetaPregunta(
              pregunta
            );

          return `
            ${tituloSeccion}

            <article
              class="
                question-card
                ${
                  pregunta.tipo === "general"
                    ? "general-question"
                    : ""
                }
              "
              data-pregunta-id="${escapeHtml(pregunta.preguntaId)}"
            >

              <div class="question-number">
                Pregunta ${index + 1} de ${state.preguntas.length}
              </div>

              <div class="question-prefix">
                ¿Cómo evaluarías?
              </div>

              <div class="question-title">
                ${escapeHtml(nombre)}
              </div>

              ${
                meta
                  ? `
                    <div class="question-meta">
                      ${escapeHtml(meta)}
                    </div>
                  `
                  : ""
              }

              ${crearSelectorEstrellas(
                pregunta
              )}

            </article>
          `;
        }
      )
      .join("");

  conectarEventosEstrellas();
}

/* =========================================================
   ESTRELLAS
========================================================= */

function crearSelectorEstrellas(
  pregunta
) {
  const botones = [];

  for (
    let valor = 1;
    valor <= 5;
    valor++
  ) {
    botones.push(`
      <button
        class="star-button"
        type="button"
        role="radio"
        aria-checked="false"
        aria-label="${valor} de 5: ${escapeHtml(getDescripcionPuntuacion(valor))}"
        data-pregunta-id="${escapeHtml(pregunta.preguntaId)}"
        data-valor="${valor}"
      >
        ★
      </button>
    `);
  }

  return `
    <div
      class="star-rating"
      role="radiogroup"
      aria-label="Puntuación de 1 a 5 estrellas"
      data-star-group="${escapeHtml(pregunta.preguntaId)}"
    >
      ${botones.join("")}
    </div>

    <div
      class="rating-description"
      data-rating-description="${escapeHtml(pregunta.preguntaId)}"
      aria-live="polite"
    >
      Selecciona de 1 a 5 estrellas
    </div>
  `;
}

function seleccionarPuntuacion(
  preguntaId,
  valor
) {
  const puntuacion =
    Number(valor);

  if (
    !preguntaId ||
    puntuacion < 1 ||
    puntuacion > 5
  ) {
    return;
  }

  state.respuestas.set(
    preguntaId,
    puntuacion
  );

  const card =
    contenedorPreguntas
      ?.querySelector(
        `[data-pregunta-id="${CSS.escape(preguntaId)}"]`
      );

  card?.classList.remove(
    "has-error"
  );

  pintarEstrellas(
    preguntaId,
    puntuacion
  );

  actualizarProgreso();
}

function pintarEstrellas(
  preguntaId,
  valor
) {
  const grupo =
    contenedorPreguntas
      ?.querySelector(
        `[data-star-group="${CSS.escape(preguntaId)}"]`
      );

  if (!grupo) {
    return;
  }

  grupo
    .querySelectorAll(
      ".star-button"
    )
    .forEach(
      boton => {
        const valorBoton =
          Number(
            boton.dataset.valor
          );

        const seleccionada =
          valorBoton <= valor;

        boton.classList.toggle(
          "selected",
          seleccionada
        );

        boton.setAttribute(
          "aria-checked",
          valorBoton === valor
            ? "true"
            : "false"
        );
      }
    );

  const descripcion =
    contenedorPreguntas
      ?.querySelector(
        `[data-rating-description="${CSS.escape(preguntaId)}"]`
      );

  if (descripcion) {
    descripcion.textContent =
      `${valor} de 5 · ${
        getDescripcionPuntuacion(
          valor
        )
      }`;
  }
}

function mostrarVistaPreviaEstrellas(
  preguntaId,
  valor
) {
  const grupo =
    contenedorPreguntas
      ?.querySelector(
        `[data-star-group="${CSS.escape(preguntaId)}"]`
      );

  if (!grupo) {
    return;
  }

  grupo
    .querySelectorAll(
      ".star-button"
    )
    .forEach(
      boton => {
        const valorBoton =
          Number(
            boton.dataset.valor
          );

        boton.classList.toggle(
          "preview",
          valorBoton <= valor
        );
      }
    );
}

function limpiarVistaPreviaEstrellas(
  preguntaId
) {
  const grupo =
    contenedorPreguntas
      ?.querySelector(
        `[data-star-group="${CSS.escape(preguntaId)}"]`
      );

  grupo
    ?.querySelectorAll(
      ".star-button"
    )
    .forEach(
      boton => {
        boton.classList.remove(
          "preview"
        );
      }
    );
}

function conectarEventosEstrellas() {
  contenedorPreguntas
    ?.querySelectorAll(
      ".star-button"
    )
    .forEach(
      boton => {
        boton.addEventListener(
          "click",
          () => {
            seleccionarPuntuacion(
              boton.dataset.preguntaId,
              Number(
                boton.dataset.valor
              )
            );
          }
        );

        boton.addEventListener(
          "mouseenter",
          () => {
            mostrarVistaPreviaEstrellas(
              boton.dataset.preguntaId,
              Number(
                boton.dataset.valor
              )
            );
          }
        );

        boton.addEventListener(
          "mouseleave",
          () => {
            limpiarVistaPreviaEstrellas(
              boton.dataset.preguntaId
            );
          }
        );

        boton.addEventListener(
          "keydown",
          event => {
            if (
              ![
                "ArrowLeft",
                "ArrowRight",
                "ArrowUp",
                "ArrowDown"
              ].includes(
                event.key
              )
            ) {
              return;
            }

            event.preventDefault();

            const actual =
              Number(
                state.respuestas.get(
                  boton.dataset.preguntaId
                ) ||
                boton.dataset.valor ||
                1
              );

            const siguiente =
              event.key === "ArrowRight" ||
              event.key === "ArrowUp"
                ? Math.min(
                    5,
                    actual + 1
                  )
                : Math.max(
                    1,
                    actual - 1
                  );

            seleccionarPuntuacion(
              boton.dataset.preguntaId,
              siguiente
            );

            const grupo =
              boton.closest(
                ".star-rating"
              );

            grupo
              ?.querySelector(
                `[data-valor="${siguiente}"]`
              )
              ?.focus();
          }
        );
      }
    );
}

/* =========================================================
   PROGRESO
========================================================= */

function getPreguntasObligatorias() {
  return state.preguntas.filter(
    pregunta =>
      pregunta.obligatoria !== false
  );
}

function getRespuestasSeleccionadas() {
  return state.preguntas
    .filter(
      pregunta =>
        state.respuestas.has(
          pregunta.preguntaId
        )
    )
    .map(
      pregunta => ({
        preguntaId:
          pregunta.preguntaId,

        /*
          El backend definitivo recibirá valores
          enteros del 1 al 5.
        */
        valor:
          Number(
            state.respuestas.get(
              pregunta.preguntaId
            )
          )
      })
    );
}

function actualizarProgreso() {
  const obligatorias =
    getPreguntasObligatorias();

  const total =
    obligatorias.length;

  const respondidas =
    obligatorias.filter(
      pregunta =>
        state.respuestas.has(
          pregunta.preguntaId
        )
    ).length;

  const porcentaje =
    total
      ? Math.round(
          respondidas /
          total *
          100
        )
      : 0;

  $("progresoTexto").textContent =
    `${respondidas} de ${total}`;

  $("progresoValor").style.width =
    `${porcentaje}%`;

  document
    .querySelector(
      ".progress-track"
    )
    ?.setAttribute(
      "aria-valuenow",
      String(porcentaje)
    );

  /*
    Queda visualmente desactivado mientras falten
    respuestas, pero validarEncuestaCompleta()
    mantiene la seguridad final.
  */
  if (btnEnviarEncuesta) {
    const incompleta =
      total > 0 &&
      respondidas < total;
  
    btnEnviarEncuesta.setAttribute(
      "aria-disabled",
      incompleta
        ? "true"
        : "false"
    );
  }
}

/* =========================================================
   VALIDACIÓN
========================================================= */

function validarEncuestaCompleta() {
  let primeraPendiente =
    null;

  getPreguntasObligatorias()
    .forEach(
      pregunta => {
        const card =
          contenedorPreguntas
            ?.querySelector(
              `[data-pregunta-id="${CSS.escape(pregunta.preguntaId)}"]`
            );

        const respondida =
          state.respuestas.has(
            pregunta.preguntaId
          );

        card?.classList.toggle(
          "has-error",
          !respondida
        );

        if (
          !respondida &&
          !primeraPendiente
        ) {
          primeraPendiente =
            card;
        }
      }
    );

  const resumen =
    $("resumenErrores");

  if (primeraPendiente) {
    resumen?.classList.add(
      "open"
    );

    /*
      Si el botón estaba desactivado, normalmente
      no se llega aquí. Esta validación también cubre
      envíos por teclado o cambios inesperados.
    */
    primeraPendiente.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });

    return false;
  }

  resumen?.classList.remove(
    "open"
  );

  return true;
}

/* =========================================================
   COMENTARIOS
========================================================= */

function alternarComentarios() {
  const boton =
    $("btnToggleComentarios");

  const contenido =
    $("contenidoComentarios");

  if (
    !boton ||
    !contenido
  ) {
    return;
  }

  const abierto =
    boton.getAttribute(
      "aria-expanded"
    ) === "true";

  boton.setAttribute(
    "aria-expanded",
    abierto
      ? "false"
      : "true"
  );

  contenido.classList.toggle(
    "hidden",
    abierto
  );

  if (!abierto) {
    setTimeout(
      () => {
        $("comentarioPositivo")
          ?.focus();
      },
      80
    );
  }
}

/* =========================================================
   ENVIAR
========================================================= */

async function enviarEncuesta(
  event
) {
  event.preventDefault();

  if (
    !validarEncuestaCompleta()
  ) {
    return;
  }

  if (!state.sesion) {
    mostrarErrorGeneral(
      "Sesión vencida",
      "Debes ingresar nuevamente tu RUT para continuar."
    );

    return;
  }

  if (
    !confirm(
      "¿Enviar definitivamente tu encuesta? Después de enviarla no podrás modificarla."
    )
  ) {
    return;
  }

  setButtonLoading(
    btnEnviarEncuesta,
    true,
    "Enviando...",
    "Enviar encuesta"
  );

  try {
    const respuestas =
      getRespuestasSeleccionadas();

    const respuesta =
      await postPublico(
        FUNCTION_URLS.enviar,
        {
          sesion:
            state.sesion,

          respuestas,

          comentarioPositivo:
            cleanText(
              $("comentarioPositivo")
                ?.value
            ),

          comentarioMejora:
            cleanText(
              $("comentarioMejora")
                ?.value
            ),

          comentarioGeneral:
            cleanText(
              $("comentarioGeneral")
                ?.value
            )
        }
      );

    /*
      Nunca guardamos el RUT en localStorage.
    */
    state.sesion = "";
    state.participante = null;
    state.encuesta = null;
    state.preguntas = [];
    state.respuestas = new Map();

    mostrarFinal(
      "¡Gracias por responder!",
      respuesta.message ||
      "Tu encuesta fue enviada correctamente."
    );
  } catch (error) {
    if (
      error.code ===
        "SESION_INVALIDA" ||
      error.code ===
        "SESION_VENCIDA"
    ) {
      mostrarErrorGeneral(
        "Sesión vencida",
        error.message ||
        "Debes ingresar nuevamente tu RUT."
      );

      return;
    }

    if (
      error.code ===
      "YA_RESPONDIO"
    ) {
      mostrarFinal(
        "¡Muchas gracias!",
        error.message ||
        "Tu participación ya había sido registrada."
      );

      return;
    }

    alert(
      error.message ||
      "No fue posible enviar la encuesta."
    );
  } finally {
    if (
      !pantallaFinal ||
      pantallaFinal.classList.contains(
        "hidden"
      )
    ) {
      setButtonLoading(
        btnEnviarEncuesta,
        false,
        "Enviando...",
        "Enviar encuesta"
      );

      actualizarProgreso();
    }
  }
}

/* =========================================================
   PANTALLA FINAL
========================================================= */

function mostrarFinal(
  titulo,
  mensaje
) {
  $("finalTitulo").textContent =
    titulo ||
    "¡Gracias por responder!";

  $("finalMensaje").textContent =
    mensaje ||
    "Tu encuesta fue enviada correctamente.";

  const botonGoogle =
    $("btnResenaGoogle");

  if (botonGoogle) {
    botonGoogle.href =
      GOOGLE_REVIEW_URL;
  }

  mostrarPantalla(
    "final"
  );
}

/* =========================================================
   EVENTOS
========================================================= */

function conectarEventos() {
  rutNumero?.addEventListener(
    "input",
    normalizarInputRut
  );

  rutDv?.addEventListener(
    "input",
    normalizarInputRut
  );

  rutNumero?.addEventListener(
    "keydown",
    event => {
      if (
        event.key === "Enter"
      ) {
        event.preventDefault();
        rutDv?.focus();
      }
    }
  );

  rutDv?.addEventListener(
    "keydown",
    event => {
      if (
        event.key === "Enter"
      ) {
        event.preventDefault();

        formAcceso
          ?.requestSubmit();
      }
    }
  );

  formAcceso?.addEventListener(
    "submit",
    identificarParticipante
  );

  formEncuesta?.addEventListener(
    "submit",
    enviarEncuesta
  );

  $("btnToggleComentarios")
    ?.addEventListener(
      "click",
      alternarComentarios
    );
}

/* =========================================================
   INICIO
========================================================= */

function init() {
  const params =
    new URLSearchParams(
      window.location.search
    );

  state.token =
    cleanText(
      params.get("token")
    );

  conectarEventos();

  if (!state.token) {
    mostrarErrorGeneral(
      "Enlace incompleto",
      "El enlace no contiene el token de la encuesta."
    );

    return;
  }

  /*
    No mostramos información del grupo antes de
    validar el RUT.
  */
  setTimeout(
    () => {
      mostrarPantalla(
        "acceso"
      );

      rutNumero?.focus();
    },
    250
  );
}

document.addEventListener(
  "DOMContentLoaded",
  init
);
