// Campos opcionales. Conserva los horarios y rutas actuales de viajes.js.
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CAMPOS=[['fechaPresentacionIda','Fecha presentación IDA','date'],['fechaArriboIda','Fecha llegada IDA','date'],['fechaPresentacionVuelta','Fecha presentación REGRESO','date'],['fechaArriboVuelta','Fecha llegada REGRESO','date'],['zonaSalida','Zona horaria del origen','text'],['zonaLlegada','Zona horaria del destino','text']];
const TERRESTRE=[['presentacionIdaHora','Presentación IDA','time'],['arriboIdaHora','Llegada IDA','time'],['presentacionVueltaHora','Presentación REGRESO','time'],['arriboVueltaHora','Llegada REGRESO','time']];
const datos=new Map();
export function camposHorarioExtra(obj={}){return Object.fromEntries([...CAMPOS,...TERRESTRE].map(([k])=>[k,String(obj[k]??'')]));}
function fila(target, campos) {
  const div = document.createElement('div');
  div.style.cssText =
    'display:flex;flex-wrap:wrap;gap:12px;margin:12px 0';

  for (const [key, label, type] of campos) {
    const lab = document.createElement('label');
    lab.dataset.horarioCampo = key;

    lab.innerHTML =
      escape(label) +
      '<br><input type="' + type +
      '" value="' + escape(target[key]) +
      '" style="width:180px"' +
      (key.startsWith('zona')
        ? ' placeholder="America/Santiago"'
        : '') +
      '>';

    lab.querySelector('input').oninput = event => {
      target[key] = event.target.value;
    };

    div.append(lab);
  }

  return div;
}

export function montarHorariosExtra(prefijo, obj = {}, tramos = []) {
  const form = document.getElementById(
    prefijo === 'm' ? 'modal-form' : 'transfer-form'
  );
  if (!form) return;

  let panel = form.querySelector('[data-horarios-extra]');

  if (!panel) {
    panel = document.createElement('details');
    panel.dataset.horariosExtra = '1';
    form.append(panel);
  }

  panel.innerHTML = `
    <summary>Fechas y zonas horarias complementarias</summary>
    <p>
      Campos opcionales. Las horas de presentación se ingresan
      en los campos principales. Las fechas de llegada corresponden
      únicamente al transporte aéreo.
      Las zonas corresponden al origen y destino de IDA;
      en regreso se invierten.
    </p>
  `;

  const model = camposHorarioExtra(obj);
  datos.set(prefijo, model);

  // Las horas se editan en los campos principales.
  panel.append(fila(model, CAMPOS));

  if (tramos.length) {
    panel.append(document.createTextNode(
      'Los campos siguientes corresponden a cada tramo aéreo.'
    ));

    tramos.forEach((tramo, index) => {
      const titulo = document.createElement('h4');
      titulo.textContent = 'Tramo ' + (index + 1);
      panel.append(titulo, fila(tramo, CAMPOS));
    });
  }

  const selector = document.getElementById(
    prefijo === 'm' ? 'm-transporte' : 't-transporte'
  );

  const actualizarVisibilidad = () => {
    const esTerrestre = selector?.value === 'terrestre';

    panel.querySelectorAll('[data-horario-campo]').forEach(label => {
      const key = label.dataset.horarioCampo;
      const esLlegada = key === 'fechaArriboIda' ||
                        key === 'fechaArriboVuelta';

      label.style.display = esTerrestre && esLlegada ? 'none' : '';
      label.querySelectorAll('input').forEach(input => {
        input.disabled = esTerrestre && esLlegada;
      });
    });
  };

  // Evita acumular listeners al abrir repetidamente el modal.
  if (panel._selectorHorarios && panel._listenerHorarios) {
    panel._selectorHorarios.removeEventListener(
      'change',
      panel._listenerHorarios
    );
  }

  panel._selectorHorarios = selector;
  panel._listenerHorarios = actualizarVisibilidad;

  selector?.addEventListener('change', actualizarVisibilidad);
  actualizarVisibilidad();
}

export function montarHorariosTramos(tramos){const model=datos.get('m')||{};montarHorariosExtra('m',model,tramos);}
export function aplicarHorariosExtra(pay, prefijo = 'm') {
  const model = datos.get(prefijo);

  // No sobrescribe campos si el panel no fue montado.
  if (!model) return pay;

  const esTerrestre = pay.tipoTransporte === 'terrestre';

  for (const [key] of CAMPOS) {
    if (
      esTerrestre &&
      (key === 'fechaArriboIda' || key === 'fechaArriboVuelta')
    ) {
      continue;
    }

    pay[key] = String(model[key] ?? '');
  }

  // No copia TERRESTRE: las horas del bus se guardan
  // desde los inputs principales como idaHora y vueltaHora.
  return pay;
}
