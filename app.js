'use strict';

// ─── PDF.js worker ────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ─── State ────────────────────────────────────────────────
const state = {
  mode: 'bullage',
  bubbles: [],
  nextId: 1,
  pendingBubble: null,
  pdfDoc: null,
  pdfBytes: null,       // ArrayBuffer conservé pour pdf-lib
  currentPage: 1,
  totalPages: 0,
  scale: 1.5,
  fileName: 'plan',
};

// ─── DOM ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const pdfCanvas   = $('pdf-canvas');
const annotCanvas = $('annot-canvas');
const pdfCtx      = pdfCanvas.getContext('2d');
const annotCtx    = annotCanvas.getContext('2d');
const popover     = $('popover');
const bubbleList  = $('bubble-list');
const emptyState  = $('empty-state');
const dropZone    = $('drop-zone');

const SCALES  = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];
const PDF_R   = 8;   // rayon des bulles en points PDF (fixe, indépendant du zoom)

// ─── Load PDF ─────────────────────────────────────────────
async function loadPDF(arrayBuffer, name) {
  try {
    // Copie des bytes avant que PDF.js ne les consomme
    state.pdfBytes = arrayBuffer.slice(0);

    state.pdfDoc      = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    state.totalPages  = state.pdfDoc.numPages;
    state.currentPage = 1;
    state.bubbles     = [];
    state.nextId      = 1;
    state.pendingBubble = null;
    state.fileName    = name.replace(/\.pdf$/i, '');

    // Restauration automatique si ce PDF contient des données d'inspection
    try {
      const existingDoc = await PDFLib.PDFDocument.load(state.pdfBytes, { ignoreEncryption: true });
      const subject = existingDoc.getSubject() || '';
      if (subject.startsWith('__pi__')) {
        const saved = JSON.parse(subject.slice(6));
        if (saved?.version === 1 && Array.isArray(saved.bubbles) && saved.bubbles.length > 0) {
          state.bubbles = saved.bubbles;
          state.nextId  = Math.max(...saved.bubbles.map(b => b.id)) + 1;
          setTimeout(() => showToast(`✓ ${saved.bubbles.length} bulle(s) restaurée(s)`), 600);
        }
      }
    } catch (_) { /* PDF sans données d'inspection — normal */ }

    dropZone.classList.add('hidden');
    $('page-controls').classList.remove('hidden');
    bubbleList.classList.remove('hidden');
    emptyState.classList.add('hidden');
    $('sidebar-footer').classList.remove('hidden');
    $('btn-export-pdf').disabled  = false;
    $('btn-export-excel').disabled = false;
    $('btn-save-pdf').disabled    = false;

    await renderPage(state.currentPage);
    updatePageInfo();
    renderBubbleList();
  } catch (err) {
    alert('Impossible de lire ce fichier PDF.\n' + err.message);
  }
}

async function renderPage(num) {
  const page     = await state.pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: state.scale });

  pdfCanvas.width    = viewport.width;
  pdfCanvas.height   = viewport.height;
  annotCanvas.width  = viewport.width;
  annotCanvas.height = viewport.height;

  await page.render({ canvasContext: pdfCtx, viewport }).promise;
  drawAnnotations();
}

// ─── File input ───────────────────────────────────────────
$('pdf-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  await loadPDF(await file.arrayBuffer(), file.name);
});

const viewer = $('viewer');
viewer.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
viewer.addEventListener('dragleave', e => { if (!viewer.contains(e.relatedTarget)) dropZone.classList.remove('drag-over'); });
viewer.addEventListener('drop', async e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file?.type === 'application/pdf') await loadPDF(await file.arrayBuffer(), file.name);
});

// ─── Page navigation ─────────────────────────────────────
function updatePageInfo() {
  $('page-info').textContent = `Page ${state.currentPage} / ${state.totalPages}`;
  $('btn-prev').disabled = state.currentPage <= 1;
  $('btn-next').disabled = state.currentPage >= state.totalPages;
}

$('btn-prev').addEventListener('click', async () => {
  if (state.currentPage > 1) { state.currentPage--; await renderPage(state.currentPage); updatePageInfo(); }
});
$('btn-next').addEventListener('click', async () => {
  if (state.currentPage < state.totalPages) { state.currentPage++; await renderPage(state.currentPage); updatePageInfo(); }
});

