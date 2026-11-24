import { app, db } from './firebase-init.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-auth.js';
import { collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.7.3/firebase-functions.js';

const $ = id => document.getElementById(id);
const api = httpsCallable(getFunctions(app, 'southamerica-west1'), 'gestionarLiquidacionFinanzas', { timeout: 540000 });
const state = { user: null, ano: null, grupos: [], obligaciones: [], abonos: [], tasas: new Map(), carga: 0, listo: false };
const form = $('formulario');
const cents = n => Math.round(Number(n) * 100);
const validMoney = n => n != null && n !== '' && Number.isFinite(Number(n));
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const currency = o => String(o.monedaObligacion ?? '').toUpperCase();
const validCurrency = m => /^[A-Z]{3}$/.test(m);
const money = (n, m) => validMoney(n) && validCurrency(m)
  ? new Intl.NumberFormat('es-CL', { style: 'currency', currency: m, currencyDisplay: 'code', maximumFractionDigits: 2 }).format(n)
  : 'Por configurar';
const groupName = g => [g.numero, g.nombre].filter(Boolean).join(' · ');
const concept = o => o.asunto || o.servicioNombre || o.hotelNombre || 'Costo acordado';
const other = o => o.fuente === 'GASTO_OTROS';
const covered = o => other(o) && o.incluidoCostoCuenta;
const scopedGroups = () => state.grupos.filter(g => !$('destino').value || g.destinos.has($('destino').value));
const list = (name, year) => getDocs(query(collection(db, name), where('anoViaje', '==', year)));
const call = async (accion, anoViaje, data = {}) => (await api({ ...data, accion, anoViaje })).data;
const records = snap => snap.docs.map(doc => ({ ...doc.data(), id: doc.id }));
$('ano').value = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'America/Santiago' }).format(new Date());

function options(select, values, empty) {
  const previous = select.value;
  select.replaceChildren(...(empty ? [new Option(empty, '')] : []), ...values.map(([id, name]) => new Option(name, id)));
  if ([...select.options].some(x => x.value === previous)) select.value = previous;
}

async function load(year = Number($('ano').value)) {
  const run = ++state.carga;
  state.listo = false;
  $('cargar').disabled = true;
  state.grupos = [];
  state.obligaciones = [];
  state.abonos = [];
  options($('destino'), [], 'Todos los destinos');
  filter();
  if (!state.user) {
    $('estado').textContent = 'Inicia sesión en Rai Trai para consultar los costos.';
    return;
  }
  $('estado').textContent = 'Cargando información de Finanzas…';
  try {
    const [catalog, costs, payments] = await Promise.all([
      call('GRUPOS_GASTO_OTRO', year), list('finanzas_obligaciones', year), list('finanzas_abonos', year)
    ]);
    if (run !== state.carga) return;
    state.ano = year;
    state.obligaciones = records(costs);
    state.abonos = records(payments);
    state.grupos = catalog.grupos.map(g => ({ ...g, id: String(g.id), destinos: new Set() }));
    const byId = new Map(state.grupos.map(g => [g.id, g]));
    for (const o of state.obligaciones) {
      if (!o.destinoFinanciero) continue;
      for (const id of [o.grupoId, ...(o.reparto ?? []).map(x => x.grupoId)]) {
        byId.get(String(id))?.destinos.add(o.destinoFinanciero);
      }
    }
    state.grupos.sort((a, b) => groupName(a).localeCompare(groupName(b), 'es', { numeric: true }));
    const destinations = [...new Set(state.obligaciones.map(o => o.destinoFinanciero).filter(Boolean))].sort();
    options($('destino'), destinations.map(d => [d, d]), 'Todos los destinos');
    state.listo = true;
    $('estado').textContent = `Información de Finanzas · ${year}`;
    filter();
  } catch (error) {
    if (run === state.carga) $('estado').textContent = `No se pudo cargar Finanzas. ${error.message}`;
  } finally {
    if (run === state.carga) $('cargar').disabled = false;
  }
}

