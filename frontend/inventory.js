let inventoryRows = [];
let currentInventoryFileName = "";
let queuedInventoryFiles = [];
let sharedQueueFiles = [];
let queueEditIndex = null;
let queueEditId = null;

const INVENTORY_QUEUE_STORAGE_KEY = "inventoryQueueFiles";
const INVENTORY_UPLOAD_STORAGE_KEY = "inventoryUploadState";

const queueItemId = () =>
  `queue-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER_URL = "http://localhost:3000";
const normalizeServerUrl = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) return DEFAULT_SERVER_URL;
  return trimmed.replace(/\/$/, "");
};
const getServerUrl = () => {
  const storedServerUrl = localStorage.getItem("shopifyServerUrl");
  return normalizeServerUrl(storedServerUrl || DEFAULT_SERVER_URL);
};
const saveServerUrl = (value) => {
  const normalized = normalizeServerUrl(value);
  localStorage.setItem("shopifyServerUrl", normalized);
  if (chrome?.storage?.local) {
    chrome.storage.local.set({ shopifyServerUrl: normalized });
  }
  return normalized;
};
const getAdminKey = () => localStorage.getItem("inventoryAdminKey") || "";
const saveAdminKey = (value) => {
  const normalized = String(value || "").trim();
  localStorage.setItem("inventoryAdminKey", normalized);
  return normalized;
};
const getDeviceName = () => {
  const savedDeviceName = localStorage.getItem("inventoryDeviceName");
  if (savedDeviceName) return savedDeviceName;

  const detectedName =
    navigator.userAgentData?.platform ||
    navigator.platform ||
    window.location.hostname ||
    "PC";
  const fallback = String(detectedName).trim() || "PC";
  localStorage.setItem("inventoryDeviceName", fallback);
  return fallback;
};
const saveDeviceName = (value) => {
  const normalized = String(value || "").trim() || "PC";
  localStorage.setItem("inventoryDeviceName", normalized);
  return normalized;
};
const setServerStatus = (state, message) => {
  const badge = $("serverStatusBadge");
  const statusMessage = $("serverStatusMessage");
  if (!badge || !statusMessage) return;

  const isConnected = state === "connected";
  badge.textContent = isConnected
    ? "Connected"
    : state === "error"
      ? "Error"
      : "Connecting...";
  badge.classList.toggle("connected", isConnected);
  badge.classList.toggle("error", state === "error");
  badge.classList.toggle("warning", state === "connecting");
  statusMessage.textContent = message || "Server status unknown.";
};
async function checkServerConnection(showStatus = true) {
  const url = getServerUrl();
  if (showStatus) {
    setServerStatus("connecting", `Connecting to ${url}...`);
  }

  try {
    const response = await fetch(`${url}/server/status`, { method: "GET" });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not reach the server.");
    }

    const message = data.message || "Server connected";
    setServerStatus("connected", message);
    return true;
  } catch (error) {
    setServerStatus("error", error.message || "The server is not responding.");
    return false;
  }
}

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");

const escapeAttribute = (value) => escapeHtml(value).replace(/`/g, "&#96;");

