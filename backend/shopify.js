require("dotenv").config();

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

async function getAccessToken() {
  const response = await fetch(
    `https://${SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    console.error("Shopify authentication failed:");
    console.error(data);
    return null;
  }

  console.log("Shopify authentication successful!");
  console.log("Scope:", data.scope);
  console.log("Expires in:", data.expires_in, "seconds");

  return data.access_token;
}

module.exports = {
  getAccessToken,
};