// ─── Zoom ────────────────────────────────────────────────
$('btn-zoom-out').addEventListener('click', async () => {
  const i = SCALES.indexOf(state.scale);
  if (i > 0) { state.scale = SCALES[i - 1]; await afterZoom(); }
});
$('btn-zoom-in').addEventListener('click', async () => {
  const i = SCALES.indexOf(state.scale);
  if (i < SCALES.length - 1) { state.scale = SCALES[i + 1]; await afterZoom(); }
});
async function afterZoom() {
  $('zoom-level').textContent = Math.round(state.scale * 100) + '%';
  if (state.pdfDoc) await renderPage(state.currentPage);
}

// ─── Mode ────────────────────────────────────────────────
$('btn-bullage').addEventListener('click', () => setMode('bullage'));
$('btn-mesure').addEventListener('click',  () => setMode('mesure'));

function setMode(mode) {
  state.mode = mode;
  $('btn-bullage').classList.toggle('active', mode === 'bullage');
  $('btn-mesure').classList.toggle('active',  mode === 'mesure');
  annotCanvas.style.cursor = mode === 'bullage' ? 'crosshair' : 'default';
  drawAnnotations();
  renderBubbleList();
}

// ─── Canvas click → place bubble ─────────────────────────
// Les positions sont stockées en points PDF (indépendant du zoom)
// canvas_px = pdf_pts × scale  →  pdf_pts = canvas_px / scale
annotCanvas.addEventListener('click', e => {
  if (state.mode !== 'bullage' || !state.pdfDoc || state.pendingBubble) return;

  const rect   = annotCanvas.getBoundingClientRect();
  const scaleX = annotCanvas.width  / rect.width;
  const scaleY = annotCanvas.height / rect.height;

  state.pendingBubble = {
    id:          state.nextId,
    page:        state.currentPage,
    x:           (e.clientX - rect.left) * scaleX / state.scale,  // PDF points
    y:           (e.clientY - rect.top)  * scaleY / state.scale,  // PDF points (y depuis le haut)
    designation: '',
    nominal:     0,
    tolPlus:     0,
    tolMinus:    0,
    unit:        'mm',
    measured:    null,
  };

  drawAnnotations();
  showPopover(e.clientX, e.clientY);
});

// ─── Annotations ─────────────────────────────────────────
function drawAnnotations() {
  annotCtx.clearRect(0, 0, annotCanvas.width, annotCanvas.height);
  state.bubbles
    .filter(b => b.page === state.currentPage)
    .forEach(b => drawBubble(b, false));
  if (state.pendingBubble?.page === state.currentPage) drawBubble(state.pendingBubble, true);
}

function bubbleColor(b, pending) {
  if (pending) return '#f59e0b';
  if (state.mode === 'mesure' && b.measured !== null && b.measured !== undefined && b.measured !== '') {
    return isOK(b) ? '#16a34a' : '#dc2626';
  }
  return '#2563eb';
}

function drawBubble(b, pending = false) {
  // Conversion PDF points → canvas pixels pour l'affichage
  const x = b.x * state.scale;
  const y = b.y * state.scale;
  const r = PDF_R * state.scale;

  const color = bubbleColor(b, pending);

  annotCtx.save();
  annotCtx.shadowColor   = 'rgba(0,0,0,0.25)';
  annotCtx.shadowBlur    = 5;
  annotCtx.shadowOffsetY = 2;
  annotCtx.beginPath();
  annotCtx.arc(x, y, r, 0, Math.PI * 2);
  annotCtx.fillStyle = color;
  annotCtx.fill();
  annotCtx.restore();

  annotCtx.beginPath();
  annotCtx.arc(x, y, r, 0, Math.PI * 2);
  annotCtx.strokeStyle = 'rgba(255,255,255,0.85)';
  annotCtx.lineWidth   = 1.5;
  annotCtx.stroke();

  annotCtx.fillStyle    = '#fff';
  annotCtx.font         = `bold ${r * 1.1}px 'Segoe UI', sans-serif`;
  annotCtx.textAlign    = 'center';
  annotCtx.textBaseline = 'middle';
  annotCtx.fillText(b.id, x, y + 0.5);
}

