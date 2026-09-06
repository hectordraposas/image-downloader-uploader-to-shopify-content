let inventoryRows = [];
let currentInventoryFileName = "";
let queuedInventoryFiles = [];
let sharedQueueFiles = [];

const INVENTORY_QUEUE_STORAGE_KEY = "inventoryQueueFiles";
const INVENTORY_UPLOAD_STORAGE_KEY = "inventoryUploadState";

const queueItemId = () =>
  `queue-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER_URL = "http://localhost:3000";
const DEFAULT_ADMIN_KEY = "admin-key";
const DEFAULT_CLIENT_KEY = "client-key";
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
const getClientKey = () => {
  const saved = localStorage.getItem("inventoryClientKey") || "";
  return String(saved || DEFAULT_CLIENT_KEY || "").trim();
};
const saveAdminKey = (value) => {
  const normalized = String(value || "").trim();
  localStorage.setItem("inventoryAdminKey", normalized);
  if (!localStorage.getItem("inventoryClientKey")) {
    localStorage.setItem("inventoryClientKey", DEFAULT_CLIENT_KEY);
  }
  return normalized;
};
const saveClientKey = (value) => {
  const normalized = String(value || "").trim();
  localStorage.setItem("inventoryClientKey", normalized);
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

function getAccessMode() {
  const key = String(getAdminKey() || "").trim();

  if (!key) return "locked";
  if (key === DEFAULT_CLIENT_KEY || key === "client" || key === "client-key") {
    return "client";
  }
  if (key === DEFAULT_ADMIN_KEY || key === "admin") return "admin";
  return "locked";
}

function canManageQueuedFiles() {
  const key = String(getAdminKey() || "").trim();
  return key === DEFAULT_ADMIN_KEY || key === "admin";
}

function canUploadQueuedFiles() {
  return canManageQueuedFiles();
}

function updateAccessModeUI() {
  const mode = getAccessMode();
  const uploadTab = document.querySelector(
    '.inventory-tab[data-panel="upload-panel"]',
  );

  if (uploadTab) {
    const isHiddenForClient = mode === "client" || mode === "locked";
    uploadTab.hidden = isHiddenForClient;
    uploadTab.disabled = isHiddenForClient;
    uploadTab.setAttribute("aria-hidden", String(isHiddenForClient));
  }

  const activePanel =
    document.querySelector(".inventory-panel.active")?.id || "excel-panel";
  if (
    (mode === "client" || mode === "locked") &&
    activePanel === "upload-panel"
  ) {
    setInventoryTab("excel-panel");
  }
}

function setInventoryTab(panelName) {
  const panels = document.querySelectorAll(".inventory-panel");
  const tabs = document.querySelectorAll(".inventory-tab");
  const mode = getAccessMode();
  const safePanelName =
    (mode === "client" || mode === "locked") && panelName === "upload-panel"
      ? "excel-panel"
      : panelName;

  panels.forEach((panel) => {
    const isActive = panel.id === safePanelName;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });

  tabs.forEach((tab) => {
    const isHiddenForClient =
      mode === "client" && tab.dataset.panel === "upload-panel";
    tab.hidden = isHiddenForClient;
    tab.disabled = isHiddenForClient;
    const isActive = tab.dataset.panel === safePanelName;
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

    if (!normalizedItem.name) {
      return accumulator;
    }

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
  const seenNames = new Set();

  const mergedQueue = [...sharedQueueFiles, ...queuedInventoryFiles]
    .filter((item) => {
      const itemName = String(item?.name || "").trim();
      if (!itemName) return false;
      const lowerName = itemName.toLowerCase();
      if (seenNames.has(lowerName)) return false;
      seenNames.add(lowerName);
      return true;
    })
    .map((item) => {
      const normalizedItem = {
        ...item,
        uploadedBy: item.uploadedBy || getDeviceName(),
        uploadedAt: item.uploadedAt || new Date().toISOString(),
        source:
          item.source ||
          (sharedQueueFiles.some(
            (candidate) =>
              String(candidate.name || "").toLowerCase() ===
              String(item.name || "").toLowerCase(),
          )
            ? "server"
            : "local"),
        size: Number(
          item.size || (item.file ? Number(item.file.size || 0) : 0),
        ),
        file: item.file || null,
      };

      return normalizedItem;
    });

  return mergedQueue.sort((left, right) => {
    const leftTime = new Date(left.uploadedAt || 0).getTime();
    const rightTime = new Date(right.uploadedAt || 0).getTime();
    return rightTime - leftTime;
  });
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
  if (!canManageQueuedFiles()) {
    $("excelQueueSummary").textContent =
      "Only the admin can delete queued files.";
    return;
  }

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
          headers: {
            ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
            ...(getClientKey() ? { "x-client-key": getClientKey() } : {}),
          },
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
      const allowDelete = canManageQueuedFiles();
      const allowUpload = canUploadQueuedFiles();
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
              ${allowUpload ? `<button type="button" class="inventory-log-download" data-action="upload" data-queue-id="${escapeAttribute(queueId)}" ${isBlocked || hasMissingFile ? "disabled" : ""}>Upload</button>` : ""}
              ${allowDelete ? `<button type="button" class="inventory-log-download inventory-log-remove" data-action="delete" data-queue-id="${escapeAttribute(queueId)}">Delete</button>` : ""}
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

async function getQueueItemFile(queueItem) {
  if (queueItem?.file) {
    return queueItem.file;
  }

  if (queueItem?.source === "server") {
    try {
      const response = await fetch(
        `${getServerUrl()}/inventory/shared-queue-file?name=${encodeURIComponent(queueItem.name || "")}`,
        {
          headers: {
            ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
            ...(getClientKey() ? { "x-client-key": getClientKey() } : {}),
          },
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
      headers: {
        ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
        ...(getClientKey() ? { "x-client-key": getClientKey() } : {}),
      },
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
      "This queued file is missing or unavailable. Please re-upload it from the queue.";
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
        headers: {
          ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
          ...(getClientKey() ? { "x-client-key": getClientKey() } : {}),
        },
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

function parseCsvTextRow(line) {
  const cells = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (insideQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (character === "," && !insideQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  cells.push(current.trim());
  return cells;
}

function renderInventoryTextPreviewModal(fileName, content) {
  const lines = (content || "").split(/\r?\n/).filter((line) => line.trim());
  const rows = lines.map(parseCsvTextRow);
  const header = rows[0] || ["Product Name", "SKU", "Quantity", "Status"];
  const bodyRows = rows.slice(1);

  const modalBackdrop = document.createElement("div");
  modalBackdrop.className = "inventory-log-preview-backdrop";
  modalBackdrop.innerHTML = `
    <div class="inventory-log-preview-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-log-preview-title">
      <div class="inventory-log-preview-header">
        <div>
          <span class="section-label">Preview</span>
          <h3 id="inventory-log-preview-title">${escapeHtml(fileName)}</h3>
        </div>
        <button type="button" class="inventory-log-preview-close" aria-label="Close preview">×</button>
      </div>
      <div class="inventory-log-preview-body">
        ${
          bodyRows.length
            ? `
          <table class="inventory-log-preview-table">
            <thead>
              <tr>
                ${header.map((cell) => `<th>${escapeHtml(cell || "-")}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${bodyRows
                .map(
                  (row) =>
                    `<tr>${[
                      ...row,
                      ...Array(Math.max(header.length - row.length, 0)).fill(
                        "",
                      ),
                    ]
                      .slice(0, header.length)
                      .map((cell) => `<td>${escapeHtml(cell || "-")}</td>`)
                      .join("")}</tr>`,
                )
                .join("")}
            </tbody>
          </table>
        `
            : '<div class="inventory-log-empty">No preview data is available for this file yet.</div>'
        }
      </div>
    </div>
  `;

  const closeButton = modalBackdrop.querySelector(
    ".inventory-log-preview-close",
  );
  closeButton.addEventListener("click", () => modalBackdrop.remove());
  modalBackdrop.addEventListener("click", (event) => {
    if (event.target === modalBackdrop) {
      modalBackdrop.remove();
    }
  });

  document.body.appendChild(modalBackdrop);
}

