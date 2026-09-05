let images = [];
let inventoryRows = [];
let currentInventoryFileName = "";

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
/* =========================================================
   INITIALIZE
========================================================= */

document.addEventListener("DOMContentLoaded", () => {
  loadImages();

  $("refresh").addEventListener("click", loadImages);

  $("selectAll").addEventListener("click", () => setAll(true));

  $("clearAll").addEventListener("click", () => setAll(false));

  $("downloadSelected").addEventListener("click", downloadSelected);

  $("uploadShopify").addEventListener("click", uploadSelectedToShopify);

  $("openInventoryDashboardPage").addEventListener("click", () => {
    if (chrome?.runtime?.getURL) {
      chrome.tabs.create({ url: chrome.runtime.getURL("inventory.html") });
    }
  });

  document.querySelectorAll(".tab-button").forEach((button) => {
    if (button.id === "openInventoryDashboard") {
      button.addEventListener("click", () => {
        if (chrome?.runtime?.getURL) {
          chrome.tabs.create({ url: chrome.runtime.getURL("inventory.html") });
        }
      });
      return;
    }

    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });
});

function setActiveTab(tabName) {
  const isImagesTab = tabName === "images";
  $("imageWorkspace").hidden = !isImagesTab;

  const dashboardButton = $("openInventoryDashboard");
  if (dashboardButton) {
    dashboardButton.classList.toggle("active", !isImagesTab);
    dashboardButton.setAttribute("aria-selected", String(!isImagesTab));
  }

  $("count").textContent = isImagesTab
    ? `${images.length} image${images.length === 1 ? "" : "s"} found`
    : "Open the inventory dashboard";
}

/* =========================================================
   BULK INVENTORY UPDATE
========================================================= */

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
      link.href = `${getServerUrl()}/inventory/text-copy?file=${encodeURIComponent(fileName)}`;
      link.download = fileName.replace(/\.[^/.]+$/, ".txt");
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  }
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

function clearInventoryUpload() {
  inventoryRows = [];
  currentInventoryFileName = "";
  $("inventoryFile").value = "";
  $("inventorySummary").textContent = "Upload a file to preview its rows.";
  $("inventoryPreview").innerHTML = "";
  $("viewInventoryLog").textContent = "View log";
  $("updateInventory").disabled = true;
}

