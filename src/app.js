import { createRequire } from "module";
const require = createRequire(import.meta.url);
require('dotenv').config();
const winston = require('winston');
const { combine, timestamp, json, errors } = winston.format;
const axios = require('axios').default;
const sanitizeHtml = require('sanitize-html');
const fs = require('fs').promises;
const express = require('express');
const path = require('path');
import { fileURLToPath } from 'url';

// Instantiate + configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: combine(errors({ stack: true }), timestamp(), json()),
  transports: [new winston.transports.Console()],
});

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get env variables
const shopifyInstance = process.env.SHOPIFY_INSTANCE;
const shopifyApiKey = process.env.SHOPIFY_API_KEY;
const shopifyApiVersion = process.env.SHOPIFY_API_VERSION;
const templateFilename = process.env.TEMPLATE_FILENAME;

const app = express();
const port = 3000;

async function getOrder(orderName) {
  try {
    const response = await axios.get(`https://${shopifyInstance}.myshopify.com/admin/api/${shopifyApiVersion}/orders.json?name=${orderName}&status=any`, {
        headers: {
            'X-Shopify-Access-Token': shopifyApiKey
        }
    })
    .then((res) => {
      if (res?.data?.orders && res?.data?.orders.length && res?.data?.orders?.[0]['note']) {
        return JSON.parse(res?.data?.orders?.[0]['note']);
      } else {
        return false;
      }
    })
    .catch((err) => console.error(err));
    return response;
  } catch (error) {
    console.error(error);
  }
}

async function truncateAndFormatString(input) {
  let truncated = input.length > 185 ? input.slice(0, 185) : input;
  let words = truncated.split(' ');
  let lines = [];
  let currentLine = '';

  words.forEach(word => {
    if ((currentLine + word).length <= 50) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  });

  if (currentLine) {
    lines.push(currentLine);
  }

  lines = lines.slice(0, 4);
  let countofLines = lines.length;
  if (countofLines < 4) {
    for (let i = countofLines; i < 5; i++) {
      lines.push('');
    }
  }

  return lines;
}

async function truncateAndAddComma(input) {
  let truncated = input.slice(0, 45);
  if (truncated.endsWith(',') || truncated.endsWith(':') || truncated.endsWith('!')) {
    truncated = truncated.slice(0, -1);
  }
  truncated += ',';
  return truncated;
}

async function truncateText(input) {
  return input.slice(0, 48);
}

async function replaceTemplateContents(templateContents, messageTo, messageText, messageSignOff, messageFrom) {
  let updatedTemplateContents = templateContents.replace(/%%messageTo%%/g, messageTo);

  for (let i = 1; i <= 4; i++) {
    const placeholder = `%%messageText${i}%%`;
    const text = messageText[i - 1] || '';
    updatedTemplateContents = updatedTemplateContents.replace(new RegExp(placeholder, 'g'), text);
  }

  updatedTemplateContents = updatedTemplateContents.replace(/%%messageSignOff%%/g, messageSignOff);
  updatedTemplateContents = updatedTemplateContents.replace(/%%messageFrom%%/g, messageFrom);

  return updatedTemplateContents;
}

async function getTemplate(filename) {
  try {
    // In AWS Lambda (Netlify Functions), LAMBDA_TASK_ROOT is /var/task
    // SVG files are bundled at /var/task/src/ via netlify.toml included_files
    const basePath = process.env.LAMBDA_TASK_ROOT
      ? path.join(process.env.LAMBDA_TASK_ROOT, 'src')
      : __dirname;
    const templateContents = await fs.readFile(path.join(basePath, filename), 'utf-8');
    return templateContents;
  } catch (error) {
    logger.error('Error reading the file:', error);
  }
}

async function getOrderMessageContent(orderId) {
  let orderMessageContent = {};

  logger.info("Getting order data...");
  let orderNote = await getOrder(orderId);
  if (orderNote) {
    logger.info("Getting order data - DONE.");

    logger.info("Cleansing data...");
    orderMessageContent.messageTo = sanitizeHtml(await truncateText(orderNote.messageTo));
    orderMessageContent.messageText = await truncateAndFormatString(orderNote.messageText);
    for (let i = 0; i < orderMessageContent.messageText.length; i++) {
      orderMessageContent.messageText[i] = sanitizeHtml(orderMessageContent.messageText[i]);
    }
    orderMessageContent.messageSignOff = sanitizeHtml(await truncateText(orderNote.messageSignOff));
    orderMessageContent.messageFrom = sanitizeHtml(await truncateText(orderNote.messageFrom));
    logger.info("Cleansing data - DONE.");

    return orderMessageContent;
  }

  return false;
}

// Serve static files from the 'public/demo-frontend' directory
app.use(express.static(path.join(__dirname, 'public/demo-frontend')));

// Route to send SVG as a file download
app.get('/download-notecard', async (req, res) => {
  const orderName = req?.query?.order_name || req?.query?.order_id || false;

  if (orderName) {
    let orderMessageContent = await getOrderMessageContent(orderName);

    if (orderMessageContent) {
      let templateContents = await getTemplate(templateFilename);
      let svgContent = await replaceTemplateContents(
        templateContents,
        orderMessageContent.messageTo,
        orderMessageContent.messageText,
        orderMessageContent.messageSignOff,
        orderMessageContent.messageFrom
      );

      const fileName = `miraco-notecard-order-${orderName}.svg`;
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.send(svgContent);
      return;
    }
  }

  res.status(404).send('404 Not Found - Order or order note was not found.');
});

// Route to serve a webpage with a link to download the SVG file
app.get('/request-notecard', async (req, res) => {
  const orderName = req?.query?.order_name || req?.query?.order_id || false;

  let notFoundMessage = '';
  if (orderName) {
    let orderMessageContent = await getOrderMessageContent(orderName);
    if (orderMessageContent) {
      const htmlContent = `
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
      `;
      res.send(htmlContent);
      return;
    } else {
      notFoundMessage = `Could not find order <strong>${orderName}</strong>.`;
    }
  }

  res.status(200).send(`
    <html>
    <head><title>Miraco SVG Exporter - Order Note Lookup</title></head>
    <body>
      <h1>Miraco SVG Exporter</h1>
      <form>
        Order Number: <input type="text" name="order_name" value="" />
        <button>Search</button>
      </form>
      <p>${notFoundMessage}</p>
    </body>
    </html>
  `);
});


// Only start the HTTP server when running locally (not in serverless/Netlify)
if (!process.env.VERCEL && !process.env.NETLIFY && !process.env.LAMBDA_TASK_ROOT) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}/`);
  });
}

export { app };

process.on("SIGINT", function() {
  logger.info('Exit.');
  process.exit();
});
