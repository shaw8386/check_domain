import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import pkg from "pg";
import cron from "node-cron";

const { Pool } = pkg;

/**
 * ENV cần có:
 * - GS_API_URL: URL Web App Apps Script (doGet/doPost)
 * - GS_TOKEN: token secret để auth
 * - DATABASE_URL: Postgres connection string (Railway provides this)
 *
 * Tuỳ chọn:
 * - DEFAULT_MAX_SLOTS: fallback nếu sheet thiếu Max_Slot_try
 * - DEFAULT_MAXTIME_TRY_SECONDS: fallback nếu sheet thiếu Maxtime_try
 * - REQUEST_TIMEOUT_MS: timeout mỗi request (mặc định 15000ms)
 * - MAX_REDIRECT_FIX: giới hạn số lần tự "fix redirect"
 * - CRON_SCHEDULE: cron schedule in server timezone (default: "0 *\/3 * * *" = every 3 hours)
 *   Note: All logs and output use Vietnam time (Asia/Ho_Chi_Minh). Adjust CRON_SCHEDULE based on server timezone.
 */

const GS_API_URL = process.env.GS_API_URL;
const GS_TOKEN = process.env.GS_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const GS_INPUT_SPREADSHEET_ID = process.env.GS_INPUT_SPREADSHEET_ID;
const GS_OUTPUT_SPREADSHEET_ID = process.env.GS_OUTPUT_SPREADSHEET_ID;
const DEFAULT_MAX_SLOTS = parseInt(process.env.DEFAULT_MAX_SLOTS || "3", 10);
const DEFAULT_MAXTIME_TRY_SECONDS = parseInt(process.env.DEFAULT_MAXTIME_TRY_SECONDS || "10", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "5000", 10);
const MAX_REDIRECT_FIX = parseInt(process.env.MAX_REDIRECT_FIX || "3", 10);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 */3 * * *"; // Every 3 hours

if (!GS_API_URL || !GS_TOKEN) {
  console.error("Missing GS_API_URL or GS_TOKEN env");
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL env");
  process.exit(1);
}

// Spreadsheet IDs are optional if set in Apps Script properties, but recommended to set here
// Note: These warnings appear before timezone functions are defined, so they use server time
if (!GS_INPUT_SPREADSHEET_ID) {
  console.warn("Warning: GS_INPUT_SPREADSHEET_ID not set. Will rely on Apps Script properties.");
}

if (!GS_OUTPUT_SPREADSHEET_ID) {
  console.warn("Warning: GS_OUTPUT_SPREADSHEET_ID not set. Will rely on Apps Script properties.");
}

// Initialize Postgres connection pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

const VIETNAM_TIMEZONE = "Asia/Ho_Chi_Minh";

/**
 * Get date/time parts in Vietnam timezone
 */
function getVietnamDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: VIETNAM_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

/**
 * Get current date/time as Date object representing Vietnam time
 * Note: This creates a Date object that represents the same moment in Vietnam time
 */
function getVietnamDate(date = new Date()) {
  const parts = getVietnamDateParts(date);
  // Create a date string in ISO format and parse it
  // Vietnam is UTC+7, so we create a UTC date that represents the Vietnam time
  const vnDateString = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  // Parse as if it's UTC+7, then convert to actual Date
  const utcDate = new Date(vnDateString + "+07:00");
  return utcDate;
}

/**
 * Format date to ISO string in Vietnam timezone
 * Returns: YYYY-MM-DDTHH:mm:ss+07:00 format
 */
function getVietnamISOString(date = new Date()) {
  const parts = getVietnamDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+07:00`;
}

/**
 * Format date for logging in Vietnam timezone
 * Returns: YYYY-MM-DD HH:mm:ss (VN)
 */
function getVietnamLogTime(date = new Date()) {
  const parts = getVietnamDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (VN)`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Parse proxy string from sheet column `Proxy_IP_PORT_USER_PASS`.
 *
 * Hỗ trợ các format phổ biến:
 * 1) ip:port:user:pass
 * 2) user:pass@ip:port
 * 3) http://user:pass@ip:port
 * 4) https://user:pass@ip:port
 *
 * Return: proxyUrl (string) hoặc null
 */
