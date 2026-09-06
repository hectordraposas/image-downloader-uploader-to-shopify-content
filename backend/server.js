const http = require("http");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const dotenv = require("dotenv");

const backendDotEnvPath = path.join(__dirname, ".env");
const rootDotEnvPath = path.join(__dirname, "..", ".env");

if (fs.existsSync(rootDotEnvPath)) {
  dotenv.config({ path: rootDotEnvPath });
}

if (fs.existsSync(backendDotEnvPath)) {
  dotenv.config({ path: backendDotEnvPath });
}

const { uploadImage } = require("./shopify-upload");
const { getAccessToken } = require("./shopify");
const {
  parseSpreadsheet,
  updateInventoryBySku,
} = require("./inventory-update");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_DIRECTORY = path.join(__dirname, "..", "frontend");
const LOG_DIRECTORY = path.join(__dirname, "logs");
const LOG_FILE_PATH = path.join(LOG_DIRECTORY, "inventory-log.txt");
const SERVER_LOG_FILE_PATH = path.join(LOG_DIRECTORY, "server-log.txt");
const TEMP_FILES_DIRECTORY = path.join(__dirname, "temp-files");
const SHARED_QUEUE_DIRECTORY = path.join(__dirname, "shared-queue");
const SHARED_QUEUE_FILES_DIRECTORY = path.join(SHARED_QUEUE_DIRECTORY, "files");
const SHARED_QUEUE_FILE_PATH = path.join(SHARED_QUEUE_DIRECTORY, "queue.json");
const ADMIN_KEY = String(process.env.ADMIN_KEY || "admin-key").trim();
const CLIENT_KEY = String(process.env.CLIENT_KEY || "client-key").trim();

const upload = multer({
  dest: path.join(__dirname, "uploads"),
});

function getRequestIpAddress(req) {
  const forwardedFor =
    req.headers["x-forwarded-for"] ||
    req.headers["x-real-ip"] ||
    req.headers["cf-connecting-ip"];

  if (Array.isArray(forwardedFor)) {
    return String(forwardedFor[0] || "").trim() || "unknown";
  }

  if (typeof forwardedFor === "string") {
    return forwardedFor.split(",")[0].trim() || "unknown";
  }

  const remoteAddress = req.socket && req.socket.remoteAddress;
  return remoteAddress
    ? String(remoteAddress).replace(/^::ffff:/, "")
    : "unknown";
}

function ensureLogDirectory() {
  if (!fs.existsSync(LOG_DIRECTORY)) {
    fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
  }

  if (!fs.existsSync(LOG_FILE_PATH)) {
    fs.writeFileSync(LOG_FILE_PATH, "", "utf8");
  }

  if (!fs.existsSync(SERVER_LOG_FILE_PATH)) {
    fs.writeFileSync(SERVER_LOG_FILE_PATH, "", "utf8");
  }
}

function ensureSharedQueueStore() {
  if (!fs.existsSync(SHARED_QUEUE_DIRECTORY)) {
    fs.mkdirSync(SHARED_QUEUE_DIRECTORY, { recursive: true });
  }

  if (!fs.existsSync(SHARED_QUEUE_FILES_DIRECTORY)) {
    fs.mkdirSync(SHARED_QUEUE_FILES_DIRECTORY, { recursive: true });
  }

  if (!fs.existsSync(SHARED_QUEUE_FILE_PATH)) {
    fs.writeFileSync(SHARED_QUEUE_FILE_PATH, "[]", "utf8");
  }
}

