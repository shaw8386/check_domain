import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import pkg from 'pg';
import axios from 'axios';
import * as cheerio from 'cheerio';

const { Pool } = pkg;

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Railway thường dùng DATABASE_URL (postgres://user:pass@host:port/db)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false }
});

// ====== INIT DB (DDL) ======

async function initDb() {
  // regions
  await pool.query(`
    CREATE TABLE IF NOT EXISTS regions (
      id SERIAL PRIMARY KEY,
      code VARCHAR(10) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL
    );
  `);

  // lottery_provinces
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lottery_provinces (
      id SERIAL PRIMARY KEY,
      region_id INTEGER NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
      code VARCHAR(10) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL
    );
  `);

  // lottery_draws
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lottery_draws (
      id SERIAL PRIMARY KEY,
      draw_date DATE NOT NULL,
      province_id INTEGER NOT NULL REFERENCES lottery_provinces(id) ON DELETE RESTRICT,
      region_id INTEGER NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (draw_date, province_id)
    );
  `);

  // lottery_results
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lottery_results (
      id SERIAL PRIMARY KEY,
      draw_id INTEGER NOT NULL REFERENCES lottery_draws(id) ON DELETE CASCADE,
      prize_code VARCHAR(20) NOT NULL,
      prize_order INTEGER NOT NULL,
      result_number TEXT NOT NULL
    );
  `);

  // auth_accept
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_accept (
      id SERIAL PRIMARY KEY,
      client_id TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      ip_address TEXT,
      user_agent TEXT,
      scopes TEXT, -- JSON string (e.g. '["read","write"]')
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMP,
      is_active BOOLEAN NOT NULL DEFAULT TRUE
    );
  `);

  await seedRegionsAndProvinces();
}

// ====== CRAWL MINH NGỌC - HELPERS ======

// Tạo danh sách ngày gần nhất, n ngày
function getLastNDaysDates(n = 100) {
  const dates = [];
  const today = new Date();

  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);

    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();

    dates.push({
      display: `${dd}-${mm}-${yyyy}`, // dùng cho URL Minh Ngọc
      iso: `${yyyy}-${mm}-${dd}` // dùng để lưu DB (DATE)
    });
  }

  return dates;
}

const REGION_SLUGS = {
  MB: 'mien-bac',
  MT: 'mien-trung',
  MN: 'mien-nam'
};

// Map tên tỉnh trên Minh Ngọc -> code tỉnh trong DB
const MINH_NGOC_PROVINCE_NAME_MAP = {
  // Miền Nam
  'TP.HCM': 'HCM',
  'TP Hồ Chí Minh': 'HCM',
  'TP Ho Chi Minh': 'HCM',
  'An Giang': 'AG',
  'Bạc Liêu': 'BL',
  'Bình Dương': 'BDI',
  'Bình Phước': 'BP',
  'Bình Thuận': 'BTH',
  'Bà Rịa Vũng Tàu': 'BRVT',
  'Bà Rịa - Vũng Tàu': 'BRVT',
  'Bến Tre': 'BTR',
  'Cà Mau': 'CM',
  'Cần Thơ': 'CT',
  'Đà Lạt': 'DL',
  'Đồng Nai': 'DNM',
  'Đồng Tháp': 'DT',
  'Hậu Giang': 'HG',
  'Kiên Giang': 'KG',
  'Long An': 'LA',
  'Sóc Trăng': 'ST',
  'Tây Ninh': 'TN',
  'Tiền Giang': 'TG',
  'Trà Vinh': 'TV',
  'Vĩnh Long': 'VL',
  // Miền Trung
  'Đà Nẵng': 'DN',
  'Quảng Bình': 'QB',
  'Quảng Trị': 'QT',
  'Thừa Thiên Huế': 'TTH',
  'Khánh Hòa': 'KH',
  'Bình Định': 'BD',
  'Ninh Thuận': 'NT',
  'Phú Yên': 'BPY',
  'Gia Lai': 'GL',
  'Đắk Lắk': 'DK',
  'Đắk Nông': 'DNO',
  'Quảng Nam': 'QNA',
  'Quảng Ngãi': 'QTN',
  // Miền Bắc
  'Hà Nội': 'HN',
  'Hải Phòng': 'HP',
  'Quảng Ninh': 'QN',
  'Thái Bình': 'TB',
  'Bắc Ninh': 'BN',
  'Nam Định': 'ND',
  'Phú Thọ': 'PT',
  'Thanh Hóa': 'TH',
  'Nghệ An': 'NA',
  'Bắc Giang': 'BDH',
  'Hà Nam': 'HNA',
  'Hưng Yên': 'HDU'
};

