
import 'dotenv/config';
import express from 'express';
import pkg from 'pg';
import cron from 'node-cron';
import cors from 'cors';
import { GoogleGenAI } from "@google/genai";
import Parser from 'rss-parser';

const { Pool } = pkg;

const app = express();

// --- CORS Configuration (Critical for POST requests) ---
const corsOptions = {
    origin: '*', 
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 200
};

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json());

process.on('SIGTERM', () => {
    console.log('>>> SIGTERM received. Server shutting down.');
    process.exit(0);
});

// --- State & Logs ---
let pool = null;
let jobHistory = []; 

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;

const getInitialStatus = () => {
    if (CONNECTION_STRING) {
        return [{
            id: 'sys-connected-waiting',
            title: { en: "🟢 System Online - Database Connected", zh: "🟢 系统在线 - 数据库已连接" },
            summary: { 
                en: "Success! The backend is connected to PostgreSQL. The list is currently empty because the AI Job hasn't run yet. Click 'TRIGGER CLOUD UPDATE' above to scrape news immediately.", 
                zh: "连接成功！后端已连接到 PostgreSQL 数据库。当前列表为空是因为 AI 任务尚未运行。请点击上方的“触发云端更新”按钮立即开始抓取新闻。" 
            },
            category: "System",
            url: "#",
            source: "System",
            date: new Date().toISOString(),
            impactScore: 1,
            tags: ["Ready", "Waiting for Trigger"]
        }];
    } else {
        return [{
            id: 'sys-missing-db',
            title: { en: "⚠️ SYSTEM ALERT: Database Not Configured", zh: "⚠️ 系统警告：未配置数据库" },
            summary: { 
                en: "The backend is running but cannot find DATABASE_URL. Data will be lost on restart. Please check Railway Variables.", 
                zh: "后端正在运行但未找到 DATABASE_URL 环境变量。重启后数据将丢失。请检查 Railway 变量设置。" 
            },
            category: "System",
            url: "#",
            source: "System",
            date: new Date().toISOString(),
            impactScore: 10,
            tags: ["Config Error"]
        }];
    }
};

let inMemoryCache = getInitialStatus();

function logJob(message) {
    const entry = `[${new Date().toISOString().split('T')[1].split('.')[0]}] ${message}`;
    console.log(entry);
    if (jobHistory.length === 0 || jobHistory[0].finished) {
        jobHistory.unshift({ id: Date.now(), started: new Date(), logs: [entry], finished: false });
    } else {
        jobHistory[0].logs.push(entry);
    }
    if (jobHistory.length > 5) jobHistory.pop();
}

function finishJob(success = true, error = null) {
    if (jobHistory.length > 0 && !jobHistory[0].finished) {
        jobHistory[0].finished = true;
        jobHistory[0].success = success;
        jobHistory[0].error = error ? error.toString() : null;
        jobHistory[0].logs.push(success ? ">>> COMPLETED SUCCESS" : `>>> FAILED: ${error}`);
    }
}

// --- Database Connection ---
if (CONNECTION_STRING) {
    try {
        pool = new Pool({
            connectionString: CONNECTION_STRING,
            ssl: CONNECTION_STRING.includes('localhost') ? false : { rejectUnauthorized: false }
        });
        const TABLE_SCHEMA = `
          CREATE TABLE IF NOT EXISTS briefings (
            date_key TEXT PRIMARY KEY, 
            display_date DATE,
            content JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `;
        pool.query(TABLE_SCHEMA)
            .then(() => console.log(">>> DB Schema Verified"))
            .catch(err => console.error(">>> DB Schema Error:", err.message));
    } catch (e) {
        console.error(">>> DB Connection Failed:", e.message);
        pool = null; 
    }
} else {
    console.warn(">>> NOTICE: No DATABASE_URL found. Using Memory Mode.");
}

const parser = new Parser({
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Compatible; AI-News-Bot)' }
});

const RSSHUB_MIRRORS = [
    'https://rsshub.app',
    'https://rsshub.feedlib.xyz',
    'https://rsshub.pseudoyu.com',
    'https://rsshub.mou.science',
    'https://rsshub.blue',
    'https://rsshub.woodland.cafe'
];