function sanitizeQueueFileName(fileName) {
  return String(fileName || "queue-file")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function readSharedQueue() {
  ensureSharedQueueStore();
  try {
    const rawQueue = fs.readFileSync(SHARED_QUEUE_FILE_PATH, "utf8");
    const parsed = JSON.parse(rawQueue || "[]");
    const normalized = Array.isArray(parsed) ? parsed : [];
    return normalized.sort(
      (a, b) =>
        new Date(b.uploadedAt || 0).getTime() -
        new Date(a.uploadedAt || 0).getTime(),
    );
  } catch {
    return [];
  }
}

function writeSharedQueue(queueItems) {
  ensureSharedQueueStore();
  const nextItems = Array.isArray(queueItems) ? queueItems : [];
  fs.writeFileSync(
    SHARED_QUEUE_FILE_PATH,
    JSON.stringify(nextItems, null, 2),
    "utf8",
  );
}

function appendServerLog(level, message, details = "") {
  ensureLogDirectory();
  const timestamp = new Date().toISOString();
  const text = [
    `[${timestamp}]`,
    `[${String(level || "INFO").toUpperCase()}]`,
    String(message || "").trim(),
    details ? `| ${String(details).trim()}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  fs.appendFileSync(SERVER_LOG_FILE_PATH, `${text}\n`, "utf8");
  return text;
}

function readServerLog() {
  ensureLogDirectory();
  return fs.readFileSync(SERVER_LOG_FILE_PATH, "utf8").trim();
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

function getRequestKey(req) {
  const headerKey =
    req.headers["x-admin-key"] ||
    req.headers["x-client-key"] ||
    req.headers["x-admin-token"] ||
    req.headers.authorization;

  const rawCandidate = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  return rawCandidate && String(rawCandidate).startsWith("Bearer ")
    ? String(rawCandidate).replace(/^Bearer\s+/i, "")
    : rawCandidate;
}

function isAdminRequest(req) {
  return String(getRequestKey(req) || "").trim() === ADMIN_KEY;
}

function isClientRequest(req) {
  return (
    Boolean(CLIENT_KEY) &&
    String(getRequestKey(req) || "").trim() === CLIENT_KEY
  );
}

function getRequestAccessRole(req) {
  if (isAdminRequest(req)) return "admin";
  if (isClientRequest(req)) return "client";
  return "none";
}

function requireClientAccess(req, res) {
  const role = getRequestAccessRole(req);

  if (role === "admin" || role === "client") {
    return true;
  }

  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      success: false,
      error: "Access denied: valid client or admin key required.",
    }),
  );
  return false;
}

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        error: "Access denied: admin key is not configured on the server.",
      }),
    );
    return false;
  }

  if (!isAdminRequest(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        error: "Access denied: admin role required.",
      }),
    );
    return false;
  }

  return true;
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

function createTextCopyOfSpreadsheet(filePath, originalFilename, rows = []) {
  const tempName = String(originalFilename || "spreadsheet")
    .replace(/\.[^/.]+$/, "")
    .trim();
  const safeName = `${tempName || "spreadsheet"}.txt`;
  const destination = path.join(TEMP_FILES_DIRECTORY, safeName);

  if (!fs.existsSync(TEMP_FILES_DIRECTORY)) {
    fs.mkdirSync(TEMP_FILES_DIRECTORY, { recursive: true });
  }

  const csvLines = [];

  if (Array.isArray(rows) && rows.length) {
    csvLines.push(["Product Name", "SKU", "Quantity", "Status"].join(","));

    rows.forEach((row) => {
      const productName = String(row.productName || "").replace(/"/g, '""');
      const sku = String(row.sku || "").replace(/"/g, '""');
      const quantity = String(row.quantity ?? "").replace(/"/g, '""');
      const status = row.success ? "success" : "failed";
      csvLines.push(
        [`"${productName}"`, `"${sku}"`, `"${quantity}"`, `"${status}"`].join(
          ",",
        ),
      );
    });

    fs.writeFileSync(destination, `${csvLines.join("\n")}\n`, "utf8");
    return destination;
  }

  if (!filePath || !fs.existsSync(filePath)) {
    fs.writeFileSync(destination, "Product Name,SKU,Quantity,Status\n", "utf8");
    return destination;
  }

  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

  if (!firstSheet) {
    throw new Error("The spreadsheet does not contain a worksheet.");
  }

  const csvText = XLSX.utils.sheet_to_csv(firstSheet);
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  const withStatus = lines.map((line, index) =>
    index === 0 ? `${line},Status` : `${line},pending`,
  );

  fs.writeFileSync(destination, `${withStatus.join("\n")}\n`, "utf8");

  return destination;
}

function getTextCopyPath(filename) {
  const safeBaseName = String(filename || "spreadsheet")
    .replace(/\.[^/.]+$/, "")
    .trim();
  const safeFilename = `${safeBaseName || "spreadsheet"}.txt`;
  return path.join(TEMP_FILES_DIRECTORY, safeFilename);
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
  };

  return types[extension] || "application/octet-stream";
}

function serveFrontendFile(res, relativePath, method = "GET") {
  const safeRelativePath = String(relativePath || "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");

  const requestedPath = path.resolve(FRONTEND_DIRECTORY, safeRelativePath);
  const normalizedRoot = path.resolve(FRONTEND_DIRECTORY);

  if (!requestedPath.startsWith(normalizedRoot)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    if (method !== "HEAD") {
      res.end(JSON.stringify({ success: false, error: "Forbidden" }));
    } else {
      res.end();
    }
    return;
  }

  if (
    !fs.existsSync(requestedPath) ||
    fs.statSync(requestedPath).isDirectory()
  ) {
    res.writeHead(404, { "Content-Type": "application/json" });
    if (method !== "HEAD") {
      res.end(JSON.stringify({ success: false, error: "File not found" }));
    } else {
      res.end();
    }
    return;
  }

  const content = fs.readFileSync(requestedPath);
  res.writeHead(200, {
    "Content-Type": getContentType(requestedPath),
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  if (method !== "HEAD") {
    res.end(content);
  } else {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-admin-key, x-client-key, x-admin-token, x-device-name, Authorization",
  );

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
        inventoryDashboardUrl: "http://localhost:3000/inventory",
      }),
    );

    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const requestUrl = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`,
    );
    const pathname = requestUrl.pathname;

    if (pathname === "/inventory" || pathname === "/inventory.html") {
      serveFrontendFile(res, "inventory.html", req.method);
      return;
    }

    if (pathname === "/inventory.css") {
      serveFrontendFile(res, "inventory.css", req.method);
      return;
    }

    if (pathname === "/inventory.js") {
      serveFrontendFile(res, "inventory.js", req.method);
      return;
    }

    if (
      pathname === "/popup.css" ||
      pathname === "/popup.js" ||
      pathname === "/popup.html"
    ) {
      serveFrontendFile(res, pathname.replace(/^\//, ""), req.method);
      return;
    }

    if (pathname.startsWith("/frontend/")) {
      serveFrontendFile(res, pathname.replace(/^\/frontend\//, ""), req.method);
      return;
    }
  }

  if (req.method === "GET" && req.url === "/server/status") {
    const content = readServerLog();
    res.writeHead(200, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify({
        success: true,
        status: "connected",
        message: "Server connected",
        content,
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
    if (!requireAdmin(req, res)) return;

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
    if (!requireAdmin(req, res)) return;

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

        if (!isAdminRequest(req)) {
          const message =
            "Access denied: admin role required for inventory updates.";
          appendServerLog("ERROR", message, spreadsheetFilename);
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: message }));
          return;
        }

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
        createTextCopyOfSpreadsheet(null, spreadsheetFilename, results);
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
        appendServerLog(
          failedCount === 0 ? "INFO" : "WARN",
          "Inventory update processed",
          `${spreadsheetFilename} | ${failedCount === 0 ? "success" : "partial failure"}`,
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, results }));
      } catch (updateError) {
        const parsedBody = (() => {
          try {
            return JSON.parse(body || "{}");
          } catch {
            return {};
          }
        })();
        const spreadsheetFilename =
          String(parsedBody.filename || "unknown-file").trim() ||
          "unknown-file";

        appendInventoryLog(spreadsheetFilename, "failed", updateError.message);
        appendServerLog(
          "ERROR",
          "Inventory update error",
          `${spreadsheetFilename} | ${updateError.message}`,
        );
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: updateError.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/inventory/shared-queue") {
    if (!requireClientAccess(req, res)) return;

    try {
      const queue = readSharedQueue();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, queue }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  if (
    req.method === "DELETE" &&
    req.url.startsWith("/inventory/shared-queue")
  ) {
    if (!requireAdmin(req, res)) return;

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const targetName = sanitizeQueueFileName(
        url.searchParams.get("name") || "",
      );
      const queue = readSharedQueue();
      const nextQueue = queue.filter((item) => {
        const itemName = String(item.name || "").trim();
        return itemName && itemName.toLowerCase() !== targetName.toLowerCase();
      });

      if (targetName) {
        const targetPath = path.join(SHARED_QUEUE_FILES_DIRECTORY, targetName);
        if (fs.existsSync(targetPath)) {
          fs.unlinkSync(targetPath);
        }
      }

      writeSharedQueue(nextQueue);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, queue: nextQueue }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/inventory/shared-queue") {
    if (!requireAdmin(req, res)) return;

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
        const uploadedBy =
          String(
            req.body?.uploadedBy ||
              req.headers["x-device-name"] ||
              "Unknown device",
          ).trim() || "Unknown device";
        const ipAddress = getRequestIpAddress(req);
        const queue = readSharedQueue();
        const safeName = sanitizeQueueFileName(
          req.file.originalname || req.file.filename,
        );
        const destinationPath = path.join(
          SHARED_QUEUE_FILES_DIRECTORY,
          safeName,
        );
        fs.copyFileSync(req.file.path, destinationPath);
        fs.unlinkSync(req.file.path);

        const nextQueueItem = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          name: safeName,
          uploadedBy,
          ipAddress,
          uploadedAt: new Date().toISOString(),
          size: Number(req.file.size || 0),
        };

        const nextQueue = [...queue, nextQueueItem];
        writeSharedQueue(nextQueue);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            item: nextQueueItem,
            queue: nextQueue,
          }),
        );
      } catch (queueError) {
        if (req.file && fs.existsSync(req.file.path))
          fs.unlinkSync(req.file.path);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: queueError.message }));
      }
    });
    return;
  }

  if (
    req.method === "GET" &&
    req.url.startsWith("/inventory/shared-queue-file")
  ) {
    if (!requireClientAccess(req, res)) return;

    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const fileName = sanitizeQueueFileName(
        url.searchParams.get("name") || "",
      );
      const filePath = path.join(SHARED_QUEUE_FILES_DIRECTORY, fileName);

      if (!fileName || !fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ success: false, error: "Queued file not found." }),
        );
        return;
      }

      const fileBuffer = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${path.basename(filePath)}"`,
      });
      res.end(fileBuffer);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/inventory/logs") {
    if (!requireClientAccess(req, res)) return;

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
    if (!requireClientAccess(req, res)) return;

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

server.listen(PORT, HOST, () => {
  console.log(`Shopify server running on http://${HOST}:${PORT}`);
});
