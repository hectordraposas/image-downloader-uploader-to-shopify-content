let inventoryRows = [];
let currentInventoryFileName = "";
let currentInventoryFileSize = 0;
let currentInventoryFile = null;
let queuedInventoryFiles = [];
let sharedQueueFiles = [];
let initialAccessLocked = true;
let mobileCategories = [];
let mobileRecords = [];
let mobileInventoryRows = [];
let currentMobileSearchRecordId = "";

const INVENTORY_QUEUE_STORAGE_KEY = "inventoryQueueFiles";
const INVENTORY_UPLOAD_STORAGE_KEY = "inventoryUploadState";
const MOBILE_CATEGORIES_STORAGE_KEY = "mobileOutfitterCategories";
const MOBILE_RECORDS_STORAGE_KEY = "mobileOutfitterRecords";

const queueItemId = () =>
  `queue-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER_URL =
  typeof window !== "undefined" && /^https?:$/i.test(window.location.protocol)
    ? window.location.origin
    : "http://localhost:3000";
let accessRole = sessionStorage.getItem("inventoryRole") || "locked";
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
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.set({ shopifyServerUrl: normalized });
  }
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
  return accessRole;
}

function getInitialPanelForRole(role = getAccessMode()) {
  if (role === "admin") return "upload-panel";
  if (role === "outfitter") return "mobile-search-panel";
  return "excel-panel";
}

function categoriesFromInventory(rows) {
  return [
    ...new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => String(row.category || "").trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function renderMobileInventory() {
  const body = $("mobileInventoryTableBody");
  const emptyState = $("mobileInventoryEmpty");
  const count = $("mobileInventoryCount");
  if (!body || !emptyState || !count) return;
  const lastUpdated = mobileInventoryRows
    .map((row) => new Date(row.updatedAt || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > 0)
    .sort((left, right) => right - left)[0];
  const lastUpdatedLabel = $("mobileInventoryLastUpdated");
  if (lastUpdatedLabel) {
    lastUpdatedLabel.textContent = lastUpdated
      ? `Last inventory update: ${new Date(lastUpdated).toLocaleString()}`
      : "Last inventory update: Not available";
  }
  count.textContent = `${mobileInventoryRows.length} row${mobileInventoryRows.length === 1 ? "" : "s"}`;
  emptyState.hidden = mobileInventoryRows.length > 0;
  body.innerHTML = mobileInventoryRows
    .map((row) => {
      const sold = mobileRecords.filter((record) =>
        getRecordCategories(record).some(
          (category) =>
            category.toLowerCase() === String(row.category).toLowerCase(),
        ),
      ).length;
      const quantity = Number(row.quantity) || 0;
      const remaining = Math.max(quantity - sold, 0);
      return `<tr><td>${escapeHtml(row.category)}</td><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.quantity)}</td><td>${sold}</td><td>${remaining}</td></tr>`;
    })
    .join("");
}

async function loadMobileInventory() {
  try {
    const response = await fetch(`${getServerUrl()}/mobile-outfitter/data`, {
      credentials: "include",
      cache: "no-store",
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.success)
      throw new Error(data.error || "Could not load inventory.");
    mobileInventoryRows = Array.isArray(data.inventory) ? data.inventory : [];
    renderMobileInventory();
  } catch (error) {
    $("mobileInventoryMessage").textContent =
      error.message || "Could not load shared inventory.";
  }
}

async function uploadMobileInventory(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const formData = new FormData();
  formData.append("file", file);
  $("mobileInventoryMessage").textContent = `Uploading ${file.name}...`;
  try {
    const response = await fetch(
      `${getServerUrl()}/mobile-outfitter/inventory`,
      {
        method: "POST",
        credentials: "include",
        headers: { "x-device-name": getDeviceName() },
        body: formData,
      },
    );
    const data = await readJsonResponse(response);
    if (!response.ok || !data.success)
      throw new Error(data.error || "Could not upload inventory.");
    mobileInventoryRows = data.inventory || [];
    mobileCategories = categoriesFromInventory(mobileInventoryRows);
    saveMobileOutfitterData();
    renderMobileCategories();
    renderFoundCategoryOptions();
    renderMobileInventory();
    $("mobileInventoryMessage").textContent =
      `${data.added} inventory row${data.added === 1 ? "" : "s"} saved to the shared server.`;
  } catch (error) {
    $("mobileInventoryMessage").textContent =
      error.message || "Could not upload inventory.";
  } finally {
    event.target.value = "";
  }
}

function loadMobileOutfitterData() {
  try {
    const savedCategories = JSON.parse(
      localStorage.getItem(MOBILE_CATEGORIES_STORAGE_KEY) || "[]",
    );
    const savedRecords = JSON.parse(
      localStorage.getItem(MOBILE_RECORDS_STORAGE_KEY) || "[]",
    );
    mobileCategories = Array.isArray(savedCategories)
      ? savedCategories.filter(Boolean).map((value) => String(value))
      : [];
    mobileRecords = Array.isArray(savedRecords) ? savedRecords : [];
  } catch {
    mobileCategories = [];
    mobileRecords = [];
  }
}

function saveMobileOutfitterData() {
  localStorage.setItem(
    MOBILE_CATEGORIES_STORAGE_KEY,
    JSON.stringify(mobileCategories),
  );
  localStorage.setItem(
    MOBILE_RECORDS_STORAGE_KEY,
    JSON.stringify(mobileRecords),
  );
  fetch(`${getServerUrl()}/mobile-outfitter/data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      categories: mobileCategories,
      records: mobileRecords,
      inventory: mobileInventoryRows,
    }),
  }).catch(() => {
    // Keep the local cache available if the shared server is temporarily offline.
  });
  renderMobileInventory();
}

