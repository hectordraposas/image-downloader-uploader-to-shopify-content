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