function filter() {
  const search = norm($('buscar').value);
  options($('grupo'), scopedGroups().filter(g => norm(groupName(g)).includes(search)).map(g => [g.id, groupName(g)]), 'Seleccionar grupo');
  render();
}

function appendRow(tbody, values, buttons = []) {
  const tr = tbody.insertRow();
  for (const v of values) tr.insertCell().textContent = v;
  if (buttons.length || tbody.id !== 'subtotal') tr.insertCell().append(...buttons);
}

function button(text, action) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.addEventListener('click', action);
  return b;
}

function render() {
  const group = state.grupos.find(g => g.id === $('grupo').value);
  const dest = $('destino').value;
  const rows = state.obligaciones.filter(o => !dest || o.destinoFinanciero === dest);
  const groups = new Set(state.grupos.map(g => g.id));
  const totals = new Map();
  let pendientes = 0;
  let abonosSinReparto = false;
  const totalsFor = m => {
    if (!totals.has(m)) totals.set(m, { costo: 0, pagado: 0 });
    return totals.get(m);
  };
  $('titulo').textContent = group ? groupName(group) : 'Costos del grupo';
  $('detalle').replaceChildren();
  $('compartidos').replaceChildren();
  for (const o of rows) {
    const m = currency(o);
    if (other(o) || o.fuente === 'COSTO_CUENTA_OTROS') {
      const assigned = (o.reparto ?? []).filter(x => groups.has(String(x.grupoId))).reduce((s, x) => s + cents(x.monto), 0);
      const active = other(o) && !covered(o);
      appendRow($('compartidos'), [o.proveedorNombre, concept(o), covered(o) ? 'Incluido en la cuenta del proveedor' : money(o.totalObligacion, m),
        covered(o) || o.requiereConfiguracion ? '—' : money((cents(o.totalObligacion) - assigned) / 100, m)],
      active ? [button('Editar gasto', () => edit(o, false)), ' ', button('Nuevo gasto de este proveedor', () => edit(o, true))] : []);
    }
    if (!group || covered(o)) continue;
    const share = other(o) ? o.reparto?.find(x => String(x.grupoId) === group.id) : null;
    if (!share && (other(o) || String(o.grupoId) !== group.id)) continue;
    const amount = share ? share.monto : o.totalObligacion;
    const configured = validCurrency(m) && validMoney(amount) && !o.requiereConfiguracion;
    if (configured) totalsFor(m).costo += cents(amount);
    else pendientes++;
    appendRow($('detalle'), [o.tipo || o.fuente || 'Costo', o.proveedorNombre || '—', concept(o), money(configured ? amount : null, m)],
      other(o) ? [button('Editar gasto', () => edit(o, false))] : []);
  }
  if (group) for (const a of state.abonos) {
    if ((dest && a.destinoFinanciero !== dest) || !validCurrency(currency(a))) continue;
    const share = a.repartoGrupos?.find(x => String(x.grupoId) === group.id);
    if (a.repartoPorActualizar) {
      if (share || String(a.grupoId) === group.id) abonosSinReparto = true;
      continue;
    }
    if (share && validMoney(share.monto)) totalsFor(currency(a)).pagado += cents(share.monto);
    else if (!a.repartoGrupos?.length && String(a.grupoId) === group.id && validMoney(a.montoAplicado)) {
      totalsFor(currency(a)).pagado += cents(a.montoAplicado);
    }
  }
  $('destinoAviso').textContent = state.listo ? 'Los importes sin asignar quedan en Finanzas hasta que se distribuyan.' : '';
  $('avisos').textContent = [!group && state.listo ? 'Selecciona un grupo para ver su costo.' : '',
    pendientes ? `${pendientes} costo(s) del grupo pendientes de configurar.` : '',
    abonosSinReparto ? 'Hay abonos cuyo reparto está pendiente de actualizar.' : ''].filter(Boolean).join(' ');
  $('totales').innerHTML = '<table><thead><tr><th>Moneda</th><th>Costo registrado</th><th>Abonos atribuidos</th><th>Saldo atribuido</th></tr></thead><tbody id="subtotal"></tbody></table>';
  for (const [m, t] of totals) appendRow($('subtotal'), [m, money(t.costo / 100, m), money(t.pagado / 100, m), money((t.costo - t.pagado) / 100, m)]);
  showConversion(totals, pendientes);
}

