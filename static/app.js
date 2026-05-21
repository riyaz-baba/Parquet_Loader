const ROW_HEIGHT = 34;
const PAGE_SIZE = 300;
const BUFFER_ROWS = 18;
const INDEX_WIDTH = 76;
const MIN_COLUMN_WIDTH = 80;
const INITIAL_COLUMN_MIN_WIDTH = 140;
const INITIAL_COLUMN_MAX_WIDTH = 340;
const CELL_HORIZONTAL_PADDING = 20;
const HEADER_HORIZONTAL_PADDING = 34;

const state = {
  datasetId: null,
  filename: "",
  rowCount: 0,
  columns: [],
  columnWidths: [],
  columnOffsets: [],
  gridTemplate: `${INDEX_WIDTH}px`,
  gridWidth: INDEX_WIDTH,
  cache: new Map(),
  pendingPages: new Set(),
  fitMetricsCache: new Map(),
  activeResize: null,
  renderToken: 0,
};

let measureContext = null;

const uploadForm = document.getElementById("uploadForm");
const uploadButton = document.getElementById("uploadButton");
const fileInput = document.getElementById("fileInput");
const fileName = document.getElementById("fileName");
const statusBar = document.getElementById("statusBar");
const statusText = document.getElementById("statusText");
const datasetSummary = document.getElementById("datasetSummary");
const dataArea = document.getElementById("dataArea");
const columnFilter = document.getElementById("columnFilter");
const columnList = document.getElementById("columnList");
const jumpInput = document.getElementById("jumpInput");
const jumpButton = document.getElementById("jumpButton");
const windowLabel = document.getElementById("windowLabel");
const headerViewport = document.getElementById("headerViewport");
const bodyViewport = document.getElementById("bodyViewport");
const bodyCanvas = document.getElementById("bodyCanvas");
const gridHeader = document.getElementById("gridHeader");
const gridRows = document.getElementById("gridRows");
const cellPreview = document.getElementById("cellPreview");