async function syncMobileOutfitterData() {
  try {
    const response = await fetch(`${getServerUrl()}/mobile-outfitter/data`, {
      credentials: "include",
      cache: "no-store",
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.success) {
      throw new Error(
        data.error || "Could not load shared MobileOutfitter data.",
      );
    }

    const hasSharedData =
      data.categories.length || data.records.length || data.inventory.length;
    if (hasSharedData || (!mobileCategories.length && !mobileRecords.length)) {
      mobileCategories = categoriesFromInventory(data.inventory);
      mobileRecords = Array.isArray(data.records) ? data.records : [];
      mobileInventoryRows = Array.isArray(data.inventory) ? data.inventory : [];
      normalizeMobileRecords();
      localStorage.setItem(
        MOBILE_CATEGORIES_STORAGE_KEY,
        JSON.stringify(mobileCategories),
      );
      localStorage.setItem(
        MOBILE_RECORDS_STORAGE_KEY,
        JSON.stringify(mobileRecords),
      );
    } else {
      saveMobileOutfitterData();
    }

    renderMobileCategories();
    renderMobileRecords();
    renderMobileSearchResults();
    renderMobileInventory();
  } catch {
    // The local cache remains usable while the shared server is unavailable.
  }
}

function renderMobileCategories() {
  const select = $("mobileCreateCategory");
  if (!select) return;

  select.innerHTML = mobileCategories.length
    ? mobileCategories
        .map(
          (category) =>
            `<option value="${escapeAttribute(category)}">${escapeHtml(category)}</option>`,
        )
        .join("")
    : '<option value="">Add a category first</option>';
  select.disabled = mobileCategories.length === 0;
}

function getRecordCategories(record) {
  if (Array.isArray(record.categories)) {
    return record.categories.filter(Boolean).map((value) => String(value));
  }
  return record.category
    ? String(record.category)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}

function recordCategoryLabel(record) {
  return getRecordCategories(record).join(", ");
}

function confirmDeleteMobileRecord(recordId) {
  if (accessRole !== "admin") return;
  const record = mobileRecords.find((item) => item.id === recordId);
  if (!record) return;

  const backdrop = document.createElement("div");
  backdrop.className = "mobile-data-modal-backdrop";
  backdrop.innerHTML = `
    <div class="mobile-data-modal mobile-delete-modal" role="dialog" aria-modal="true" aria-labelledby="mobile-delete-title">
      <div class="mobile-data-modal-header">
        <div><span class="section-label">Admin action</span><h3 id="mobile-delete-title">Delete customer?</h3></div>
        <button type="button" class="mobile-modal-close" aria-label="Close delete confirmation">×</button>
      </div>
      <div class="mobile-delete-details">
        <p>This will permanently remove this customer record from the shared database.</p>
        <dl>
          <div><dt>Name</dt><dd>${escapeHtml(record.name)}</dd></div>
          <div><dt>Number</dt><dd>${escapeHtml(record.number)}</dd></div>
          <div><dt>Category</dt><dd>${escapeHtml(recordCategoryLabel(record))}</dd></div>
          <div><dt>Added</dt><dd>${escapeHtml(record.createdAt)}</dd></div>
        </dl>
      </div>
      <div class="mobile-delete-actions">
        <button type="button" class="secondary-button mobile-delete-cancel">Cancel</button>
        <button type="button" class="mobile-record-delete mobile-delete-confirm">Delete customer</button>
      </div>
    </div>`;

  const close = () => backdrop.remove();
  backdrop
    .querySelector(".mobile-modal-close")
    .addEventListener("click", close);
  backdrop
    .querySelector(".mobile-delete-cancel")
    .addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop
    .querySelector(".mobile-delete-confirm")
    .addEventListener("click", () => {
      mobileRecords = mobileRecords.filter((item) => item.id !== recordId);
      saveMobileOutfitterData();
      renderMobileRecords();
      close();
    });
  document.body.appendChild(backdrop);
}

function normalizeMobileRecords() {
  const mergedRecords = [];
  const byCustomer = new Map();

  mobileRecords.forEach((record) => {
    const name = String(record.name || "").trim();
    const number = String(record.number || "").trim();
    const key = `${name.toLowerCase()}|${number}`;
    const existing = byCustomer.get(key);

    if (!existing) {
      const categories = getRecordCategories(record);
      const normalizedRecord = {
        ...record,
        name,
        number,
        categories,
        category: categories.join(", "),
      };
      byCustomer.set(key, normalizedRecord);
      mergedRecords.push(normalizedRecord);
      return;
    }

    const categories = getRecordCategories(existing);
    getRecordCategories(record).forEach((category) => {
      if (
        !categories.some(
          (item) => item.toLowerCase() === category.toLowerCase(),
        )
      ) {
        categories.push(category);
      }
    });
    existing.categories = categories;
    existing.category = categories.join(", ");
  });

  const changed = mergedRecords.length !== mobileRecords.length;
  mobileRecords = mergedRecords;
  if (changed) saveMobileOutfitterData();
}

function renderMobileRecords() {
  const body = $("mobileCreateTableBody");
  const emptyState = $("mobileCreateEmpty");
  const count = $("mobileCreateCount");
  if (!body || !emptyState || !count) return;

  count.textContent = `${mobileRecords.length} record${mobileRecords.length === 1 ? "" : "s"}`;
  emptyState.hidden = mobileRecords.length > 0;
  body.innerHTML = mobileRecords
    .map(
      (record) => `
        <tr>
          <td>${escapeHtml(record.name)}</td>
          <td>${escapeHtml(record.number)}</td>
          <td>${escapeHtml(recordCategoryLabel(record))}</td>
          <td>${escapeHtml(record.createdAt)}</td>
          <td class="mobile-record-actions"><button type="button" class="mobile-record-edit" data-edit-record-id="${escapeAttribute(record.id)}">Update</button>${accessRole === "admin" ? `<button type="button" class="mobile-record-delete" data-record-id="${escapeAttribute(record.id)}">Delete</button>` : ""}</td>
        </tr>`,
    )
    .join("");

  body.querySelectorAll("[data-record-id]").forEach((button) => {
    button.addEventListener("click", () => {
      if (accessRole !== "admin") return;
      confirmDeleteMobileRecord(button.dataset.recordId);
    });
  });

  body.querySelectorAll("[data-edit-record-id]").forEach((button) => {
    button.addEventListener("click", () =>
      openMobileRecordModal(button.dataset.editRecordId),
    );
  });
}

function renderMobileSearchResults() {
  const body = $("mobileSearchTableBody");
  const emptyState = $("mobileSearchEmpty");
  const count = $("mobileSearchCount");
  const foundLabels = $("mobileSearchFoundLabels");
  const searchName = String($("mobileSearchInput")?.value || "")
    .trim()
    .toLowerCase();
  if (!body || !emptyState || !count) return;

  const results = searchName
    ? mobileRecords.filter((record) =>
        [record.name, record.number].some((value) =>
          String(value || "")
            .toLowerCase()
            .includes(searchName),
        ),
      )
    : [];
  const foundRecord = results[0];
  currentMobileSearchRecordId = foundRecord?.id || "";
  if (foundLabels) {
    foundLabels.hidden = false;
    if (foundRecord) {
      $("mobileSearchFoundName").textContent = foundRecord.name;
      $("mobileSearchFoundNumber").textContent = foundRecord.number;
      renderFoundCategoryOptions(getRecordCategories(foundRecord)[0] || "");
    } else {
      $("mobileSearchFoundName").textContent = "";
      $("mobileSearchFoundNumber").textContent = "";
      renderFoundCategoryOptions();
    }
  }
  $("mobileSearchSaveCategory").disabled = !foundRecord;
  const categoryRows = results.flatMap((record) =>
    getRecordCategories(record).map((category) => ({ record, category })),
  );
  count.textContent = `${categoryRows.length} row${categoryRows.length === 1 ? "" : "s"}`;
  emptyState.hidden = !searchName || categoryRows.length > 0;
  body.innerHTML = results
    .flatMap((record) =>
      getRecordCategories(record).map(
        (category) => `
        <tr>
          <td>${escapeHtml(category)}</td>
          <td>${escapeHtml(record.createdAt)}</td>
        </tr>`,
      ),
    )
    .join("");
}

function renderFoundCategoryOptions(selectedCategory = "") {
  const select = $("mobileSearchFoundCategory");
  if (!select) return;
  select.innerHTML = mobileCategories
    .map(
      (category) =>
        `<option value="${escapeAttribute(category)}" ${category === selectedCategory ? "selected" : ""}>${escapeHtml(category)}</option>`,
    )
    .join("");
  select.disabled = mobileCategories.length === 0;
}

function saveFoundCategory() {
  const record = mobileRecords.find(
    (item) => item.id === currentMobileSearchRecordId,
  );
  const category = $("mobileSearchFoundCategory")?.value || "";
  if (!record || !category) return;
  const categories = getRecordCategories(record);
  if (categories.some((item) => item.toLowerCase() === category.toLowerCase()))
    return;
  categories.push(category);
  record.categories = categories;
  record.category = categories.join(", ");
  saveMobileOutfitterData();
  renderMobileRecords();
  renderMobileSearchResults();
}

function openMobileRecordModal(recordId) {
  const record = mobileRecords.find((item) => item.id === recordId);
  if (!record) return;
  const backdrop = document.createElement("div");
  backdrop.className = "mobile-data-modal-backdrop";
  backdrop.innerHTML = `<div class="mobile-data-modal" role="dialog" aria-modal="true"><div class="mobile-data-modal-header"><h3>Update record</h3><button type="button" class="mobile-modal-close">×</button></div><form class="mobile-record-modal-form"><label>Name<input name="name" value="${escapeAttribute(record.name)}" required /></label><label>Number<input name="number" type="number" min="0" step="1" value="${escapeAttribute(record.number)}" required /></label><label>Category<select name="category">${mobileCategories.map((category) => `<option value="${escapeAttribute(category)}" ${category === record.category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}</select></label><button class="primary-button" type="submit">Save changes</button></form></div>`;
  const close = () => backdrop.remove();
  backdrop
    .querySelector(".mobile-modal-close")
    .addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const previousName = record.name;
    const previousNumber = record.number;
    record.name = String(form.get("name") || "").trim();
    record.number = String(form.get("number") || "")
      .trim()
      .replace(/\D/g, "");
    const duplicateNumber = mobileRecords.some(
      (item) => item.id !== record.id && String(item.number) === record.number,
    );
    if (duplicateNumber) {
      record.name = previousName;
      record.number = previousNumber;
      alert("This number has already been saved to the database.");
      return;
    }
    record.category = String(form.get("category") || "");
    saveMobileOutfitterData();
    renderMobileRecords();
    renderMobileSearchResults();
    close();
  });
  document.body.appendChild(backdrop);
}

function addMobileRecord(event) {
  event.preventDefault();
  const name = $("mobileCreateName").value.trim();
  const number = $("mobileCreateNumber").value.trim().replace(/\D/g, "");
  const category = $("mobileCreateCategory").value;
  if (!name || !number || !category) return;

  const numberAlreadySaved = mobileRecords.some(
    (record) =>
      String(record.number) === number &&
      String(record.name || "")
        .trim()
        .toLowerCase() !== name.toLowerCase(),
  );
  if (numberAlreadySaved) {
    $("mobileCreateMessage").textContent =
      "This number has already been saved to the database.";
    return;
  }

  const existingCustomer = mobileRecords.find(
    (record) =>
      String(record.name || "")
        .trim()
        .toLowerCase() === name.toLowerCase() &&
      String(record.number) === number,
  );

  let message = "Customer added.";
  if (existingCustomer) {
    const categories = getRecordCategories(existingCustomer);
    const hasCategory = categories.some(
      (item) => item.toLowerCase() === category.toLowerCase(),
    );
    if (!hasCategory) {
      categories.push(category);
      existingCustomer.categories = categories;
      existingCustomer.category = categories.join(", ");
      message = `Category added to ${existingCustomer.name}.`;
    } else {
      message = `${existingCustomer.name} already has this category.`;
    }
  } else {
    mobileRecords.unshift({
      id: queueItemId(),
      name,
      number,
      category,
      categories: [category],
      createdAt: new Date().toLocaleString(),
    });
  }
  saveMobileOutfitterData();
  renderMobileRecords();
  event.target.reset();
  renderMobileCategories();
  $("mobileCreateMessage").textContent = message;
}

function updateDrawerRoleLabel() {
  const label = $("drawerRoleLabel");
  if (!label) return;

  const role = getAccessMode();
  label.textContent =
    role === "admin"
      ? "Logged in as Admin"
      : role === "client"
        ? "Logged in as Client"
        : role === "outfitter"
          ? "Logged in as Outfitter"
          : "Logged in as";
}

function canManageQueuedFiles() {
  return accessRole === "admin";
}

function canUploadQueuedFiles() {
  return canManageQueuedFiles();
}

function updateAccessModeUI() {
  const mode = getAccessMode();
  const outfitterView = mode === "outfitter";
  document.querySelectorAll('[data-group="shopify"]').forEach((item) => {
    item.hidden = outfitterView;
    item.style.display = outfitterView ? "none" : "";
  });
  const uploadTab = document.querySelector(
    '.inventory-tab[data-panel="upload-panel"]',
  );
  const uploadPanel = document.getElementById("upload-panel");
  const clientView =
    initialAccessLocked || mode === "client" || mode === "locked";
  const hideShopify = clientView || outfitterView;

  if (uploadTab) {
    uploadTab.hidden = hideShopify;
    uploadTab.disabled = hideShopify;
    uploadTab.style.display = hideShopify ? "none" : "";
    uploadTab.setAttribute("aria-hidden", String(hideShopify));
    if (hideShopify) {
      uploadTab.classList.remove("active");
      uploadTab.setAttribute("aria-selected", "false");
    }
  }

  if (uploadPanel && hideShopify) {
    uploadPanel.hidden = true;
    uploadPanel.classList.remove("active");
    uploadPanel.style.display = "none";
  } else if (uploadPanel) {
    uploadPanel.style.display = "";
  }

  const activePanel =
    document.querySelector(".inventory-panel.active")?.id || "excel-panel";
  if (
    (mode === "client" || mode === "locked") &&
    activePanel === "upload-panel"
  ) {
    setInventoryTab("excel-panel");
  }

  if (
    outfitterView &&
    ["upload-panel", "excel-panel", "logs-panel"].includes(activePanel)
  ) {
    setInventoryTab("mobile-search-panel");
  }
}

function forceLockedStartState() {
  const uploadTab = document.querySelector(
    '.inventory-tab[data-panel="upload-panel"]',
  );
  const uploadPanel = document.getElementById("upload-panel");

  if (uploadTab) {
    uploadTab.hidden = true;
    uploadTab.disabled = true;
    uploadTab.classList.remove("active");
    uploadTab.setAttribute("aria-selected", "false");
  }

  if (uploadPanel) {
    uploadPanel.hidden = true;
    uploadPanel.classList.remove("active");
  }
}

function setInventoryTab(panelName) {
  const panels = document.querySelectorAll(".inventory-panel");
  const tabs = document.querySelectorAll(".inventory-tab");
  const mode = getAccessMode();
  const safePanelName =
    (mode === "client" || mode === "locked") && panelName === "upload-panel"
      ? "excel-panel"
      : mode === "outfitter" &&
          ["upload-panel", "excel-panel", "logs-panel"].includes(panelName)
        ? "mobile-search-panel"
        : panelName;

  panels.forEach((panel) => {
    const isActive = panel.id === safePanelName;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });

  tabs.forEach((tab) => {
    const isHiddenForClient =
      tab.dataset.panel === "upload-panel" &&
      (initialAccessLocked || mode === "client" || mode === "locked");
    const isHiddenForOutfitter =
      mode === "outfitter" && tab.dataset.group === "shopify";
    const isHidden = isHiddenForClient || isHiddenForOutfitter;
    tab.hidden = isHidden;
    tab.disabled = isHidden;
    tab.style.display = isHidden ? "none" : "";
    const isActive = tab.dataset.panel === safePanelName;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });
}

function toggleInventoryFormatGuide() {
  const panel = $("inventoryFormatPanel");
  if (!panel) return;

  const existingModal = $("inventoryFormatModal");
  if (existingModal) {
    existingModal.remove();
    return;
  }

  const modalBackdrop = document.createElement("div");
  modalBackdrop.id = "inventoryFormatModal";
  modalBackdrop.className = "inventory-format-backdrop";
  modalBackdrop.innerHTML = `
    <div class="inventory-format-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-format-title">
      <div class="inventory-format-modal-header">
        <h2 id="inventory-format-title">How to format the file</h2>
        <button type="button" class="inventory-format-modal-close" aria-label="Close format guide">×</button>
      </div>
      <div class="inventory-format-modal-body">
        ${panel.innerHTML.replace('id="downloadInventoryTemplate"', 'id="downloadInventoryTemplateModal"')}
      </div>
    </div>
  `;

  const closeModal = () => modalBackdrop.remove();
  modalBackdrop
    .querySelector(".inventory-format-modal-close")
    .addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (event) => {
    if (event.target === modalBackdrop) closeModal();
  });
  modalBackdrop
    .querySelector("#downloadInventoryTemplateModal")
    .addEventListener("click", downloadInventoryTemplate);
  document.body.appendChild(modalBackdrop);
}

function toggleMobileInventoryFormatGuide() {
  const panel = $("mobileInventoryFormatPanel");
  if (!panel) return;
  const existingModal = $("mobileInventoryFormatModal");
  if (existingModal) {
    existingModal.remove();
    return;
  }

  const modalBackdrop = document.createElement("div");
  modalBackdrop.id = "mobileInventoryFormatModal";
  modalBackdrop.className = "inventory-format-backdrop";
  modalBackdrop.innerHTML = `
    <div class="inventory-format-modal" role="dialog" aria-modal="true" aria-labelledby="mobile-inventory-format-title">
      <div class="inventory-format-modal-header">
        <h2 id="mobile-inventory-format-title">How to format the file</h2>
        <button type="button" class="inventory-format-modal-close" aria-label="Close format guide">×</button>
      </div>
      <div class="inventory-format-modal-body">${panel.innerHTML}</div>
    </div>`;
  const closeModal = () => modalBackdrop.remove();
  modalBackdrop
    .querySelector(".inventory-format-modal-close")
    .addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", (event) => {
    if (event.target === modalBackdrop) closeModal();
  });
  document.body.appendChild(modalBackdrop);
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
      currentInventoryFileSize,
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
    currentInventoryFileSize = Number(rawState.currentInventoryFileSize || 0);
    inventoryRows = Array.isArray(rawState.rows) ? rawState.rows : [];
  } catch {
    currentInventoryFileName = "";
    currentInventoryFileSize = 0;
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
  const queueItem = getQueueItemById(queueId);
  if (!queueItem) return;

  const targetName = String(queueItem.name || "").trim();
  if (!targetName) return;

  try {
    if (queueItem.source === "server") {
      if (!canManageQueuedFiles()) {
        $("excelQueueSummary").textContent =
          "Only the admin can delete server queue files.";
        return;
      }

      const response = await fetch(
        `${getServerUrl()}/inventory/shared-queue?name=${encodeURIComponent(targetName)}`,
        {
          method: "DELETE",
          credentials: "include",
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
      const allowDelete =
        canManageQueuedFiles() || queueItem.source === "local";
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
          credentials: "include",
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

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function createNormalizedQueueFile(file, rows) {
  const csvLines = ["Product Name,SKU,Quantity"];
  rows.forEach((row) => {
    csvLines.push(
      [row.productName, row.sku, row.quantity].map(csvCell).join(","),
    );
  });

  return {
    name: `${file.name.replace(/\.[^/.]+$/, "")}-normalized.csv`,
    blob: new Blob([`${csvLines.join("\n")}\n`], { type: "text/csv" }),
  };
}

function confirmNormalizedQueueUpload(file, data) {
  return new Promise((resolve) => {
    const modalBackdrop = document.createElement("div");
    modalBackdrop.className = "inventory-log-preview-backdrop";
    const rejectedRows = Array.isArray(data.rejected) ? data.rejected : [];
    const rows = Array.isArray(data.rows) ? data.rows : [];

    modalBackdrop.innerHTML = `
      <div class="inventory-log-preview-modal" role="dialog" aria-modal="true" aria-labelledby="queue-normalize-title">
        <div class="inventory-log-preview-header">
          <div>
            <span class="section-label">Confirm upload</span>
            <h3 id="queue-normalize-title">${escapeHtml(file.name)}</h3>
          </div>
          <button type="button" class="inventory-log-preview-close" aria-label="Cancel upload">×</button>
        </div>
        <div class="inventory-log-preview-body">
          <p class="queue-normalize-message">The file was parsed into the standard Product Name, SKU, Quantity format. Upload these ${rows.length} row${rows.length === 1 ? "" : "s"}?</p>
          ${
            rows.length
              ? `<table class="inventory-log-preview-table"><thead><tr><th>Product name</th><th>SKU</th><th>Qty</th></tr></thead><tbody>${rows
                  .map(
                    (row) =>
                      `<tr><td>${escapeHtml(row.productName)}</td><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.quantity)}</td></tr>`,
                  )
                  .join("")}</tbody></table>`
              : '<div class="inventory-log-empty">No valid rows were found.</div>'
          }
          ${
            rejectedRows.length
              ? `<div class="queue-normalize-warning">${rejectedRows.length} row${rejectedRows.length === 1 ? "" : "s"} will not be uploaded because they need attention.<ul>${rejectedRows
                  .map(
                    (row) =>
                      `<li>Row ${escapeHtml(row.rowNumber)}: ${escapeHtml(row.raw || row.error || "Invalid row")}</li>`,
                  )
                  .join("")}</ul></div>`
              : ""
          }
          <div class="queue-modal-actions">
            <button type="button" class="secondary-button" data-queue-confirm="cancel">No, cancel</button>
            <button type="button" class="primary-button" data-queue-confirm="upload" ${rows.length ? "" : "disabled"}>Yes, upload</button>
          </div>
        </div>
      </div>
    `;

    const finish = (confirmed) => {
      modalBackdrop.remove();
      resolve(confirmed ? createNormalizedQueueFile(file, rows) : null);
    };
    modalBackdrop
      .querySelector("[data-queue-confirm='cancel']")
      .addEventListener("click", () => finish(false));
    modalBackdrop
      .querySelector("[data-queue-confirm='upload']")
      .addEventListener("click", () => finish(true));
    modalBackdrop
      .querySelector(".inventory-log-preview-close")
      .addEventListener("click", () => finish(false));
    modalBackdrop.addEventListener("click", (event) => {
      if (event.target === modalBackdrop) finish(false);
    });
    document.body.appendChild(modalBackdrop);
  });
}

async function previewQueueFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${getServerUrl()}/inventory/preview`, {
    method: "POST",
    headers: { "x-device-name": getDeviceName() },
    credentials: "include",
    body: formData,
  });
  const data = await readJsonResponse(response);
  if (!response.ok || !data.success) {
    throw new Error(data.error || "Could not parse this spreadsheet.");
  }
  return data;
}

