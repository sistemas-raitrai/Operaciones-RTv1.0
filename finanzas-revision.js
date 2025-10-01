<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EasyMaker — Rastrea y coordina tus repuestos</title>
  <meta name="description" content="Plataforma minimal y veloz para coordinar mantenimiento, compras y bodega. Encuentra lo que necesitas en el menor tiempo." />
  <style>
    :root{
      /* ===== Paleta negro/metal con acento neón ===== */
      --bg:#0a0a0c; --panel:#0e1118; --stroke:#1b2130;
      --txt:#e9edf3; --muted:#9aa3b6;
      --accent:#27ffd0; --accent2:#7affee; /* neón original */

      /* PATCH: toque azul sutil del PDF (no cambia el look general).
         Si quieres 100% azul, reemplaza --accent/--accent2 por tonos azules. */
      --pdf-blue:#0F3D6E; --pdf-blue-2:#12508F;

      --progress: 0; /* 0 → 1 scroll progress del recorrido */
    }
    html,body{margin:0;height:100%;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif}

    /* ===== PRELOADER: tuerca recorriendo camino (muy veloz) ===== */
    .preloader{position:fixed;inset:0;background:#000;display:grid;place-items:center;z-index:9999;overflow:hidden}
    .skip{position:absolute;top:14px;right:14px;background:rgba(255,255,255,.08);color:#fff;border:1px solid var(--stroke);padding:.32rem .55rem;border-radius:999px;cursor:pointer;font-size:12px}
    .hint{position:absolute;bottom:20px;left:0;right:0;text-align:center;color:#9aa3b6;font-size:12px}
    .trailGlow{filter: drop-shadow(0 0 10px var(--accent2)) drop-shadow(0 0 24px var(--accent))}
    @keyframes dash { to { stroke-dashoffset: 0; } }

    /* ===== GENERAL LAYOUT ===== */
    header{padding:16px 20px;background:#0b0e14;color:#fff;position:sticky;top:0;z-index:5;display:flex;align-items:center;border-bottom:1px solid var(--stroke)}
    .brand{font-weight:800;font-size:18px;letter-spacing:.3px}
    .brand b{color:var(--accent)}
    .cta{margin-left:auto;background:linear-gradient(90deg,#1efccf,#6ffff0);color:#001015;padding:.6rem 1rem;border:0;border-radius:12px;font-weight:800;cursor:pointer}

    /* PATCH: leve tinte azul del PDF en el fondo del hero (sin perder el neón) */
    .hero{
      min-height:66vh;display:grid;place-items:center;text-align:center;padding:72px 20px;
      background:
        radial-gradient(900px 520px at 12% 8%, #27ffd00f 0%, transparent 60%),
        radial-gradient(1200px 620px at 100% -10%, color-mix(in oklab, var(--pdf-blue) 25%, transparent) 0%, transparent 60%);
    }
    .hero h1{font-size:clamp(28px,4.2vw,54px);margin:0 0 10px;text-wrap:balance}
    .hero p{color:var(--muted);margin:0 0 20px}

    /* ============ Recorrido central que acompaña todo ============ */
    .pathWrap{position:relative}
    .pathWrap:before{
      content:"";position:absolute;left:50%;top:0;width:2px;height:100%;
      background:linear-gradient(#1b2130,#27ffd055,#1b2130);
      transform-origin: top; transform: translateX(-50%) scaleY(var(--progress)); /* centrado perfecto también en móvil */
    }

    .section{padding:48px 20px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;max-width:1100px;margin:0 auto}
    .card{background:var(--panel);border:1px solid var(--stroke);border-radius:16px;padding:18px}
    .card h3{margin:.2rem 0}
    .card p{margin:.25rem 0;color:var(--muted);font-size:14px}

    /* Hitos de la ruta (nodos) */
    .node{position:relative;max-width:1100px;margin:0 auto}
    .node:before{content:"";position:absolute;left:50%;top:-8px;width:12px;height:12px;border-radius:50%;background:var(--accent);box-shadow:0 0 14px var(--accent2);transform:translateX(-50%)}

    /* Stepper (cómo funciona) */
    .steps{max-width:900px;margin:0 auto;display:grid;gap:18px}
    .step{display:grid;grid-template-columns:56px 1fr;gap:12px;align-items:start}
    .badge{width:56px;height:56px;border-radius:14px;background:#0f1320;border:1px solid var(--stroke);display:grid;place-items:center;color:var(--accent);font-weight:800}
    .step p{margin:.25rem 0;color:var(--muted)}

    /* Imagen Laptop */
    .laptop-section{display:flex;justify-content:center;align-items:center;margin:40px 0}
    .laptop-section img{max-width:800px;width:100%;height:auto;display:block;box-shadow:0 4px 15px rgba(0,0,0,0.3);border-radius:8px}

    /* CTA final */
    .strip{background:#0b0f16;border-top:1px solid var(--stroke);border-bottom:1px solid var(--stroke);padding:30px 20px;text-align:center}

    footer{padding:36px 20px;text-align:center;color:var(--muted)}

    /* ===== Formulario de contacto: campos 1 por línea ===== */
    .contact-wrap{max-width:900px;margin:0 auto}
    .contact-wrap h2{margin:0 0 8px}
    .contact-wrap p{margin:0}
    .form{margin:18px auto 0;max-width:760px;background:var(--panel);border:1px solid var(--stroke);border-radius:16px;padding:18px}
    .form label{display:block;text-align:left;margin-bottom:12px}
    .form label span{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
    .form input,.form textarea{width:100%;background:#0c1118;border:1px solid #141a24;border-radius:12px;color:var(--txt);padding:.7rem .8rem;font:inherit;box-sizing:border-box}
    .form textarea{min-height:120px;resize:vertical}
    .form input:focus,.form textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(39,255,208,.12)}
    .form .cta{margin-top:6px}
    .form small{display:inline-block;margin-left:8px;color:var(--muted)}
    .form-msg{margin-top:10px;color:var(--muted)}
    @media (max-width:600px){ .form{padding:14px} }

    /* Animaciones suaves al entrar */
    [data-reveal]{opacity:0;transform:translateY(10px)}
    .show{opacity:1;transform:none;transition:.5s ease}

    @media (prefers-reduced-motion: reduce){ .preloader *{animation:none !important;transition:none !important} }
    /* ===== Ajustes responsivos del preloader (1:1) y centrado laptop ===== */
    .preloader .frame{aspect-ratio:1; width:min(90vmin,560px); max-width:560px; display:grid; place-items:center}
    .preloader svg{width:100%; height:100%}
    @media (max-width:600px){ .trailGlow{filter: drop-shadow(0 0 6px var(--accent2)) drop-shadow(0 0 14px var(--accent))} }

    /* Fuerza centrado absoluto de la imagen de laptop en pantallas grandes */
    .laptop-section{display:flex; justify-content:center; align-items:center; margin:40px 0; width:100%; text-align:center}
    .laptop-section img{width:min(90vw, 900px); height:auto; margin:0 auto; display:block; box-shadow:0 4px 15px rgba(0,0,0,.3); border-radius:8px}

    /* ===== Créditos y ajustes móviles ===== */
    .credits{padding:14px 20px;text-align:center;color:var(--muted);border-top:1px solid var(--stroke);background:#0a0d12}
    .credits a{color:var(--accent);text-decoration:none}
    .credits a:hover{text-decoration:underline}

    /* PATCH: Ocultar los puntos/nodos y la línea central en móvil para limpiar la lectura */
    @media (max-width: 640px){
      .node:before{display:none}
      .pathWrap:before{display:none}
    }
  </style>
</head>
<body>
  <!-- ===== PRELOADER RÁPIDO (LABERINTO) ===== -->
  <div class="preloader">
    <button class="skip" id="skipBtn">Saltar</button>
    <div class="frame">
      <svg viewBox="0 0 560 560" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        <!-- Recorrido 1:1 pensado para un canvas cuadrado 560x560 -->
        <path id="mazePath" class="trailGlow" d="M40 520 H260 V80 H520 V340 H340 V220 H140 V440 H480" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <!-- Tuerca (nut) que recorre el camino -->
        <g id="nut" class="trailGlow">
          <polygon points="0,-12 10,-6 10,6 0,12 -10,6 -10,-6" fill="var(--accent)"/>
          <circle r="4" fill="#0b0f1a" />
        </g>
        <!-- Destino pulsante al final del recorrido -->
        <g transform="translate(480,440)">
          <circle r="10" fill="none" stroke="var(--accent)" stroke-width="3" opacity=".6">
            <animate attributeName="r" values="8;12;8" dur="1.0s" repeatCount="indefinite"/>
          </circle>
          <circle r="4" fill="var(--accent)"/>
        </g>
        <defs>
          <!-- PATCH: si quieres acento AZUL, cambia los stops a tonos azules -->
          <linearGradient id="g" x1="0" y1="0" x2="560" y2="0" gradientUnits="userSpaceOnUse">
            <stop stop-color="#27ffd0"/>
            <stop offset="1" stop-color="#7affee"/>
          </linearGradient>
        </defs>
      </svg>
    </div>
    <div class="hint">Encontrando la mejor ruta…</div>
  </div>

  <!-- ===== CABECERA ===== -->
  <header>
    <div class="brand">easy<b>maker</b></div>
    <button class="cta" onclick="document.getElementById('contacto').scrollIntoView({behavior:'smooth'})">Contáctanos</button>
  </header>

  <div class="pathWrap" id="ruta">
    <!-- ===== HERO ===== -->
    <section class="hero node">
      <div data-reveal>
        <!-- PATCH: copy enfocado en OPERACIÓN -->
        <h1>Mantenimiento, compras y bodega conectados: visibilidad total</h1>
        <p>EasyMaker alinea las áreas operativas para planificar mantenciones sin urgencias y con repuestos asegurados.</p>
        <button class="cta" onclick="document.getElementById('quees').scrollIntoView({behavior:'smooth'})">Cómo funciona</button>
      </div>
    </section>

    <!-- ===== IMAGEN LAPTOP ===== -->
    <section class="laptop-section node">
      <!-- Mantén tu asset original; puedes reemplazar por un mock nuevo -->
      <img src="Laptop.png" alt="Vista previa EasyMaker en Laptop" data-reveal>
    </section>

    <!-- ===== ¿QUÉ ES? ===== -->
    <section id="quees" class="section node">
      <div class="node" style="max-width:900px" data-reveal>
        <h2>¿Qué es EasyMaker?</h2>
        <!-- PATCH: contenido adaptado a Operación -->
        <p style="color:var(--muted);font-size:18px;line-height:1.5">
          EasyMaker conecta <b>mantención</b>, <b>compras</b> y <b>bodega</b> para que cada Orden de Mantención se ejecute con <b>repuestos garantizados</b>, trazabilidad y cero sorpresas.
        </p>
        <p style="color:var(--muted);font-size:18px;line-height:1.5">
          Resultado: <b>menos detenciones</b>, <b>cero urgencias</b> y un flujo de trabajo claro del <i>pedido</i> al <i>montaje</i>.
        </p>
      </div>
    </section>

    <!-- ===== BENEFICIOS (tarjetas) ===== -->
    <section id="beneficios" class="section node">
      <div class="grid" data-reveal>
        <article class="card">
          <h3>Anticipación</h3>
          <p>Proyecta necesidades de repuestos y agenda mantenciones críticas con señales tempranas.</p>
        </article>
        <article class="card">
          <h3>Coordinación</h3>
          <p>Sincroniza compras y bodega con mantención, con estado en tiempo real de cada pieza.</p>
        </article>
        <article class="card">
          <h3>Planificación crítica</h3>
          <p>Bloques visuales para las OM que no se pueden caer: stock y proveedores confirmados.</p>
        </article>
        <article class="card">
          <h3>Catálogo inteligente</h3>
          <p>Encuentra rápido repuestos, equivalentes y proveedores con historial de trazabilidad.</p>
        </article>
      </div>
    </section>

    <!-- ===== DISEÑADO PARA OPERACIONES REALES ===== -->
    <section class="section node">
      <div class="node" style="max-width:900px" data-reveal>
        <h2>Diseñado para operación real, no para llenar formularios</h2>
        <ul style="color:var(--muted);line-height:1.7;font-size:16px">
          <li><strong>OM con garantías:</strong> No se agenda si el kit de repuestos no está asegurado.</li>
          <li><strong>Ligero y rápido:</strong> Se implementa sin el peso de un ERP completo.</li>
          <li><strong>Trazabilidad completa:</strong> Pedido, stock, tránsito y entrega en una sola vista.</li>
        </ul>
      </div>
    </section>

    <!-- ===== CÓMO FUNCIONA (recorrido breve) ===== -->
    <section class="section node">
      <div class="steps" data-reveal>
        <div class="step">
          <div class="badge">1</div>
          <div>
            <h3>Detecta</h3>
            <p>Señales de mantención: sensor, OT o alerta del jefe de área.</p>
          </div>
        </div>
        <div class="step">
          <div class="badge">2</div>
          <div>
            <h3>Encuentra</h3>
            <p>Catálogo, equivalentes y stock; elige proveedor y fecha de entrega.</p>
          </div>
        </div>
        <div class="step">
          <div class="badge">3</div>
          <div>
            <h3>Coordina</h3>
            <p>Compras y bodega sincronizadas; repuesto a tiempo para ejecutar la OM.</p>
          </div>
        </div>
      </div>
    </section>
  </div>

  <!-- ===== CTA intermedio ===== -->
  <div class="strip" data-reveal>
    <strong>Si no tienes visibilidad, no tienes control.</strong>
  </div>

  <!-- ===== CONTACTO ===== -->
  <footer id="contacto">
    <div class="contact-wrap">
      <h2>¿Hablamos?</h2>
      <p style="opacity:.85">Escríbenos a <a href="mailto:hola@easymaker.cl" style="color:#b8ffe6">hola@easymaker.cl</a> o usa el formulario:</p>

      <form id="contactForm" class="form" novalidate>
        <label>
          <span>Nombre y Apellido *</span>
          <input type="text" name="nombre" required placeholder="Tu nombre" />
        </label>
        <label>
          <span>Correo electrónico *</span>
          <input type="email" name="correo" required placeholder="tu@empresa.com" />
        </label>
        <label>
          <span>Teléfono celular</span>
          <input type="tel" name="telefono" placeholder="+56 9 1234 5678" />
        </label>
        <label>
          <span>Asunto</span>
          <input type="text" name="asunto" placeholder="Consulta / Demo / Soporte" />
        </label>
        <label>
          <span>Mensaje</span>
          <textarea name="mensaje" rows="6" placeholder="Cuéntanos qué necesitas"></textarea>
        </label>
        <button class="cta" type="submit">Enviar</button>
        <small>* Campos obligatorios</small>
        <div id="formMsg" class="form-msg" role="status" aria-live="polite"></div>
      </form>
    </div>
  </footer>

  <!-- ===== Créditos ===== -->
  <div class="credits">
    Diseño & desarrollo web — <a href="https://www.ignovacion.com" target="_blank" rel="noopener">ignovacion.com</a>
  </div>

  <script>
  window.addEventListener('DOMContentLoaded', () => {
    // ===== Preloader ultra-rápido y robusto =====
    const path = document.getElementById('mazePath');
    const nut  = document.getElementById('nut');
    const pre  = document.querySelector('.preloader');
    const skip = document.getElementById('skipBtn');

    const MAX_PRELOAD_MS = 4000;   // Fallback por si algo falla
    const FADE_OUT_MS     = 340;   // Duración del fade-out

    function revealContent() {
      document.querySelectorAll('[data-reveal]').forEach(el => el.classList.add('show'));
    }
    function hidePreloader() {
      if (!pre || !document.body.contains(pre)) return;
      pre.style.transition = `opacity ${FADE_OUT_MS}ms ease`;
      pre.style.opacity = '0';
      setTimeout(() => { if (pre && pre.parentNode) pre.parentNode.removeChild(pre); }, FADE_OUT_MS + 40);
      revealContent();
    }

    // Botón "Saltar"
    skip?.addEventListener('click', hidePreloader);

    try {
      const totalLen = path.getTotalLength();
      path.style.strokeDasharray  = totalLen;
      path.style.strokeDashoffset = totalLen;
      path.style.animation = 'dash 1.0s ease-out forwards';

      let start = null;
      const duration = 1500; // ms (ajusta la velocidad aquí)

      function animateNut(ts){
        if(!start) start = ts;
        const p  = Math.min(1, (ts - start) / duration);
        const pt = path.getPointAtLength(totalLen * p);
        nut.setAttribute('transform', `translate(${pt.x},${pt.y}) rotate(${p*540})`);
        if (p < 1) requestAnimationFrame(animateNut);
        else hidePreloader();
      }

      requestAnimationFrame(animateNut);
    } catch (e) {
      console.error('Preloader fallback:', e);
      hidePreloader();
    }

    // Fallback por tiempo máximo
    setTimeout(hidePreloader, MAX_PRELOAD_MS);

    // ===== Recorrido central crece con el scroll =====
    const wrap = document.getElementById('ruta');
    function updateProgress(){
      const r = wrap.getBoundingClientRect();
      const vh = window.innerHeight;
      const total  = r.height - vh * 0.2;             // margen para no llegar al 100% tan pronto
      const passed = Math.min(Math.max(vh*0.3 - r.top, 0), total);
      const p = total > 0 ? passed / total : 0;
      document.documentElement.style.setProperty('--progress', p);
    }
    updateProgress();
    window.addEventListener('scroll', updateProgress, {passive:true});
    window.addEventListener('resize', updateProgress);

    // Entrada suave al hacer scroll
    const obs = new IntersectionObserver((entries)=>{
      entries.forEach(e=>{ if(e.isIntersecting) e.target.classList.add('show'); });
    }, { threshold: .15 });
    document.querySelectorAll('[data-reveal]').forEach(el => obs.observe(el));

    // ===== Formulario: crea un mailto a hola@easymaker.cl =====
    const form = document.getElementById('contactForm');
    const formMsg = document.getElementById('formMsg');
    form?.addEventListener('submit', (e)=>{
      e.preventDefault();
      const fd = new FormData(form);
      const nombre = (fd.get('nombre')||'').toString().trim();
      const correo = (fd.get('correo')||'').toString().trim();
      const telefono = (fd.get('telefono')||'').toString().trim();
      const asunto = (fd.get('asunto')||'Consulta desde easymaker.cl').toString().trim() || 'Consulta desde easymaker.cl';
      const mensaje = (fd.get('mensaje')||'').toString().trim();

      if(!nombre || !correo){
        formMsg.textContent = 'Por favor completa Nombre y Apellido y tu correo.';
        return;
      }
      const body = `Nombre y Apellido: ${nombre}%0D%0AEmail: ${correo}%0D%0ATeléfono: ${telefono || '-'}%0D%0AMensaje:%0D%0A${encodeURIComponent(mensaje)}`;
      const mailto = `mailto:hola@easymaker.cl?subject=${encodeURIComponent(asunto)}&body=${body}`;
      window.location.href = mailto;
      formMsg.textContent = 'Abriendo tu correo para enviar el mensaje…';
    });
  });
  </script>
</body>
</html>
