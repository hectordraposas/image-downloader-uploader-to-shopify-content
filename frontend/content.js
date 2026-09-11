(() => {
  function getBestSrc(img) {
    if (img.currentSrc) return img.currentSrc;
    if (img.src) return img.src;

    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const candidates = srcset
        .split(",")
        .map((x) => x.trim().split(/\s+/)[0])
        .filter(Boolean);
      return candidates[candidates.length - 1] || "";
    }
    return "";
  }

  function collectImages() {
    const result = [];
    const seen = new Set();

    document.querySelectorAll("img").forEach((img, index) => {
      const url = getBestSrc(img);
      if (!url || url.startsWith("data:")) return;

      let absolute;
      try {
        absolute = new URL(url, location.href).href;
      } catch {
        return;
      }

      if (seen.has(absolute)) return;
      seen.add(absolute);

      result.push({
        id: index,
        url: absolute,
        alt: img.alt || "",
        width: img.naturalWidth || img.width || 0,
        height: img.naturalHeight || img.height || 0,
      });
    });

    // Also collect CSS background images.
    document.querySelectorAll("*").forEach((el, index) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === "none") return;

      const matches = [...bg.matchAll(/url\(["']?(.*?)["']?\)/g)];
      for (const match of matches) {
        let url = match[1];
        if (!url || url.startsWith("data:")) continue;

        try {
          url = new URL(url, location.href).href;
        } catch {
          continue;
        }

        if (seen.has(url)) continue;
        seen.add(url);

        result.push({
          id: `bg-${index}`,
          url,
          alt: "Background image",
          width: 0,
          height: 0,
        });
      }
    });

    return result;
  }

  async function getImageData(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read image data."));
      reader.readAsDataURL(blob);
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GET_IMAGES") {
      sendResponse({ images: collectImages() });
      return true;
    }

    if (message?.type === "GET_IMAGE_DATA") {
      getImageData(String(message.url || ""))
        .then((dataUrl) => sendResponse({ success: true, dataUrl }))
        .catch((error) =>
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      return true;
    }
  });
})();
