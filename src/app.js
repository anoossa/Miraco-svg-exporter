import dotenv from "dotenv";
dotenv.config();

import winston from "winston";
import axios from "axios";
import sanitizeHtml from "sanitize-html";
import { promises as fs } from "fs";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const { combine, timestamp, json, errors } = winston.format;

const logger = winston.createLogger({
  level: "info",
  format: combine(errors({ stack: true }), timestamp(), json()),
  transports: [new winston.transports.Console()],
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const shopifyInstance = process.env.SHOPIFY_INSTANCE;
const shopifyApiKey = process.env.SHOPIFY_API_KEY;
const shopifyApiVersion = process.env.SHOPIFY_API_VERSION;
const shopifyClientId = process.env.SHOPIFY_CLIENT_ID;
const shopifyClientSecret = process.env.SHOPIFY_CLIENT_SECRET;
const templateFilename = process.env.TEMPLATE_FILENAME;

const app = express();
const port = 3000;

// Serve static files — from root /public in production, from ../public locally
app.use(express.static(path.join(__dirname, "../public")));

async function getOrder(orderName) {
  try {
    const res = await axios.post(
      `https://${shopifyInstance}/admin/api/${shopifyApiVersion}/graphql.json`,
      {
        query: `query getOrder($query: String!) {
          orders(first: 1, query: $query) {
            edges {
              node {
                note
                name
              }
            }
          }
        }`,
        variables: { query: `name:${orderName}` },
      },
      {
        headers: { "X-Shopify-Access-Token": shopifyApiKey, "Content-Type": "application/json" },
        timeout: 8000,
      },
    );

    logger.info({ graphqlResponse: JSON.stringify(res.data) });

    const order = res?.data?.data?.orders?.edges?.[0]?.node;
    if (order?.note) {
      return JSON.parse(order.note);
    }
    return false;
  } catch (error) {
    logger.error({ message: error.message, response: error.response?.data });
    return false;
  }
}

async function truncateAndFormatString(input) {
  let truncated = input.length > 185 ? input.slice(0, 185) : input;
  let words = truncated.split(" ");
  let lines = [];
  let currentLine = "";

  words.forEach((word) => {
    if ((currentLine + word).length <= 50) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  });

  if (currentLine) lines.push(currentLine);

  lines = lines.slice(0, 4);
  while (lines.length < 4) lines.push("");

  return lines;
}

async function truncateText(input) {
  return input.slice(0, 48);
}

async function replaceTemplateContents(
  templateContents,
  messageTo,
  messageText,
  messageSignOff,
  messageFrom,
) {
  let out = templateContents.replace(/%%messageTo%%/g, messageTo);

  for (let i = 1; i <= 4; i++) {
    out = out.replace(
      new RegExp(`%%messageText${i}%%`, "g"),
      messageText[i - 1] || "",
    );
  }

  out = out.replace(/%%messageSignOff%%/g, messageSignOff);
  out = out.replace(/%%messageFrom%%/g, messageFrom);

  return out;
}

async function getTemplate(filename) {
  // In Vercel/Lambda the project root is the working directory
  const basePath =
    process.env.VERCEL || process.env.LAMBDA_TASK_ROOT
      ? path.join(process.cwd(), "src")
      : __dirname;
  return fs.readFile(path.join(basePath, filename), "utf-8");
}

async function getOrderMessageContent(orderName) {
  logger.info("Getting order data...");
  const orderNote = await getOrder(orderName);
  if (!orderNote) return false;

  logger.info("Cleansing data...");
  const messageText = await truncateAndFormatString(orderNote.messageText);

  return {
    messageTo: sanitizeHtml(await truncateText(orderNote.messageTo)),
    messageText: messageText.map((line) => sanitizeHtml(line)),
    messageSignOff: sanitizeHtml(await truncateText(orderNote.messageSignOff)),
    messageFrom: sanitizeHtml(await truncateText(orderNote.messageFrom)),
  };
}

// ── Shopify OAuth (run once to get access token) ──────────────────────────────

app.get("/auth", (req, res) => {
  const shop = req.query.shop || shopifyInstance;
  const redirectUri = process.env.SHOPIFY_REDIRECT_URI || `${req.protocol}://${req.get("host")}/auth/callback`;
  const scopes = "read_orders";
  const state = crypto.randomBytes(16).toString("hex");

  res.cookie("shopify_oauth_state", state, { httpOnly: true });
  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${shopifyClientId}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state, shop, hmac } = req.query;

  // Validate HMAC
  const params = Object.fromEntries(
    Object.entries(req.query).filter(([k]) => k !== "hmac"),
  );
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const digest = crypto
    .createHmac("sha256", shopifyClientSecret)
    .update(message)
    .digest("hex");

  if (digest !== hmac) {
    return res.status(400).send("Invalid HMAC — request could not be verified.");
  }

  try {
    const tokenRes = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      { client_id: shopifyClientId, client_secret: shopifyClientSecret, code },
    );
    const accessToken = tokenRes.data.access_token;
    res.send(`
      <html><body>
        <h2>Access token obtained successfully!</h2>
        <p>Add this to your <code>.env</code> as <code>SHOPIFY_API_KEY</code>:</p>
        <pre style="background:#f4f4f4;padding:12px;font-size:1.1rem">${accessToken}</pre>
        <p>Then restart the app — you won't need to do this again.</p>
      </body></html>
    `);
  } catch (error) {
    logger.error(error);
    res.status(500).send("Failed to exchange code for access token.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────

app.get("/download-notecard", async (req, res) => {
  try {
    const orderName = req.query.order_name || req.query.order_id || false;

    if (orderName) {
      const orderMessageContent = await getOrderMessageContent(orderName);
      if (orderMessageContent) {
        const templateContents = await getTemplate(templateFilename);
        const svgContent = await replaceTemplateContents(
          templateContents,
          orderMessageContent.messageTo,
          orderMessageContent.messageText,
          orderMessageContent.messageSignOff,
          orderMessageContent.messageFrom,
        );

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="miraco-notecard-order-${orderName}.svg"`,
        );
        res.setHeader("Content-Type", "image/svg+xml");
        res.send(svgContent);
        return;
      }
    }

    res.status(404).send("404 Not Found - Order or order note was not found.");
  } catch (error) {
    logger.error({ message: error.message, stack: error.stack });
    res.status(500).send(`Server error: ${error.message}`);
  }
});

app.get("/request-notecard", async (req, res) => {
  const orderName = req.query.order_name || req.query.order_id || false;

  if (orderName) {
    const orderMessageContent = await getOrderMessageContent(orderName);
    if (orderMessageContent) {
      res.send(`
        <html>
          <head>
            <title>Miraco SVG Exporter - Order ${orderName}</title>
            <style>
              table { width: 550px; }
              tr, td { padding: 10px; border: 1px solid #999; }
              .field-title { text-align: right; margin-right: 20px; }
              .download-link { font-size: 1.5rem; }
            </style>
          </head>
          <body>
            <h1>Miraco SVG Exporter</h1>
            <form>
              Order Number: <input type="text" name="order_name" value="${orderName}" />
              <button>Search</button>
            </form>
            <p>Found the following content for <b>Order ${orderName}</b>:<br />&nbsp;</p>
            <table>
              <tr><th>Field</th><th>Content</th></tr>
              <tr><td class="field-title">To</td><td>${orderMessageContent.messageTo}</td></tr>
              <tr><td class="field-title">Message Line 1</td><td>${orderMessageContent.messageText[0]}</td></tr>
              <tr><td class="field-title">Message Line 2</td><td>${orderMessageContent.messageText[1]}</td></tr>
              <tr><td class="field-title">Message Line 3</td><td>${orderMessageContent.messageText[2]}</td></tr>
              <tr><td class="field-title">Message Line 4</td><td>${orderMessageContent.messageText[3]}</td></tr>
              <tr><td class="field-title">Sign Off</td><td>${orderMessageContent.messageSignOff}</td></tr>
              <tr><td class="field-title">From</td><td>${orderMessageContent.messageFrom}</td></tr>
            </table>
            <p class="download-link">
              <a href="/download-notecard?order_name=${orderName}" download="miraco-notecard-order-${orderName}.svg">Download SVG File</a>
            </p>
          </body>
        </html>
      `);
      return;
    }

    res.status(200).send(`
      <html><head><title>Miraco SVG Exporter</title></head>
      <body>
        <h1>Miraco SVG Exporter</h1>
        <form>Order Number: <input type="text" name="order_name" value="" /><button>Search</button></form>
        <p>Could not find order <strong>${orderName}</strong>.</p>
      </body></html>
    `);
    return;
  }

  res.status(200).send(`
    <html><head><title>Miraco SVG Exporter</title></head>
    <body>
      <h1>Miraco SVG Exporter</h1>
      <form>Order Number: <input type="text" name="order_name" value="" /><button>Search</button></form>
    </body></html>
  `);
});

if (!process.env.VERCEL && !process.env.LAMBDA_TASK_ROOT) {
  app.listen(port, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${port}/`);
  });
}

export { app };
export default app;

process.on("SIGINT", () => {
  logger.info("Exit.");
  process.exit();
});
