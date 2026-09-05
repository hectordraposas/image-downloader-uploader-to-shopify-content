let inventoryRows = [];
let currentInventoryFileName = "";

const $ = (id) => document.getElementById(id);
const SERVER_URL = "http://localhost:3000";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");

const escapeAttribute = (value) => escapeHtml(value).replace(/`/g, "&#96;");

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
      const link = document.createElement("a");
      link.href = `${SERVER_URL}/inventory/text-copy?file=${encodeURIComponent(fileName)}`;
      link.download = fileName.replace(/\.[^/.]+$/, ".txt");
      document.body.appendChild(link);
      link.click();
      link.remove();
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

    const response = await fetch(`${SERVER_URL}/inventory/preview`, {
      method: "POST",
      body: formData,
    });

    const data = await readJsonResponse(response);
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not read this spreadsheet.");
    }

    inventoryRows = data.rows;
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
    const response = await fetch(`${SERVER_URL}/inventory/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

      const link = document.createElement("a");
      link.href = `${SERVER_URL}/inventory/text-copy?file=${encodeURIComponent(fileName)}`;
      link.download = fileName.replace(/\.[^/.]+$/, ".txt");
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  });
}

async function viewInventoryLog() {
  try {
    const response = await fetch(`${SERVER_URL}/inventory/logs`);
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
  $("inventoryFile").value = "";
  $("inventorySummary").textContent = "Upload a file to preview its rows.";
  $("inventoryPreview").innerHTML = "";
  $("updateInventory").disabled = true;
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
  $("inventoryFile").addEventListener("change", previewInventoryFile);
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
});
