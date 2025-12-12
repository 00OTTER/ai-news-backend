import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import cron from 'node-cron';
import cors from 'cors';
import { GoogleGenAI } from "@google/genai";
import Parser from 'rss-parser';

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

// --- Database Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize Table
// Note: We use .then/.catch because top-level await is supported in ESM but better to be explicit in initialization logic
pool.query(`
  CREATE TABLE IF NOT EXISTS briefings (
    date_key TEXT PRIMARY KEY, -- Format: YYYY-MM-DD-HH (to distinguish 8am vs 2pm)
    display_date DATE,
    content JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`).catch(err => console.error("DB Init Error:", err));

// --- Configuration ---
const parser = new Parser();

// Consistent Sources with Frontend
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

// --- Core Logic ---

async function fetchFeeds() {
  let context = "RAW FEED DATA:\n";
  console.log("Starting feed fetch...");
  
  for (const source of SOURCES) {
    try {
      // Set a timeout for parser
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
  console.log(`>>> Running ${timeLabel} Cycle...`);
  
  try {
    const now = new Date();
    // YYYY-MM-DD
    const dateStr = now.toISOString().split('T')[0];
    // Key to distinguish sessions: 2023-12-12-AM or 2023-12-12-PM
    const sessionKey = `${dateStr}-${isMorning ? 'AM' : 'PM'}`;
    
    // 1. Fetch
    const feedData = await fetchFeeds();
    if (feedData.length < 50) throw new Error("Feeds empty or failed");

    // 2. Generate
    const jsonStr = await generateBriefing(feedData);
    
    // 3. Save
    await pool.query(
      `INSERT INTO briefings (date_key, display_date, content) VALUES ($1, $2, $3) 
       ON CONFLICT (date_key) DO UPDATE SET content = $3, created_at = CURRENT_TIMESTAMP`,
      [sessionKey, dateStr, jsonStr]
    );
    console.log(`>>> Success! Briefing saved for ${sessionKey}`);
  } catch (e) {
    console.error(`>>> ${timeLabel} Job Failed:`, e);
  }
}

// --- Cron Schedules (UTC Time) ---

// 1. Morning Briefing: 8:00 AM Beijing Time = 00:00 UTC
cron.schedule('0 0 * * *', () => {
    runJob(true);
});

// 2. Afternoon Update: 2:00 PM Beijing Time = 06:00 UTC
cron.schedule('0 6 * * *', () => {
    runJob(false);
});


// --- API Routes ---

app.get('/', (req, res) => res.send('AI News Backend Active.'));

// Get the absolute latest briefing (either AM or PM)
app.get('/api/latest', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM briefings ORDER BY created_at DESC LIMIT 1');
    if (result.rows.length === 0) return res.json([]); 
    res.json(result.rows[0].content);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Get history list
app.get('/api/history', async (req, res) => {
   try {
     const result = await pool.query('SELECT date_key, display_date, created_at FROM briefings ORDER BY created_at DESC');
     res.json(result.rows);
   } catch (e) {
     res.status(500).send(e.message);
   }
});

// Get specific session
app.get('/api/history/:key', async (req, res) => {
   try {
     const result = await pool.query('SELECT content FROM briefings WHERE date_key = $1', [req.params.key]);
     if (result.rows.length === 0) return res.status(404).send("Not Found");
     res.json(result.rows[0].content);
   } catch (e) {
     res.status(500).send(e.message);
   }
});

// Manual Trigger for testing
app.post('/api/trigger', async (req, res) => {
    if (req.headers['authorization'] !== process.env.API_KEY) {
        return res.status(401).send("Unauthorized");
    }
    // Determine roughly if it's AM or PM logic based on current server time
    const currentHour = new Date().getUTCHours();
    const isMorning = currentHour < 3; // Arbitrary logic for manual trigger
    
    runJob(isMorning);
    res.send(`Job started (Simulating ${isMorning ? 'AM' : 'PM'})`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