const SOURCES = [
   { name: 'Tencent Tech', url: 'https://rsshub.app/tencent/news/channel/tech' },
   { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
   { name: 'Y Combinator AI', url: 'https://hnrss.org/newest?q=AI' },
   { name: 'Arxiv AI', url: 'https://export.arxiv.org/rss/cs.AI' },
   { name: 'Reddit LocalLlama', url: 'https://rsshub.app/reddit/subreddit/LocalLLaMA' },
   { name: 'Reddit StableDiffusion', url: 'https://rsshub.app/reddit/subreddit/StableDiffusion' }
];

// UPDATED: Requested more items (20-30) and stricter date handling
const SYSTEM_INSTRUCTION = `
You are an expert AI News Aggregator. Analyze the RAW FEED DATA.
Your goal is to provide COMPREHENSIVE coverage of the last 24 hours.
Identify ALL significant AI stories (aim for 20-30 items if available).
Generate a JSON array with fields: title (en/zh), summary (en/zh), category, url, source, impactScore (1-10), tags, date.
Category options: LLMs, Image & Video, Hardware, Business, Research, Robotics.

IMPORTANT RULES:
1. FILTER STRICTLY: Do NOT include any news older than 24 hours. Check the "Date:" field.
2. DATE ACCURACY: The "date" field in JSON MUST match the source "Date:" exactly.
3. COMPREHENSIVE: Do not just pick the top 5. List all relevant news.
4. STRUCTURE: Return valid JSON only.
`;

function cleanJson(text) {
  if (!text) return "[]";
  let cleaned = text.trim();
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1];
  }
  return cleaned;
}

async function fetchWithMirrors(source) {
    let urlsToTry = [source.url];
    if (source.url.includes('rsshub.app')) {
        const path = source.url.split('rsshub.app')[1];
        urlsToTry = RSSHUB_MIRRORS.map(domain => `${domain}${path}`);
    }

    for (const url of urlsToTry.slice(0, 3)) {
        try {
            const feed = await Promise.race([
                parser.parseURL(url),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000))
            ]);
            if (feed && feed.items) return feed;
        } catch (e) { }
    }
    throw new Error(`All mirrors failed for ${source.name}`);
}

async function fetchFeeds() {
  let context = "RAW FEED DATA:\n";
  logJob("Starting feed fetch...");
  
  const now = new Date();
  const cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24 Hours Ago

  for (const source of SOURCES) {
    try {
      const feed = await fetchWithMirrors(source);
      if (feed && feed.items) {
          context += `--- SOURCE: ${source.name} ---\n`;
          let addedCount = 0;
          
          // INCREASED LIMIT: Process up to 15 items per source to get "All News"
          feed.items.forEach(item => {
             const itemDateStr = item.pubDate || item.isoDate || item.date;
             let itemDate = itemDateStr ? new Date(itemDateStr) : null;
             
             // STRICTER DATE CHECK:
             // If date is invalid or missing, we skip it.
             // We do NOT default to 'new Date()' anymore, as that incorrectly labels old news as "Today".
             if (!itemDate || isNaN(itemDate.getTime())) {
                 return; 
             }
             
             if (itemDate < cutoffTime) return; // Skip old news

             if (addedCount >= 15) return; 

             const snippet = item.contentSnippet || item.content || "";
             context += `Title: ${item.title}\nDate: ${itemDate.toISOString()}\nLink: ${item.link}\nSnippet: ${snippet.substring(0, 300)}...\n\n`;
             addedCount++;
          });
          logJob(`Fetched ${source.name} (${addedCount} fresh items)`);
      }
    } catch (e) {
      logJob(`Skipped ${source.name}: ${e.message}`);
    }
  }
  return context;
}

async function generateBriefing(feedContext) {
  logJob("Calling Gemini API...");
  if (!process.env.API_KEY) throw new Error("API_KEY missing");

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: feedContext + "\n\nGenerate the comprehensive daily feed based on the above. STRICTLY last 24 hours.",
    config: { responseMimeType: 'application/json', systemInstruction: SYSTEM_INSTRUCTION }
  });
  return response.text;
}

