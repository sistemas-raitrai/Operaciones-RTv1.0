<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <title>Itinerario de Grupo | RT v1.0</title>
  <!-- 1) CSS global + específico -->
  <link rel="stylesheet" href="estilos.css" />
</head>
<body class="itinerario-page">

  <!-- 2) Encabezado reutilizable -->
  <div id="encabezado"></div>
  <script type="module">
    (async () => {
      // Carga el header común y el script.js para reloj/logout/etc.
      const html = await (await fetch('encabezado.html')).text();
      document.getElementById('encabezado').innerHTML = html;
      await import('./script.js');
    })();
  </script>

  <main class="main">
    <!-- 3) Selector de grupo -->
    <div class="row">
      <div class="column long">
        <h2>Programa: <span id="grupo-title">–</span></h2>
      </div>
      <div class="column medium">
        <label for="grupo-select-name">Nombre de Grupo</label>
        <select id="grupo-select-name">
          <option value="">Cargando…</option>
        </select>
      </div>
      <div class="column short">
        <label for="grupo-select-num">N° Negocio</label>
        <select id="grupo-select-num">
          <option value="">Cargando…</option>
        </select>
      </div>
    </div>

    <!-- 4) Panel de creación rápida -->
    <section id="quick-add" class="quick-add">
      <h3>Programar Actividad</h3>
      <div class="row">
        <div class="column short">
          <label for="qa-dia">Día</label>
          <select id="qa-dia"></select>
        </div>
        <div class="column short">
          <label for="qa-horaInicio">Hora inicio</label>
          <input type="time" id="qa-horaInicio" value="07:00" />
        </div>
        <div class="column medium">
          <label for="qa-actividad">Actividad</label>
          <input type="text" id="qa-actividad" placeholder="Nombre de la actividad" />
        </div>
        <div class="column short">
          <label>&nbsp;</label>
          <button id="qa-add" class="btn-add">Añadir</button>
        </div>
      </div>
    </section>

    <!-- 5) Carrusel de días -->
    <div id="itinerario-container" class="grid">
      <!-- Las secciones de cada día se insertarán aquí dinámicamente -->
    </div>
  </main>

  <!-- 6) Modal de actividad -->
  <div id="modal-backdrop" class="modal-backdrop" style="display:none;"></div>
  <div id="modal" class="modal" style="display:none;">
    <h3 id="modal-title">Actividad</h3>
    <form id="modal-form">
      <label for="m-fecha">Fecha</label>
      <select id="m-fecha"></select>

      <label for="m-horaInicio">Hora Inicio</label>
      <input type="time" id="m-horaInicio" />

      <label for="m-horaFin">Hora Fin</label>
      <input type="time" id="m-horaFin" />

      <label for="m-actividad">Actividad</label>
      <input type="text" id="m-actividad" />

      <label for="m-pasajeros">Pasajeros</label>
      <input type="number" id="m-pasajeros" min="1" />

      <label for="m-notas">Notas</label>
      <textarea id="m-notas" rows="2"></textarea>

      <div class="actions">
        <button type="button" id="modal-cancel">Cancelar</button>
        <button type="submit" id="modal-save">Guardar</button>
      </div>
    </form>
  </div>

  <!-- 7) Firebase + jQuery + script específico -->
  <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
  <script type="module" src="itinerario.js"></script>
</body>
</html>