function parseProxy(proxyRaw) {
  if (!proxyRaw) return null;
  const s = String(proxyRaw).trim();
  if (!s) return null;

  // already a url
  if (s.startsWith("http://") || s.startsWith("https://")) return s;

  // user:pass@ip:port
  if (s.includes("@") && s.includes(":")) {
    return "http://" + s; // default http proxy scheme
  }

  // ip:port:user:pass  (4 parts)
  const parts = s.split(":");
  if (parts.length === 4) {
    const [ip, port, user, pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${ip}:${port}`;
  }

  // ip:port (no auth)
  if (parts.length === 2) {
    const [ip, port] = parts;
    return `http://${ip}:${port}`;
  }

  // fallback: treat as host:port or raw
  return "http://" + s;
}

function normalizeDomain(domainRaw) {
  const d = String(domainRaw || "").trim();
  if (!d) return "";
  // nếu người dùng nhập full url, tách host
  try {
    if (d.startsWith("http://") || d.startsWith("https://")) {
      const u = new URL(d);
      return u.host;
    }
  } catch {}
  return d;
}

/**
 * Generate target URLs to try.
 * Ưu tiên HTTPS trước, rồi HTTP; thử thêm/bớt www nếu cần.
 */
function buildCandidateUrls(domain) {
  const host = normalizeDomain(domain);
  if (!host) return [];

  const hasWww = host.startsWith("www.");
  const bare = hasWww ? host.slice(4) : host;
  const withWww = hasWww ? host : `www.${host}`;

  // ưu tiên dạng host gốc trước, sau đó biến thể
  const hosts = [host];
  if (host !== bare) hosts.push(bare);
  if (host !== withWww) hosts.push(withWww);

  const urls = [];
  for (const h of hosts) {
    urls.push(`https://${h}`);
    urls.push(`http://${h}`);
  }

  // loại trùng
  return [...new Set(urls)];
}

/**
 * “Xử lí lỗi theo status”:
 * - Tuỳ theo status/failure type, điều chỉnh headers, url list, delay...
 */
function getFixPlan({ status, errorCode, currentUrl, domain, redirectLocation }) {
  const plan = {
    extraDelayMs: 0,
    headers: null,
    nextUrls: []
  };

  // Base “browser-like” headers (đặc biệt hữu ích với 403/406)
  const browserHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
  };

  // Nếu lỗi timeout / network
  if (errorCode === "ETIMEDOUT" || errorCode === "ECONNABORTED") {
    plan.extraDelayMs = 2000;
    plan.headers = browserHeaders;
    plan.nextUrls = [currentUrl]; // try same
    return plan;
  }

  // 429: rate limit -> chờ lâu hơn
  if (status === 429) {
    plan.extraDelayMs = 10000;
    plan.headers = browserHeaders;
    plan.nextUrls = [currentUrl];
    return plan;
  }

  // 403/406: thử “browser-like” headers
  if (status === 403 || status === 406) {
    plan.extraDelayMs = 3000;
    plan.headers = browserHeaders;
    plan.nextUrls = [currentUrl];
    return plan;
  }

  // 404: thử biến thể www và http/https
  if (status === 404) {
    plan.headers = browserHeaders;
    plan.nextUrls = buildCandidateUrls(domain);
    return plan;
  }

  // 3xx: vì bạn muốn 3xx là FAIL, nhưng “xử lí” bằng cách thử Location
  if (status >= 300 && status <= 399 && redirectLocation) {
    // if Location là relative, resolve
    try {
      const resolved = new URL(redirectLocation, currentUrl).toString();
      plan.nextUrls = [resolved];
    } catch {
      plan.nextUrls = [currentUrl];
    }
    plan.headers = browserHeaders;
    return plan;
  }

  // 5xx: lỗi server -> backoff nhẹ, thử lại
  if (status >= 500 && status <= 599) {
    plan.extraDelayMs = 4000;
    plan.headers = browserHeaders;
    plan.nextUrls = [currentUrl];
    return plan;
  }

  // Default: retry same with browser headers
  plan.headers = browserHeaders;
  plan.nextUrls = [currentUrl];
  return plan;
}

