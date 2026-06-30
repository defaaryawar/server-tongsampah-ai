require("dotenv").config();
const express = require("express");
const cloudinary = require("cloudinary").v2;
const Groq = require("groq-sdk");
const multer = require("multer");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const FIREBASE_URL     = process.env.FIREBASE_URL;
const FIREBASE_SECRET  = process.env.FIREBASE_SECRET;
const VALID_CATEGORIES = ["organik", "non-organik"];

// ===================== MIDDLEWARE =====================
app.use((req, res, next) => {
  res.setHeader("Connection", "close"); // cegah ESP32 kena keepalive stale connection
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] >>> ${req.method} ${req.url}`);
  console.log(`[REQ] Headers: ${JSON.stringify(req.headers)}`);
  next();
});

// ===================== HELPER =====================
function uploadCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    console.log(`[CLOUDINARY] Mulai upload buffer ${buffer.length} bytes...`);
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "image", folder: "tong-sampah" },
      (err, result) => {
        if (err) {
          console.error("[CLOUDINARY] Upload gagal:", err);
          return reject(err);
        }
        console.log(`[CLOUDINARY] Upload sukses: ${result.secure_url}`);
        resolve(result);
      }
    );
    stream.end(buffer);
  });
}

function parseVLMResponse(raw) {
  console.log(`[PARSE] Raw VLM response:\n${raw}`);
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```json|```/g, "")
    .trim();
  console.log(`[PARSE] Setelah cleaning:\n${cleaned}`);
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(`Tidak ada JSON ditemukan dalam response VLM: ${raw}`);
  }
  const jsonStr = cleaned.slice(start, end + 1);
  console.log(`[PARSE] JSON string diekstrak: ${jsonStr}`);
  const parsed = JSON.parse(jsonStr);
  console.log(`[PARSE] Parsed:`, parsed);
  return parsed;
}

async function classifyWithGroq(base64Image, retries = 3) {
  console.log(`[GROQ] Mulai klasifikasi | image base64 length: ${base64Image.length}`);
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[GROQ] Attempt ${i + 1}/${retries}...`);
      const tStart = Date.now();
      const result = await groq.chat.completions.create({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `Kamu adalah sistem klasifikasi sampah otomatis.
Tugasmu: identifikasi benda dalam gambar dan tentukan kategori sampahnya.

Aturan kategori:
- "organik": sisa makanan, daun, kertas, kayu, kardus
- "non-organik": plastik, botol, kaleng, kaca, baterai, rokok, styrofoam, karet

Balas HANYA dengan JSON tanpa markdown tanpa teks lain, format:
{"category":"organik" atau "non-organik","object":"nama benda dalam bahasa Indonesia","confidence":0.0-1.0}

Jika gambar tidak jelas, tetap berikan jawaban terbaik dengan confidence rendah.`,
            },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
          ],
        }],
        max_tokens: 150,
      });
      const elapsed = Date.now() - tStart;
      console.log(`[GROQ] Sukses dalam ${elapsed} ms`);
      console.log(`[GROQ] Usage:`, result.usage);
      return result;
    } catch (err) {
      console.error(`[GROQ] Attempt ${i + 1} gagal: ${err.message}`);
      if (err.status) console.error(`[GROQ] HTTP status: ${err.status}`);
      if (i === retries - 1) {
        console.error("[GROQ] Semua retry habis, throw error.");
        throw err;
      }
      const waitMs = 1500 * (i + 1);
      console.log(`[GROQ] Tunggu ${waitMs} ms sebelum retry...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

async function simpanRiwayat(imageUrl, category, object, confidence) {
  console.log(`[FIREBASE] Simpan riwayat: category=${category} object=${object} confidence=${confidence}`);
  console.log(`[FIREBASE] URL: ${FIREBASE_URL}/riwayat.json`);
  const body = JSON.stringify({
    timestamp:  Date.now(),
    category,
    object,
    confidence,
    image_url:  imageUrl,
  });
  console.log(`[FIREBASE] Payload: ${body}`);
  const res = await fetch(`${FIREBASE_URL}/riwayat.json?auth=${FIREBASE_SECRET}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const resText = await res.text();
  if (!res.ok) {
    throw new Error(`Firebase HTTP ${res.status}: ${resText}`);
  }
  console.log(`[FIREBASE] Sukses: ${resText}`);
}

// ===================== ROUTES =====================
app.get("/ping", (req, res) => {
  console.log("[PING] Ping diterima, balas ok.");
  res.json({ status: "ok", time: Date.now() });
});

app.post("/classify", upload.single("photo"), async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] === /classify MULAI ===`);

  if (!req.file) {
    console.error("[CLASSIFY] Tidak ada file diterima.");
    console.error("[CLASSIFY] req.body:", req.body);
    return res.status(400).json({ error: "Tidak ada file" });
  }

  console.log(`[CLASSIFY] File diterima:`);
  console.log(`  - fieldname : ${req.file.fieldname}`);
  console.log(`  - originalname: ${req.file.originalname}`);
  console.log(`  - mimetype  : ${req.file.mimetype}`);
  console.log(`  - size      : ${req.file.size} bytes`);

  try {
    const base64Image = req.file.buffer.toString("base64");
    console.log(`[CLASSIFY] base64 length: ${base64Image.length}`);

    console.log("[CLASSIFY] Mulai Cloudinary + Groq paralel...");
    const tParallel = Date.now();

    const [cloudinaryResult, groqResponse] = await Promise.all([
      uploadCloudinary(req.file.buffer),
      classifyWithGroq(base64Image),
    ]);

    console.log(`[CLASSIFY] Parallel selesai dalam ${Date.now() - tParallel} ms`);

    const imageUrl = cloudinaryResult.secure_url;
    console.log(`[CLASSIFY] Cloudinary URL: ${imageUrl}`);

    const raw    = groqResponse.choices[0].message.content;
    const result = parseVLMResponse(raw);

    // Validasi category
    if (!VALID_CATEGORIES.includes(result.category)) {
      throw new Error(`Category tidak valid: "${result.category}" (expected: ${VALID_CATEGORIES.join(" / ")})`);
    }

    // Validasi confidence
    if (typeof result.confidence !== "number" || result.confidence < 0 || result.confidence > 1) {
      throw new Error(`Confidence tidak valid: ${result.confidence}`);
    }

    console.log(`[CLASSIFY] HASIL FINAL:`);
    console.log(`  - category  : ${result.category}`);
    console.log(`  - object    : ${result.object ?? "unknown"}`);
    console.log(`  - confidence: ${result.confidence}`);

    // Simpan riwayat async (non-fatal)
    simpanRiwayat(imageUrl, result.category, result.object ?? "unknown", result.confidence)
      .catch(err => console.error("[FIREBASE] Gagal simpan riwayat (non-fatal):", err.message));

    const responseBody = {
      category:   result.category,
      object:     result.object ?? "unknown",
      confidence: result.confidence,
    };
    console.log(`[CLASSIFY] Mengirim response: ${JSON.stringify(responseBody)}`);
    return res.json(responseBody);

  } catch (err) {
    console.error(`[CLASSIFY] ERROR: ${err.message}`);
    if (err.stack) console.error(err.stack);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/update-tong", express.json(), async (req, res) => {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] === /update-tong MULAI ===`);

  const { jarak_organik, jarak_non_organik, status_organik, status_non_organik } = req.body;

  if (jarak_organik === undefined || jarak_non_organik === undefined) {
    console.error("[TONG] Body tidak lengkap:", req.body);
    return res.status(400).json({ error: "jarak_organik dan jarak_non_organik wajib diisi" });
  }

  console.log(`[TONG] Diterima: organik=${jarak_organik}cm (${status_organik}) | non_organik=${jarak_non_organik}cm (${status_non_organik})`);

  try {
    const payload = JSON.stringify({
      organik: { jarak_cm: jarak_organik, status: status_organik },
      non_organik: { jarak_cm: jarak_non_organik, status: status_non_organik },
    });

    const fbRes = await fetch(`${FIREBASE_URL}/tong.json?auth=${FIREBASE_SECRET}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    const fbText = await fbRes.text();

    if (!fbRes.ok) {
      throw new Error(`Firebase HTTP ${fbRes.status}: ${fbText}`);
    }

    console.log(`[TONG] Sukses update Firebase: ${fbText}`);
    return res.json({ success: true });

  } catch (err) {
    console.error(`[TONG] ERROR: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ===================== SERVER =====================
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`\n[SERVER] Jalan di port ${PORT}`);
  console.log(`[SERVER] FIREBASE_URL: ${FIREBASE_URL}`);
  console.log(`[SERVER] CLOUDINARY_CLOUD_NAME: ${process.env.CLOUDINARY_CLOUD_NAME}`);
  console.log(`[SERVER] GROQ_API_KEY: ${process.env.GROQ_API_KEY ? "SET" : "TIDAK SET"}`);
});

server.keepAliveTimeout = 1000;   // turunin drastis biar ESP32 gak ketemu stale
server.headersTimeout   = 2000;

process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});