function formatFileSize(bytes) {
  const number = Number(bytes || 0);
  if (!Number.isFinite(number) || number <= 0) return "0 KB";

  const units = ["B", "KB", "MB", "GB"];
  let size = number;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function setInventoryTab(panelName) {
  const panels = document.querySelectorAll(".inventory-panel");
  const tabs = document.querySelectorAll(".inventory-tab");

  panels.forEach((panel) => {
    const isActive = panel.id === panelName;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });

  tabs.forEach((tab) => {
    const isActive = tab.dataset.panel === panelName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
}

function toggleInventoryFormatGuide() {
  const panel = $("inventoryFormatPanel");
  if (!panel) return;
  panel.hidden = !panel.hidden;
}

function downloadInventoryTemplate() {
  const csvContent = [
    "Product Name,SKU,Quantity",
    "Classic T-Shirt,TS-1001,25",
    "Black Mug,MUG-404,12",
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "inventory-template.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function normalizeQueuedInventoryFiles(items) {
  const seenNames = new Set(
    queuedInventoryFiles.map((queuedItem) => queuedItem.name.toLowerCase()),
  );

  return (items || []).reduce((accumulator, item) => {
    const normalizedItem =
      item && typeof item === "object" && "name" in item
        ? {
            id: item.id || queueItemId(),
            name: item.name,
            file: item.file || null,
          }
        : {
            id: queueItemId(),
            name: String(item),
            file: null,
          };

    if (
      !normalizedItem.name ||
      seenNames.has(normalizedItem.name.toLowerCase())
    ) {
      return accumulator;
    }

    seenNames.add(normalizedItem.name.toLowerCase());
    accumulator.push(normalizedItem);
    return accumulator;
  }, []);
}

async function fileToDataUrl(file) {
  if (!file) return "";

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () =>
      reject(new Error("Could not encode the queued file."));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl, fileName) {
  if (!dataUrl || !dataUrl.includes(",")) return null;

  const [header, encodedPayload] = dataUrl.split(",");
  const mimeMatch = header.match(/^data:(.*?);base64$/i);
  const mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";

  try {
    const binary = atob(encodedPayload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new File([bytes], fileName || "queued-file.csv", {
      type: mimeType,
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
}

async function persistQueuedFiles() {
  const queueSnapshot = await Promise.all(
    queuedInventoryFiles.map(async ({ id, name, file }) => ({
      id,
      name,
      dataUrl: file ? await fileToDataUrl(file) : "",
    })),
  );

  localStorage.setItem(
    INVENTORY_QUEUE_STORAGE_KEY,
    JSON.stringify(queueSnapshot),
  );
}

function restoreQueuedFiles() {
  try {
    const rawQueue = JSON.parse(
      localStorage.getItem(INVENTORY_QUEUE_STORAGE_KEY) || "[]",
    );

    queuedInventoryFiles = (Array.isArray(rawQueue) ? rawQueue : []).map(
      (item) => ({
        id: item?.id || queueItemId(),
        name: item?.name || "",
        file: item?.dataUrl
          ? dataUrlToFile(item.dataUrl, item?.name || "queued-file.csv")
          : null,
      }),
    );
  } catch {
    queuedInventoryFiles = [];
  }
}

function persistInventoryUploadState() {
  localStorage.setItem(
    INVENTORY_UPLOAD_STORAGE_KEY,
    JSON.stringify({
      currentInventoryFileName,
      rows: inventoryRows,
    }),
  );
}

function restoreInventoryUploadState() {
  try {
    const rawState = JSON.parse(
      localStorage.getItem(INVENTORY_UPLOAD_STORAGE_KEY) || "null",
    );
    if (!rawState) return;

    currentInventoryFileName = String(rawState.currentInventoryFileName || "");
    inventoryRows = Array.isArray(rawState.rows) ? rawState.rows : [];
  } catch {
    currentInventoryFileName = "";
    inventoryRows = [];
  }
}

function hasActiveInventoryUploadData() {
  return Boolean(
    currentInventoryFileName ||
    inventoryRows.length > 0 ||
    localStorage.getItem(INVENTORY_UPLOAD_STORAGE_KEY),
  );
}

function getQueuedDisplayItems() {
  const serverLookup = new Set(
    sharedQueueFiles.map((item) => String(item.name || "").toLowerCase()),
  );
  const localOnlyItems = queuedInventoryFiles.filter(
    (item) => !serverLookup.has(String(item.name || "").toLowerCase()),
  );

  return [
    ...sharedQueueFiles.map((item) => ({
      ...item,
      uploadedBy: item.uploadedBy || "Unknown device",
      uploadedAt: item.uploadedAt || new Date().toISOString(),
      source: "server",
      file: null,
      size: Number(item.size || 0),
    })),
    ...localOnlyItems.map((item) => ({
      ...item,
      uploadedBy: getDeviceName(),
      uploadedAt: new Date().toISOString(),
      source: "local",
      size: item.file ? Number(item.file.size || 0) : 0,
    })),
  ];
}

function getQueueItemById(queueId) {
  const normalizedId = String(queueId || "").trim();
  if (!normalizedId) return null;

  return getQueuedDisplayItems().find(
    (candidate) =>
      String(candidate.id || candidate.name || "").toLowerCase() ===
      normalizedId.toLowerCase(),
  );
}

async function deleteQueueItem(queueId) {
  const queueItem = getQueueItemById(queueId);
  if (!queueItem) return;

  const targetName = String(queueItem.name || "").trim();
  if (!targetName) return;

  try {
    if (queueItem.source === "server") {
      const response = await fetch(
        `${getServerUrl()}/inventory/shared-queue?name=${encodeURIComponent(targetName)}`,
        {
          method: "DELETE",
          headers: getAdminKey() ? { "x-admin-key": getAdminKey() } : {},
        },
      );
      const data = await readJsonResponse(response);
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Could not delete the queued file.");
      }
      await loadSharedQueue();
      $("excelQueueSummary").textContent = `Removed queued file: ${targetName}`;
      return;
    }

    queuedInventoryFiles = queuedInventoryFiles.filter(
      (item) =>
        String(item.name || "").toLowerCase() !== targetName.toLowerCase(),
    );
    await persistQueuedFiles();
    renderQueuedFiles();
    $("excelQueueSummary").textContent = `Removed queued file: ${targetName}`;
  } catch (error) {
    $("excelQueueSummary").textContent =
      error.message || "Could not delete the queued file.";
  }
}

function renderQueuedFiles() {
  const queueList = $("excelQueueList");
  const summary = $("excelQueueSummary");

  if (!queueList || !summary) return;

  const displayQueue = getQueuedDisplayItems();
  if (!displayQueue.length) {
    queueList.innerHTML = "";
    summary.textContent = "No spreadsheet files queued yet.";
    return;
  }

  summary.textContent = `${displayQueue.length} file${displayQueue.length === 1 ? "" : "s"} queued.`;
  queueList.innerHTML = displayQueue
    .map((queueItem, index) => {
      const queueId = String(
        queueItem.id || queueItem.name || `local-${index}`,
      );
      const hasMissingFile = !queueItem.name;
      const isPersistedOnly = Boolean(
        queueItem.name && queueItem.source === "local" && !queueItem.file,
      );
      const isBlocked = hasActiveInventoryUploadData();
      const fileSize = formatFileSize(queueItem.size || 0);
      const statusLabel = hasMissingFile
        ? "Error"
        : isBlocked
          ? "Blocked"
          : "Staged";
      const statusReason = hasMissingFile
        ? "File is missing or invalid. Replace it."
        : isBlocked
          ? "Clear the Upload & Update tab before uploading another file."
          : isPersistedOnly
            ? "Restored from last session and ready to upload."
            : queueItem.source === "server"
              ? `Queued by ${escapeHtml(queueItem.uploadedBy || "Unknown device")} on ${new Date(queueItem.uploadedAt || Date.now()).toLocaleString()}`
              : "Ready to upload into the Upload & Update tab.";
      const uploaderName = queueItem.uploadedBy || "Unknown PC";
      const uploaderIp = queueItem.ipAddress || "IP unavailable";

      return `
        <div class="excel-queue-item">
          <div class="excel-queue-item-main">
            <div class="excel-queue-file-meta">
              <span class="excel-queue-file-name">${escapeHtml(queueItem.name || "Unknown file")}</span>
              <span class="excel-queue-status excel-queue-status-${statusLabel.toLowerCase()}">${escapeHtml(statusLabel)}</span>
            </div>
            <span class="excel-queue-actions">
              <button type="button" class="inventory-log-download" data-action="upload" data-queue-id="${escapeAttribute(queueId)}" ${isBlocked || hasMissingFile ? "disabled" : ""}>Upload</button>
              <button type="button" class="inventory-log-download inventory-log-edit" data-action="edit" data-queue-id="${escapeAttribute(queueId)}">Edit</button>
              <button type="button" class="inventory-log-download inventory-log-remove" data-action="delete" data-queue-id="${escapeAttribute(queueId)}">Delete</button>
            </span>
          </div>
          <div class="excel-queue-status-detail">${escapeHtml(statusReason)}</div>
          <div class="excel-queue-status-detail">File size: ${escapeHtml(fileSize)}</div>
          <div class="excel-queue-status-detail">PC name: ${escapeHtml(uploaderName)}</div>
          <div class="excel-queue-status-detail">IP address: ${escapeHtml(uploaderIp)}</div>
        </div>
      `;
    })
    .join("");

  queueList.querySelectorAll("[data-action='upload']").forEach((button) => {
    button.onclick = async () => {
      const queueId = String(button.dataset.queueId || "");
      const queueItem = getQueueItemById(queueId);
      if (!queueItem) return;
      if (hasActiveInventoryUploadData()) {
        $("excelQueueSummary").textContent =
          "Clear the Upload & Update tab before sending another file.";
        return;
      }
      const uploadIndex = getQueuedDisplayItems().findIndex(
        (candidate) =>
          String(candidate.id || candidate.name || "").toLowerCase() ===
          queueId.toLowerCase(),
      );
      await uploadQueuedFilesToUpdateTab(uploadIndex >= 0 ? uploadIndex : 0);
    };
  });

  queueList.querySelectorAll("[data-action='edit']").forEach((button) => {
    button.onclick = () => {
      const queueId = String(button.dataset.queueId || "");
      openQueueFileEditor(queueId);
    };
  });

  queueList.querySelectorAll("[data-action='delete']").forEach((button) => {
    button.onclick = async () => {
      const queueId = String(button.dataset.queueId || "");
      await deleteQueueItem(queueId);
    };
  });
}

async function setMainInventoryFile(file) {
  const input = $("inventoryFile");
  if (!input || !file) return;

  try {
    if (typeof DataTransfer !== "undefined") {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      return;
    }
  } catch {
    // Some browsers do not support DataTransfer; the file will still be sent by the queue upload path.
  }

  input.value = "";
}

function readQueueFileText(file) {
  if (!file) return "";
  if (typeof file.text === "function") {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read this file."));
    reader.readAsText(file);
  });
}

function setQueueModalVisible(isVisible) {
  const modal = $("queueEditModal");
  if (!modal) return;

  modal.classList.toggle("hidden", !isVisible);
  modal.classList.toggle("is-visible", isVisible);
  modal.setAttribute("aria-hidden", String(!isVisible));
  modal.style.display = isVisible ? "flex" : "none";
  document.body.style.overflow = isVisible ? "hidden" : "";
}

function normalizeEditorRows(rows) {
  if (!Array.isArray(rows)) {
    return [["Product Name", "SKU", "Quantity"]];
  }

  const normalized = rows.map((row) => {
    if (Array.isArray(row)) {
      return row.map((cell) => String(cell ?? ""));
    }

    if (row && typeof row === "object") {
      return Object.values(row).map((cell) => String(cell ?? ""));
    }

    return [String(row ?? "")];
  });

  return normalized.filter(
    (row) =>
      Array.isArray(row) &&
      row.some((cell) => String(cell ?? "").trim() !== ""),
  );
}

function parseCsvTable(rawText) {
  if (Array.isArray(rawText)) {
    return normalizeEditorRows(rawText);
  }

  if (
    rawText &&
    typeof rawText === "object" &&
    typeof rawText.text === "function"
  ) {
    return [["Product Name", "SKU", "Quantity"]];
  }

  const text =
    typeof rawText === "string"
      ? rawText
      : rawText != null
        ? String(rawText)
        : "";
  const cleanedText = text.replace(/\r/g, "").trim();

  if (!cleanedText) {
    return [["Product Name", "SKU", "Quantity"]];
  }

  const rows = cleanedText
    .split("\n")
    .map((line) => {
      const cells = [];
      let current = "";
      let inQuotes = false;

      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const nextChar = line[index + 1];

        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            current += '"';
            index += 1;
          } else {
            inQuotes = !inQuotes;
          }
          continue;
        }

        if (char === "," && !inQuotes) {
          cells.push(current);
          current = "";
          continue;
        }

        current += char;
      }

      cells.push(current);
      return cells.map((cell) => cell.trim());
    })
    .filter(
      (row) =>
        Array.isArray(row) &&
        row.some((cell) => String(cell || "").trim() !== ""),
    );

  if (!rows.length) {
    return [["Product Name", "SKU", "Quantity"]];
  }

  const maxColumns = Math.max(...rows.map((row) => row.length));
  return rows.map((row) =>
    Array.from({ length: maxColumns }, (_, index) => row[index] ?? ""),
  );
}

function serializeCsvTable(rows) {
  const data = Array.isArray(rows) ? rows : [];
  return data
    .map((row) =>
      (row || [])
        .map((cell) => {
          const text = String(cell ?? "");
          if (/[",\n]/.test(text)) {
            return `"${text.replace(/"/g, '""')}"`;
          }
          return text;
        })
        .join(","),
    )
    .join("\n");
}

function renderQueueGridEditor(rawText) {
  const gridContainer = $("queueEditGrid");
  if (!gridContainer) return;

  let rows = [["Product Name", "SKU", "Quantity"]];
  try {
    const parsedRows = parseCsvTable(rawText);
    rows =
      Array.isArray(parsedRows) && parsedRows.length
        ? parsedRows.map((row) =>
            Array.isArray(row)
              ? row.map((cell) => String(cell ?? ""))
              : [String(row ?? "")],
          )
        : [["Product Name", "SKU", "Quantity"]];
  } catch {
    rows = [["Product Name", "SKU", "Quantity"]];
  }

  const maxColumns = Math.max(1, ...rows.map((row) => row.length));
  const gridHtml = rows
    .map(
      (row, rowIndex) => `
        <tr>
          ${Array.from({ length: maxColumns }, (_, columnIndex) => {
            const cellValue = Array.isArray(row)
              ? (row[columnIndex] ?? "")
              : "";
            return `
              <td>
                <input
                  type="text"
                  class="queue-grid-cell"
                  data-row="${rowIndex}"
                  data-col="${columnIndex}"
                  value="${escapeAttribute(cellValue)}"
                />
              </td>
            `;
          }).join("")}
        </tr>
      `,
    )
    .join("");

  gridContainer.innerHTML = `
    <div class="queue-grid-scroll">
      <table class="queue-grid-table">
        <tbody>${gridHtml}</tbody>
      </table>
    </div>
  `;
}

async function openQueueFileEditor(queueId) {
  const queueItem = getQueueItemById(queueId);
  if (!queueItem) return;

  const targetIndex = getQueuedDisplayItems().findIndex(
    (candidate) =>
      String(candidate.id || candidate.name || "").toLowerCase() ===
      String(queueId || "").toLowerCase(),
  );

  queueEditIndex = targetIndex >= 0 ? targetIndex : null;
  queueEditId = String(queueItem.id || queueItem.name || "");
  const fileNameInput = $("queueEditFileName");
  const gridContainer = $("queueEditGrid");
  const modal = $("queueEditModal");
  if (!fileNameInput || !gridContainer || !modal) return;

  fileNameInput.value = queueItem.name || "inventory-file.csv";
  gridContainer.innerHTML = "";
  setQueueModalVisible(true);

  try {
    const sourceFile = queueItem.file || (await getQueueItemFile(queueItem));
    const fileText = sourceFile ? await readQueueFileText(sourceFile) : "";
    renderQueueGridEditor(fileText || "");
  } catch {
    renderQueueGridEditor("");
  }
}

function closeQueueFileEditor() {
  queueEditIndex = null;
  queueEditId = null;
  setQueueModalVisible(false);
}

function replaceQueueFileFromPicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".xlsx,.xls,.csv";
  input.multiple = false;

  input.addEventListener("change", async (event) => {
    const [selectedFile] = Array.from(event.target.files || []);
    if (!selectedFile) return;

    const fileNameInput = $("queueEditFileName");
    const gridContainer = $("queueEditGrid");
    if (fileNameInput) fileNameInput.value = selectedFile.name;
    if (gridContainer) {
      try {
        const fileText = await readQueueFileText(selectedFile);
        renderQueueGridEditor(fileText || "");
      } catch {
        renderQueueGridEditor("");
      }
    }
  });

  input.click();
}

function saveQueueFileEditor() {
  const fileNameInput = $("queueEditFileName");
  const gridContainer = $("queueEditGrid");
  if (!fileNameInput || !gridContainer) return;

  const updatedName = String(
    fileNameInput.value || "inventory-file.csv",
  ).trim();

  const rows = [];
  const cells = Array.from(gridContainer.querySelectorAll(".queue-grid-cell"));
  const rowMap = new Map();

  cells.forEach((cell) => {
    const rowIndex = Number(cell.dataset.row || 0);
    const columnIndex = Number(cell.dataset.col || 0);
    const row = rowMap.get(rowIndex) || [];
    row[columnIndex] = cell.value || "";
    rowMap.set(rowIndex, row);
  });

  Array.from(rowMap.entries())
    .sort(([left], [right]) => left - right)
    .forEach(([, row]) => {
      const normalizedRow = Array.from(
        { length: Math.max(1, row.length) },
        (_, index) => row[index] ?? "",
      );
      rows.push(normalizedRow);
    });

  const fileText = serializeCsvTable(rows).trim();
  const nextFile = fileText
    ? new File([fileText], updatedName, { type: "text/csv;charset=utf-8" })
    : null;

  const activeQueueId =
    queueEditId ||
    String(
      getQueuedDisplayItems()[queueEditIndex]?.id ||
        queuedInventoryFiles[queueEditIndex]?.id ||
        "",
    );

  const currentQueueItem = getQueueItemById(activeQueueId);
  const targetItem =
    currentQueueItem ||
    queuedInventoryFiles.find(
      (item) =>
        String(item.id || item.name || "").toLowerCase() ===
        String(activeQueueId || "").toLowerCase(),
    ) ||
    queuedInventoryFiles[queueEditIndex] ||
    null;

  if (!targetItem) {
    closeQueueFileEditor();
    return;
  }

  const localItem = {
    ...targetItem,
    id: targetItem.id || queueItemId(),
    name: updatedName,
    file: nextFile || targetItem.file || null,
    source: "local",
    uploadedBy: getDeviceName(),
    uploadedAt: new Date().toISOString(),
    size: nextFile ? Number(nextFile.size || 0) : Number(targetItem.size || 0),
  };

  if (targetItem.source === "local") {
    queuedInventoryFiles = queuedInventoryFiles.map((item) =>
      String(item.id || item.name || "").toLowerCase() ===
      String(targetItem.id || targetItem.name || "").toLowerCase()
        ? localItem
        : item,
    );
  } else {
    queuedInventoryFiles = [...queuedInventoryFiles, localItem];
  }

  persistQueuedFiles();
  renderQueuedFiles();
  closeQueueFileEditor();
}

async function getQueueItemFile(queueItem) {
  if (queueItem?.file) {
    return queueItem.file;
  }

  if (queueItem?.source === "server") {
    try {
      const response = await fetch(
        `${getServerUrl()}/inventory/shared-queue-file?name=${encodeURIComponent(queueItem.name || "")}`,
        {
          headers: getAdminKey() ? { "x-admin-key": getAdminKey() } : {},
        },
      );

      if (!response.ok) {
        return null;
      }

      const blob = await response.blob();
      return new File([blob], queueItem.name || "queued-file.csv", {
        type: blob.type || "application/octet-stream",
        lastModified: Date.now(),
      });
    } catch {
      return null;
    }
  }

  const input = $("excelQueueFile");
  if (!input || !input.files || !input.files.length) return null;

  return (
    Array.from(input.files).find(
      (candidate) => candidate.name === queueItem?.name,
    ) || null
  );
}

async function loadSharedQueue() {
  try {
    const response = await fetch(`${getServerUrl()}/inventory/shared-queue`, {
      headers: getAdminKey() ? { "x-admin-key": getAdminKey() } : {},
    });
    const data = await readJsonResponse(response);

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not load the shared queue.");
    }

    sharedQueueFiles = Array.isArray(data.queue) ? data.queue : [];
    renderQueuedFiles();
  } catch {
    sharedQueueFiles = [];
    renderQueuedFiles();
  }
}

async function uploadQueuedFilesToUpdateTab(index = 0) {
  const displayQueue = getQueuedDisplayItems();
  if (!displayQueue.length) return;

  if (hasActiveInventoryUploadData()) {
    $("excelQueueSummary").textContent =
      "The Upload & Update tab still contains data. Clear it before uploading another file.";
    return;
  }

  const queueItem = displayQueue[index] || displayQueue[0];
  const file = await getQueueItemFile(queueItem);

  if (!file) {
    $("excelQueueSummary").textContent =
      "This queued file is missing. Use Edit to choose or restore it before uploading.";
    if (queueItem.source !== "server") {
      openQueueFileEditor(index);
    }
    return;
  }

  if (queueItem.source === "local") {
    queuedInventoryFiles = queuedInventoryFiles.filter(
      (item) =>
        String(item.name || "").toLowerCase() !==
        String(queueItem.name || "").toLowerCase(),
    );
    await persistQueuedFiles();
  }
  renderQueuedFiles();

  const input = $("inventoryFile");
  if (input) {
    setMainInventoryFile(file);
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch(`${getServerUrl()}/inventory/preview`, {
      method: "POST",
      headers: getAdminKey() ? { "x-admin-key": getAdminKey() } : {},
      body: formData,
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not read this spreadsheet.");
    }

    inventoryRows = data.rows;
    currentInventoryFileName = file.name;
    persistInventoryUploadState();
    $("inventorySummary").textContent =
      `${inventoryRows.length} ready to update`;
    renderInventoryPreview(data.rows, data.rejected);
    $("updateInventory").disabled = inventoryRows.length === 0;
    setInventoryTab("upload-panel");
  } catch (error) {
    $("inventorySummary").textContent = getInventoryErrorMessage(error);
    $("inventoryPreview").innerHTML = "";
  }
}

function renderInventoryPreview(rows, rejected) {
  const previewRows = [
    ...rows.map((row) => ({
      ...row,
      state: row.success ? "Updated" : "Ready",
    })),
    ...rejected.map((row) => ({ ...row, state: row.error })),
  ];

  const hasSuccessfulFileDownload = Boolean(
    currentInventoryFileName &&
    (rows.some((row) => row.success) ||
      previewRows.some((row) => row.state === "Updated")),
  );

  const downloadButton = hasSuccessfulFileDownload
    ? `<div class="inventory-download-row"><button type="button" class="inventory-download-button" data-download-file="${escapeAttribute(currentInventoryFileName)}">Download .txt file</button></div>`
    : "";

  $("inventoryPreview").innerHTML = previewRows.length
    ? `${downloadButton}<table><thead><tr><th>Product name</th><th>SKU</th><th>Qty</th><th>Status</th></tr></thead><tbody>${previewRows
        .map(
          (row) => `<tr class="${row.error ? "row-error" : ""}">
            <td title="${escapeAttribute(row.productName)}">${escapeHtml(row.productName || "—")}</td>
            <td>${escapeHtml(row.sku || "—")}</td>
            <td>${escapeHtml(row.quantity)}</td>
            <td>${escapeHtml(row.state)}</td>
          </tr>`,
        )
        .join("")}</tbody></table>`
    : downloadButton;

  const downloadButtonElement = document.querySelector(
    ".inventory-download-button",
  );
  if (downloadButtonElement) {
    downloadButtonElement.addEventListener("click", () => {
      const fileName = downloadButtonElement.dataset.downloadFile;
      if (!fileName) return;
      const downloadUrl = `${getServerUrl()}/inventory/text-copy?file=${encodeURIComponent(fileName)}`;
      fetch(downloadUrl, {
        headers: getAdminKey() ? { "x-admin-key": getAdminKey() } : {},
      })
        .then((response) => response.blob())
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = objectUrl;
          link.download = fileName.replace(/\.[^/.]+$/, ".txt");
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(objectUrl);
        })
        .catch(() => {
          alert(
            "The protected text copy could not be downloaded. Check the admin key.",
          );
        });
    });
  }
}

async function previewInventoryFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  inventoryRows = [];
  currentInventoryFileName = file.name;
  $("updateInventory").disabled = true;
  $("inventorySummary").textContent = `Reading ${file.name}...`;
  $("inventoryPreview").innerHTML = "";

  try {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(`${getServerUrl()}/inventory/preview`, {
      method: "POST",
      headers: getAdminKey() ? { "x-admin-key": getAdminKey() } : {},
      body: formData,
    });

    const data = await readJsonResponse(response);
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not read this spreadsheet.");
    }

    inventoryRows = data.rows;
    persistInventoryUploadState();
    const rejectedCount = data.rejected.length;
    $("inventorySummary").textContent =
      `${inventoryRows.length} ready to update${rejectedCount ? ` · ${rejectedCount} row${rejectedCount === 1 ? "" : "s"} need attention` : ""}`;

    renderInventoryPreview(data.rows, data.rejected);
    $("updateInventory").disabled = inventoryRows.length === 0;
  } catch (error) {
    $("inventorySummary").textContent = getInventoryErrorMessage(error);
    $("inventoryPreview").innerHTML = "";
  }
}