fileInput.addEventListener("change", () => {
  fileName.textContent = fileInput.files[0]?.name || "Choose parquet file";
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) {
    setStatus("Choose a parquet file first.", true);
    return;
  }

  setBusy(true);
  setStatus(`Loading ${file.name}...`);

  try {
    const response = await fetch("/api/upload", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(file.name),
      },
      body: file,
    });

    const payload = await parseJsonResponse(response);
    initializeDataset(payload);
    setStatus(`Loaded ${formatNumber(payload.row_count)} rows from ${payload.filename}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
});

bodyViewport.addEventListener("scroll", () => {
  headerViewport.scrollLeft = bodyViewport.scrollLeft;
  scheduleRender();
});

columnFilter.addEventListener("input", renderColumnList);

jumpButton.addEventListener("click", jumpToRow);
jumpInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    jumpToRow();
  }
});

function initializeDataset(payload) {
  state.datasetId = payload.dataset_id;
  state.filename = payload.filename;
  state.rowCount = payload.row_count;
  state.columns = payload.columns;
  state.cache = new Map();
  state.pendingPages = new Set();
  state.fitMetricsCache = new Map();
  state.activeResize = null;
  state.renderToken += 1;

  computeColumnLayout();
  renderHeader();
  renderColumnList();

  bodyCanvas.style.height = `${Math.max(state.rowCount * ROW_HEIGHT, 1)}px`;
  applyGridLayout();

  bodyViewport.scrollTop = 0;
  bodyViewport.scrollLeft = 0;
  headerViewport.scrollLeft = 0;

  jumpInput.max = Math.max(state.rowCount, 1);
  jumpInput.value = state.rowCount > 0 ? 1 : 0;
  cellPreview.textContent = "None";
  dataArea.classList.remove("is-empty");

  datasetSummary.textContent = `${formatNumber(payload.row_count)} rows, ${formatNumber(
    payload.column_count
  )} columns, ${payload.memory_label}`;

  scheduleRender();
}

function computeColumnLayout() {
  state.columnWidths = state.columns.map((column) => {
    const labelLength = Math.max(column.name.length, column.dtype.length + 4);
    return clamp(labelLength * 8 + 36, INITIAL_COLUMN_MIN_WIDTH, INITIAL_COLUMN_MAX_WIDTH);
  });

  updateColumnLayout();
}

function updateColumnLayout() {
  state.columnOffsets = [];
  let offset = INDEX_WIDTH;
  for (const width of state.columnWidths) {
    state.columnOffsets.push(offset);
    offset += width;
  }

  state.gridWidth = offset;
  state.gridTemplate = `${INDEX_WIDTH}px ${state.columnWidths.map((width) => `${width}px`).join(" ")}`;
}

function applyGridLayout() {
  const width = `${state.gridWidth}px`;
  bodyCanvas.style.width = width;
  gridRows.style.width = width;
  gridHeader.style.width = width;
  gridHeader.style.gridTemplateColumns = state.gridTemplate;

  for (const row of gridRows.children) {
    row.style.width = width;
    row.style.gridTemplateColumns = state.gridTemplate;
  }
}

function renderHeader() {
  gridHeader.style.gridTemplateColumns = state.gridTemplate;
  gridHeader.replaceChildren();

  const index = document.createElement("div");
  index.className = "grid-cell header-cell index-cell";
  index.textContent = "#";
  gridHeader.append(index);

  for (const column of state.columns) {
    const cell = document.createElement("div");
    cell.className = "grid-cell header-cell resizable-header-cell";
    cell.title = `${column.name} (${column.dtype})`;

    const name = document.createElement("span");
    name.className = "header-name";
    name.textContent = column.name;

    const type = document.createElement("span");
    type.className = "header-type";
    type.textContent = column.dtype;

    const resizer = document.createElement("div");
    resizer.className = "column-resizer";
    resizer.dataset.columnIndex = column.index;
    resizer.tabIndex = 0;
    resizer.title = "Drag to resize. Double-click to fit content.";
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-label", `Resize ${column.name}`);
    resizer.setAttribute("aria-orientation", "vertical");
    resizer.setAttribute("aria-valuemin", String(MIN_COLUMN_WIDTH));
    resizer.setAttribute("aria-valuenow", String(Math.round(state.columnWidths[column.index])));
    resizer.addEventListener("pointerdown", (event) => startColumnResize(event, column.index));
    resizer.addEventListener("dblclick", (event) => autoFitColumn(event, column.index));
    resizer.addEventListener("keydown", (event) => handleColumnResizeKeydown(event, column.index));

    cell.append(name, type, resizer);
    gridHeader.append(cell);
  }
}

function startColumnResize(event, columnIndex) {
  if (event.button !== 0 || event.detail > 1) return;

  event.preventDefault();
  event.stopPropagation();

  const handle = event.currentTarget;
  state.activeResize = {
    columnIndex,
    handle,
    pointerId: event.pointerId,
    startWidth: state.columnWidths[columnIndex] || MIN_COLUMN_WIDTH,
    startX: event.clientX,
  };

  document.body.classList.add("is-column-resizing");
  handle.setPointerCapture(event.pointerId);
  handle.addEventListener("pointermove", handleColumnResizeMove);
  handle.addEventListener("pointerup", stopColumnResize);
  handle.addEventListener("pointercancel", stopColumnResize);
}

function handleColumnResizeMove(event) {
  const resize = state.activeResize;
  if (!resize || event.pointerId !== resize.pointerId) return;

  const nextWidth = resize.startWidth + event.clientX - resize.startX;
  setColumnWidth(resize.columnIndex, nextWidth);
}

function stopColumnResize(event) {
  const resize = state.activeResize;
  if (!resize || event.pointerId !== resize.pointerId) return;

  resize.handle.removeEventListener("pointermove", handleColumnResizeMove);
  resize.handle.removeEventListener("pointerup", stopColumnResize);
  resize.handle.removeEventListener("pointercancel", stopColumnResize);

  if (resize.handle.hasPointerCapture(event.pointerId)) {
    resize.handle.releasePointerCapture(event.pointerId);
  }

  state.activeResize = null;
  document.body.classList.remove("is-column-resizing");
}

function handleColumnResizeKeydown(event, columnIndex) {
  if (event.key === "Enter" || event.key === " ") {
    autoFitColumn(event, columnIndex);
    return;
  }

  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

  event.preventDefault();
  const step = event.shiftKey ? 40 : 12;
  const direction = event.key === "ArrowRight" ? 1 : -1;
  setColumnWidth(columnIndex, state.columnWidths[columnIndex] + direction * step);
}

async function autoFitColumn(event, columnIndex) {
  event.preventDefault();
  event.stopPropagation();

  if (!state.datasetId) return;

  const column = state.columns[columnIndex];
  if (!column) return;

  try {
    if (!state.fitMetricsCache.has(columnIndex)) {
      setStatus(`Measuring ${column.name}...`);
    }
    const metrics = await getColumnFitMetrics(columnIndex);
    setColumnWidth(columnIndex, calculateAutoFitWidth(columnIndex, metrics));
    setStatus(`Column ${column.name} resized to fit its content.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function getColumnFitMetrics(columnIndex) {
  const cached = state.fitMetricsCache.get(columnIndex);
  if (cached) return cached;

  const response = await fetch(`/api/datasets/${state.datasetId}/columns/${columnIndex}/width`);
  const payload = await parseJsonResponse(response);
  state.fitMetricsCache.set(columnIndex, payload);
  return payload;
}

function calculateAutoFitWidth(columnIndex, metrics) {
  const column = state.columns[columnIndex];
  const bodyStyle = getComputedStyle(document.body);
  const cellFont = `400 13px ${bodyStyle.fontFamily}`;
  const headerFont = `650 13px ${bodyStyle.fontFamily}`;
  const typeFont = `500 11px ${bodyStyle.fontFamily}`;
  const sampleText = metrics.sample_text || "";
  const sampleLength = sampleText.length;
  const maxDisplayLength = Number(metrics.max_display_length) || sampleLength;
  const widestCharacterWidth = measureTextWidth("W", cellFont);

  const headerWidth =
    Math.max(
      measureTextWidth(column.name, headerFont),
      measureTextWidth(column.dtype, typeFont)
    ) + HEADER_HORIZONTAL_PADDING;
  const sampleWidth = measureTextWidth(sampleText, cellFont) + CELL_HORIZONTAL_PADDING;
  const lengthEstimateWidth =
    maxDisplayLength > sampleLength
      ? maxDisplayLength * widestCharacterWidth + CELL_HORIZONTAL_PADDING
      : 0;
  const cachedRowsWidth = getCachedColumnContentWidth(columnIndex, cellFont) + CELL_HORIZONTAL_PADDING;

  return Math.ceil(
    Math.max(
      MIN_COLUMN_WIDTH,
      headerWidth,
      sampleWidth,
      lengthEstimateWidth,
      cachedRowsWidth
    )
  );
}

function getCachedColumnContentWidth(columnIndex, font) {
  let width = 0;
  for (const row of state.cache.values()) {
    if (!row || columnIndex >= row.length) continue;
    width = Math.max(width, measureTextWidth(formatCell(row[columnIndex]), font));
  }
  return width;
}

function setColumnWidth(columnIndex, width) {
  if (!state.columns[columnIndex]) return;

  state.columnWidths[columnIndex] = Math.max(MIN_COLUMN_WIDTH, Math.round(width));
  updateColumnLayout();
  applyGridLayout();
  updateResizerValue(columnIndex);
}

function updateResizerValue(columnIndex) {
  const resizer = gridHeader.querySelector(`.column-resizer[data-column-index="${columnIndex}"]`);
  if (resizer) {
    resizer.setAttribute("aria-valuenow", String(Math.round(state.columnWidths[columnIndex])));
  }
}

function renderColumnList() {
  const query = columnFilter.value.trim().toLowerCase();
  const fragment = document.createDocumentFragment();

  state.columns
    .filter((column) => {
      if (!query) return true;
      return (
        column.name.toLowerCase().includes(query) ||
        column.dtype.toLowerCase().includes(query)
      );
    })
    .forEach((column) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "column-item";
      item.title = `${column.name} (${column.dtype})`;
      item.addEventListener("click", () => scrollToColumn(column.index));

      const name = document.createElement("span");
      name.className = "column-name";
      name.textContent = column.name;

      const type = document.createElement("span");
      type.className = "column-type";
      type.textContent = column.dtype;

      item.append(name, type);
      fragment.append(item);
    });

  columnList.replaceChildren(fragment);
}

