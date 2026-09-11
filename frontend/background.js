console.log("Shopify Image Uploader background service started");

const DEFAULT_SERVER_URL = "http://localhost:3000";

function getServerUrl() {
  return new Promise((resolve) => {
    if (!chrome?.storage?.local) {
      resolve(DEFAULT_SERVER_URL);
      return;
    }

    chrome.storage.local.get(["shopifyServerUrl"], (result) => {
      const value = result.shopifyServerUrl || DEFAULT_SERVER_URL;
      resolve(String(value).trim().replace(/\/$/, "") || DEFAULT_SERVER_URL);
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetch-image") {
    (async () => {
      try {
        const imageUrl = String(message.url || "").trim();
        if (!imageUrl) {
          throw new Error("Image URL is empty.");
        }

        const response = await fetch(imageUrl, { credentials: "include" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 0x8000;

        for (let index = 0; index < bytes.length; index += chunkSize) {
          binary += String.fromCharCode(
            ...bytes.subarray(index, index + chunkSize),
          );
        }

        const contentType = response.headers.get("content-type") || "image/png";
        sendResponse({
          success: true,
          dataUrl: `data:${contentType};base64,${btoa(binary)}`,
        });
      } catch (error) {
        console.error("Background image fetch failed:", error);
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return true;
  }

  if (message.action === "test-server") {
    (async () => {
      try {
        const serverUrl = await getServerUrl();
        const response = await fetch(`${serverUrl}/`);
        const data = await response.json();

        console.log("Server response:", data);

        sendResponse({
          success: true,
          data: data,
        });
      } catch (error) {
        console.error("Server connection failed:", error);

        sendResponse({
          success: false,
          error: error.message,
        });
      }
    })();

    return true;
  }
});