async function fetchMinhNgocHtml(regionSlug, dateDisplay) {
  const url = `https://www.minhngoc.net.vn/ket-qua-xo-so/${regionSlug}/${dateDisplay}.html`;
  console.log('Fetching:', url);

  const res = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    },
    timeout: 15000
  });

  return res.data;
}

// Chuẩn hóa tên giải -> mã giải
function normalizePrizeCode(label, regionCode) {
  const l = label.toLowerCase();

  if (l.includes('đặc biệt') || l.includes('dac biet')) return 'DB';
  if (l.includes('nhất') || l.includes('nhat')) return 'G1';
  if (l.includes('nhì') || l.includes('nhi')) return 'G2';
  if (l.includes('ba')) return 'G3';
  if (l.includes('tư') || l.includes('tu')) return 'G4';
  if (l.includes('năm') || l.includes('nam')) return 'G5';
  if (l.includes('sáu') || l.includes('sau')) return 'G6';
  if (l.includes('bảy') || l.includes('bay')) return 'G7';
  if (l.includes('tám') || l.includes('tam')) return 'G8';

  // Có thể có các giải phụ khác, bạn bổ sung thêm nếu cần
  return null;
}

/**
 * Parse HTML Minh Ngọc thành:
 * [
 *   {
 *     provinceName: 'TP Hồ Chí Minh',
 *     prizes: [
 *       { prize_code: 'DB', numbers: ['123456'] },
 *       { prize_code: 'G1', numbers: ['98765'] },
 *       ...
 *     ]
 *   },
 *   ...
 * ]
 */
function parseMinhNgocHtml(html, regionCode) {
  const $ = cheerio.load(html);
  const result = [];

  // Cấu trúc Minh Ngọc có thể thay đổi, ở đây chọn cách parse tương đối generic.
  $('table').each((_, table) => {
    const $table = $(table);

    const headerText = $table.find('thead th, thead td').first().text().trim();
    if (!headerText) return;

    const provinceName = headerText
      .replace('Kết quả xổ số', '')
      .replace('Xổ số', '')
      .trim();

    if (!provinceName) return;

    const prizeMap = new Map();

    $table.find('tbody tr').each((__, row) => {
      const $cells = $(row).find('td');
      if ($cells.length < 2) return;

      const rawPrize = $cells.eq(0).text().trim();
      const rawNumbers = $cells.eq(1).text().trim();

      if (!rawPrize || !rawNumbers) return;

      const prizeCode = normalizePrizeCode(rawPrize, regionCode);
      const numbers = rawNumbers
        .split('-')
        .map(s => s.trim())
        .filter(Boolean);

      if (!prizeCode || numbers.length === 0) return;

      if (!prizeMap.has(prizeCode)) {
        prizeMap.set(prizeCode, []);
      }
      prizeMap.get(prizeCode).push(...numbers);
    });

    if (prizeMap.size === 0) return;

    const prizes = [];
    for (const [prize_code, numbers] of prizeMap.entries()) {
      prizes.push({ prize_code, numbers });
    }

    result.push({ provinceName, prizes });
  });

  return result;
}