async function loadSharedQueue() {
  try {
    const response = await fetch(`${getServerUrl()}/inventory/shared-queue`, {
      credentials: "include",
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
      headers: { "x-device-name": getDeviceName() },
      credentials: "include",
      body: formData,
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not read this spreadsheet.");
    }

    inventoryRows = data.rows;
    currentInventoryFileName = file.name;
    currentInventoryFileSize = Number(file.size || 0);
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
        credentials: "include",
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

  currentInventoryFile = file;
  inventoryRows = [];
  currentInventoryFileName = file.name;
  currentInventoryFileSize = Number(file.size || 0);
  $("updateInventory").disabled = true;
  $("inventorySummary").textContent = `Reading ${file.name}...`;
  $("inventoryPreview").innerHTML = "";

  try {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(`${getServerUrl()}/inventory/preview`, {
      method: "POST",
      headers: { "x-device-name": getDeviceName() },
      credentials: "include",
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
  if (getAccessMode() === "client") {
    if (!currentInventoryFile) {
      $("inventorySummary").textContent =
        "Choose the spreadsheet again before sending it to the queue.";
      $("updateInventory").disabled = false;
      return;
    }

    $("inventorySummary").textContent =
      "Uploading spreadsheet to the admin queue...";
    try {
      const formData = new FormData();
      formData.append("file", currentInventoryFile);
      formData.append("uploadedBy", getDeviceName());
      const response = await fetch(`${getServerUrl()}/inventory/shared-queue`, {
        method: "POST",
        headers: { "x-device-name": getDeviceName() },
        credentials: "include",
        body: formData,
      });
      const data = await readJsonResponse(response);
      if (!response.ok || !data.success) {
        throw new Error(
          data.error || "Could not upload the spreadsheet to the queue.",
        );
      }
      $("inventorySummary").textContent =
        "Spreadsheet uploaded to the admin queue.";
      await loadSharedQueue();
    } catch (error) {
      $("inventorySummary").textContent = getInventoryErrorMessage(error);
    } finally {
      $("updateInventory").disabled = false;
    }
    return;
  }

  $("inventorySummary").textContent =
    `Updating ${inventoryRows.length} SKU${inventoryRows.length === 1 ? "" : "s"} in Shopify...`;

  try {
    const response = await fetch(`${getServerUrl()}/inventory/update`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        rows: inventoryRows,
        filename: currentInventoryFileName || "unknown-file",
        fileSize: currentInventoryFileSize,
        uploadedBy: getDeviceName(),
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
      const metadata = {};
      const cleanDetailParts = detail.split(/\s*\|\s*/).filter((part) => {
        const metadataMatch = part.match(/^(rows|size|client|ip):(.*)$/i);
        if (!metadataMatch) return true;
        metadata[metadataMatch[1].toLowerCase()] = metadataMatch[2].trim();
        return false;
      });

      return {
        timestamp: dateLabel,
        filename,
        status: normalizedStatus,
        detail: cleanDetailParts.join(" | "),
        rowCount: metadata.rows || "Unavailable",
        fileSize: metadata.size ? formatFileSize(metadata.size) : "Unavailable",
        uploadedBy: metadata.client || "Unavailable",
        ipAddress: metadata.ip || "Unavailable",
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
              <div class="inventory-log-metadata">
                <span>Rows: ${escapeHtml(entry.rowCount)}</span>
                <span>File size: ${escapeHtml(entry.fileSize)}</span>
                <span>Uploaded by: ${escapeHtml(entry.uploadedBy)}</span>
                <span>IP address: ${escapeHtml(entry.ipAddress)}</span>
              </div>
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
            credentials: "include",
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
      credentials: "include",
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

async function logoutInventory() {
  try {
    await fetch(`${getServerUrl()}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } finally {
    sessionStorage.removeItem("inventoryRole");
    window.location.replace("/inventory");
  }
}

async function verifyDashboardSession() {
  try {
    const response = await fetch(`${getServerUrl()}/auth/session`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Login required.");

    const data = await response.json();
    if (!data.success) throw new Error("Login required.");

    accessRole = data.role || accessRole;
    sessionStorage.setItem("inventoryRole", accessRole);
    initialAccessLocked = accessRole === "locked";
    updateDrawerRoleLabel();
    setInventoryTab(getInitialPanelForRole(accessRole));
    updateAccessModeUI();
  } catch {
    sessionStorage.removeItem("inventoryRole");
    window.location.replace("/inventory");
  }
}

async function readJsonResponse(response) {
  const responseText = await response.text();

  if (response.status === 401) {
    sessionStorage.removeItem("inventoryRole");
    window.location.href = "/inventory";
    throw new Error("Your login session expired. Redirecting to login.");
  }

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
  const isRemotePage =
    /^https?:$/i.test(window.location.protocol) &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(
      window.location.origin,
    );
  const hasStaleLocalhostUrl =
    isRemotePage &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(savedUrl);

  initialAccessLocked = getAccessMode() === "locked";
  updateDrawerRoleLabel();

  if (!localStorage.getItem("shopifyServerUrl") || hasStaleLocalhostUrl) {
    saveServerUrl(window.location.origin);
  }

  $("serverUrlInput").value = hasStaleLocalhostUrl
    ? window.location.origin
    : savedUrl || DEFAULT_SERVER_URL;
  $("deviceNameInput").value = getDeviceName();
  loadMobileOutfitterData();
  normalizeMobileRecords();
  renderMobileCategories();
  renderFoundCategoryOptions();
  renderMobileRecords();
  renderMobileSearchResults();
  loadMobileInventory();
  syncMobileOutfitterData();
  setInventoryTab(getInitialPanelForRole());
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
    if (!selectedFiles.length) {
      $("excelQueueSummary").textContent =
        "Choose at least one spreadsheet file.";
      event.target.value = "";
      return;
    }

    const uploadedBy = getDeviceName();
    let uploadedCount = 0;
    const errors = [];
    for (const file of selectedFiles) {
      try {
        const parsedData = await previewQueueFile(file);
        const normalizedFile = await confirmNormalizedQueueUpload(
          file,
          parsedData,
        );
        if (!normalizedFile) continue;

        const formData = new FormData();
        formData.append("file", normalizedFile.blob, normalizedFile.name);
        formData.append("uploadedBy", uploadedBy);

        const response = await fetch(
          `${getServerUrl()}/inventory/shared-queue`,
          {
            method: "POST",
            headers: { "x-device-name": uploadedBy },
            credentials: "include",
            body: formData,
          },
        );
        const data = await readJsonResponse(response);
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not upload the parsed file.");
        }
        uploadedCount += 1;
      } catch (error) {
        errors.push(`${file.name}: ${getInventoryErrorMessage(error)}`);
      }
    }

    event.target.value = "";
    await loadSharedQueue();
    renderQueuedFiles();
    $("excelQueueSummary").textContent = errors.length
      ? `${uploadedCount} file${uploadedCount === 1 ? "" : "s"} uploaded. ${errors.join(" ")}`
      : `${uploadedCount} file${uploadedCount === 1 ? "" : "s"} parsed, confirmed, and saved to the server queue.`;
  });
  $("applyServerUrl").addEventListener("click", async () => {
    const value = $("serverUrlInput").value;
    const nextUrl = saveServerUrl(value);
    $("serverUrlInput").value = nextUrl;
    await checkServerConnection(true);
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
    setInventoryTab(getInitialPanelForRole());
    checkServerConnection(true);
    loadSharedQueue();
  });
  $("logoutButton").addEventListener("click", logoutInventory);
  $("mobileCreateForm").addEventListener("submit", addMobileRecord);
  $("mobileInventoryFile").addEventListener("change", uploadMobileInventory);
  $("mobileInventoryFormatGuide").addEventListener(
    "click",
    toggleMobileInventoryFormatGuide,
  );
  $("mobileSearchInput").addEventListener("input", renderMobileSearchResults);
  $("mobileSearchSaveCategory").addEventListener("click", saveFoundCategory);
  $("mobileSearchClear").addEventListener("click", () => {
    $("mobileSearchInput").value = "";
    currentMobileSearchRecordId = "";
    renderMobileSearchResults();
  });
  $("mobileCreateNumber").addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "");
  });
  $("drawerToggle").addEventListener("click", () => {
    const drawer = $("dashboardDrawer");
    const isOpen = drawer.classList.toggle("open");
    $("drawerToggle").setAttribute("aria-expanded", String(isOpen));
  });

  document.querySelectorAll(".inventory-tab").forEach((button) => {
    button.addEventListener("click", () => {
      setInventoryTab(button.dataset.panel);
      $("dashboardDrawer").classList.remove("open");
      $("drawerToggle").setAttribute("aria-expanded", "false");
      if (button.dataset.panel === "logs-panel") {
        viewInventoryLog();
      }
    });
  });

  setInventoryTab(getInitialPanelForRole());
  updateAccessModeUI();
  viewInventoryLog();
  checkServerConnection(true);
  loadSharedQueue();
  setInterval(() => {
    loadSharedQueue();
  }, 5000);
});

window.addEventListener("pageshow", () => {
  verifyDashboardSession();
});