function scheduleRender() {
  window.requestAnimationFrame(renderVisibleRows);
}

function renderVisibleRows() {
  if (!state.datasetId) return;

  const scrollTop = bodyViewport.scrollTop;
  const viewportHeight = bodyViewport.clientHeight || 1;
  const start = clamp(Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS, 0, state.rowCount);
  const end = clamp(
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + BUFFER_ROWS,
    0,
    state.rowCount
  );

  ensureRows(start, end);

  const fragment = document.createDocumentFragment();
  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    fragment.append(renderRow(rowIndex));
  }

  gridRows.replaceChildren(fragment);
  updateWindowLabel(start, end);
}

function renderRow(rowIndex) {
  const row = document.createElement("div");
  row.className = "grid-row data-row";
  row.style.gridTemplateColumns = state.gridTemplate;
  row.style.width = `${state.gridWidth}px`;
  row.style.transform = `translateY(${rowIndex * ROW_HEIGHT}px)`;

  const indexCell = document.createElement("div");
  indexCell.className = "grid-cell index-cell";
  indexCell.textContent = formatNumber(rowIndex + 1);
  row.append(indexCell);

  const rowData = state.cache.get(rowIndex);
  if (!rowData) {
    for (let index = 0; index < state.columns.length; index += 1) {
      const cell = document.createElement("div");
      cell.className = "grid-cell loading-cell";
      cell.textContent = "Loading";
      row.append(cell);
    }
    return row;
  }

  rowData.forEach((value, columnIndex) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "grid-cell";
    const text = formatCell(value);
    cell.textContent = text;
    cell.title = text;
    if (value === null || value === undefined) {
      cell.classList.add("null-cell");
    }
    cell.addEventListener("click", () => {
      const columnName = state.columns[columnIndex]?.name || `Column ${columnIndex + 1}`;
      cellPreview.textContent = `Row ${formatNumber(rowIndex + 1)}, ${columnName}: ${text}`;
    });
    row.append(cell);
  });

  return row;
}