// ─── Popover ─────────────────────────────────────────────
function showPopover(cx, cy) {
  popover.classList.remove('hidden');
  $('popover-badge').textContent = state.pendingBubble.id;
  $('inp-desig').value     = '';
  $('inp-nominal').value   = '';
  $('inp-tol-plus').value  = '';
  $('inp-tol-minus').value = '';
  $('inp-unit').value      = 'mm';

  const W = 276, H = 290;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = cx + 14;
  let top  = cy - H / 2;
  if (left + W > vw - 8) left = cx - W - 14;
  if (top < 8) top = 8;
  if (top + H > vh - 8) top = vh - H - 8;
  popover.style.left = left + 'px';
  popover.style.top  = top + 'px';

  setTimeout(() => $('inp-desig').focus(), 40);
}

$('inp-desig').addEventListener('keydown',     e => { if (e.key === 'Enter') $('inp-nominal').focus(); });
$('inp-nominal').addEventListener('keydown',   e => { if (e.key === 'Enter') $('inp-tol-plus').focus(); });
$('inp-tol-plus').addEventListener('keydown',  e => { if (e.key === 'Enter') $('inp-tol-minus').focus(); });
$('inp-tol-minus').addEventListener('keydown', e => { if (e.key === 'Enter') confirmBubble(); });

$('btn-confirm-bubble').addEventListener('click', confirmBubble);
$('btn-cancel-bubble').addEventListener('click',  cancelBubble);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.pendingBubble) cancelBubble(); });

function confirmBubble() {
  if (!state.pendingBubble) return;
  const b = state.pendingBubble;
  b.designation = $('inp-desig').value.trim();
  b.nominal     = parseFloat($('inp-nominal').value)   || 0;
  b.tolPlus     = Math.abs(parseFloat($('inp-tol-plus').value)  || 0);
  b.tolMinus    = Math.abs(parseFloat($('inp-tol-minus').value) || 0);
  b.unit        = $('inp-unit').value;
  state.bubbles.push({ ...b });
  state.nextId++;
  state.pendingBubble = null;
  popover.classList.add('hidden');
  drawAnnotations();
  renderBubbleList();
}

function cancelBubble() {
  state.pendingBubble = null;
  popover.classList.add('hidden');
  drawAnnotations();
}

// ─── Sidebar ─────────────────────────────────────────────
function isOK(b) {
  if (b.measured === null || b.measured === undefined || b.measured === '') return null;
  const m = parseFloat(b.measured);
  return m >= (b.nominal - b.tolMinus) && m <= (b.nominal + b.tolPlus);
}

function renderBubbleList() {
  bubbleList.innerHTML = '';
  updateStats();

  if (state.bubbles.length === 0) {
    bubbleList.innerHTML = `<p style="text-align:center;color:#94a3b8;font-size:12px;padding:24px 8px">
      ${state.mode === 'bullage'
        ? 'Cliquez sur le plan pour placer une bulle'
        : 'Passez en mode Bullage pour ajouter des cotes'}
    </p>`;
    return;
  }

  for (const b of state.bubbles) {
    const ok        = isOK(b);
    const okClass   = ok === null ? '' : ok ? 'ok' : 'nok';
    const chipClass = ok === null ? 'pending' : ok ? 'ok' : 'nok';
    const chipText  = ok === null ? '—' : ok ? 'OK' : 'NOK';
    const tol = b.tolPlus === b.tolMinus
      ? `± ${b.tolPlus} ${b.unit}`
      : `+${b.tolPlus} / −${b.tolMinus} ${b.unit}`;

    const div = document.createElement('div');
    div.className = 'bubble-item';
    div.dataset.id = b.id;

    if (state.mode === 'bullage') {
      div.innerHTML = `
        <div class="bubble-badge ${okClass}">${b.id}</div>
        <div class="bubble-info">
          <span class="bubble-desig">${b.designation || '—'}</span>
          <span class="bubble-spec">${b.nominal} ${b.unit} &nbsp;·&nbsp; ${tol}</span>
        </div>
        <button class="btn-del" title="Supprimer">✕</button>
      `;
      div.querySelector('.btn-del').addEventListener('click', () => deleteBubble(b.id));
    } else {
      div.innerHTML = `
        <div class="bubble-badge ${okClass}">${b.id}</div>
        <div class="bubble-info">
          <span class="bubble-desig">${b.designation || '—'}</span>
          <span class="bubble-spec">${b.nominal} ${b.unit} &nbsp;·&nbsp; ${tol}</span>
          <div class="measure-row">
            <input type="number" class="measure-input" step="any"
              value="${b.measured ?? ''}" placeholder="Valeur mesurée">
            <span class="status-chip ${chipClass}">${chipText}</span>
          </div>
        </div>
      `;
      div.querySelector('.measure-input').addEventListener('input', function () {
        onMeasureInput(b.id, this, div);
      });
    }

    bubbleList.appendChild(div);
  }
}

