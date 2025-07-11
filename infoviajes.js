//  in our initForm:
const hotelesCtr = document.getElementById('hotelesContainer');
const btnAddHotel = document.getElementById('btnAddHotel');

// listener:
btnAddHotel.onclick = addHotelRow;

// limpiar + preparar cada vez que cambie destino o programa:
function resetHotelRows() {
  hotelesCtr.innerHTML = '';
}

// nueva función:
function addHotelRow(data={ hotel:'', noches:'' }) {
  const dest = inpDestino.value;
  const opciones = (HOTELES_MAP[dest]||[]).map(h =>
    `<option value="${h.name}">${h.name} (${h.city})</option>`
  ).join('');
  
  const div = document.createElement('div');
  div.classList.add('hotel-row');
  div.innerHTML = `
    <select class="hotel-select">
      <option value="">-- Seleccione Hotel --</option>
      ${opciones}
    </select>
    <input type="number" class="hotel-nights" min="1" value="${data.noches||''}" placeholder="Noches">
    <button type="button" class="btn-remove">×</button>
  `;
  // remove
  div.querySelector('.btn-remove').onclick = () => div.remove();
  hotelesCtr.appendChild(div);
}
