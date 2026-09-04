require("dotenv").config();

const REQUIRED_SCOPES = ["read_products", "read_locations", "write_inventory"];

const CLIENT_ID = (process.env.SHOPIFY_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();

function getShopDomain() {
  const configuredShop = (process.env.SHOPIFY_SHOP || "").trim();

  if (!configuredShop) {
    throw new Error("SHOPIFY_SHOP is not configured.");
  }

  const url = new URL(
    configuredShop.includes("://")
      ? configuredShop
      : `https://${configuredShop}`,
  );
  const hostname = url.hostname.toLowerCase();

  if (hostname.endsWith(".myshopify.com")) {
    return hostname;
  }

  if (hostname.includes(".")) {
    throw new Error(
      "SHOPIFY_SHOP must be the store handle or its exact *.myshopify.com domain, not a custom storefront URL or Shopify Admin URL.",
    );
  }

  return `${hostname}.myshopify.com`;
}

async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET must be set in backend/.env.",
    );
  }

  const response = await fetch(
    `https://${getShopDomain()}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: REQUIRED_SCOPES.join(","),
      }),
    },
  );

  const responseText = await response.text();
  let data;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      "Shopify authentication returned an unexpected response. Check that SHOPIFY_SHOP is your store's myshopify.com domain or store handle.",
    );
  }

  if (!response.ok) {
    console.error("Shopify authentication failed:");
    console.error(data);
    return null;
  }

  const grantedScopes = String(data.scope || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const missingScopes = REQUIRED_SCOPES.filter(
    (scope) => !grantedScopes.includes(scope),
  );

  if (missingScopes.length) {
    throw new Error(
      `Shopify access token is missing required scopes: ${missingScopes.join(", ")}. Reinstall the app with read_products, read_locations, and write_inventory permissions.`,
    );
  }

  console.log("Shopify authentication successful!");
  console.log("Scope:", data.scope);
  console.log("Expires in:", data.expires_in, "seconds");

  return data.access_token;
}

module.exports = {
  getAccessToken,
  getShopDomain,
};