function onMeasureInput(id, input, div) {
  const b = state.bubbles.find(x => x.id === id);
  if (!b) return;
  b.measured = input.value !== '' ? parseFloat(input.value) : null;
  const ok = isOK(b);
  div.querySelector('.bubble-badge').className = `bubble-badge ${ok === null ? '' : ok ? 'ok' : 'nok'}`;
  const chip = div.querySelector('.status-chip');
  chip.className   = `status-chip ${ok === null ? 'pending' : ok ? 'ok' : 'nok'}`;
  chip.textContent = ok === null ? '—' : ok ? 'OK' : 'NOK';
  drawAnnotations();
  updateStats();
}

function deleteBubble(id) {
  state.bubbles = state.bubbles.filter(b => b.id !== id);
  drawAnnotations();
  renderBubbleList();
}

function updateStats() {
  const total = state.bubbles.length;
  const oks   = state.bubbles.filter(b => isOK(b) === true).length;
  const noks  = state.bubbles.filter(b => isOK(b) === false).length;
  $('stat-total').textContent = `${total} cote${total > 1 ? 's' : ''}`;
  $('stat-ok').textContent    = `${oks} OK`;
  $('stat-nok').textContent   = `${noks} NOK`;
}

// ─── Sauvegarder PDF avec bulles intégrées ────────────────
// Les bulles sont dessinées en vecteurs PDF (pas de rasterisation)
// b.x, b.y sont en points PDF avec origine haut-gauche
// pdf-lib utilise origine bas-gauche → flip y : pdfY = pageHeight - b.y
$('btn-save-pdf').addEventListener('click', savePDF);

async function savePDF() {
  if (!state.pdfBytes || !state.bubbles.length) return;

  const btn = $('btn-save-pdf');
  btn.disabled   = true;
  btn.textContent = '…';

  try {
    const { PDFDocument, rgb, StandardFonts } = PDFLib;

    const pdfDoc = await PDFDocument.load(state.pdfBytes);
    const font   = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const pages  = pdfDoc.getPages();

    const FONT_SIZE = PDF_R * 1.05;

    for (const b of state.bubbles) {
      const page = pages[b.page - 1];
      if (!page) continue;

      const { height } = page.getSize();
      const pdfX = b.x;
      const pdfY = height - b.y;   // flip : PDF origine bas-gauche

      // Couleur de la bulle
      let fillColor;
      if (b.measured !== null && b.measured !== undefined && b.measured !== '') {
        fillColor = isOK(b) ? rgb(0.086, 0.639, 0.290) : rgb(0.863, 0.149, 0.149);
      } else {
        fillColor = rgb(0.145, 0.388, 0.922);
      }

      // Cercle
      page.drawCircle({
        x:           pdfX,
        y:           pdfY,
        size:        PDF_R,
        color:       fillColor,
        borderColor: rgb(1, 1, 1),
        borderWidth: 0.8,
        opacity:     0.92,
      });

      // Numéro centré
      const text      = String(b.id);
      const textWidth = font.widthOfTextAtSize(text, FONT_SIZE);
      page.drawText(text, {
        x:    pdfX - textWidth / 2,
        y:    pdfY - FONT_SIZE * 0.36,
        size: FONT_SIZE,
        font,
        color: rgb(1, 1, 1),
      });
    }

    // Encode les bulles dans les métadonnées PDF pour pouvoir rouvrir et continuer
    pdfDoc.setSubject('__pi__' + JSON.stringify({ version: 1, bubbles: state.bubbles }));

    const savedBytes = await pdfDoc.save();
    triggerDownload(savedBytes, `${state.fileName}_bullage.pdf`, 'application/pdf');
  } catch (err) {
    alert('Erreur lors de la sauvegarde :\n' + err.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = '💾 Sauvegarder PDF';
  }
}

// ─── Toast notification ───────────────────────────────────
function showToast(msg, duration = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), duration);
}

