const XLSX = require("xlsx");

const API_VERSION = "2026-01";
const { getShopDomain } = require("./shopify");

function normaliseHeader(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function valueFor(row, acceptedHeaders) {
  const matchingKey = Object.keys(row).find((key) =>
    acceptedHeaders.includes(normaliseHeader(key)),
  );

  return matchingKey === undefined ? "" : row[matchingKey];
}

function parseProductAndSku(value) {
  const match = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!match) return { productName: String(value ?? "").trim(), sku: "" };

  return {
    productName: match[1].trim(),
    sku: match[2].trim(),
  };
}

function parseSpreadsheet(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

  if (!firstSheet) {
    throw new Error("The spreadsheet does not contain a worksheet.");
  }

  const rawRows = XLSX.utils.sheet_to_json(firstSheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  if (!rawRows.length) {
    throw new Error("The first worksheet is empty.");
  }

  const firstRow = rawRows[0].map(normaliseHeader);
  const hasStandardHeaders =
    firstRow.includes("productname") ||
    firstRow.includes("product") ||
    firstRow.includes("name") ||
    firstRow.includes("title") ||
    firstRow.includes("sku") ||
    firstRow.includes("variantsku") ||
    firstRow.includes("quantity") ||
    firstRow.includes("qty") ||
    firstRow.includes("available");
  const spreadsheetRows = hasStandardHeaders
    ? XLSX.utils.sheet_to_json(firstSheet, {
        defval: "",
        // Formatted values preserve SKU leading zeroes when the spreadsheet uses them.
        raw: false,
      })
    : rawRows.map((rawRow) => {
        const cells = rawRow.map((cell) => String(cell ?? "").trim());
        const parsedProduct = parseProductAndSku(cells[0]);
        const hasSeparateSkuColumn = cells.length >= 3 && cells[1] !== "";
        return {
          productName: hasSeparateSkuColumn
            ? cells[0]
            : parsedProduct.productName,
          sku: hasSeparateSkuColumn ? cells[1] : parsedProduct.sku,
          quantity: hasSeparateSkuColumn ? cells[2] : cells[1],
        };
      });

  const rows = [];
  const rejected = [];

  spreadsheetRows.forEach((spreadsheetRow, index) => {
    const rowNumber = index + 2;
    const rawProductName = String(
      valueFor(spreadsheetRow, ["productname", "product", "name", "title"]),
    ).trim();
    const explicitSku = String(
      valueFor(spreadsheetRow, ["sku", "variantsku"]),
    ).trim();
    const embeddedProduct = parseProductAndSku(rawProductName);
    const productName = explicitSku
      ? rawProductName
      : embeddedProduct.productName;
    const sku = explicitSku || embeddedProduct.sku;
    const rawQuantity = valueFor(spreadsheetRow, [
      "quantity",
      "qty",
      "available",
    ]);
    const quantity =
      typeof rawQuantity === "number"
        ? rawQuantity
        : Number(String(rawQuantity).replace(/,/g, "").trim());

    if (!productName || !sku || !Number.isInteger(quantity) || quantity < 0) {
      rejected.push({
        rowNumber,
        productName,
        sku,
        quantity: rawQuantity,
        raw: Object.values(spreadsheetRow).join(" | "),
        error:
          "Each row needs a product name, a SKU, and a whole-number quantity of zero or more.",
      });
      return;
    }

    rows.push({ rowNumber, productName, sku, quantity });
  });

  const skuCounts = rows.reduce((counts, row) => {
    counts[row.sku] = (counts[row.sku] || 0) + 1;
    return counts;
  }, {});
  const validRows = [];

  rows.forEach((row) => {
    if (skuCounts[row.sku] > 1) {
      rejected.push({
        ...row,
        error: "This SKU appears more than once in the spreadsheet.",
      });
      return;
    }

    validRows.push(row);
  });

  return { rows: validRows, rejected, total: spreadsheetRows.length };
}

async function shopifyRequest(query, variables, accessToken) {
  const response = await fetch(
    `https://${getShopDomain()}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const responseText = await response.text();
  let payload;

  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(
      "Shopify returned an unexpected response. Check the SHOPIFY_SHOP environment variable format.",
    );
  }

  if (!response.ok || payload.errors) {
    const apiError = Array.isArray(payload.errors)
      ? payload.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join(" ")
      : "";

    const accessDeniedMessage =
      apiError.includes("Access denied") || apiError.includes("productVariants")
        ? "Shopify access token is missing the required product and inventory scopes. Reinstall the app with read_products, read_locations, and write_inventory permissions."
        : "";

    throw new Error(
      accessDeniedMessage ||
        apiError ||
        `Shopify inventory request failed (HTTP ${response.status}).`,
    );
  }

  return payload.data;
}

async function getInventoryLocation(accessToken) {
  const configuredLocationId = process.env.SHOPIFY_LOCATION_ID;

  if (configuredLocationId) {
    return configuredLocationId;
  }

  const data = await shopifyRequest(
    `query InventoryLocations {
      locations(first: 50) { nodes { id } }
    }`,
    {},
    accessToken,
  );
  // The locations query returns active locations by default.
  const location = data.locations.nodes[0];

  if (!location) {
    throw new Error(
      "No active Shopify location was found. Set the SHOPIFY_LOCATION_ID environment variable.",
    );
  }

  return location.id;
}

async function findVariantBySku(sku, accessToken) {
  const escapedSku = sku.replace(/([\\'\"])/g, "\\$1");
  const data = await shopifyRequest(
    `query VariantBySku($query: String!) {
      productVariants(first: 20, query: $query) {
        nodes { id sku product { title } inventoryItem { id tracked } }
      }
    }`,
    { query: `sku:'${escapedSku}'` },
    accessToken,
  );

  return data.productVariants.nodes.find((variant) => variant.sku === sku);
}

async function setInventoryQuantity(
  inventoryItemId,
  locationId,
  quantity,
  accessToken,
) {
  const data = await shopifyRequest(
    `mutation SetInventoryQuantity($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [{ inventoryItemId, locationId, quantity }],
      },
    },
    accessToken,
  );
  const errors = data.inventorySetQuantities.userErrors;

  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join(" "));
  }
}

async function updateInventoryBySku(rows, accessToken) {
  const locationId = await getInventoryLocation(accessToken);
  const results = [];

  for (const row of rows) {
    try {
      const variant = await findVariantBySku(row.sku, accessToken);

      if (!variant) {
        throw new Error("No Shopify variant matches this SKU.");
      }

      if (!variant.inventoryItem?.tracked) {
        throw new Error("Inventory is not tracked for this Shopify variant.");
      }

      await setInventoryQuantity(
        variant.inventoryItem.id,
        locationId,
        row.quantity,
        accessToken,
      );

      results.push({
        ...row,
        success: true,
        shopifyProductName: variant.product.title,
      });
    } catch (error) {
      results.push({ ...row, success: false, error: error.message });
    }
  }

  return results;
}

module.exports = { parseSpreadsheet, updateInventoryBySku };
