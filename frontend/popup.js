let images = [];

const $ = (id) => document.getElementById(id);
const SERVER_URL = "http://localhost:3000";
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
});

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

  const response = await fetch(`${SERVER_URL}/upload`, {
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