/**
 * Single HTTP check attempt.
 * SUCCESS only if status === 200
 * For redirect handling: we keep maxRedirects=0 để bắt 3xx và xử lí theo Location.
 */
async function checkOnce({ url, proxyUrl, headers }) {
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  const res = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
    maxRedirects: 0, // quan trọng: bắt 3xx, tự xử lí “fix”
    headers: headers || {
      "User-Agent": "Railway-Proxy-HTTP-Checker/1.0",
      "Accept": "*/*"
    },
    httpsAgent: agent,
    httpAgent: agent
  });

  return {
    status: res.status,
    redirectLocation: res.headers?.location || null
  };
}

/**
 * Read input from Apps Script:
 * GET {GS_API_URL}?action=input&token=...&inputSpreadsheetId=...
 * Expect: { ok:true, rows:[{Domain,...}] }
 */
async function getInputRows() {
  let url = `${GS_API_URL}?action=input&token=${encodeURIComponent(GS_TOKEN)}`;

  if (GS_INPUT_SPREADSHEET_ID) {
    url += `&inputSpreadsheetId=${encodeURIComponent(GS_INPUT_SPREADSHEET_ID)}`;
  }

  console.log(`[${getVietnamLogTime()}] GS GET: ${url.replace(GS_TOKEN, "***")}`);

  try {
    const res = await axios.get(url, {
      timeout: 20000,
      // tránh cache + dễ debug
      headers: { "Cache-Control": "no-cache" }
    });

    console.log(`[${getVietnamLogTime()}] GS status=${res.status} data=${JSON.stringify(res.data)}`);

    if (!res.data || res.data.ok !== true) {
      throw new Error(`GS input error: ${res.data?.error || "empty/invalid response"}`);
    }
    return res.data.rows || [];
  } catch (err) {
    // axios error details
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error(`[${getVietnamLogTime()}] GS request failed status=${status} data=${JSON.stringify(data)} err=${err?.message}`);
    throw err;
  }
}

/**
 * Initialize database schema
 */
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS domain_checks (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        isp VARCHAR(255),
        dns VARCHAR(255),
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status_http VARCHAR(10),
        status_final VARCHAR(10) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_domain_checks_domain ON domain_checks(domain);
      CREATE INDEX IF NOT EXISTS idx_domain_checks_update_time ON domain_checks(update_time);
    `);
    console.log(`[${getVietnamLogTime()}] Database schema initialized`);
  } catch (error) {
    console.error(`[${getVietnamLogTime()}] Error initializing database:`, error);
    throw error;
  }
}

/**
 * Save result to Postgres database
 */
async function saveToDatabase(result) {
  try {
    // Use Vietnam time for database timestamp
    const vnDate = getVietnamDate();
    await pool.query(
      `INSERT INTO domain_checks (domain, isp, dns, update_time, status_http, status_final)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        result.Domain || "",
        result.ISP || "",
        result.DNS || "",
        vnDate,
        result.StatusHTTP ? String(result.StatusHTTP) : "",
        result.StatusFinal || "FAIL"
      ]
    );
  } catch (error) {
    console.error(`[${getVietnamLogTime()}] Error saving to database for domain ${result.Domain}:`, error);
    // Don't throw - continue processing other rows
  }
}

/**
 * Write output to Apps Script:
 * POST {action:"output", token, outputSpreadsheetId, sheetName, headers, data}
 */
async function postOutput(sheetName, data) {
  const payload = {
    action: "output",
    token: GS_TOKEN,
    sheetName,
    headers: [
      "Domain",
      "ISP",
      "DNS",
      "Update",
      "StatusHTTP",
      "StatusFinal"
    ],
    data: data.map(row => ({
      Domain: row.Domain || "",
      ISP: row.ISP || "",
      DNS: row.DNS || "",
      Update: getVietnamISOString(),
      StatusHTTP: row.StatusHTTP ? String(row.StatusHTTP) : "",
      StatusFinal: row.StatusFinal || "FAIL"
    }))
  };

  // Add output spreadsheet ID if provided
  if (GS_OUTPUT_SPREADSHEET_ID) {
    payload.outputSpreadsheetId = GS_OUTPUT_SPREADSHEET_ID;
  }

  const res = await axios.post(GS_API_URL, payload, { timeout: 30000 });
  if (!res.data?.ok) throw new Error(res.data?.error || "GS output error");
  return res.data;
}

