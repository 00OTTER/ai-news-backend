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

// --- Graceful Shutdown (Fixes npm error SIGTERM) ---
process.on('SIGTERM', () => {
    console.log('>>> SIGTERM received. Closing server gracefully...');
    process.exit(0); // Success code prevents "npm error" logs
});

// --- Global Error Handlers ---
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// --- In-Memory State ---
let pool = null;
let jobHistory = []; 

// Default state so frontend shows *something* instead of empty list
let inMemoryCache = [
    {
        id: 'sys-init',
        title: { en: "Backend Online - Waiting for Trigger", zh: "后端服务在线 - 等待任务触发" },
        summary: { 
            en: "The backend is connected. If this is the only card, the AI Job hasn't run successfully yet. Please check API_KEY is set in Railway Variables and click 'Trigger Cloud Update'.", 
            zh: "后端连接成功。如果你只看到这张卡片，说明 AI 任务尚未成功运行。请检查 Railway 环境变量中是否设置了 API_KEY，然后点击“触发云端更新”。" 
        },
        category: "System",
        url: "#",
        source: "System",
        date: new Date().toISOString(),
        impactScore: 1,
        tags: ["Status", "Waiting"]
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

// --- Database Setup ---
if (process.env.DATABASE_URL) {
    try {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
        });
        const TABLE_SCHEMA = `
          CREATE TABLE IF NOT EXISTS briefings (
            date_key TEXT PRIMARY KEY, 
            display_date DATE,
            content JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `;
        pool.query(TABLE_SCHEMA).catch(err => console.error("DB Init Warning:", err.message));
        console.log(">>> Database connection initialized.");
    } catch (e) {
        console.error(">>> DB Connection Failed:", e.message);
        pool = null; 
    }
} else {
    console.warn(">>> NOTICE: DATABASE_URL is not set. Using in-memory storage.");
}

// --- Configuration ---
const parser = new Parser({
    timeout: 15000, 
    headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
    }
});

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

// --- Core Logic ---

async function fetchFeeds() {
  let context = "RAW FEED DATA:\n";
  logJob("Starting feed fetch...");
  
  for (const source of SOURCES) {
    try {
      // Use standard fetch with timeout for parser
      const feed = await Promise.race([
          parser.parseURL(source.url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);
      
      if (feed && feed.items) {
          context += `--- SOURCE: ${source.name} ---\n`;
          feed.items.slice(0, 5).forEach(item => {
             const snippet = item.contentSnippet || item.content || "";
             context += `Title: ${item.title}\nLink: ${item.link}\nSnippet: ${snippet.substring(0, 200)}...\n\n`;
          });
          logJob(`Fetched ${source.name} (${feed.items.length} items)`);
      }
    } catch (e) {
      logJob(`Skipped ${source.name}: ${e.message}`);
    }
  }
  return context;
}

async function generateBriefing(feedContext) {
  logJob("Calling Gemini API...");
  
  if (!process.env.API_KEY) {
      throw new Error("Server missing API_KEY env var in Railway Settings.");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: feedContext + "\n\nGenerate the daily briefing based on the above.",
    config: { 
        responseMimeType: 'application/json',
        systemInstruction: SYSTEM_INSTRUCTION
    }
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
    if (feedData.length < 50) {
        logJob("WARNING: Feed data is empty. Check internet/proxy.");
    }

    // 2. Generate
    const rawText = await generateBriefing(feedData);
    logJob("Gemini response received.");
    
    const jsonStr = cleanJson(rawText);

    // Validate JSON
    let parsedContent;
    try {
        parsedContent = JSON.parse(jsonStr);
        if(!Array.isArray(parsedContent)) throw new Error("Result is not an array");
    } catch(e) {
        logJob(`JSON Parse Error: ${e.message}`);
        throw e;
    }
    
    // 3. Save
    inMemoryCache = parsedContent;
    logJob(`Memory updated (${parsedContent.length} items).`);

    if (pool) {
        await pool.query(
          `INSERT INTO briefings (date_key, display_date, content) VALUES ($1, $2, $3) 
           ON CONFLICT (date_key) DO UPDATE SET content = $3, created_at = CURRENT_TIMESTAMP`,
          [sessionKey, dateStr, jsonStr]
        );
        logJob("Saved to DB.");
    } else {
        logJob("DB skipped (not configured).");
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
    res.json({
        uptime: process.uptime(),
        env: {
            hasApiKey: !!process.env.API_KEY,
            hasDb: !!process.env.DATABASE_URL
        },
        jobHistory: jobHistory
    });
});

app.get('/api/latest', async (req, res) => {
  try {
    // 1. DB
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1');
            if (result.rows.length > 0) {
                 const content = typeof result.rows[0].content === 'string' 
                    ? JSON.parse(result.rows[0].content) 
                    : result.rows[0].content;
                 return res.json(content);
            }
        } catch (dbErr) {
            console.error("DB Read Error:", dbErr.message);
        }
    }

    // 2. Cache (Always returns at least the default system status if empty)
    return res.json(inMemoryCache);

  } catch (e) {
    res.status(500).send("Internal Server Error: " + e.message);
  }
});

app.post('/api/trigger', async (req, res) => {
    console.log(">>> [TRIGGER] Request received.");
    
    if (!process.env.API_KEY) {
        return res.status(500).send("Server Config Error: API_KEY missing in Railway Variables.");
    }

    // Simple auth check
    if (req.headers['authorization'] !== process.env.API_KEY) {
        return res.status(401).send("Unauthorized: Key Mismatch");
    }

    const isMorning = new Date().getUTCHours() < 3;
    runJob(isMorning); 
    
    res.send("Job started in background. Check /api/debug.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));