async function updateInventoryQuantities() {
  if (!inventoryRows.length) return;

  $("updateInventory").disabled = true;
  $("inventorySummary").textContent =
    `Updating ${inventoryRows.length} SKU${inventoryRows.length === 1 ? "" : "s"} in Shopify...`;

  try {
    const response = await fetch(`${getServerUrl()}/inventory/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
      },
      body: JSON.stringify({
        rows: inventoryRows,
        filename: currentInventoryFileName || "unknown-file",
      }),
    });

    const data = await readJsonResponse(response);
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Shopify inventory update failed.");
    }

    if (data.duplicate && data.message) {
      $("inventorySummary").textContent = data.message;
      persistInventoryUploadState();
      renderInventoryPreview(
        inventoryRows.map((row) => ({ ...row, success: true })),
        [],
      );
      return;
    }

    const succeeded = data.results.filter((result) => result.success).length;
    const failed = data.results.length - succeeded;
    $("inventorySummary").textContent =
      `${succeeded} SKU${succeeded === 1 ? "" : "s"} updated${failed ? ` · ${failed} failed` : " successfully"}`;
    persistInventoryUploadState();

    renderInventoryPreview(
      data.results.filter((result) => result.success),
      data.results.filter((result) => !result.success),
    );
  } catch (error) {
    $("inventorySummary").textContent = getInventoryErrorMessage(error);
  } finally {
    $("updateInventory").disabled = inventoryRows.length === 0;
  }
}

function renderInventoryLogEntries(content) {
  const lines = (content || "").split(/\r?\n/).filter(Boolean);

  if (!lines.length) {
    $("inventoryLogViewer").innerHTML =
      '<div class="inventory-log-empty">No inventory updates yet.</div>';
    return;
  }

  const entries = lines
    .slice()
    .reverse()
    .map((line) => {
      const match = line.match(
        /^\[(.*?)\]\s*(.*?)\s*\|\s*(done|failed)\s*(?:\|\s*(.*))?$/i,
      );
      if (!match) return null;

      const [, rawTimestamp, fileName, status, detailText = ""] = match;
      const dateLabel = rawTimestamp
        ? new Date(rawTimestamp).toLocaleString()
        : "Unknown time";
      const filename = String(fileName || "unknown-file").trim();
      const normalizedStatus = status.toLowerCase();
      const detail = String(detailText || "").trim();

      return {
        timestamp: dateLabel,
        filename,
        status: normalizedStatus,
        detail,
      };
    })
    .filter(Boolean);

  if (!entries.length) {
    $("inventoryLogViewer").innerHTML =
      '<div class="inventory-log-empty">No inventory updates yet.</div>';
    return;
  }

  $("inventoryLogViewer").innerHTML = `
    <div class="inventory-log-list">
      ${entries
        .map(
          (entry) => `
            <div class="inventory-log-item">
              <div class="inventory-log-header">
                <span class="inventory-log-time">${escapeHtml(entry.timestamp)}</span>
                <span class="inventory-log-status inventory-log-status-${entry.status}">${escapeHtml(entry.status)}</span>
              </div>
              <div class="inventory-log-file">${escapeHtml(entry.filename)}</div>
              <div class="inventory-log-detail">${escapeHtml(entry.detail || "No details")}</div>
              <button type="button" class="inventory-log-download" data-download-file="${escapeAttribute(entry.filename)}">Download .txt</button>
            </div>
          `,
        )
        .join("")}
    </div>
  `;

  document.querySelectorAll(".inventory-log-download").forEach((button) => {
    button.addEventListener("click", () => {
      const fileName = button.dataset.downloadFile;
      if (!fileName) return;

      const downloadUrl = `${getServerUrl()}/inventory/text-copy?file=${encodeURIComponent(fileName)}`;
      fetch(downloadUrl, {
        headers: getAdminKey() ? { "x-admin-key": getAdminKey() } : {},
      })
        .then((response) => response.blob())
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = objectUrl;
          link.download = fileName.replace(/\.[^/.]+$/, ".txt");
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(objectUrl);
        })
        .catch(() => {
          alert(
            "The protected text copy could not be downloaded. Check the admin key.",
          );
        });
    });
  });
}

async function viewInventoryLog() {
  try {
    const response = await fetch(`${getServerUrl()}/inventory/logs`, {
      headers: getAdminKey() ? { "x-admin-key": getAdminKey() } : {},
    });
    const data = await readJsonResponse(response);

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not read the inventory log.");
    }

    renderInventoryLogEntries(data.content || "");
    setInventoryTab("logs-panel");
  } catch (error) {
    $("inventoryLogViewer").innerHTML =
      `<div class="inventory-log-empty">${getInventoryErrorMessage(error)}</div>`;
  }
}

function clearInventoryUpload() {
  inventoryRows = [];
  currentInventoryFileName = "";
  localStorage.removeItem(INVENTORY_UPLOAD_STORAGE_KEY);
  $("inventoryFile").value = "";
  $("inventorySummary").textContent = "Upload a file to preview its rows.";
  $("inventoryPreview").innerHTML = "";
  $("updateInventory").disabled = true;
  renderQueuedFiles();
}

function getInventoryErrorMessage(error) {
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return "Cannot reach the local backend. Run npm start from the project folder, then try again.";
  }

  return error.message || "The inventory request could not be completed.";
}

async function readJsonResponse(response) {
  const responseText = await response.text();

  try {
    return JSON.parse(responseText);
  } catch {
    const contentType = response.headers.get("content-type") || "unknown type";
    throw new Error(
      `The local backend returned ${contentType}, not the inventory API response. Restart npm start and reload the extension.`,
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const savedUrl =
    localStorage.getItem("shopifyServerUrl") || DEFAULT_SERVER_URL;
  $("serverUrlInput").value = savedUrl;
  $("adminKeyInput").value = getAdminKey();
  $("deviceNameInput").value = getDeviceName();

  restoreQueuedFiles();
  restoreInventoryUploadState();
  renderQueuedFiles();

  if (currentInventoryFileName || inventoryRows.length) {
    $("inventorySummary").textContent =
      `${inventoryRows.length} ready to update${currentInventoryFileName ? ` · ${currentInventoryFileName}` : ""}`;
    renderInventoryPreview(inventoryRows, []);
    $("updateInventory").disabled = inventoryRows.length === 0;
  }

  $("inventoryFile").addEventListener("change", previewInventoryFile);
  $("queueEditChooseFile").addEventListener(
    "click",
    replaceQueueFileFromPicker,
  );
  $("queueEditSave").addEventListener("click", saveQueueFileEditor);
  document.querySelectorAll("[data-close-queue-modal]").forEach((button) => {
    button.addEventListener("click", closeQueueFileEditor);
  });
  $("excelQueueFile").addEventListener("change", async (event) => {
    const selectedFiles = Array.from(event.target.files || []);
    const newQueueFiles = normalizeQueuedInventoryFiles(
      selectedFiles.map((file) => ({
        id: queueItemId(),
        name: file.name,
        file,
      })),
    );

    if (!newQueueFiles.length) {
      $("excelQueueSummary").textContent =
        "That file was already queued or is invalid.";
      event.target.value = "";
      return;
    }

    const uploadedBy = getDeviceName();
    for (const file of selectedFiles) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("uploadedBy", uploadedBy);

        await fetch(`${getServerUrl()}/inventory/shared-queue`, {
          method: "POST",
          headers: {
            ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
            "x-device-name": uploadedBy,
          },
          body: formData,
        });
      } catch {
        queuedInventoryFiles = [
          ...queuedInventoryFiles,
          { id: queueItemId(), name: file.name, file },
        ];
      }
    }

    queuedInventoryFiles = [...queuedInventoryFiles, ...newQueueFiles];
    persistQueuedFiles();
    event.target.value = "";
    await loadSharedQueue();
    renderQueuedFiles();
    $("excelQueueSummary").textContent =
      `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} saved to the server queue and staged.`;
  });
  $("applyServerUrl").addEventListener("click", async () => {
    const value = $("serverUrlInput").value;
    const nextUrl = saveServerUrl(value);
    $("serverUrlInput").value = nextUrl;
    await checkServerConnection(true);
  });
  $("adminKeyInput").addEventListener("input", (event) => {
    saveAdminKey(event.target.value);
  });
  $("deviceNameInput").addEventListener("input", (event) => {
    const normalized = saveDeviceName(event.target.value);
    $("deviceNameInput").value = normalized;
  });
  $("inventoryFormatGuide").addEventListener(
    "click",
    toggleInventoryFormatGuide,
  );
  $("downloadInventoryTemplate").addEventListener(
    "click",
    downloadInventoryTemplate,
  );
  $("clearInventory").addEventListener("click", clearInventoryUpload);
  $("updateInventory").addEventListener("click", updateInventoryQuantities);
  $("refreshInventoryPage").addEventListener("click", () => {
    setInventoryTab("upload-panel");
    viewInventoryLog();
  });

  document.querySelectorAll(".inventory-tab").forEach((button) => {
    button.addEventListener("click", () => {
      setInventoryTab(button.dataset.panel);
      if (button.dataset.panel === "logs-panel") {
        viewInventoryLog();
      }
    });
  });

  setInventoryTab("upload-panel");
  viewInventoryLog();
  checkServerConnection(true);
  loadSharedQueue();
  setInterval(() => {
    loadSharedQueue();
  }, 5000);
});
