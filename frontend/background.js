console.log("Shopify Image Uploader background service started");

const SERVER_URL = "http://localhost:3000";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "test-server") {
    fetch(`${SERVER_URL}/`)
      .then((response) => response.json())
      .then((data) => {
        console.log("Server response:", data);

        sendResponse({
          success: true,
          data: data,
        });
      })
      .catch((error) => {
        console.error("Server connection failed:", error);

        sendResponse({
          success: false,
          error: error.message,
        });
      });

    return true;
  }
});