async function runJob(isMorning) {
  const timeLabel = isMorning ? "Morning" : "Afternoon";
  jobHistory.unshift({ id: Date.now(), started: new Date(), logs: [], finished: false });
  logJob(`Job Started: ${timeLabel}`);
  
  try {
    const now = new Date();
    // Use full date string as key to separate AM/PM if needed, or just date for daily
    const dateStr = now.toISOString().split('T')[0];
    const sessionKey = `${dateStr}-${isMorning ? 'AM' : 'PM'}`;
    
    // 1. Fetch
    const feedData = await fetchFeeds();
    
    // 2. Generate
    const rawText = await generateBriefing(feedData);
    logJob("Gemini response received.");
    
    // 3. Parse
    let parsedContent = JSON.parse(cleanJson(rawText));
    if(!Array.isArray(parsedContent)) throw new Error("Invalid JSON Array");
    
    // 3.5. Sanitize Data
    parsedContent = parsedContent.map((item, idx) => {
        let validDate = item.date;
        // Keep the generation timestamp fallback ONLY if the AI returns strictly nothing.
        // But since we filtered inputs, the AI *should* have valid dates.
        if (!validDate || isNaN(new Date(validDate).getTime())) {
            validDate = new Date().toISOString();
        }
        return {
            ...item,
            id: item.id || `gen-${Date.now()}-${idx}`,
            date: validDate,
            title: (typeof item.title === 'string') ? { en: item.title, zh: item.title } : item.title,
            summary: (typeof item.summary === 'string') ? { en: item.summary, zh: item.summary } : item.summary,
        };
    });

    inMemoryCache = parsedContent;
    logJob(`Memory cache updated (${parsedContent.length} items).`);

    if (pool) {
        await pool.query(
          `INSERT INTO briefings (date_key, display_date, content) VALUES ($1, $2, $3) 
           ON CONFLICT (date_key) DO UPDATE SET content = $3, created_at = CURRENT_TIMESTAMP`,
          [sessionKey, dateStr, JSON.stringify(parsedContent)]
        );
        logJob("Saved to DB successfully.");
    }
    finishJob(true);

  } catch (e) {
    logJob(`FATAL ERROR: ${e.message}`);
    finishJob(false, e.message);
  }
}

// --- Schedules ---
cron.schedule('0 0 * * *', () => runJob(true)); 
cron.schedule('0 6 * * *', () => runJob(false)); 

// --- API ---
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.send('AI News Backend Active.'));

app.get('/api/debug', (req, res) => {
    res.json({ uptime: process.uptime(), env: { hasApiKey: !!process.env.API_KEY, hasDb: !!CONNECTION_STRING }, jobHistory });
});

// GET LATEST (Default)
app.get('/api/latest', async (req, res) => {
  try {
    if (pool) {
        // Fetch the most recent successful generation
        const result = await pool.query('SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1');
        if (result.rows.length > 0) {
             const content = result.rows[0].content;
             return res.json(typeof content === 'string' ? JSON.parse(content) : content);
        }
    }
    return res.json(inMemoryCache);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// NEW: GET AVAILABLE DATES
app.get('/api/dates', async (req, res) => {
    try {
        if (!pool) return res.json([]);
        // Return distinct dates present in DB, sorted new to old
        const result = await pool.query('SELECT DISTINCT display_date FROM briefings ORDER BY display_date DESC LIMIT 30');
        const dates = result.rows.map(r => {
             // Handle PG date object or string
             const d = new Date(r.display_date);
             return d.toISOString().split('T')[0];
        });
        res.json(dates);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

// NEW: GET ARCHIVE BY DATE
app.get('/api/archive/:date', async (req, res) => {
    try {
        const { date } = req.params;
        if (!pool) return res.json([]);
        
        // Fetch specific date. If multiple (AM/PM), merge them or take latest?
        // Let's take ALL items from that day and merge them for a "Full Day" view
        const result = await pool.query('SELECT content FROM briefings WHERE display_date = $1 ORDER BY created_at DESC', [date]);
        
        let mergedContent = [];
        result.rows.forEach(row => {
            const batch = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
            if (Array.isArray(batch)) mergedContent = [...mergedContent, ...batch];
        });
        
        // Deduplicate based on URL or Title
        const seen = new Set();
        const uniqueContent = mergedContent.filter(item => {
            const key = item.url || item.title.en;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        res.json(uniqueContent);
    } catch (e) {
        console.error(e);
        res.status(500).send(e.message);
    }
});

app.post('/api/trigger', async (req, res) => {
    if (!process.env.API_KEY) return res.status(500).send("API_KEY missing");
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.trim() !== process.env.API_KEY.trim()) return res.status(401).send("Unauthorized");

    const isMorning = new Date().getUTCHours() < 3;
    runJob(isMorning);
    res.send("Job started.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
