import 'dotenv/config';
import express from 'express';
import pkg from 'pg';
import cron from 'node-cron';
import cors from 'cors';
import { GoogleGenAI } from "@google/genai";
import Parser from 'rss-parser';

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// --- Graceful Shutdown ---
process.on('SIGTERM', () => {
    console.log('>>> SIGTERM received. Server shutting down.');
    process.exit(0);
});

// --- State & Logs ---
let pool = null;
let jobHistory = []; 

// 1. Determine Database URL (Support both standard names)
const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL;

// 2. Startup Diagnostic (Helps user see if vars are actually injected)
console.log(">>> ENVIRONMENT DIAGNOSTIC:");
console.log(">>> Keys present:", Object.keys(process.env).filter(k => !k.startsWith('npm_')).join(', '));
console.log(">>> Has API_KEY:", !!process.env.API_KEY);
console.log(">>> Has DB URL:", !!CONNECTION_STRING);

// DEFAULT STATE
let inMemoryCache = [
    {
        id: 'sys-status',
        title: { en: "⚠️ SYSTEM STATUS: Database Not Connected", zh: "⚠️ 系统状态：未连接数据库" },
        summary: { 
            en: "The backend is running in 'Memory Mode'. If you have added DATABASE_URL to Railway, you MUST Redeploy the service for it to take effect. Check the Railway Build/Deploy logs to see the 'ENVIRONMENT DIAGNOSTIC' output.", 
            zh: "后端运行在“内存模式”。如果您已经在 Railway 添加了 DATABASE_URL，请务必“重新部署 (Redeploy)”服务以使其生效。请检查 Railway 的部署日志查看“ENVIRONMENT DIAGNOSTIC”输出。" 
        },
        category: "System",
        url: "#",
        source: "System",
        date: new Date().toISOString(),
        impactScore: 10,
        tags: ["Config Required", "Action Needed"]
    }
];

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
            .then(() => console.log(">>> DB Schema Verified (Table 'briefings' ready)"))
            .catch(err => console.error(">>> DB Schema Error:", err.message));
            
        console.log(">>> Database connection initialized using provided URL.");
    } catch (e) {
        console.error(">>> DB Connection Failed:", e.message);
        pool = null; 
    }
} else {
    console.warn(">>> NOTICE: No DATABASE_URL or POSTGRES_URL found. Using in-memory storage.");
}

// --- RSS Configuration ---
const parser = new Parser({
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Compatible; AI-News-Bot)' }
});

const RSSHUB_MIRRORS = [
    'https://rsshub.app',
    'https://rsshub.feedlib.xyz',
    'https://rsshub.pseudoyu.com',
    'https://rsshub.blue'
];

const SOURCES = [
   { name: 'Tencent Tech', url: 'https://rsshub.app/tencent/news/channel/tech' },
   { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
   { name: 'Y Combinator AI', url: 'https://hnrss.org/newest?q=AI' },
   { name: 'Arxiv AI', url: 'https://export.arxiv.org/rss/cs.AI' },
   { name: 'Reddit LocalLlama', url: 'https://rsshub.app/reddit/subreddit/LocalLLaMA' },
   { name: 'Reddit StableDiffusion', url: 'https://rsshub.app/reddit/subreddit/StableDiffusion' }
];

const SYSTEM_INSTRUCTION = `
You are an expert AI News Aggregator. Analyze the RAW FEED DATA.
Select the top 8-12 most important AI stories.
Generate a JSON array with fields: title (en/zh), summary (en/zh), category, url, source, impactScore (1-10), tags.
Category options: LLMs, Image & Video, Hardware, Business, Research, Robotics.
STRICTLY return valid JSON only.
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

// --- Robust Fetcher ---
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
  
  for (const source of SOURCES) {
    try {
      const feed = await fetchWithMirrors(source);
      if (feed && feed.items) {
          context += `--- SOURCE: ${source.name} ---\n`;
          feed.items.slice(0, 5).forEach(item => {
             const snippet = item.contentSnippet || item.content || "";
             context += `Title: ${item.title}\nLink: ${item.link}\nSnippet: ${snippet.substring(0, 200)}...\n\n`;
          });
          logJob(`Fetched ${source.name} (${feed.items.length})`);
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
    contents: feedContext + "\n\nGenerate the daily briefing based on the above.",
    config: { responseMimeType: 'application/json', systemInstruction: SYSTEM_INSTRUCTION }
  });
  return response.text();
}

async function runJob(isMorning) {
  const timeLabel = isMorning ? "Morning" : "Afternoon";
  jobHistory.unshift({ id: Date.now(), started: new Date(), logs: [], finished: false });
  logJob(`Job Started: ${timeLabel}`);
  
  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const sessionKey = `${dateStr}-${isMorning ? 'AM' : 'PM'}`;
    
    // 1. Fetch
    const feedData = await fetchFeeds();
    if (feedData.length < 50) logJob("WARNING: Feed data extremely short.");

    // 2. Generate
    const rawText = await generateBriefing(feedData);
    logJob("Gemini response received.");
    
    // 3. Parse
    let parsedContent = JSON.parse(cleanJson(rawText));
    if(!Array.isArray(parsedContent)) throw new Error("Invalid JSON Array");
    
    // 4. Save
    inMemoryCache = parsedContent;
    logJob(`Memory cache updated (${parsedContent.length} items).`);

    if (pool) {
        await pool.query(
          `INSERT INTO briefings (date_key, display_date, content) VALUES ($1, $2, $3) 
           ON CONFLICT (date_key) DO UPDATE SET content = $3, created_at = CURRENT_TIMESTAMP`,
          [sessionKey, dateStr, JSON.stringify(parsedContent)]
        );
        logJob("Saved to DB successfully.");
    } else {
        logJob("DB skipped (Not Configured). Data will be lost on restart.");
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

app.get('/', (req, res) => res.send('AI News Backend Active.'));

app.get('/api/debug', (req, res) => {
    // Expose which variables are actually visible to the process
    res.json({
        uptime: process.uptime(),
        env: {
            hasApiKey: !!process.env.API_KEY,
            hasDb: !!CONNECTION_STRING,
            dbVarName: process.env.DATABASE_URL ? 'DATABASE_URL' : (process.env.POSTGRES_URL ? 'POSTGRES_URL' : 'NONE')
        },
        jobHistory: jobHistory
    });
});

app.get('/api/latest', async (req, res) => {
  try {
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1');
            if (result.rows.length > 0) {
                 const content = result.rows[0].content;
                 return res.json(typeof content === 'string' ? JSON.parse(content) : content);
            }
        } catch (dbErr) {
            console.error("DB Read Error:", dbErr.message);
        }
    }
    return res.json(inMemoryCache);
  } catch (e) {
    res.status(500).send("Internal Server Error: " + e.message);
  }
});

app.post('/api/trigger', async (req, res) => {
    if (!process.env.API_KEY) return res.status(500).send("API_KEY missing");
    if (req.headers['authorization'] !== process.env.API_KEY) return res.status(401).send("Unauthorized");

    const isMorning = new Date().getUTCHours() < 3;
    runJob(isMorning);
    res.send("Job started. Check /api/debug for progress.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));