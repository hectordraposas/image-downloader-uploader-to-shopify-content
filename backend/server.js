const http = require("http");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");

require("dotenv").config({
  path: path.join(__dirname, ".env"),
});

const { uploadImage } = require("./shopify-upload");
const { getAccessToken } = require("./shopify");
const {
  parseSpreadsheet,
  updateInventoryBySku,
} = require("./inventory-update");

const PORT = 3000;
const LOG_DIRECTORY = path.join(__dirname, "logs");
const LOG_FILE_PATH = path.join(LOG_DIRECTORY, "inventory-log.txt");
const TEMP_FILES_DIRECTORY = path.join(__dirname, "temp-files");

const upload = multer({
  dest: path.join(__dirname, "uploads"),
});

function ensureLogDirectory() {
  if (!fs.existsSync(LOG_DIRECTORY)) {
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
  }

  if (!fs.existsSync(LOG_FILE_PATH)) {
    fs.writeFileSync(LOG_FILE_PATH, "", "utf8");
  }
}

function appendInventoryLog(filename, status, details = "", rowHash = "") {
  ensureLogDirectory();
  const timestamp = new Date().toISOString();
  const safeFilename =
    String(filename || "unknown-file").trim() || "unknown-file";
  const safeDetails = String(details || "").trim();
  const hashSuffix = rowHash ? ` | hash:${rowHash}` : "";
  const entry = `[${timestamp}] ${safeFilename} | ${status}${safeDetails ? ` | ${safeDetails}` : ""}${hashSuffix}\n`;
  fs.appendFileSync(LOG_FILE_PATH, entry, "utf8");
}

function readInventoryLog() {
  ensureLogDirectory();
  return fs.readFileSync(LOG_FILE_PATH, "utf8").trim();
}

function hashInventoryRows(rows) {
  return require("crypto")
    .createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .map((row) => ({
            productName: String(row.productName || "").trim(),
            sku: String(row.sku || "").trim(),
            quantity: Number(row.quantity),
          }))
          .sort((a, b) => a.sku.localeCompare(b.sku)),
      ),
    )
    .digest("hex");
}

function getDuplicateSuccessfulUpload(filename, rows) {
  const logText = readInventoryLog();
  if (!logText) {
    return null;
  }

  const rowHash = hashInventoryRows(rows);
  const normalizedFilename = String(filename || "unknown-file")
    .trim()
    .toLowerCase();

  const lines = logText.split(/\r?\n/).filter(Boolean);
  const match = [...lines].reverse().find((line) => {
    if (!line.toLowerCase().includes(normalizedFilename)) {
      return false;
    }

    if (!line.includes("| done")) {
      return false;
    }

    return line.includes(`hash:${rowHash}`);
  });

  return match
    ? "This file has already been uploaded and updated successfully."
    : null;
}

function createTextCopyOfSpreadsheet(filePath, originalFilename) {
  const tempName = String(originalFilename || "spreadsheet")
    .replace(/\.[^/.]+$/, "")
    .trim();
  const safeName = `${tempName || "spreadsheet"}.txt`;
  const destination = path.join(TEMP_FILES_DIRECTORY, safeName);

  if (!fs.existsSync(TEMP_FILES_DIRECTORY)) {
    fs.mkdirSync(TEMP_FILES_DIRECTORY, { recursive: true });
  }

  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

  if (!firstSheet) {
    throw new Error("The spreadsheet does not contain a worksheet.");
  }

  const csvText = XLSX.utils.sheet_to_csv(firstSheet);
  fs.writeFileSync(destination, csvText, "utf8");

  return destination;
}

function getTextCopyPath(filename) {
  const safeBaseName = String(filename || "spreadsheet")
    .replace(/\.[^/.]+$/, "")
    .trim();
  const safeFilename = `${safeBaseName || "spreadsheet"}.txt`;
  return path.join(TEMP_FILES_DIRECTORY, safeFilename);
}

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

  // Read a quantity update spreadsheet without changing Shopify inventory.
  if (req.method === "POST" && req.url === "/inventory/preview") {
    upload.single("file")(req, res, async (error) => {
      if (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: error.message }));
        return;
      }

      if (!req.file) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: false, error: "No spreadsheet received." }),
        );
        return;
      }

      try {
        createTextCopyOfSpreadsheet(
          req.file.path,
          req.file.originalname || req.file.filename,
        );
        const spreadsheet = parseSpreadsheet(req.file.path);
        fs.unlinkSync(req.file.path);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, ...spreadsheet }));
      } catch (parseError) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: parseError.message }));
      }
    });
    return;
  }

  // Update Shopify quantities only after the user confirms the reviewed rows.
  if (req.method === "POST" && req.url === "/inventory/update") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { rows, filename } = JSON.parse(body || "{}");
        const spreadsheetFilename =
          String(filename || "unknown-file").trim() || "unknown-file";

        if (!Array.isArray(rows) || !rows.length) {
          throw new Error("No valid spreadsheet rows were supplied.");
        }

        const duplicateMessage = getDuplicateSuccessfulUpload(
          spreadsheetFilename,
          rows,
        );
        if (duplicateMessage) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              duplicate: true,
              message: duplicateMessage,
              results: rows.map((row) => ({
                ...row,
                success: true,
                alreadyUploaded: true,
              })),
            }),
          );
          return;
        }

        const accessToken = await getAccessToken();
        if (!accessToken)
          throw new Error("Could not get Shopify access token.");

        const results = await updateInventoryBySku(rows, accessToken);
        const failedCount = results.filter((result) => !result.success).length;
        const status = failedCount === 0 ? "done" : "failed";
        const rowHash = hashInventoryRows(rows);

        appendInventoryLog(
          spreadsheetFilename,
          status,
          failedCount === 0
            ? `${results.length} SKU${results.length === 1 ? "" : "s"} updated successfully`
            : `${results.length - failedCount} succeeded, ${failedCount} failed`,
          rowHash,
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, results }));
      } catch (updateError) {
        const { filename } = JSON.parse(body || "{}");
        const spreadsheetFilename =
          String(filename || "unknown-file").trim() || "unknown-file";

        appendInventoryLog(spreadsheetFilename, "failed", updateError.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: updateError.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/inventory/logs") {
    try {
      const content = readInventoryLog();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, content }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/inventory/text-copy")) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const fileName = url.searchParams.get("file") || "";
      const textFilePath = getTextCopyPath(fileName);

      if (!fs.existsSync(textFilePath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: false, error: "Text copy not found." }),
        );
        return;
      }

      const content = fs.readFileSync(textFilePath, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${path.basename(textFilePath)}"`,
      });
      res.end(content);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
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