function renderInventoryLogEntries(content) {
  const lines = (content || "").split(/\r?\n/).filter(Boolean);

  if (!lines.length) {
    $("inventoryLogViewer").innerHTML =
      '<div class="inventory-log-empty">No inventory updates yet.</div>';
    return;
  }

  const entries = lines
    .map((line) => {
      const match = line.match(
        /^\[(.*?)\]\s*(.*?)\s*\|\s*(done|failed)\s*(?:\|\s*(.*))?$/i,
      );
      if (!match) return null;

      const [, rawTimestamp, fileName, status, detailText = ""] = match;
      const dateTime = rawTimestamp ? new Date(rawTimestamp).getTime() : 0;
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
        dateTime,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.dateTime - left.dateTime);

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
              <div class="inventory-log-actions">
                <button type="button" class="inventory-log-preview" data-preview-file="${escapeAttribute(entry.filename)}">Preview</button>
                <button type="button" class="inventory-log-download" data-download-file="${escapeAttribute(entry.filename)}">Download .txt</button>
              </div>
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
        headers: {
          ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
          ...(getClientKey() ? { "x-client-key": getClientKey() } : {}),
        },
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

  document.querySelectorAll(".inventory-log-preview").forEach((button) => {
    button.addEventListener("click", async () => {
      const fileName = button.dataset.previewFile;
      if (!fileName) return;

      try {
        const response = await fetch(
          `${getServerUrl()}/inventory/text-copy?file=${encodeURIComponent(fileName)}`,
          {
            headers: {
              ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
              ...(getClientKey() ? { "x-client-key": getClientKey() } : {}),
            },
          },
        );

        if (!response.ok) {
          throw new Error("Preview file not found.");
        }

        const content = await response.text();
        renderInventoryTextPreviewModal(fileName, content);
      } catch (error) {
        alert(error.message || "Could not load the preview for this file.");
      }
    });
  });
}

async function viewInventoryLog() {
  try {
    const response = await fetch(`${getServerUrl()}/inventory/logs`, {
      headers: {
        ...(getAdminKey() ? { "x-admin-key": getAdminKey() } : {}),
        ...(getClientKey() ? { "x-client-key": getClientKey() } : {}),
      },
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
  if (!localStorage.getItem("shopifyServerUrl")) {
    saveServerUrl(DEFAULT_SERVER_URL);
  }
  if (!localStorage.getItem("inventoryAdminKey")) {
    saveAdminKey(DEFAULT_CLIENT_KEY);
  }
  $("serverUrlInput").value = savedUrl || DEFAULT_SERVER_URL;
  $("adminKeyInput").value = getAdminKey() || DEFAULT_CLIENT_KEY;
  $("deviceNameInput").value = getDeviceName();
  updateAccessModeUI();

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
            ...(getClientKey() ? { "x-client-key": getClientKey() } : {}),
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
    updateAccessModeUI();
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

  updateAccessModeUI();
  setInventoryTab("excel-panel");
  viewInventoryLog();
  checkServerConnection(true);
  loadSharedQueue();
  setInterval(() => {
    loadSharedQueue();
  }, 5000);
});
