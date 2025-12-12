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

// --- Database Setup ---
let pool = null;
let inMemoryCache = []; // Fallback storage if DB is missing

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

        // Initialize Table (Lazy)
        pool.query(TABLE_SCHEMA).catch(err => console.error("DB Init Warning:", err.message));
        console.log(">>> Database connection initialized.");
    } catch (e) {
        console.error(">>> DB Connection Failed:", e.message);
        pool = null; // Ensure pool is null if init fails
    }
} else {
    console.warn(">>> NOTICE: DATABASE_URL is not set. Using in-memory storage (data will be lost on restart).");
}

// --- Configuration ---
const parser = new Parser();

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

// --- Helpers ---

function cleanJson(text) {
  if (!text) return "[]";
  let cleaned = text.trim();
  // Remove markdown code blocks if present
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1];
  }
  return cleaned;
}

// --- Core Logic ---

async function fetchFeeds() {
  let context = "RAW FEED DATA:\n";
  console.log("Starting feed fetch...");
  
  for (const source of SOURCES) {
    try {
      const feed = await Promise.race([
          parser.parseURL(source.url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);
      
      context += `--- SOURCE: ${source.name} ---\n`;
      feed.items.slice(0, 5).forEach(item => {
         const snippet = item.contentSnippet || item.content || "";
         context += `Title: ${item.title}\nLink: ${item.link}\nSnippet: ${snippet.substring(0, 200)}...\n\n`;
      });
      console.log(`Fetched ${source.name}`);
    } catch (e) {
      console.error(`Failed to fetch ${source.name}:`, e.message);
    }
  }
  return context;
}

async function generateBriefing(feedContext) {
  console.log("Calling Gemini...");
  
  // Use env var primarily, but strict mode requires process.env.API_KEY
  if (!process.env.API_KEY) {
      throw new Error("Server missing API_KEY env var");
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
  const timeLabel = isMorning ? "Morning (8AM)" : "Afternoon (2PM)";
  console.log(`>>> [JOB START] Running ${timeLabel} Cycle...`);
  
  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const sessionKey = `${dateStr}-${isMorning ? 'AM' : 'PM'}`;
    
    // 1. Fetch
    const feedData = await fetchFeeds();
    if (feedData.length < 50) throw new Error("Feeds empty or failed (Content too short)");

    // 2. Generate
    const rawText = await generateBriefing(feedData);
    const jsonStr = cleanJson(rawText);

    // Validate JSON
    let parsedContent;
    try {
        parsedContent = JSON.parse(jsonStr);
        if(!Array.isArray(parsedContent)) throw new Error("Result is not an array");
    } catch(e) {
        throw new Error(`Generated invalid JSON: ${e.message}`);
    }
    
    // 3. Save (Dual Write: Memory + DB)
    inMemoryCache = parsedContent;
    console.log(`>>> Memory cache updated (${parsedContent.length} items).`);

    if (pool) {
        await pool.query(
          `INSERT INTO briefings (date_key, display_date, content) VALUES ($1, $2, $3) 
           ON CONFLICT (date_key) DO UPDATE SET content = $3, created_at = CURRENT_TIMESTAMP`,
          [sessionKey, dateStr, jsonStr]
        );
        console.log(`>>> Success! Briefing saved to DB for ${sessionKey}`);
    } else {
        console.log(">>> DB not configured, skipping persistent save.");
    }
    
    console.log(`>>> [JOB COMPLETE] ${timeLabel} finished successfully.`);

  } catch (e) {
    console.error(`>>> [JOB FAILED] ${timeLabel} Error:`, e);
  }
}

// --- Cron Schedules (UTC Time) ---
cron.schedule('0 0 * * *', () => runJob(true)); // 8:00 AM CST
cron.schedule('0 6 * * *', () => runJob(false)); // 2:00 PM CST

// --- API Routes ---

app.get('/', (req, res) => res.send('AI News Backend Active.'));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/latest', async (req, res) => {
  try {
    // Priority 1: Try DB
    if (pool) {
        try {
            const result = await pool.query('SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1');
            if (result.rows.length > 0) {
                 // Ensure valid JSON
                 const content = typeof result.rows[0].content === 'string' 
                    ? JSON.parse(result.rows[0].content) 
                    : result.rows[0].content;
                 return res.json(content);
            }
        } catch (dbErr) {
            console.error("DB Read Error (falling back):", dbErr.message);
            // Don't error out, fall through to memory cache
        }
    }

    // Priority 2: Memory Cache
    if (inMemoryCache && inMemoryCache.length > 0) {
        return res.json(inMemoryCache);
    }

    // Priority 3: Empty (Valid 200 response, not 500)
    return res.json([]); 

  } catch (e) {
    console.error("API Fatal Error:", e);
    res.status(500).send("Internal Server Error: " + e.message);
  }
});

app.post('/api/trigger', async (req, res) => {
    console.log(">>> [TRIGGER] Received manual trigger request.");
    
    // Check if Server Key is configured
    if (!process.env.API_KEY) {
        console.error(">>> [TRIGGER ERROR] process.env.API_KEY is missing on server.");
        return res.status(500).send("Server Configuration Error: API_KEY missing.");
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== process.env.API_KEY) {
        console.warn(">>> [TRIGGER DENIED] Unauthorized access attempt.");
        return res.status(401).send("Unauthorized: Key mismatch.");
    }

    const currentHour = new Date().getUTCHours();
    const isMorning = currentHour < 3;
    
    console.log(`>>> [TRIGGER STARTING] Mode: ${isMorning ? 'AM' : 'PM'}`);
    
    // Run async, don't await
    runJob(isMorning);
    
    res.send(`Job started in background (Mode: ${isMorning ? 'AM' : 'PM'}). Check server logs.`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));