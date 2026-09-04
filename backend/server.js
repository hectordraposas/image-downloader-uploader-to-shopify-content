const http = require("http");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

const { uploadImage } = require("./shopify-upload");
const { getAccessToken } = require("./shopify");

const PORT = 3000;

const upload = multer({
  dest: path.join(__dirname, "uploads"),
});

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Test server
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        success: true,
        message: "Shopify server is running",
      }),
    );

    return;
  }

  // Upload image
  if (req.method === "POST" && req.url === "/upload") {
    upload.single("image")(req, res, async (error) => {
      if (error) {
        res.writeHead(400, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: false,
            error: error.message,
          }),
        );

        return;
      }

      if (!req.file) {
        res.writeHead(400, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: false,
            error: "No image received",
          }),
        );

        return;
      }

      try {
        console.log("Image received:", req.file.originalname);

        const accessToken = await getAccessToken();

        if (!accessToken) {
          throw new Error("Could not get Shopify access token.");
        }

        const file = await uploadImage(req.file.path, accessToken);

        // Delete temporary file
        fs.unlinkSync(req.file.path);

        res.writeHead(200, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: true,
            file: file,
          }),
        );
      } catch (error) {
        console.error("Shopify upload failed:", error);

        // Remove temporary file if it exists
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }

        res.writeHead(500, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: false,
            error: error.message,
          }),
        );
      }
    });

    return;
  }

  // Not found
  res.writeHead(404, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      success: false,
      error: "Route not found",
    }),
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Shopify server running on http://localhost:${PORT}`);
});