function triggerDownload(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Export PDF (rapport) ────────────────────────────────
$('btn-export-pdf').addEventListener('click', exportPDF);

async function exportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const PW  = 210;

  // Plan annoté : composite PDF + bulles
  const tmp    = document.createElement('canvas');
  tmp.width    = pdfCanvas.width;
  tmp.height   = pdfCanvas.height;
  const tmpCtx = tmp.getContext('2d');
  tmpCtx.drawImage(pdfCanvas, 0, 0);
  tmpCtx.drawImage(annotCanvas, 0, 0);
  const img = tmp.toDataURL('image/jpeg', 0.92);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Rapport de contrôle', PW / 2, 14, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(100);
  doc.text(`Fichier : ${state.fileName}`, 14, 20);
  doc.text(`Date : ${new Date().toLocaleDateString('fr-FR')}`, PW - 14, 20, { align: 'right' });
  doc.setTextColor(0);

  const maxW = PW - 28, maxH = 125;
  const ratio = tmp.width / tmp.height;
  let iW = maxW, iH = maxW / ratio;
  if (iH > maxH) { iH = maxH; iW = maxH * ratio; }
  doc.addImage(img, 'JPEG', (PW - iW) / 2, 24, iW, iH);

  const headers = [['N°', 'Désignation', 'Nominale', 'Tol. +', 'Tol. −', 'Unité', 'Mesure', 'Statut']];
  const rows    = state.bubbles.map(b => {
    const ok = isOK(b);
    return [b.id, b.designation || '—', b.nominal, b.tolPlus, b.tolMinus, b.unit,
      b.measured ?? '—', ok === null ? '—' : ok ? 'OK' : 'NOK'];
  });

  doc.autoTable({
    head: headers, body: rows,
    startY: 24 + iH + 6,
    theme: 'grid',
    headStyles:         { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    bodyStyles:         { fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles:       { 0: { cellWidth: 9, halign: 'center' }, 7: { halign: 'center' } },
    didParseCell: data => {
      if (data.column.index === 7 && data.section === 'body') {
        if (data.cell.raw === 'OK')  { data.cell.styles.textColor = [22, 163, 74];  data.cell.styles.fontStyle = 'bold'; }
        if (data.cell.raw === 'NOK') { data.cell.styles.textColor = [220, 38, 38]; data.cell.styles.fontStyle = 'bold'; }
      }
    },
    margin: { left: 14, right: 14 },
  });

  const total = state.bubbles.length;
  const oks   = state.bubbles.filter(b => isOK(b) === true).length;
  const noks  = state.bubbles.filter(b => isOK(b) === false).length;
  doc.setFontSize(8);
  doc.setTextColor(100);
  doc.text(`Total : ${total} cote${total > 1 ? 's' : ''} | OK : ${oks} | NOK : ${noks}`,
    14, doc.lastAutoTable.finalY + 5);

  doc.save(`${state.fileName}_rapport.pdf`);
}

// ─── Export Excel ─────────────────────────────────────────
$('btn-export-excel').addEventListener('click', exportExcel);

function exportExcel() {
  const wb     = XLSX.utils.book_new();
  const header = ['N°', 'Désignation', 'Nominale', 'Tol. +', 'Tol. −', 'Unité', 'Valeur mesurée', 'Statut', 'Page'];
  const rows   = state.bubbles.map(b => {
    const ok = isOK(b);
    return [b.id, b.designation || '', b.nominal, b.tolPlus, b.tolMinus, b.unit,
      b.measured ?? '', ok === null ? '' : ok ? 'OK' : 'NOK', b.page];
  });
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = [
    { wch: 5 }, { wch: 28 }, { wch: 12 }, { wch: 9 }, { wch: 9 },
    { wch: 8 }, { wch: 16 }, { wch: 8 }, { wch: 6 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Contrôle');
  XLSX.writeFile(wb, `${state.fileName}_rapport.xlsx`);
}