function renderInventoryLogEntries(content) {
  const lines = (content || "").split(/\r?\n/).filter(Boolean);

  if (!lines.length) {
    $("inventoryPreview").innerHTML =
      '<div class="inventory-log-empty">No inventory updates yet.</div>';
    return;
  }

  const entries = lines
    .map((line) => {
      const match = line.match(
        /^\[(.*?)\]\s*(.*?)\s*\|\s*(done|failed)\s*(?:\|\s*(.*))?$/i,
      );

      if (!match) {
        return null;
      }

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
    $("inventoryPreview").innerHTML =
      '<div class="inventory-log-empty">No inventory updates yet.</div>';
    return;
  }

  $("inventoryPreview").innerHTML = `
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
              <button
                type="button"
                class="inventory-log-download"
                data-download-file="${escapeAttribute(entry.filename)}"
              >
                Download .txt
              </button>
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
      link.href = `${getServerUrl()}/inventory/text-copy?file=${encodeURIComponent(fileName)}`;
      link.download = fileName.replace(/\.[^/.]+$/, ".txt");
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  });
}

async function viewInventoryLog() {
  try {
    const response = await fetch(`${getServerUrl()}/inventory/logs`);
    const data = await readJsonResponse(response);

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Could not read the inventory log.");
    }

    const content = data.content || "";
    $("inventorySummary").textContent = "Inventory log";
    renderInventoryLogEntries(content);
    $("viewInventoryLog").textContent = "View log";
  } catch (error) {
    $("inventorySummary").textContent = getInventoryErrorMessage(error);
    $("inventoryPreview").innerHTML = "";
  }
}

async function updateInventoryQuantities() {
  if (!inventoryRows.length) return;

  const button = $("updateInventory");
  button.disabled = true;
  $("inventorySummary").textContent =
    `Updating ${inventoryRows.length} SKU${inventoryRows.length === 1 ? "" : "s"} in Shopify...`;

  try {
    const response = await fetch(`${getServerUrl()}/inventory/update`, {
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
    button.disabled = inventoryRows.length === 0;
  }
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

/* =========================================================
   GET ACTIVE TAB
========================================================= */

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tabs[0];
}

/* =========================================================
   LOAD IMAGES
========================================================= */

async function loadImages() {
  $("status").textContent = "Scanning...";

  $("imageList").innerHTML = "";

  try {
    const tab = await getActiveTab();

    if (!tab?.id) {
      throw new Error("No active tab.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_IMAGES",
    });

    /*
     * Only keep images where BOTH
     * width and height are at least 500px.
     */

    images = (response?.images || [])
      .filter((image) => {
        const width = Number(image.width) || 0;

        const height = Number(image.height) || 0;

        return width >= 500 && height >= 500;
      })
      .map((image) => ({
        ...image,

        /*
         * Default layout.
         */

        layout: "padding",
      }));

    renderImages();

    $("status").textContent = "Ready";
  } catch (error) {
    console.error(error);

    $("status").textContent = "Cannot scan this page";

    $("imageList").innerHTML = `
        <div class="empty">
          Open a normal website and click refresh.
        </div>
      `;
  }
}

/* =========================================================
   RENDER IMAGES
========================================================= */

function renderImages() {
  $("count").textContent =
    `${images.length} image${images.length === 1 ? "" : "s"} found`;

  if (!images.length) {
    $("imageList").innerHTML = `
        <div class="empty">
          No images 500 × 500 px or larger found.
        </div>
      `;
    return;
  }

  $("imageList").innerHTML = images
    .map(
      (image, index) => `
        <div class="image-row">

          <div
            class="image-main"
            data-index="${index}"
          >

            <input
              type="checkbox"
              class="image-check"
              data-index="${index}"
              
            >

            <img
              class="thumb"
              src="${escapeAttribute(image.url)}"
              alt=""
            >

            <div class="info">

              <div
                class="name"
                title="${escapeAttribute(getImageName(image, index))}"
              >
                ${escapeHtml(getImageName(image, index))}
              </div>

              <div class="dimensions">
                ${image.width || "?"}
                ×
                ${image.height || "?"}
              </div>

            </div>

          </div>


          <div class="image-layout">

            <label>

              <input
                type="radio"
                name="layout-${index}"
                value="full"
                data-index="${index}"
                class="layout-radio"

                ${image.layout === "full" ? "checked" : ""}
              >

              Full Screen

            </label>


            <label>

              <input
                type="radio"
                name="layout-${index}"
                value="padding"
                data-index="${index}"
                class="layout-radio"

                ${image.layout === "padding" ? "checked" : ""}
              >

              200px Padding

            </label>

          </div>

        </div>
      `,
    )
    .join("");

  /* =========================================================
     CLICK IMAGE MAIN TO TOGGLE CHECKBOX
  ========================================================= */

  document.querySelectorAll(".image-main").forEach((main) => {
    main.addEventListener("click", (event) => {
      /*
       * If the user clicked the checkbox itself,
       * let the checkbox handle the click normally.
       */

      if (event.target.classList.contains("image-check")) {
        return;
      }

      const index = Number(main.dataset.index);

      const checkbox = main.querySelector(".image-check");

      checkbox.checked = !checkbox.checked;
    });
  });

  /* =========================================================
     LAYOUT RADIO BUTTONS
  ========================================================= */

  document.querySelectorAll(".layout-radio").forEach((radio) => {
    radio.addEventListener("change", (event) => {
      const index = Number(event.target.dataset.index);

      images[index].layout = event.target.value;

      console.log(`Image ${index + 1} layout:`, images[index].layout);
    });
  });
}

/* =========================================================
   GET IMAGE NAME
========================================================= */

function getImageName(image, index) {
  /*
   * Use ALT text first.
   */

  if (image.alt && image.alt.trim()) {
    return shortenName(image.alt.trim());
  }

  /*
   * Otherwise get the filename
   * from the image URL.
   */

  try {
    const url = new URL(image.url);

    let filename = url.pathname.split("/").pop();

    /*
     * Remove extension.
     */

    filename = filename.replace(/\.(jpg|jpeg|png|webp|gif|avif|svg)$/i, "");

    /*
     * Decode URL characters.
     */

    filename = decodeURIComponent(filename);

    /*
     * Replace - and _
     * with spaces.
     */

    filename = filename.replace(/[-_]+/g, " ");

    /*
     * Remove duplicate spaces.
     */

    filename = filename.replace(/\s+/g, " ").trim();

    if (filename) {
      return shortenName(filename);
    }
  } catch (error) {
    console.error("Could not get image name:", error);
  }

  /*
   * Final fallback.
   */

  return `Image ${index + 1}`;
}

/* =========================================================
   SHORTEN IMAGE NAME
========================================================= */

function shortenName(name) {
  const maxLength = 35;

  if (name.length <= maxLength) {
    return name;
  }

  return name.substring(0, maxLength) + "...";
}

/* =========================================================
   SELECT ALL / CLEAR
========================================================= */

function setAll(value) {
  document.querySelectorAll(".image-check").forEach((check) => {
    check.checked = value;
  });
}

/* =========================================================
   GET SELECTED IMAGES
========================================================= */

function getSelectedImages() {
  return [...document.querySelectorAll(".image-check:checked")].map(
    (check) => images[Number(check.dataset.index)],
  );
}

/* =========================================================
   DOWNLOAD SELECTED
========================================================= */

async function downloadSelected() {
  const selected = getSelectedImages();

  if (!selected.length) {
    $("status").textContent = "Select at least one image.";

    return;
  }

  const keepAspect = $("keepAspect").checked;

  const button = $("downloadSelected");

  button.disabled = true;

  let completed = 0;
  let failed = 0;

  try {
    for (let i = 0; i < selected.length; i++) {
      const image = selected[i];

      try {
        $("status").textContent = `Processing ${i + 1} / ${selected.length}...`;

        /*
         * Use this image's own layout.
         */

        const blob = await createCanvasImage(
          image.url,
          image.layout,
          keepAspect,
        );

        const dataUrl = await blobToDataUrl(blob);

        const filename = `image-canvas/HDR_${String(i + 1).padStart(
          3,
          "0",
        )}.png`;

        await chrome.downloads.download({
          url: dataUrl,

          filename,

          saveAs: false,

          conflictAction: "uniquify",
        });

        completed++;

        $("status").textContent =
          `Downloaded ${completed} / ${selected.length}`;

        await sleep(250);
      } catch (error) {
        failed++;

        console.error(`Download ${i + 1} failed:`, error);
      }
    }

    if (failed === 0) {
      $("status").textContent = `Finished: ${completed} / ${selected.length}`;
    } else {
      $("status").textContent =
        `Finished: ${completed} downloaded, ${failed} failed`;
    }
  } finally {
    button.disabled = false;
  }
}

/* =========================================================
   BLOB TO DATA URL
========================================================= */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => resolve(reader.result);

    reader.onerror = reject;

    reader.readAsDataURL(blob);
  });
}

/* =========================================================
   SLEEP
========================================================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================================================
   CREATE CANVAS IMAGE
========================================================= */

async function createCanvasImage(url, layout, keepAspect) {
  const response = await fetch(url, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const blob = await response.blob();

  const objectUrl = URL.createObjectURL(blob);

  try {
    const img = await loadImage(objectUrl);

    const canvas = document.createElement("canvas");

    canvas.width = 1000;

    canvas.height = 1000;

    const ctx = canvas.getContext("2d", {
      alpha: false,
    });

    /*
     * Always start with
     * white background.
     */

    ctx.fillStyle = "#ffffff";

    ctx.fillRect(0, 0, 1000, 1000);

    /*
     * 200PX PADDING
     */

    if (layout === "padding") {
      const area = 600;

      drawContain(ctx, img, 200, 200, area, area, keepAspect);
    } else {
      /*
       * FULL SCREEN
       */

      drawCover(ctx, img, 0, 0, 1000, 1000);
    }

    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/* =========================================================
   DRAW CONTAIN
========================================================= */

function drawContain(ctx, img, x, y, width, height, keepAspect) {
  if (!keepAspect) {
    ctx.drawImage(img, x, y, width, height);

    return;
  }

  const scale = Math.min(
    width / img.naturalWidth,

    height / img.naturalHeight,
  );

  const w = img.naturalWidth * scale;

  const h = img.naturalHeight * scale;

  ctx.drawImage(
    img,

    x + (width - w) / 2,

    y + (height - h) / 2,

    w,

    h,
  );
}

/* =========================================================
   DRAW COVER
========================================================= */

function drawCover(ctx, img, x, y, width, height) {
  const scale = Math.max(
    width / img.naturalWidth,

    height / img.naturalHeight,
  );

  const w = img.naturalWidth * scale;

  const h = img.naturalHeight * scale;

  const dx = x + (width - w) / 2;

  const dy = y + (height - h) / 2;

  ctx.drawImage(
    img,

    dx,
    dy,

    w,
    h,
  );
}

/* =========================================================
   LOAD IMAGE
========================================================= */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => resolve(img);

    img.onerror = () => reject(new Error("Image could not be loaded."));

    img.src = src;
  });
}

/* =========================================================
   CANVAS TO BLOB
========================================================= */

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Canvas export failed."));
        }
      },

      "image/png",
    );
  });
}

/* =========================================================
   UPLOAD IMAGE TO SHOPIFY BACKEND
========================================================= */

async function uploadImageToShopify(blob, filename) {
  const formData = new FormData();

  formData.append("image", blob, filename);

  const response = await fetch(`${getServerUrl()}/upload`, {
    method: "POST",
    body: formData,
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    throw new Error(data.error || "Shopify upload failed");
  }

  return data;
}

/* =========================================================
   UPLOAD SELECTED IMAGES TO SHOPIFY
========================================================= */

async function uploadSelectedToShopify() {
  const selected = getSelectedImages();

  if (!selected.length) {
    $("status").textContent = "Select at least one image.";

    return;
  }

  const button = $("uploadShopify");

  button.disabled = true;

  let completed = 0;
  let failed = 0;

  const keepAspect = $("keepAspect").checked;

  try {
    for (let i = 0; i < selected.length; i++) {
      const image = selected[i];

      try {
        $("status").textContent = `Processing ${i + 1} / ${selected.length}...`;

        /*
         * IMPORTANT:
         *
         * Use this image's
         * individual layout.
         */

        const blob = await createCanvasImage(
          image.url,
          image.layout,
          keepAspect,
        );

        $("status").textContent = `Uploading ${i + 1} / ${selected.length}...`;

        const filename = `shopify-image-${String(i + 1).padStart(3, "0")}.png`;

        const result = await uploadImageToShopify(blob, filename);

        console.log(`Shopify image ${i + 1}:`, result);

        completed++;

        $("status").textContent = `Uploaded ${completed} / ${selected.length}`;

        await sleep(300);
      } catch (error) {
        failed++;

        console.error(`Image ${i + 1} failed:`, error);
      }
    }

    if (failed === 0) {
      $("status").textContent = `All ${completed} images uploaded to Shopify!`;
    } else {
      $("status").textContent =
        `Finished: ${completed} uploaded, ${failed} failed`;
    }
  } finally {
    button.disabled = false;
  }
}

/* =========================================================
   ESCAPE HTML
========================================================= */

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")

    .replaceAll("<", "&lt;")

    .replaceAll(">", "&gt;")

    .replaceAll('"', "&quot;")

    .replaceAll("'", "&#039;");
}

/* =========================================================
   ESCAPE ATTRIBUTE
========================================================= */

function escapeAttribute(value) {
  return escapeHtml(value);
}