function showConversion(totals, pendientes) {
  const target = $('conversion').value;
  $('tasas').replaceChildren();
  const entries = [...totals].filter(([, t]) => t.costo !== 0);
  const refresh = () => {
    let sum = 0;
    for (const [m, t] of entries) {
      const rate = m === target ? 1 : state.tasas.get(m + target);
      if (!Number.isFinite(rate) || rate <= 0) {
        $('convertido').value = 'Completa los tipos de cambio para calcular el equivalente.';
        return;
      }
      sum += t.costo / 100 * rate;
    }
    $('convertido').value = `Costo registrado equivalente: ${money(sum, target)}${pendientes ? ' · Hay costos por configurar' : ''}`;
  };
  $('convertido').value = '';
  if (!target || !totals.size) return;
  for (const [m] of entries) {
    if (m === target) continue;
    const label = document.createElement('label');
    label.textContent = `${target} por 1 ${m}`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = 'any';
    input.value = state.tasas.get(m + target) ?? '';
    input.addEventListener('input', () => {
      state.tasas.set(m + target, input.valueAsNumber);
      refresh();
    });
    label.append(input);
    $('tasas').append(label);
  }
  refresh();
}

function edit(cost, nuevo) {
  const year = state.ano;
  const m = currency(cost);
  const selected = $('grupo').value;
  const groups = state.grupos;
  const lookup = new Map(groups.map(g => [g.id, g]));
  const fields = form.elements;
  $('editorTitulo').textContent = `${nuevo ? 'Nuevo gasto' : 'Editar gasto'} · ${cost.proveedorNombre} · ${cost.destinoFinanciero}`;
  $('montoEtiqueta').firstChild.nodeValue = `Costo total en ${m} `;
  fields.asunto.value = nuevo ? '' : concept(cost);
  fields.monto.value = nuevo ? '' : cost.monto ?? '';
  fields.modo.value = nuevo ? 'MANUAL' : ['PAX', 'LIBRE'].includes(cost.modo) ? cost.modo : 'MANUAL';
  $('asignaciones').replaceChildren();
  $('editorError').textContent = '';
  function add(row = {}) {
    const node = document.createElement('div');
    node.className = 'assignment';
    const group = document.createElement('select');
    group.setAttribute('aria-label', 'Grupo');
    options(group, groups.map(g => [g.id, groupName(g)]), 'Seleccionar grupo');
    if (row.grupoId && !lookup.has(String(row.grupoId))) group.add(new Option(`Grupo fuera del catálogo · ${row.grupoId}`, row.grupoId));
    group.value = row.grupoId ?? '';
    const amount = document.createElement('input');
    amount.type = 'number';
    amount.step = '0.01';
    amount.min = '0';
    amount.setAttribute('aria-label', 'Monto o número de pasajeros');
    amount.value = fields.modo.value === 'PAX' ? row.pax ?? lookup.get(group.value)?.pax ?? '' : row.monto ?? '';
    group.addEventListener('change', () => {
      if (fields.modo.value === 'PAX') amount.value = lookup.get(group.value)?.pax ?? '';
      preview();
    });
    amount.addEventListener('input', preview);
    node.append(group, amount, button('Quitar', () => { node.remove(); preview(); }));
    $('asignaciones').append(node);
    preview();
  }
  function allocations() {
    return [...$('asignaciones').children].map(node => ({
      grupoId: node.querySelector('select').value,
      valor: node.querySelector('input').valueAsNumber
    }));
  }
  function preview() {
    const mode = fields.modo.value;
    $('asignaciones').hidden = mode === 'LIBRE';
    $('agregar').hidden = mode === 'LIBRE';
    for (const node of $('asignaciones').children) node.querySelector('input').hidden = mode === 'IGUAL' || mode === 'LIBRE';
    const left = cents(fields.monto.value) - allocations().reduce((s, x) => s + (Number.isFinite(x.valor) ? cents(x.valor) : 0), 0);
    $('repartoEstado').value = mode === 'MANUAL' ? `Diferencia por distribuir: ${money(left / 100, m)}` :
      mode === 'IGUAL' ? 'El costo se reparte en partes iguales.' :
      mode === 'PAX' ? 'El costo se reparte según los pasajeros indicados.' : 'El gasto queda asignado al destino.';
  }
  $('agregar').onclick = () => add();
  $('cancelar').onclick = () => $('editor').close();
  fields.monto.oninput = () => {
    const only = $('asignaciones').children;
    if (nuevo && only.length === 1 && fields.modo.value === 'MANUAL') only[0].querySelector('input').value = fields.monto.value;
    preview();
  };
  fields.modo.onchange = () => {
    if (fields.modo.value === 'PAX') for (const node of $('asignaciones').children) {
      node.querySelector('input').value = lookup.get(node.querySelector('select').value)?.pax ?? '';
    }
    preview();
  };
  const initial = nuevo ? (selected ? [{ grupoId: selected }] : []) : cost.reparto ?? [];
  initial.forEach(add);
  preview();
  let saving = false;
  $('editor').oncancel = e => { if (saving) e.preventDefault(); };
  form.onsubmit = async e => {
    e.preventDefault();
    if (saving) return;
    const mode = fields.modo.value;
    const monto = fields.monto.valueAsNumber;
    let reparto = mode === 'LIBRE' ? [] : allocations();
    if (mode !== 'LIBRE' && (!reparto.length || reparto.length > 200 ||
      reparto.some(x => !lookup.has(x.grupoId)) || new Set(reparto.map(x => x.grupoId)).size !== reparto.length)) {
      $('editorError').textContent = 'Selecciona entre 1 y 200 grupos válidos y sin repetir.';
      return;
    }
    if (mode === 'IGUAL') {
      const total = cents(monto);
      const base = Math.floor(total / reparto.length);
      reparto = reparto.map((x, i) => ({ ...x, valor: (base + Number(i < total % reparto.length)) / 100 }));
    }
    if (reparto.some(x => !Number.isFinite(x.valor) || x.valor < 0 ||
        (mode === 'PAX' && (!Number.isSafeInteger(x.valor) || x.valor < 1 || x.valor > 100000))) ||
        (['MANUAL', 'IGUAL'].includes(mode) && reparto.reduce((s, x) => s + cents(x.valor), 0) !== cents(monto))) {
      $('editorError').textContent = 'Completa el reparto. Los montos deben sumar el costo y los pasajeros deben ser enteros positivos.';
      return;
    }
    saving = true;
    $('guardar').disabled = $('cancelar').disabled = true;
    $('editorError').textContent = '';
    try {
      const result = await call('GUARDAR_GASTO_OTRO', year, {
        id: cost.id, version: cost.version || 0, nuevo, asunto: fields.asunto.value, monto,
        modo: mode === 'IGUAL' ? 'MANUAL' : mode, reparto
      });
      $('editor').close();
      const dest = $('destino').value;
      await load(year);
      if ([...$('destino').options].some(x => x.value === dest)) $('destino').value = dest;
      filter();
      if ([...$('grupo').options].some(x => x.value === selected)) $('grupo').value = selected;
      render();
      if (!result.recalculado) $('estado').textContent = 'Gasto guardado. Finanzas todavía tiene pendiente el recálculo.';
    } catch (error) {
      $('editorError').textContent = error.message;
    } finally {
      saving = false;
      $('guardar').disabled = $('cancelar').disabled = false;
    }
  };
  $('editor').showModal();
}

$('cargar').onclick = () => {
  if ($('ano').reportValidity() && $('ano').value) load();
};
$('destino').onchange = filter;
$('buscar').oninput = filter;
$('grupo').onchange = render;
$('conversion').onchange = render;
onAuthStateChanged(getAuth(app), user => { state.user = user; load(); });
