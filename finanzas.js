/* =========================================================
   Finanzas — implementación completa con mejoras pedidas
   ========================================================= */

/* ========== Helpers mínimos (no cambies si ya los tienes) ========== */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const el = (id) => document.getElementById(id);

const nfNum  = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 });
const nfCLP  = new Intl.NumberFormat('es-CL', { style:'currency', currency:'CLP', maximumFractionDigits: 0 });

function fmt(n){
  if (n==null || Number.isNaN(n)) return '0';
  return nfNum.format(Number(n));
}
function money(n){
  if (n==null || Number.isNaN(n)) return '$0';
  return nfCLP.format(Math.round(Number(n)));
}
function parseNumber(txt){
  if (typeof txt !== 'string') txt = String(txt ?? '');
  // quita símbolos de moneda y espacios, normaliza coma/punto
  const cleaned = txt.replace(/[^\d,.\-]/g,'').replace(/\./g,'').replace(',', '.');
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : 0;
}
function slug(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function normalizarMoneda(m){ return String(m||'CLP').trim().toUpperCase(); }

/* === FX (usa tu fuente real; esto es un puente compatible) === */
const CLP_PER = {
  CLP: 1,
  USD: 950,   // <--- ajusta a tu tasa si tienes una global
  BRL: 180,
  ARS: 1.2
};
function convertirTodas(moneda, monto){
  const m = normalizarMoneda(moneda);
  const baseCLP = Number(monto || 0) * (CLP_PER[m] || 1);
  const USD = baseCLP / CLP_PER.USD;
  const BRL = baseCLP / CLP_PER.BRL;
  const ARS = baseCLP / CLP_PER.ARS;
  const CLP = baseCLP;
  return { USD, BRL, ARS, CLP };
}

/* === Abonos helpers (compatibles con tu back) === */
function abonoEquivalentes(ab){
  return convertirTodas(ab.moneda || 'CLP', ab.monto || 0);
}
function abonoEstadoLabel(ab){
  const st = (ab.estado || '').toUpperCase();
  if (st === 'ARCHIVADO' || st === 'ARCHIVED') return 'ARCHIVADO';
  return 'VIGENTE';
}

/* ==== Sorting util (si ya tienes makeSortable, elimina este bloque) ==== */
function makeSortable(table, types, opts={}) {
  const skipIdx = new Set((opts.skipIdx || []));
  const ths = table.querySelectorAll('thead th');
  ths.forEach((th, idx)=>{
    if (skipIdx.has(idx)) return;
    th.style.cursor = 'pointer';
    th.addEventListener('click', ()=>{
      const tbody = table.tBodies[0];
      const rows  = Array.from(tbody.querySelectorAll('tr'));
      const t = (types && types[idx]) || 'text';
      const dir = th.dataset.sortDir === 'asc' ? 'desc' : 'asc';
      ths.forEach(x=> x.removeAttribute('data-sort-dir'));
      th.dataset.sortDir = dir;

      const getVal = (tr)=>{
        const cell = tr.children[idx];
        const txt  = (cell?.textContent || '').trim();
        if (t==='num' || t==='money'){ return parseNumber(txt); }
        if (t==='date'){ return new Date(txt || 0).getTime() || 0; }
        return txt.toLowerCase();
      };

      rows.sort((a,b)=>{
        const va = getVal(a), vb = getVal(b);
        if (va<vb) return dir==='asc' ? -1 : 1;
        if (va>vb) return dir==='asc' ? 1 : -1;
        return 0;
      });
      rows.forEach(r=> tbody.appendChild(r));
    });
  });
}

/* ==== Export util (CSV simple) ==== */
function exportModalToExcel(cont, nombre='proveedor'){
  const tables = [
    ['ResumenServicios', $('#tblProvResumen', cont)],
    ['Abonos', $('#tblAbonos', cont)],
    ['Saldo', $('#tblSaldo', cont)],
    ['Detalle', $('#tblDetalleProv', cont)]
  ].filter(([,t])=> !!t);

  let zipParts = [];
  for (const [name, t] of tables){
    const rows = [];
    t.querySelectorAll('tr').forEach(tr=>{
      const cols = Array.from(tr.children).map(td => {
        const raw = (td.textContent || '').replace(/\s+/g,' ').trim();
        const safe = raw.includes(',') ? `"${raw.replace(/"/g,'""')}"` : raw;
        return safe;
      });
      rows.push(cols.join(','));
    });
    const csv = rows.join('\n');
    zipParts.push({ filename: `${name}.csv`, content: csv });
  }

  // descarga múltiple como archivos sueltos (prefijo) – simple
  zipParts.forEach(part=>{
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([part.content], {type:'text/csv;charset=utf-8;'}));
    a.download = `${nombre}-${part.filename}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

/* ========== UI: pintar saldos totales del footer (IDs conservados) ========== */
function paintSaldoCells({clp, usd, brl, ars}){
  const cl = el('saldoCLP'), us = el('saldoUSD'), br = el('saldoBRL'), ar = el('saldoARS');
  if (cl) { cl.textContent = money(clp); cl.classList.toggle('saldo-rojo', Math.abs(clp)>0.0001); }
  if (us) { us.textContent = fmt(usd);   us.classList.toggle('saldo-rojo', Math.abs(usd)>0.0001); }
  if (br) { br.textContent = fmt(brl);   br.classList.toggle('saldo-rojo', Math.abs(brl)>0.0001); }
  if (ar) { ar.textContent = fmt(ars);   ar.classList.toggle('saldo-rojo', Math.abs(ars)>0.0001); }
}

/* =========================================================
   1) buildModalShell() — REEMPLAZO COMPLETO
   ========================================================= */
function buildModalShell() {
  const cont = $('.fin-modal-body', el('modal'));
  cont.dataset.verArchivados = '0';

  cont.innerHTML = `
    <div class="modal-toolbar">
      <input id="modalSearch" type="search" placeholder="BUSCAR EN ABONOS Y DETALLE…" />
      <div class="spacer"></div>

      <button class="btn btn-blue" id="btnAbonar">ABONAR DINERO</button>
      <button class="btn btn-dark" id="btnVerArch" aria-pressed="false">VER ARCHIVADOS</button>
      <button class="btn btn-excel" id="btnExportXLS">EXPORTAR EXCEL</button>
    </div>

    <div class="scroll-x" style="margin-bottom:.5rem;">
      <table class="fin-table upper" id="tblProvResumen">
        <thead>
          <tr>
            <th>SERVICIO</th>
            <th class="right">CLP</th>
            <th class="right">USD</th>
            <th class="right">BRL</th>
            <th class="right">ARS</th>
            <th class="right"># ÍTEMS</th>
            <th></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <section class="panel abonos-panel">
      <div class="abonos-header upper">
        <span><b>ABONOS</b></span>
      </div>
      <div class="scroll-x">
        <table class="fin-table upper" id="tblAbonos">
          <thead>
            <tr>
              <th>SERVICIO</th>
              <th>RESPONSABLE</th>
              <th>FECHA</th>
              <th>MONEDA</th>
              <th class="right">MONTO</th>
              <th class="right">CLP</th>
              <th class="right">USD</th>
              <th class="right">BRL</th>
              <th class="right">ARS</th>
              <th>NOTA</th>
              <th>COMPROBANTE</th>
              <th class="actions">ACCIONES</th>
              <th>ESTADO</th>
            </tr>
          </thead>
          <tbody></tbody>
          <tfoot>
            <tr class="bold">
              <th colspan="5" class="right">TOTALES</th>
              <th id="abTotCLP" class="right">$0</th>
              <th id="abTotUSD" class="right">0</th>
              <th id="abTotBRL" class="right">0</th>
              <th id="abTotARS" class="right">0</th>
              <th colspan="4"></th>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

    <section class="panel">
      <h4 class="upper bold">SALDO POR PAGAR</h4>
      <div class="scroll-x">
        <table class="fin-table upper" id="tblSaldo">
          <thead>
            <tr>
              <th>SERVICIO</th>
              <th class="right">CLP</th>
              <th class="right">USD</th>
              <th class="right">BRL</th>
              <th class="right">ARS</th>
            </tr>
          </thead>
          <tbody id="saldoBody"></tbody>
          <tfoot>
            <tr class="bold">
              <td>SALDO TOTAL</td>
              <td id="saldoCLP" class="right">$0</td>
              <td id="saldoUSD" class="right">0</td>
              <td id="saldoBRL" class="right">0</td>
              <td id="saldoARS" class="right">0</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

    <div class="scroll-x">
      <table class="fin-table upper" id="tblDetalleProv">
        <thead>
          <tr>
            <th>FECHA</th>
            <th>NEGOCIO-ID</th>
            <th>GRUPO</th>
            <th>SERVICIO</th>
            <th class="right">PAX</th>
            <th>MODALIDAD</th>
            <th>MONEDA</th>
            <th class="right">TARIFA</th>
            <th class="right">USD</th>
            <th class="right">BRL</th>
            <th class="right">ARS</th>
            <th class="right">CLP</th>
          </tr>
        </thead>
        <tbody></tbody>
        <tfoot>
          <tr class="bold">
            <th colspan="11" class="right">TOTAL CLP</th>
            <th id="modalTotalCLP" class="right">$0</th>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- Submodal Abono -->
    <div id="submodalAbono" class="submodal" hidden>
      <div class="card">
        <header class="upper bold">ABONO</header>
        <div class="grid">
          <label>FECHA
            <input type="date" id="abFecha" />
          </label>
          <label>MONEDA
            <select id="abMoneda">
              <option>CLP</option><option>USD</option><option>BRL</option><option>ARS</option>
            </select>
          </label>
          <label>MONTO
            <input type="number" id="abMonto" step="0.01" />
          </label>
          <label>NOTA
            <input type="text" id="abNota" maxlength="140" />
          </label>
          <label>COMPROBANTE (IMAGEN/PDF)
            <input type="file" id="abFile" accept="image/*,application/pdf" />
          </label>
        </div>
        <footer>
          <button class="btn secondary" id="abCancelar">CANCELAR</button>
          <button class="btn" id="abGuardar">GUARDAR</button>
        </footer>
      </div>
    </div>
  `;
  return cont;
}

/* =========================================================
   2) openModalProveedor() — REEMPLAZO COMPLETO
   ========================================================= */
async function openModalProveedor(slugProv, data) {
  const modal = el('modal');
  const dests = [...data.destinos];
  const gruposSet = new Set(data.items.map(i => i.grupoId));
  const paxTotal = data.items.reduce((s,i)=> s + (Number(i.pax||0)), 0);
  el('modalTitle').textContent = `DETALLE — ${(data?.nombre || slugProv).toUpperCase()}`;
  el('modalSub').textContent = `DESTINOS: ${dests.join(', ').toUpperCase()} • GRUPOS: ${gruposSet.size} • PAX: ${fmt(paxTotal)}`;

  const cont = buildModalShell();

  // Contexto de proveedor (para saldos globales)
  cont._providerItems = data.items;
  cont._svcMap = new Map(); // servicioId -> { slug, name, destinoId }
  for (const it of data.items) {
    if (!it.servicioId || !it.destinoGrupo) continue;
    const sSlug = slug(it.servicio || '');
    if (!cont._svcMap.has(it.servicioId)) {
      cont._svcMap.set(it.servicioId, { slug: sSlug, name: it.servicio || '', destinoId: it.destinoGrupo });
    }
  }

  // Botón "VER TODOS"
  const btnClear = document.createElement('button');
  btnClear.className = 'btn ghost';
  btnClear.id = 'btnDetClear';
  btnClear.textContent = 'VER TODOS';
  btnClear.style.display = 'none';
  $('.modal-toolbar', cont).prepend(btnClear);

  // Resumen por servicio
  const resumen = agruparItemsPorServicio(data.items);
  const tbRes = $('#tblProvResumen tbody', cont);
  tbRes.innerHTML = '';
  for (const r of resumen) {
    tbRes.insertAdjacentHTML('beforeend', `
      <tr>
        <td title="${r.servicio}">${r.servicio}</td>
        <td class="right bold" title="${r.clpEq}">${money(r.clpEq)}</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.count}">${fmt(r.count)}</td>
        <td class="right"><button class="btn secondary btn-det-svc" data-svc="${slug(r.servicio)}">VER DETALLE</button></td>
      </tr>
    `);
  }
  makeSortable($('#tblProvResumen', cont), ['text','money','num','num','num','num','text'], {skipIdx:[6]});

  // Detalle
  const tb = $('#tblDetalleProv tbody', cont);
  tb.innerHTML = '';
  const rows = [...data.items].sort((a,b) =>
    (a.fecha || '').localeCompare(b.fecha || '') ||
    (a.nombreGrupo || '').localeCompare(b.nombreGrupo || '')
  );

  let totCLP = 0;
  for (const it of rows) {
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (typeof conv.CLP === 'number') totCLP += conv.CLP;
    const negocioId = (it.numeroNegocio || it.grupoId || '') + (it.identificador ? `-${it.identificador}`:'');
    const grupoTxt  = it.nombreGrupo || '';
    const nativeClass = (m) => (normalizarMoneda(it.moneda) === m ? 'is-native-service' : '');
    tb.insertAdjacentHTML('beforeend', `
      <tr data-svc="${slug(it.servicio || '')}">
        <td title="${it.fecha || ''}">${it.fecha || ''}</td>
        <td title="${negocioId}">${negocioId}</td>
        <td title="${grupoTxt}">${grupoTxt}</td>
        <td title="${it.servicio || ''}">${it.servicio || ''}</td>
        <td class="right" title="${it.pax || 0}">${fmt(it.pax || 0)}</td>
        <td title="${it.pagoTipo === 'por_pax' ? 'POR PAX' : 'POR GRUPO'} — ${(it.pagoFrecuencia || 'unitario').toUpperCase()}">
          ${(it.pagoTipo === 'por_pax' ? 'POR PAX' : 'POR GRUPO')} — ${(it.pagoFrecuencia || 'unitario').toUpperCase()}
        </td>
        <td title="${(it.moneda || 'CLP').toUpperCase()}">${(it.moneda || 'CLP').toUpperCase()}</td>
        <td class="right" title="${it.tarifa || 0}">${fmt(it.tarifa || 0)}</td>
        <td class="right ${nativeClass('USD')}" title="${conv.USD==null?'':fmt(conv.USD)}">${conv.USD==null?'—':fmt(conv.USD)}</td>
        <td class="right ${nativeClass('BRL')}" title="${conv.BRL==null?'':fmt(conv.BRL)}">${conv.BRL==null?'—':fmt(conv.BRL)}</td>
        <td class="right ${nativeClass('ARS')}" title="${conv.ARS==null?'':fmt(conv.ARS)}">${conv.ARS==null?'—':fmt(conv.ARS)}</td>
        <td class="right ${nativeClass('CLP')}" title="${conv.CLP==null?'':fmt(conv.CLP)}">${conv.CLP==null?'—':fmt(conv.CLP)}</td>
      </tr>
    `);
  }
  $('#modalTotalCLP', cont).textContent = money(totCLP);
  makeSortable($('#tblDetalleProv', cont),
    ['date','text','text','text','num','text','text','num','num','num','num','num']
  );

  // Filtro por servicio (desde resumen)
  cont.querySelectorAll('.btn-det-svc').forEach(btn => {
    btn.addEventListener('click', async () => {
      const svcSlug = btn.getAttribute('data-svc');
      const rows = $$('#tblDetalleProv tbody tr', cont);
      let hayFiltro = false;
      rows.forEach(tr => {
        const ok = tr.getAttribute('data-svc') === svcSlug;
        tr.style.display = ok ? '' : 'none';
        if (ok) hayFiltro = true;
      });
      btnClear.style.display = hayFiltro ? '' : 'none';

      const itemSvc = data.items.find(i => slug(i.servicio||'') === svcSlug);
      if (itemSvc?.servicioId && itemSvc?.destinoGrupo) {
        await pintarAbonos({
          destinoId: itemSvc.destinoGrupo,
          servicioId: itemSvc.servicioId,
          servicioNombre: itemSvc.servicio || '',
          cont,
        });
      }
      await calcSaldoDesdeTablas(cont);
    });
  });
  btnClear.addEventListener('click', async () => {
    $$('#tblDetalleProv tbody tr', cont).forEach(tr => tr.style.display = '');
    btnClear.style.display = 'none';
    limpiarAbonos(cont);
    await calcSaldoDesdeTablas(cont); // saldo global proveedor
  });

  // Buscador global
  $('#modalSearch', cont).addEventListener('input', async (e) => {
    const q = e.target.value.trim().toLowerCase();
    const match = (txt) => txt.toLowerCase().includes(q);
    $$('#tblDetalleProv tbody tr', cont).forEach(tr => {
      const txt = tr.textContent || '';
      tr.style.display = match(txt) ? '' : 'none';
    });
    $$('#tblAbonos tbody tr', cont).forEach(tr => {
      const txt = tr.textContent || '';
      tr.style.display = match(txt) ? '' : 'none';
    });
    await calcSaldoDesdeTablas(cont);
  });

  // Toggle VER ARCHIVADOS (botón negro) — seguro
  const btnArch = $('#btnVerArch', cont);
  const updateBtnArch = ()=>{
    const on = cont.dataset.verArchivados === '1';
    btnArch.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnArch.textContent = on ? 'VER ARCHIVADOS: ON' : 'VER ARCHIVADOS';
  };
  btnArch.addEventListener('click', async ()=>{
    if (!cont.dataset.curServicioId) {
      alert('Selecciona un servicio con "VER DETALLE" para ver abonos archivados.');
      return;
    }
    cont.dataset.verArchivados = cont.dataset.verArchivados === '1' ? '0' : '1';
    updateBtnArch();
    await pintarAbonos({
      destinoId: cont.dataset.curDestinoId,
      servicioId: cont.dataset.curServicioId,
      servicioNombre: cont.dataset.curServicioNombre || '',
      cont
    });
    await calcSaldoDesdeTablas(cont);
  });
  updateBtnArch();

  // Export Excel
  $('#btnExportXLS', cont).addEventListener('click', () => exportModalToExcel(cont, (data?.nombre||'proveedor')));

  // Mostrar
  el('backdrop').style.display = 'block';
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');

  $('#modalClose').onclick = () => {
    el('backdrop').style.display = 'none';
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  };

  // Saldo inicial (global proveedor)
  await calcSaldoDesdeTablas(cont);
}
window.openModalProveedor = openModalProveedor;

/* =========================================================
   3) pintarAbonos() — REEMPLAZO COMPLETO
   ========================================================= */
async function pintarAbonos({ destinoId, servicioId, servicioNombre, cont }) {
  cont.dataset.curDestinoId = destinoId;
  cont.dataset.curServicioId = servicioId;
  cont.dataset.curServicioNombre = servicioNombre || '';

  let showArchived = cont.dataset.verArchivados === '1';
  const tbody = $('#tblAbonos tbody', cont);
  tbody.innerHTML = '';

  let abonos = await loadAbonos(destinoId, servicioId);
  abonos.sort((a,b)=> (b.fecha||'').localeCompare(a.fecha||''));

  const archivedCount = abonos.filter(a => abonoEstadoLabel(a)==='ARCHIVADO').length;
  const btnArch = $('#btnVerArch', cont);
  btnArch.disabled = (archivedCount === 0);

  if (showArchived && archivedCount === 0) {
    alert('No hay abonos archivados para este servicio/proveedor.');
    cont.dataset.verArchivados = '0';
    showArchived = false;
    if (btnArch) { btnArch.setAttribute('aria-pressed','false'); btnArch.textContent = 'VER ARCHIVADOS'; }
  }

  let tCLP=0, tUSD=0, tBRL=0, tARS=0;

  for (const ab of abonos) {
    const eq = abonoEquivalentes(ab);
    const estado = abonoEstadoLabel(ab);
    const incluir = (estado !== 'ARCHIVADO') || showArchived;

    if (estado !== 'ARCHIVADO') {
      tCLP += (eq.CLP || 0);
      tUSD += (eq.USD || 0);
      tBRL += (eq.BRL || 0);
      tARS += (eq.ARS || 0);
    }

    const tr = document.createElement('tr');
    if (estado === 'ARCHIVADO') tr.classList.add('abono-archivado');
    tr.innerHTML = `
      <td title="${servicioNombre}">${servicioNombre}</td>
      <td title="${(ab.updatedByEmail || ab.createdByEmail || '').toLowerCase()}">
        <span class="email-normal">${(ab.updatedByEmail || ab.createdByEmail || '').toLowerCase()}</span>
      </td>
      <td title="${ab.fecha || ''}">${ab.fecha || ''}</td>
      <td title="${(ab.moneda||'CLP').toUpperCase()}"><span class="abono-blue bold">${(ab.moneda||'CLP').toUpperCase()}</span></td>
      <td class="right" title="${ab.monto || 0}"><span class="abono-blue bold">${fmt(ab.monto || 0)}</span></td>
      <td class="right" title="${eq.CLP==null?'':fmt(eq.CLP)}">${eq.CLP==null?'—':fmt(eq.CLP)}</td>
      <td class="right" title="${eq.USD==null?'':fmt(eq.USD)}">${eq.USD==null?'—':fmt(eq.USD)}</td>
      <td class="right" title="${eq.BRL==null?'':fmt(eq.BRL)}">${eq.BRL==null?'—':fmt(eq.BRL)}</td>
      <td class="right" title="${eq.ARS==null?'':fmt(eq.ARS)}">${eq.ARS==null?'—':fmt(eq.ARS)}</td>
      <td title="${ab.nota || ''}">${ab.nota || ''}</td>
      <td>${ab.comprobanteURL ? `<a href="${ab.comprobanteURL}" target="_blank" rel="noopener">VER</a>` : '—'}</td>
      <td class="actions">
        <button class="btn ghost btn-edit"   title="EDITAR">EDITAR</button>
        <button class="btn ghost btn-arch"   title="ARCHIVAR">ARCHIVAR</button>
      </td>
      <td title="${estado}">${estado}</td>
    `;
    if (incluir) tbody.appendChild(tr);

    tr.querySelector('.btn-edit').addEventListener('click', () => abrirSubmodalAbono({
      cont, destinoId, servicioId, abono: { ...ab, id: ab.id }
    }));
    tr.querySelector('.btn-arch').addEventListener('click', async () => {
      if (!confirm('¿ARCHIVAR ESTE ABONO?')) return;
      await archivarAbono({ destinoId, servicioId, abonoId: ab.id });
      await pintarAbonos({ destinoId, servicioId, servicioNombre, cont });
      await calcSaldoDesdeTablas(cont);
    });
  }

  $('#abTotCLP', cont).textContent = money(tCLP);
  $('#abTotUSD', cont).textContent = fmt(tUSD);
  $('#abTotBRL', cont).textContent = fmt(tBRL);
  $('#abTotARS', cont).textContent = fmt(tARS);

  $('#btnAbonar', cont).onclick = () =>
    abrirSubmodalAbono({ cont, destinoId, servicioId, abono: null });

  await calcSaldoDesdeTablas(cont);

  makeSortable($('#tblAbonos', cont),
    ['text','text','date','text','num','num','num','num','num','text','text','text','text'],
    {skipIdx:[11]}
  );
}

/* =========================================================
   4) calcSaldoDesdeTablas() — REEMPLAZO COMPLETO (async)
   ========================================================= */
async function calcSaldoDesdeTablas(cont){
  const saldoBody = $('#saldoBody', cont);
  saldoBody.innerHTML = '';

  // 1) Sumar DETALLE visible por servicio (slug)
  const detalle = {};            // slug -> { name, usd, brl, ars, clp }
  const slugsVisibles = new Set();

  $$('#tblDetalleProv tbody tr', cont).forEach(tr => {
    if (tr.style.display === 'none') return;
    const svcSlug = tr.getAttribute('data-svc') || '';
    const cols = tr.querySelectorAll('td');
    const name = cols[3]?.textContent?.trim() || '';
    const usd = parseNumber(cols[8]?.textContent || '0');
    const brl = parseNumber(cols[9]?.textContent || '0');
    const ars = parseNumber(cols[10]?.textContent || '0');
    const clp = parseNumber(cols[11]?.textContent || '0');

    const acc = detalle[svcSlug] || { name, usd:0, brl:0, ars:0, clp:0 };
    acc.usd += usd; acc.brl += brl; acc.ars += ars; acc.clp += clp;
    detalle[svcSlug] = acc;
    slugsVisibles.add(svcSlug);
  });

  // 2) Sumar ABONOS por servicio
  const abonos = {};             // slug -> { usd, brl, ars, clp }
  const usarSoloActual = !!cont.dataset.curServicioId;
  const filterSlugs = usarSoloActual ? new Set([slug(cont.dataset.curServicioNombre || '')]) : slugsVisibles;

  if (cont._svcMap && filterSlugs.size) {
    for (const [svcId, info] of cont._svcMap.entries()){
      if (!filterSlugs.has(info.slug)) continue;
      const list = await loadAbonos(info.destinoId, svcId);
      for (const ab of list){
        if (abonoEstadoLabel(ab) === 'ARCHIVADO') continue;
        const eq = abonoEquivalentes(ab);
        const a = abonos[info.slug] || { usd:0, brl:0, ars:0, clp:0 };
        a.usd += (eq.USD || 0);
        a.brl += (eq.BRL || 0);
        a.ars += (eq.ARS || 0);
        a.clp += (eq.CLP || 0);
        abonos[info.slug] = a;
      }
    }
  }

  // 3) Pintar filas por servicio y TOTAL
  let totCLP=0, totUSD=0, totBRL=0, totARS=0;
  for (const s of Object.keys(detalle)){
    const d = detalle[s];
    const a = abonos[s] || {usd:0, brl:0, ars:0, clp:0};
    const sc = { clp: d.clp - a.clp, usd: d.usd - a.usd, brl: d.brl - a.brl, ars: d.ars - a.ars };
    totCLP += sc.clp; totUSD += sc.usd; totBRL += sc.brl; totARS += sc.ars;

    saldoBody.insertAdjacentHTML('beforeend', `
      <tr>
        <td>${d.name}</td>
        <td class="right ${Math.abs(sc.clp)>0.0001?'saldo-rojo':''}">${money(sc.clp)}</td>
        <td class="right ${Math.abs(sc.usd)>0.0001?'saldo-rojo':''}">${fmt(sc.usd)}</td>
        <td class="right ${Math.abs(sc.brl)>0.0001?'saldo-rojo':''}">${fmt(sc.brl)}</td>
        <td class="right ${Math.abs(sc.ars)>0.0001?'saldo-rojo':''}">${fmt(sc.ars)}</td>
      </tr>
    `);
  }

  // 4) Totales (se mantienen IDs y estilo)
  paintSaldoCells({ clp: totCLP, usd: totUSD, brl: totBRL, ars: totARS });
}

/* =========================================================
   5) renderTablaProveedores() — REEMPLAZO COMPLETO
   ========================================================= */
function renderTablaProveedores(mapProv) {
  const tb = el('tblProveedores').querySelector('tbody');
  tb.innerHTML = '';
  const rows = [];
  mapProv.forEach((v, key) => rows.push({
    slug:key, nombre:v.nombre, destinos:[...v.destinos].join(', '),
    clpEq:v.clpEq||0, usdEq:v.usdEq||0, brlEq:v.brlEq||0, arsEq:v.arsEq||0,
    count:v.count||0, items:v.items
  }));
  rows.sort((a,b)=>b.clpEq - a.clpEq);

  for (const r of rows) {
    tb.insertAdjacentHTML('beforeend', `
      <tr data-prov="${r.slug}">
        <td title="${r.nombre}">${r.nombre}</td>
        <td title="${r.destinos}">${r.destinos}</td>
        <td class="right" title="${r.clpEq}">${money(r.clpEq)}</td>
        <td class="right saldo-clp" title="Saldo CLP">…</td>
        <td class="right" title="${r.usdEq}">${fmt(r.usdEq)}</td>
        <td class="right" title="${r.brlEq}">${fmt(r.brlEq)}</td>
        <td class="right" title="${r.arsEq}">${fmt(r.arsEq)}</td>
        <td class="right" title="${r.count}">${fmt(r.count)}</td>
        <td class="right">
          <button class="btn secondary" data-prov="${r.slug}">VER DETALLE</button>
        </td>
      </tr>
    `);
  }

  tb.querySelectorAll('button[data-prov]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slugProv = btn.getAttribute('data-prov');
      openModalProveedor(slugProv, mapProv.get(slugProv));
    });
  });

  makeSortable(el('tblProveedores'),
    ['text','text','money','money','num','num','num','num','text'],
    {skipIdx:[8]}
  );

  // calcular saldos asíncronos por proveedor
  actualizarSaldosProveedores(mapProv);
}
window.renderTablaProveedores = renderTablaProveedores;

/* =========================================================
   6) NUEVAS funciones de saldo por proveedor
   ========================================================= */
async function calcularSaldoProveedorCLP(record){
  let totalDetalleCLP = 0;
  const pares = new Map(); // key "destino|servicioId" -> {destinoId, servicioId}

  for (const it of record.items){
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    if (typeof conv.CLP === 'number') totalDetalleCLP += conv.CLP;

    if (it.servicioId && it.destinoGrupo){
      const k = it.destinoGrupo + '|' + it.servicioId;
      if (!pares.has(k)) pares.set(k, { destinoId: it.destinoGrupo, servicioId: it.servicioId });
    }
  }

  let totalAbonosCLP = 0;
  for (const p of pares.values()){
    const list = await loadAbonos(p.destinoId, p.servicioId);
    for (const ab of list){
      if (abonoEstadoLabel(ab) === 'ARCHIVADO') continue;
      const eq = abonoEquivalentes(ab);
      totalAbonosCLP += (eq.CLP || 0);
    }
  }

  return { totalDetalleCLP, totalAbonosCLP, saldoCLP: totalDetalleCLP - totalAbonosCLP };
}

async function actualizarSaldosProveedores(mapProv){
  const tb = el('tblProveedores').querySelector('tbody');
  const trs = [...tb.querySelectorAll('tr[data-prov]')];
  for (const tr of trs){
    const slugProv = tr.getAttribute('data-prov');
    const rec = mapProv.get(slugProv);
    const cell = tr.querySelector('td.saldo-clp');
    if (!rec || !cell){ continue; }

    cell.textContent = '…';
    try{
      const res = await calcularSaldoProveedorCLP(rec);
      cell.textContent = money(res.saldoCLP);
      cell.classList.toggle('saldo-rojo', Math.abs(res.saldoCLP) > 0.0001);
    }catch(e){
      cell.textContent = '—';
      console.warn('Saldo proveedor falló:', slugProv, e);
    }
  }
}

/* =========================================================
   7) Submodal de Abono (crear/editar) — compat
   ========================================================= */
// Nota: estas funciones asumen existencia de un backend propio. Si ya tienes
// tus propias implementaciones, puedes omitir este bloque y mantener las tuyas.
async function abrirSubmodalAbono({ cont, destinoId, servicioId, abono }) {
  const sub = $('#submodalAbono', cont);
  sub.hidden = false;

  const inFecha = $('#abFecha', sub);
  const inMon   = $('#abMoneda', sub);
  const inMonto = $('#abMonto', sub);
  const inNota  = $('#abNota', sub);
  const inFile  = $('#abFile', sub);

  if (abono){
    inFecha.value = abono.fecha || '';
    inMon.value   = (abono.moneda || 'CLP').toUpperCase();
    inMonto.value = abono.monto || '';
    inNota.value  = abono.nota  || '';
  }else{
    inFecha.value = new Date().toISOString().slice(0,10);
    inMon.value   = 'CLP';
    inMonto.value = '';
    inNota.value  = '';
    inFile.value  = '';
  }

  const close = ()=>{ sub.hidden = true; };
  $('#abCancelar', sub).onclick = close;
  $('#abGuardar', sub).onclick = async ()=>{
    const nuevo = {
      id: abono?.id || crypto.randomUUID(),
      fecha: inFecha.value,
      moneda: inMon.value,
      monto: Number(inMonto.value || 0),
      nota: inNota.value,
      comprobanteURL: '', // subir y setear si corresponde
      createdByEmail: abono?.createdByEmail || 'sistema@local',
      estado: 'VIGENTE'
    };
    await guardarAbono({ destinoId, servicioId, abono: nuevo });
    close();
    await pintarAbonos({ destinoId, servicioId, servicioNombre: cont.dataset.curServicioNombre || '', cont });
    await calcSaldoDesdeTablas(cont);
  };
}

/* =========================================================
   8) Capa de datos de Abonos — placeholder compatible
   ========================================================= */
// Si ya tienes estas funciones (loadAbonos, guardarAbono, archivarAbono),
// deja las tuyas. Este bloque permite que el archivo sea "completo" por sí solo.
const _ABONOS_MEM = new Map(); // key: `${destinoId}|${servicioId}` -> array abonos

function _keyAbono(destinoId, servicioId){ return `${destinoId}|${servicioId}`; }

async function loadAbonos(destinoId, servicioId){
  const key = _keyAbono(destinoId, servicioId);
  return (_ABONOS_MEM.get(key) || []).slice();
}

async function guardarAbono({ destinoId, servicioId, abono }){
  const key = _keyAbono(destinoId, servicioId);
  const list = _ABONOS_MEM.get(key) || [];
  const idx = list.findIndex(a=> a.id === abono.id);
  if (idx>=0) list[idx] = { ...list[idx], ...abono, updatedByEmail: 'sistema@local' };
  else list.push({ ...abono });
  _ABONOS_MEM.set(key, list);
}

async function archivarAbono({ destinoId, servicioId, abonoId }){
  const key = _keyAbono(destinoId, servicioId);
  const list = _ABONOS_MEM.get(key) || [];
  const it = list.find(a=> a.id === abonoId);
  if (it){ it.estado = 'ARCHIVADO'; _ABONOS_MEM.set(key, list); }
}

/* =========================================================
   9) Helper: limpiarAbonos (cuando "VER TODOS")
   ========================================================= */
function limpiarAbonos(cont){
  const tbody = $('#tblAbonos tbody', cont);
  tbody.innerHTML = '';
  $('#abTotCLP', cont).textContent = money(0);
  $('#abTotUSD', cont).textContent = fmt(0);
  $('#abTotBRL', cont).textContent = fmt(0);
  $('#abTotARS', cont).textContent = fmt(0);
  cont.dataset.curDestinoId = '';
  cont.dataset.curServicioId = '';
  cont.dataset.curServicioNombre = '';
}

/* =========================================================
   10) Agrupar items por servicio (resumen superior modal)
   ========================================================= */
function agruparItemsPorServicio(items){
  const map = new Map();
  for (const it of items){
    const s = it.servicio || '—';
    const m = map.get(s) || { servicio:s, clpEq:0, usdEq:0, brlEq:0, arsEq:0, count:0 };
    const conv = convertirTodas(it.moneda, it.totalMoneda);
    m.clpEq += (conv.CLP || 0);
    m.usdEq += (conv.USD || 0);
    m.brlEq += (conv.BRL || 0);
    m.arsEq += (conv.ARS || 0);
    m.count += 1;
    map.set(s, m);
  }
  return [...map.values()].sort((a,b)=> b.clpEq - a.clpEq);
}

/* =========================================================
   11) Bootstrap básico (si ya tienes tu flujo, ignóralo)
   ========================================================= */
// Deja disponibles algunas funciones globales para tu app existente.
window.buildModalShell = buildModalShell;
window.pintarAbonos = pintarAbonos;
window.calcSaldoDesdeTablas = calcSaldoDesdeTablas;
window.convertirTodas = convertirTodas;
window.abonoEquivalentes = abonoEquivalentes;
window.abonoEstadoLabel = abonoEstadoLabel;
window.actualizarSaldosProveedores = actualizarSaldosProveedores;
window.calcularSaldoProveedorCLP = calcularSaldoProveedorCLP;

/* Nota:
   - Si tu app ya inicializa la tabla de proveedores, solo llama:
       renderTablaProveedores(mapProv);
   - No cambié nombres de IDs ni de funciones públicas usadas en tu flujo.
*/