function ensureRows(start, end) {
  if (start >= end) return;

  const firstPage = Math.floor(start / PAGE_SIZE) * PAGE_SIZE;
  const lastPage = Math.floor((end - 1) / PAGE_SIZE) * PAGE_SIZE;

  for (let offset = firstPage; offset <= lastPage; offset += PAGE_SIZE) {
    if (state.cache.has(offset) || state.pendingPages.has(offset)) {
      continue;
    }
    fetchRows(offset);
  }
}

async function fetchRows(offset) {
  const token = state.renderToken;
  state.pendingPages.add(offset);

  try {
    const url = `/api/datasets/${state.datasetId}/rows?offset=${offset}&limit=${PAGE_SIZE}`;
    const response = await fetch(url);
    const payload = await parseJsonResponse(response);

    if (token !== state.renderToken) return;

    payload.rows.forEach((row, index) => {
      state.cache.set(payload.offset + index, row);
    });
    scheduleRender();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.pendingPages.delete(offset);
  }
}

function jumpToRow() {
  if (!state.datasetId || state.rowCount === 0) return;

  const requested = Number.parseInt(jumpInput.value, 10);
  if (!Number.isFinite(requested)) return;

  const target = clamp(requested, 1, state.rowCount) - 1;
  bodyViewport.scrollTop = target * ROW_HEIGHT;
  scheduleRender();
}

function scrollToColumn(columnIndex) {
  const x = state.columnOffsets[columnIndex] || 0;
  bodyViewport.scrollLeft = Math.max(x - INDEX_WIDTH, 0);
  headerViewport.scrollLeft = bodyViewport.scrollLeft;
}

function updateWindowLabel(start, end) {
  if (!state.datasetId) {
    windowLabel.textContent = "Rows 0-0";
    return;
  }

  if (state.rowCount === 0) {
    windowLabel.textContent = "Rows 0-0 of 0";
    return;
  }

  windowLabel.textContent = `Rows ${formatNumber(start + 1)}-${formatNumber(end)} of ${formatNumber(
    state.rowCount
  )}`;
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || `Request failed with ${response.status}`);
  }
  return payload;
}

function setBusy(isBusy) {
  uploadButton.disabled = isBusy;
  fileInput.disabled = isBusy;
}

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusBar.classList.toggle("is-error", isError);
}

function formatCell(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function measureTextWidth(text, font) {
  if (!measureContext) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  measureContext.font = font;
  return measureContext.measureText(String(text ?? "")).width;
}