async function saveCrawledDayRegionToDb(regionCode, dateObj, parsedList) {
  if (!parsedList || parsedList.length === 0) return;

  const regionRes = await pool.query('SELECT id FROM regions WHERE code = $1', [regionCode]);
  if (regionRes.rowCount === 0) return;
  const regionId = regionRes.rows[0].id;

  const clientDb = await pool.connect();
  try {
    await clientDb.query('BEGIN');

    for (const item of parsedList) {
      const mappedCode = MINH_NGOC_PROVINCE_NAME_MAP[item.provinceName];
      if (!mappedCode) {
        console.log('Không map được tỉnh:', item.provinceName, 'region', regionCode);
        continue;
      }

      const provRes = await clientDb.query(
        'SELECT id FROM lottery_provinces WHERE code = $1 AND region_id = $2 LIMIT 1;',
        [mappedCode, regionId]
      );
      if (provRes.rowCount === 0) {
        console.log('Không tìm thấy tỉnh trong DB:', mappedCode, item.provinceName);
        continue;
      }
      const provinceId = provRes.rows[0].id;

      const drawRes = await clientDb.query(
        `
        INSERT INTO lottery_draws (draw_date, province_id, region_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (draw_date, province_id) DO UPDATE
          SET region_id = EXCLUDED.region_id
        RETURNING id;
        `,
        [dateObj.iso, provinceId, regionId]
      );
      const drawId = drawRes.rows[0].id;

      await clientDb.query('DELETE FROM lottery_results WHERE draw_id = $1;', [drawId]);

      for (const prize of item.prizes) {
        let order = 1;
        for (const num of prize.numbers) {
          await clientDb.query(
            `
            INSERT INTO lottery_results (draw_id, prize_code, prize_order, result_number)
            VALUES ($1, $2, $3, $4);
            `,
            [drawId, prize.prize_code, order, num]
          );
          order++;
        }
      }
    }

    await clientDb.query('COMMIT');
    console.log(`Đã lưu xong ${regionCode} - ${dateObj.iso}`);
  } catch (err) {
    await clientDb.query('ROLLBACK');
    console.error('Lỗi lưu DB:', err);
  } finally {
    clientDb.release();
  }
}

// ====== SEED DATA REGIONS + PROVINCES ======

async function seedRegionsAndProvinces() {
  // Insert regions if empty
  const resRegions = await pool.query(`SELECT COUNT(*)::int AS count FROM regions;`);
  if (resRegions.rows[0].count === 0) {
    await pool.query(`
      INSERT INTO regions (code, name) VALUES
      ('MB', 'Miền Bắc'),
      ('MT', 'Miền Trung'),
      ('MN', 'Miền Nam');
    `);
  }

  const regionMapRes = await pool.query(`SELECT id, code FROM regions;`);
  const regionMap = {};
  for (const r of regionMapRes.rows) {
    regionMap[r.code] = r.id;
  }

  // Danh sách đài xổ số (tương đối đầy đủ, có thể chỉnh thêm nếu bạn muốn)
  const provinces = [
    // Miền Bắc (1 đài/ngày, dùng tên tỉnh làm code)
    { region: 'MB', code: 'HN', name: 'Hà Nội' },
    { region: 'MB', code: 'HP', name: 'Hải Phòng' },
    { region: 'MB', code: 'QN', name: 'Quảng Ninh' },
    { region: 'MB', code: 'TB', name: 'Thái Bình' },
    { region: 'MB', code: 'BN', name: 'Bắc Ninh' },
    { region: 'MB', code: 'ND', name: 'Nam Định' },
    { region: 'MB', code: 'PT', name: 'Phú Thọ' },
    { region: 'MB', code: 'TH', name: 'Thanh Hóa' },
    { region: 'MB', code: 'NA', name: 'Nghệ An' },
    { region: 'MB', code: 'BDH', name: 'Bắc Giang' },
    { region: 'MB', code: 'HNA', name: 'Hà Nam' },
    { region: 'MB', code: 'HDU', name: 'Hưng Yên' },

    // Miền Trung
    { region: 'MT', code: 'DN', name: 'Đà Nẵng' },
    { region: 'MT', code: 'QT', name: 'Quảng Trị' },
    { region: 'MT', code: 'QNA', name: 'Quảng Nam' },
    { region: 'MT', code: 'BD', name: 'Bình Định' },
    { region: 'MT', code: 'NT', name: 'Ninh Thuận' },
    { region: 'MT', code: 'KH', name: 'Khánh Hòa' },
    { region: 'MT', code: 'GL', name: 'Gia Lai' },
    { region: 'MT', code: 'DK', name: 'Đắk Lắk' },
    { region: 'MT', code: 'QTN', name: 'Quảng Ngãi' },
    { region: 'MT', code: 'DNO', name: 'Đắk Nông' },
    { region: 'MT', code: 'QB', name: 'Quảng Bình' },
    { region: 'MT', code: 'TTH', name: 'Thừa Thiên Huế' },

    // Miền Nam
    { region: 'MN', code: 'HCM', name: 'TP Hồ Chí Minh' },
    { region: 'MN', code: 'AG', name: 'An Giang' },
    { region: 'MN', code: 'BL', name: 'Bạc Liêu' },
    { region: 'MN', code: 'BP', name: 'Bình Phước' },
    { region: 'MN', code: 'BTH', name: 'Bình Thuận' },
    { region: 'MN', code: 'BRVT', name: 'Bà Rịa - Vũng Tàu' },
    { region: 'MN', code: 'BTR', name: 'Bến Tre' },
    { region: 'MN', code: 'BDI', name: 'Bình Dương' },
    { region: 'MN', code: 'CM', name: 'Cà Mau' },
    { region: 'MN', code: 'CT', name: 'Cần Thơ' },
    { region: 'MN', code: 'DL', name: 'Đà Lạt (Lâm Đồng)' },
    { region: 'MN', code: 'DNM', name: 'Đồng Nai' },
    { region: 'MN', code: 'DT', name: 'Đồng Tháp' },
    { region: 'MN', code: 'HG', name: 'Hậu Giang' },
    { region: 'MN', code: 'KG', name: 'Kiên Giang' },
    { region: 'MN', code: 'LA', name: 'Long An' },
    { region: 'MN', code: 'ST', name: 'Sóc Trăng' },
    { region: 'MN', code: 'TN', name: 'Tây Ninh' },
    { region: 'MN', code: 'TG', name: 'Tiền Giang' },
    { region: 'MN', code: 'TV', name: 'Trà Vinh' },
    { region: 'MN', code: 'VL', name: 'Vĩnh Long' },
    { region: 'MN', code: 'BPY', name: 'Phú Yên' } // có thể xem lại phân vùng nếu cần
  ];

  for (const p of provinces) {
    const regionId = regionMap[p.region];
    if (!regionId) continue;

    await pool.query(
      `
      INSERT INTO lottery_provinces (region_id, code, name)
      VALUES ($1, $2, $3)
      ON CONFLICT (code) DO NOTHING;
      `,
      [regionId, p.code, p.name]
    );
  }
}

