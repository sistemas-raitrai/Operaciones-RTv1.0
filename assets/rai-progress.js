// assets/rai-progress.js

window.RaiProgress = {
  ensure() {
    if (document.getElementById('loadBox')) return;

    const box = document.createElement('div');
    box.id = 'loadBox';
    box.innerHTML = `
      <div class="rai-load-card">
        <div class="rai-load-head">
          <strong id="loadTitle">Cargando...</strong>
          <span id="loadPercent">0%</span>
        </div>
        <div id="loadDetail">Preparando información...</div>
        <div class="rai-load-bar">
          <div id="loadProgress"></div>
        </div>
      </div>
    `;
    document.body.appendChild(box);

    const style = document.createElement('style');
    style.id = 'rai-progress-style';
    style.textContent = `
      #loadBox{
        position:fixed;
        left:24px;
        right:24px;
        bottom:24px;
        z-index:99999;
        display:none;
        pointer-events:none;
      }

      #loadBox .rai-load-card{
        max-width:520px;
        margin-left:auto;
        background:#ffffff;
        border:1px solid #e5e7eb;
        border-radius:14px;
        box-shadow:0 12px 30px rgba(0,0,0,.18);
        padding:14px 16px;
        font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        color:#111827;
      }

      .rai-load-head{
        display:flex;
        justify-content:space-between;
        gap:12px;
        margin-bottom:6px;
        font-size:14px;
      }

      #loadDetail{
        font-size:13px;
        color:#4b5563;
        margin-bottom:10px;
      }

      .rai-load-bar{
        height:8px;
        background:#e5e7eb;
        border-radius:999px;
        overflow:hidden;
      }

      #loadProgress{
        height:100%;
        width:0%;
        background:#2563eb;
        transition:width .25s ease;
      }

      #loadBox.ok #loadProgress{
        background:#16a34a;
      }

      #loadBox.error #loadProgress{
        background:#dc2626;
      }
    `;
    document.head.appendChild(style);
  },

  set(porcentaje, titulo, detalle = '') {
    this.ensure();

    const box = document.getElementById('loadBox');
    const bar = document.getElementById('loadProgress');
    const title = document.getElementById('loadTitle');
    const detail = document.getElementById('loadDetail');
    const percent = document.getElementById('loadPercent');

    const p = Math.max(0, Math.min(100, Number(porcentaje) || 0));

    box.classList.remove('ok', 'error');
    box.style.display = 'block';

    bar.style.width = `${p}%`;
    title.textContent = titulo || 'Cargando...';
    detail.textContent = detalle || '';
    percent.textContent = `${p}%`;
  },

  ok(detalle = 'Datos cargados correctamente.') {
    this.ensure();

    const box = document.getElementById('loadBox');
    box.classList.remove('error');
    box.classList.add('ok');

    document.getElementById('loadProgress').style.width = '100%';
    document.getElementById('loadTitle').textContent = 'Listo';
    document.getElementById('loadDetail').textContent = detalle;
    document.getElementById('loadPercent').textContent = '100%';

    setTimeout(() => {
      box.style.display = 'none';
    }, 1800);
  },

  error(error) {
    this.ensure();

    const box = document.getElementById('loadBox');
    box.classList.remove('ok');
    box.classList.add('error');

    document.getElementById('loadProgress').style.width = '100%';
    document.getElementById('loadTitle').textContent = 'Error al cargar';
    document.getElementById('loadDetail').textContent =
      error?.message || String(error) || 'Error desconocido. Revisa la consola.';
    document.getElementById('loadPercent').textContent = '100%';
  },

  hide() {
    const box = document.getElementById('loadBox');
    if (box) box.style.display = 'none';
  }
};
