// encuesta.js
// Encuesta pública de viaje
// No consulta Firestore directamente.
// Toda validación se realiza mediante Cloud Functions.

const FUNCTION_URLS = Object.freeze({
  identificar:
    "https://identificarparticipanteencuesta-r3llfis4wa-tl.a.run.app",

  enviar:
    "https://enviarrespuestaencuesta-r3llfis4wa-tl.a.run.app"
});

/* =========================================================
   ESTADO
========================================================= */

const state = {
  token: "",
  sesion: "",
  participante: null,
  encuesta: null,
  preguntas: []
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

function formatDate(value = "") {
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
    .forEach(([key, element]) => {
      element?.classList.toggle(
        "hidden",
        key !== nombre
      );
    });

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
      formatDate(
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
  if (!button) return;

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
  } catch (error) {
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
  if (!rutNumero || !rutDv) {
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
    formatearRutNumero(numero);

  rutDv.value =
    dv;

  const completo =
    getRutCompleto();

  rutNumero.classList.toggle(
    "input-error",
    !!numero &&
    numero.length >= 7 &&
    !!dv &&
    !completo
  );

  rutDv.classList.toggle(
    "input-error",
    !!numero &&
    numero.length >= 7 &&
    !!dv &&
    !completo
  );

  if (!numero || !dv) {
    rutHint.textContent =
      "Ingresa el número y el dígito verificador.";

    return;
  }

  if (completo) {
    rutHint.textContent =
      "RUT válido ✓";
  } else {
    rutHint.textContent =
      "El RUT ingresado no es válido.";
  }
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

    rutNumero.classList.add(
      "input-error"
    );

    rutDv.classList.add(
      "input-error"
    );

    rutNumero.focus();

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
      respuesta.sesion;

    state.participante =
      respuesta.participante ||
      {};

    state.encuesta =
      respuesta.encuesta ||
      {};

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

function manejarErrorAcceso(error = {}) {
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
    code === "ENCUESTA_CERRADA"
  ) {
    mostrarErrorGeneral(
      "Encuesta cerrada",
      error.message
    );

    return;
  }

  if (
    code === "ENCUESTA_NO_DISPONIBLE" ||
    code === "ENLACE_INVALIDO"
  ) {
    mostrarErrorGeneral(
      "Encuesta no disponible",
      error.message
    );

    return;
  }

  if (
    code === "RUT_NO_PERTENECE"
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
   CONSTRUIR ENCUESTA
========================================================= */

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

  const datos = [
    encuesta.colegio,
    encuesta.curso,
    encuesta.destino,
    encuesta.programa
  ]
    .map(cleanText)
    .filter(Boolean);

  $("datosEncuesta").innerHTML =
    datos.length
      ? datos
          .map(
            (item, index) =>
              index === 0
                ? `<strong>${escapeHtml(item)}</strong>`
                : `<span>${escapeHtml(item)}</span>`
          )
          .join("")
      : `
          <strong>
            Viaje de estudios
          </strong>
        `;

  state.preguntas =
    construirPreguntas(
      encuesta.preguntas ||
      {}
    );

  renderPreguntas();
  actualizarProgreso();
}

function construirPreguntas(
  preguntasBackend = {}
) {
  const preguntas = [];

  function agregarLista(
    lista,
    tipo,
    seccion
  ) {
    (
      Array.isArray(lista)
        ? lista
        : []
    ).forEach(item => {
      preguntas.push({
        preguntaId:
          `${tipo}:${item.id}`,

        tipo,

        seccion,

        nombre:
          cleanText(
            item.nombre
          ),

        proveedor:
          cleanText(
            item.proveedor
          ),

        fecha:
          cleanText(
            item.fecha
          )
      });
    });
  }

  agregarLista(
    preguntasBackend.actividades,
    "actividad",
    "Actividades"
  );

  agregarLista(
    preguntasBackend.hoteles,
    "hotel",
    "Hotel"
  );

  agregarLista(
    preguntasBackend.transportes,
    "transporte",
    "Transporte"
  );

  agregarLista(
    preguntasBackend.coordinadores,
    "coordinador",
    "Coordinadores"
  );

  preguntas.push({
    preguntaId:
      "general:viaje",

    tipo:
      "general",

    seccion:
      "Evaluación general",

    nombre:
      "¿Cómo evaluarías el viaje en general?",

    proveedor: "",
    fecha: ""
  });

  return preguntas;
}

function getTituloPregunta(
  pregunta
) {
  if (
    pregunta.tipo ===
    "actividad"
  ) {
    return `¿Cómo evaluarías ${pregunta.nombre}?`;
  }

  if (
    pregunta.tipo ===
    "hotel"
  ) {
    return `¿Cómo evaluarías el hotel ${pregunta.nombre}?`;
  }

  if (
    pregunta.tipo ===
    "transporte"
  ) {
    return `¿Cómo evaluarías ${pregunta.nombre}?`;
  }

  if (
    pregunta.tipo ===
    "coordinador"
  ) {
    return `¿Cómo evaluarías al coordinador(a) ${pregunta.nombre}?`;
  }

  return pregunta.nombre;
}

function getMetaPregunta(
  pregunta
) {
  const partes = [];

  if (pregunta.fecha) {
    const fecha =
      new Date(
        `${pregunta.fecha}T12:00:00`
      );

    if (
      !Number.isNaN(
        fecha.getTime()
      )
    ) {
      partes.push(
        fecha.toLocaleDateString(
          "es-CL",
          {
            day: "2-digit",
            month: "long"
          }
        )
      );
    }
  }

  if (pregunta.proveedor) {
    partes.push(
      pregunta.proveedor
    );
  }

  return partes.join(" · ");
}

function renderPreguntas() {
  if (!contenedorPreguntas) {
    return;
  }

  if (!state.preguntas.length) {
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
      .map((pregunta, index) => {
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

        const meta =
          getMetaPregunta(
            pregunta
          );

        return `
          ${tituloSeccion}

          <article
            class="question-card"
            data-pregunta-id="${escapeHtml(pregunta.preguntaId)}"
          >

            <div class="question-number">
              Pregunta ${index + 1} de ${state.preguntas.length}
            </div>

            <div class="question-title">
              ${escapeHtml(getTituloPregunta(pregunta))}
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

            <div
              class="rating-grid"
              role="radiogroup"
              aria-label="${escapeHtml(getTituloPregunta(pregunta))}"
            >

              ${crearOpcionEvaluacion({
                preguntaId:
                  pregunta.preguntaId,

                valor:
                  "muy_bueno",

                etiqueta:
                  "Muy bueno",

                clase:
                  "very-good"
              })}

              ${crearOpcionEvaluacion({
                preguntaId:
                  pregunta.preguntaId,

                valor:
                  "bueno",

                etiqueta:
                  "Bueno",

                clase:
                  "good"
              })}

              ${crearOpcionEvaluacion({
                preguntaId:
                  pregunta.preguntaId,

                valor:
                  "regular",

                etiqueta:
                  "Regular",

                clase:
                  "regular"
              })}

              ${crearOpcionEvaluacion({
                preguntaId:
                  pregunta.preguntaId,

                valor:
                  "malo",

                etiqueta:
                  "Malo",

                clase:
                  "bad"
              })}

            </div>

          </article>
        `;
      })
      .join("");

  contenedorPreguntas
    .querySelectorAll(
      'input[type="radio"]'
    )
    .forEach(input => {
      input.addEventListener(
        "change",
        () => {
          const card =
            input.closest(
              ".question-card"
            );

          card?.classList.remove(
            "has-error"
          );

          actualizarProgreso();
        }
      );
    });
}

function crearOpcionEvaluacion({
  preguntaId,
  valor,
  etiqueta,
  clase
}) {
  const name =
    `respuesta_${preguntaId}`;

  const id =
    `${name}_${valor}`
      .replace(/[^a-zA-Z0-9_-]/g, "_");

  return `
    <label
      class="rating-option ${escapeHtml(clase)}"
      for="${escapeHtml(id)}"
    >

      <input
        id="${escapeHtml(id)}"
        type="radio"
        name="${escapeHtml(name)}"
        value="${escapeHtml(valor)}"
        data-pregunta-id="${escapeHtml(preguntaId)}"
        required
      >

      <span>
        ${escapeHtml(etiqueta)}
      </span>

    </label>
  `;
}

/* =========================================================
   PROGRESO
========================================================= */

function getRespuestasSeleccionadas() {
  return [
    ...contenedorPreguntas
      .querySelectorAll(
        'input[type="radio"]:checked'
      )
  ].map(input => ({
    preguntaId:
      input.dataset.preguntaId,

    valor:
      input.value
  }));
}

function actualizarProgreso() {
  const total =
    state.preguntas.length;

  const respondidas =
    getRespuestasSeleccionadas()
      .length;

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

  $("progresoValor")
    .setAttribute(
      "aria-valuenow",
      String(porcentaje)
    );
}

/* =========================================================
   VALIDAR Y ENVIAR
========================================================= */

function validarEncuestaCompleta() {
  let primeraPendiente =
    null;

  state.preguntas.forEach(
    pregunta => {
      const card =
        contenedorPreguntas
          .querySelector(
            `[data-pregunta-id="${CSS.escape(pregunta.preguntaId)}"]`
          );

      const checked =
        card?.querySelector(
          'input[type="radio"]:checked'
        );

      card?.classList.toggle(
        "has-error",
        !checked
      );

      if (
        !checked &&
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
    resumen.classList.add(
      "open"
    );

    primeraPendiente.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });

    return false;
  }

  resumen.classList.remove(
    "open"
  );

  return true;
}

async function enviarEncuesta(
  event
) {
  event.preventDefault();

  if (
    !validarEncuestaCompleta()
  ) {
    return;
  }

  if (
    !state.sesion
  ) {
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
      Se limpia la sesión del navegador después
      del envío. No guardamos RUT en localStorage.
    */
    state.sesion = "";
    state.participante = null;
    state.encuesta = null;
    state.preguntas = [];

    mostrarFinal(
      "¡Muchas gracias!",
      respuesta.message ||
      "Tu respuesta fue registrada de manera anónima."
    );

  } catch (error) {
    if (
      error.code ===
      "SESION_INVALIDA"
    ) {
      mostrarErrorGeneral(
        "Sesión vencida",
        error.message
      );

      return;
    }

    if (
      error.code ===
      "ENCUESTA_CERRADA"
    ) {
      mostrarErrorGeneral(
        "Encuesta cerrada",
        error.message
      );

      return;
    }

    if (
      error.code ===
      "YA_RESPONDIO"
    ) {
      mostrarFinal(
        "¡Muchas gracias!",
        "Tu participación ya había sido registrada."
      );

      return;
    }

    $("resumenErrores").textContent =
      error.message ||
      "No fue posible enviar la encuesta. Inténtalo nuevamente.";

    $("resumenErrores")
      .classList.add("open");

    $("resumenErrores")
      .scrollIntoView({
        behavior: "smooth",
        block: "center"
      });

  } finally {
    setButtonLoading(
      btnEnviarEncuesta,
      false,
      "Enviando...",
      "Enviar encuesta"
    );
  }
}

function mostrarFinal(
  titulo,
  mensaje
) {
  $("finalTitulo").textContent =
    titulo ||
    "¡Muchas gracias!";

  $("finalMensaje").textContent =
    mensaje ||
    "Tu respuesta fue registrada de manera anónima.";

  mostrarPantalla(
    "final"
  );
}

/* =========================================================
   INICIO
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
}

function init() {
  conectarEventos();

  const params =
    new URLSearchParams(
      window.location.search
    );

  state.token =
    cleanText(
      params.get("token")
    );

  if (!state.token) {
    mostrarErrorGeneral(
      "Enlace incompleto",
      "Este enlace no contiene el token necesario para acceder a la encuesta."
    );

    return;
  }

  $("textoCarga").textContent =
    "Enlace recibido. Preparando acceso.";

  /*
    No consultamos Firestore ni mostramos información
    del grupo antes de que la persona valide su RUT.
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