// ====== AUTH MIDDLEWARE ======

async function authMiddleware(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key' });
  }

  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    const result = await pool.query(
      `SELECT * FROM auth_accept WHERE api_key = $1 AND is_active = TRUE LIMIT 1;`,
      [apiKey]
    );
    if (result.rowCount === 0) {
      return res.status(403).json({ error: 'Invalid or inactive API key' });
    }

    const client = result.rows[0];

    // Update last_used_at, ip, ua (ưu tiên ghi log mới)
    await pool.query(
      `
      UPDATE auth_accept
      SET last_used_at = NOW(),
          ip_address = COALESCE($1, ip_address),
          user_agent = COALESCE($2, user_agent)
      WHERE id = $3;
      `,
      [ip, ua, client.id]
    );

    req.client = {
      id: client.id,
      client_id: client.client_id,
      scopes: client.scopes
    };

    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Auth internal error' });
  }
}

// ====== ROUTES ======

// Tạo client + api_key (tạm thời không bảo vệ, bạn có thể thêm secret sau)
app.post('/api/auth/register-client', async (req, res) => {
  try {
    const { client_id, scopes } = req.body;
    if (!client_id) {
      return res.status(400).json({ error: 'client_id is required' });
    }

    const apiKey = 'api_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const scopesStr = scopes ? JSON.stringify(scopes) : JSON.stringify(['read', 'write']);

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    const result = await pool.query(
      `
      INSERT INTO auth_accept (client_id, api_key, ip_address, user_agent, scopes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, client_id, api_key, scopes, created_at;
      `,
      [client_id, apiKey, ip, ua, scopesStr]
    );

    res.json({ client: result.rows[0] });
  } catch (err) {
    console.error('register-client error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Middleware bảo vệ các route sau
app.use('/api/lottery', authMiddleware);

// Crawl 100 ngày gần nhất từ Minh Ngọc và lưu vào DB
// Body: { "days": 100 } (tùy chọn, mặc định 100)
app.post('/api/lottery/crawl-last-days', async (req, res) => {
  try {
    const days = Number(req.body?.days) || 100;
    const dates = getLastNDaysDates(days);
    const regionOrder = ['MB', 'MT', 'MN'];

    for (const dateObj of dates) {
      for (const regionCode of regionOrder) {
        const slug = REGION_SLUGS[regionCode];
        try {
          const html = await fetchMinhNgocHtml(slug, dateObj.display);
          const parsed = parseMinhNgocHtml(html, regionCode);
          await saveCrawledDayRegionToDb(regionCode, dateObj, parsed);
          // nghỉ 500ms để tránh spam
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.error('Lỗi crawl', regionCode, dateObj.display, e.message);
        }
      }
    }

    res.json({ success: true, daysCrawled: days });
  } catch (err) {
    console.error('crawl-last-days error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Lưu kết quả xổ số cho 1 kỳ quay
// Body ví dụ:
// {
//   "draw_date": "2026-01-01",
//   "province_code": "HN",
//   "results": [
//     { "prize_code": "DB", "prize_order": 1, "result_number": "12345" },
//     { "prize_code": "G1", "prize_order": 1, "result_number": "54321" },
//     { "prize_code": "G2", "prize_order": 1, "result_number": "11111" },
//     { "prize_code": "G2", "prize_order": 2, "result_number": "22222" }
//   ]
// }
app.post('/api/lottery/save-result', async (req, res) => {
  const client = req.client;
  if (!client) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  const { draw_date, province_code, results } = req.body;

  if (!draw_date || !province_code || !Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: 'draw_date, province_code, results are required' });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
  console.log(`Client ${client.client_id} saving result for ${province_code} on ${draw_date} from IP ${clientIp}`);

  const clientDb = await pool.connect();
  try {
    await clientDb.query('BEGIN');

    const provinceRes = await clientDb.query(
      `SELECT lp.id, lp.region_id, r.code AS region_code
       FROM lottery_provinces lp
       JOIN regions r ON r.id = lp.region_id
       WHERE lp.code = $1
       LIMIT 1;`,
      [province_code]
    );
    if (provinceRes.rowCount === 0) {
      await clientDb.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid province_code' });
    }

    const province = provinceRes.rows[0];

    const drawRes = await clientDb.query(
      `
      INSERT INTO lottery_draws (draw_date, province_id, region_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (draw_date, province_id) DO UPDATE
        SET region_id = EXCLUDED.region_id
      RETURNING id;
      `,
      [draw_date, province.id, province.region_id]
    );
    const drawId = drawRes.rows[0].id;

    // Xóa kết quả cũ của kỳ quay (nếu có), để insert lại
    await clientDb.query(`DELETE FROM lottery_results WHERE draw_id = $1;`, [drawId]);

    for (const r of results) {
      await clientDb.query(
        `
        INSERT INTO lottery_results (draw_id, prize_code, prize_order, result_number)
        VALUES ($1, $2, $3, $4);
        `,
        [drawId, r.prize_code, r.prize_order, r.result_number]
      );
    }

    await clientDb.query('COMMIT');

    res.json({ success: true, draw_id: drawId });
  } catch (err) {
    await clientDb.query('ROLLBACK');
    console.error('save-result error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    clientDb.release();
  }
});

// Lấy kết quả theo ngày + mã tỉnh
// /api/lottery/results?date=2026-01-01&province_code=HN
app.get('/api/lottery/results', async (req, res) => {
  const { date, province_code } = req.query;

  if (!date || !province_code) {
    return res.status(400).json({ error: 'date and province_code are required' });
  }

  try {
    const drawRes = await pool.query(
      `
      SELECT d.id AS draw_id, d.draw_date, lp.code AS province_code, lp.name AS province_name,
             r.code AS region_code, r.name AS region_name
      FROM lottery_draws d
      JOIN lottery_provinces lp ON lp.id = d.province_id
      JOIN regions r ON r.id = d.region_id
      WHERE d.draw_date = $1 AND lp.code = $2
      LIMIT 1;
      `,
      [date, province_code]
    );

    if (drawRes.rowCount === 0) {
      return res.status(404).json({ error: 'No draw found' });
    }

    const draw = drawRes.rows[0];

    const resultsRes = await pool.query(
      `
      SELECT prize_code, prize_order, result_number
      FROM lottery_results
      WHERE draw_id = $1
      ORDER BY prize_code, prize_order;
      `,
      [draw.draw_id]
    );

    res.json({
      draw: {
        draw_id: draw.draw_id,
        draw_date: draw.draw_date,
        province_code: draw.province_code,
        province_name: draw.province_name,
        region_code: draw.region_code,
        region_name: draw.region_name
      },
      results: resultsRes.rows
    });
  } catch (err) {
    console.error('get results error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ====== START SERVER ======

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to init DB:', err);
    process.exit(1);
  });