/**
 * Name output sheet: HH:mm_MM/DD/YYYY theo Asia/Ho_Chi_Minh
 */
function vnSheetName(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: VIETNAM_TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  })
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.hour}:${parts.minute}_${parts.month}/${parts.day}/${parts.year}`;
}

/**
 * Main per-row process:
 * - Try candidates
 * - SUCCESS only if status 200
 * - Retry Max_Slot_try times
 * - Delay between retries: Maxtime_try + 5s (+ extra delay from fixPlan)
 * - Each retry must apply “fix plan” based on last fail status
 */
async function processRow(row) {
  const domain = String(row.Domain || "").trim();
  const proxyRaw = row.Proxy_IP_PORT_USER_PASS;
  const proxyUrl = parseProxy(proxyRaw);

  const isp = row.ISP ?? "";
  const dns = row.DNS ?? "";

  const maxSlots = parseInt(row.Max_Slot_try || DEFAULT_MAX_SLOTS, 10);
  const maxTimeTrySec = parseInt(row.Maxtime_try || DEFAULT_MAXTIME_TRY_SECONDS, 10);
  // Nếu Maxtime_try đang là milliseconds, đổi dòng dưới thành: const baseDelayMs = maxTimeTrySec + 5000;
  const baseDelayMs = maxTimeTrySec * 1000 + 5000;

  const candidates = buildCandidateUrls(domain);
  if (!domain || candidates.length === 0) {
    return {
      ...row,
      StatusHTTP: "",
      StatusFinal: "FAIL",
      TriedCount: 0,
      LastURL: ""
    };
  }

  let tried = 0;
  let lastStatus = "";
  let lastUrl = candidates[0];
  let statusFinal = "FAIL";

  // vòng retry slots
  let currentUrl = candidates[0];
  let currentHeaders = null;

  // để “xử lí redirect” nhiều bước nhưng vẫn nằm trong 1 slot:
  let redirectFixCount = 0;

  for (let slot = 1; slot <= maxSlots; slot++) {
    tried = slot;

    try {
      const result = await checkOnce({
        url: currentUrl,
        proxyUrl,
        headers: currentHeaders
      });

      lastStatus = result.status;
      lastUrl = currentUrl;

      // SUCCESS only when 200
      if (result.status === 200) {
        statusFinal = "SUCCESS";
        break;
      }

      // FAIL: xử lí theo status
      const fixPlan = getFixPlan({
        status: result.status,
        errorCode: null,
        currentUrl,
        domain,
        redirectLocation: result.redirectLocation
      });

      // special: redirect fix limited
      if (result.status >= 300 && result.status <= 399 && result.redirectLocation) {
        redirectFixCount += 1;
        if (redirectFixCount > MAX_REDIRECT_FIX) {
          // quá nhiều redirect “fix” -> cứ coi là fail bình thường và đi retry slot tiếp
          redirectFixCount = 0;
        } else if (fixPlan.nextUrls?.length) {
          // thử URL location trong lần slot kế tiếp
          currentUrl = fixPlan.nextUrls[0];
        }
      } else {
        redirectFixCount = 0;
      }

      if (fixPlan.headers) currentHeaders = fixPlan.headers;

      // chọn next url nếu fixPlan đề xuất (vd 404)
      if (fixPlan.nextUrls?.length) {
        // ưu tiên URL khác current nếu có
        const pick = fixPlan.nextUrls.find((u) => u !== currentUrl) || fixPlan.nextUrls[0];
        currentUrl = pick;
      }

      // delay trước khi retry slot tiếp theo
      const waitMs = baseDelayMs + (fixPlan.extraDelayMs || 0);
      if (slot < maxSlots) await sleep(waitMs);
    } catch (err) {
      const msg = String(err?.message || err);
      const code = err?.code || null;

      lastStatus = ""; // không có HTTP status
      lastUrl = currentUrl;

      // xử lí theo error
      const fixPlan = getFixPlan({
        status: null,
        errorCode: code,
        currentUrl,
        domain,
        redirectLocation: null
      });

      if (fixPlan.headers) currentHeaders = fixPlan.headers;
      if (fixPlan.nextUrls?.length) currentUrl = fixPlan.nextUrls[0];

      const waitMs = baseDelayMs + (fixPlan.extraDelayMs || 0);
      if (slot < maxSlots) await sleep(waitMs);

      // vẫn tiếp tục retry cho tới slot cuối
      if (slot === maxSlots) {
        // final FAIL
        statusFinal = "FAIL";
      }

      // ghi log ra console để Railway log
      console.error(`[${getVietnamLogTime()}] [FAIL] domain=${domain} slot=${slot}/${maxSlots} url=${currentUrl} proxy=${proxyUrl ? "YES" : "NO"} err=${msg}`);
    }
  }

  return {
    Domain: domain,
    Proxy_IP_PORT_USER_PASS: proxyRaw ?? "",
    ISP: isp,
    DNS: dns,
    Maxtime_try: row.Maxtime_try ?? "",
    Max_Slot_try: row.Max_Slot_try ?? "",
    StatusHTTP: lastStatus,
    StatusFinal: statusFinal,
    TriedCount: tried,
    LastURL: lastUrl
  };
}

async function main() {
  console.log(`[${getVietnamLogTime()}] Starting domain check process...`);
  
  try {
    const rows = await getInputRows();
    console.log(`[${getVietnamLogTime()}] Retrieved ${rows.length} rows from Google Sheets`);

    const output = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`[${getVietnamLogTime()}] Processing row ${i + 1}/${rows.length}: ${row.Domain || "N/A"}`);
      
      const r = await processRow(row);
      output.push(r);
      
      // Save to database
      await saveToDatabase(r);
    }

    const sheetName = vnSheetName(getVietnamDate());
    await postOutput(sheetName, output);

    console.log(`[${getVietnamLogTime()}] DONE outputSheet=${sheetName} rows=${output.length}`);
  } catch (error) {
    console.error(`[${getVietnamLogTime()}] Error in main process:`, error);
    throw error;
  }
}

// Initialize database and start scheduled job
async function start() {
  try {
    await initDatabase();
    console.log(`[${getVietnamLogTime()}] Database initialized successfully`);
    
    // Run immediately on startup (optional - remove if you only want scheduled runs)
    await main();
    
    // Schedule job to run every 3 hours (in server timezone, but logs will show Vietnam time)
    // Note: Cron runs in server timezone. To run at specific Vietnam times, adjust CRON_SCHEDULE
    // Example: "0 0,3,6,9,12,15,18,21 * * *" runs at 00:00, 03:00, 06:00, etc. in server timezone
    // If server is UTC, add 7 hours to get Vietnam time (e.g., "0 7,10,13,16,19,22,1,4 * * *" for Vietnam 00:00, 03:00, etc.)
    console.log(`[${getVietnamLogTime()}] Scheduling job with cron: ${CRON_SCHEDULE} (server timezone)`);
    console.log(`[${getVietnamLogTime()}] Current Vietnam time: ${getVietnamLogTime()}`);
    
    cron.schedule(CRON_SCHEDULE, async () => {
      console.log(`[${getVietnamLogTime()}] Scheduled job triggered`);
      try {
        await main();
      } catch (error) {
        console.error(`[${getVietnamLogTime()}] Scheduled job error:`, error);
      }
    });
    
    console.log(`[${getVietnamLogTime()}] Scheduler started. Waiting for next scheduled run...`);
    
    // Keep process alive
    process.on("SIGTERM", async () => {
      console.log(`[${getVietnamLogTime()}] SIGTERM received, closing database pool...`);
      await pool.end();
      process.exit(0);
    });
    
    process.on("SIGINT", async () => {
      console.log(`[${getVietnamLogTime()}] SIGINT received, closing database pool...`);
      await pool.end();
      process.exit(0);
    });
  } catch (error) {
    console.error(`[${getVietnamLogTime()}] Error starting application:`, error);
    process.exit(1);
  }
}

start();
