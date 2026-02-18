require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-this';

// --- Debug Route ---
app.get('/api/debug', (req, res) => {
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    res.json({
        status: 'ok',
        isVercel: !!process.env.VERCEL,
        nodeVersion: process.version,
        hasGeminiKey: !!geminiKey,
        geminiKeyName: process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : (process.env.GOOGLE_GENERATIVE_AI_API_KEY ? 'GOOGLE_GENERATIVE_AI_API_KEY' : 'MISSING'),
        hasJwtSecret: !!process.env.JWT_SECRET,
        cwd: process.cwd()
    });
});

// --- Middleware ---
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
// Use process.cwd() for Vercel compatibility (not __dirname which points to /var/task/api/)
const publicDir = path.join(process.cwd(), 'public');
app.use(express.static(publicDir));

// --- Database Setup ---
// On Vercel: use in-memory store. Locally: use SQLite.
const isVercel = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_VERSION;
let db;

const initializeMockDB = () => {
    console.log('[DB] Using In-Memory Mock Database (Vercel mode)');
    class MockDB {
        constructor() {
            this.users = [];
            this.history = [];
            this._lastID = 0;
        }
        serialize(cb) { if (cb) cb(); }
        run(sql, params = [], cb) {
            if (sql.startsWith('INSERT INTO users')) {
                this._lastID++;
                this.users.push({ id: this._lastID, first_name: params[0], last_name: params[1], email: params[2], password: params[3] });
                if (cb) cb.call({ lastID: this._lastID }, null);
            } else if (sql.startsWith('INSERT INTO chat_history')) {
                this.history.push({ user_id: params[0], message: params[1], sender: params[2], session_id: params[3], timestamp: new Date().toISOString() });
                if (cb) cb(null);
            } else {
                if (cb) cb(null);
            }
        }
        get(sql, params = [], cb) {
            if (sql.includes('WHERE email')) {
                cb(null, this.users.find(u => u.email === params[0]) || null);
            } else if (sql.includes('WHERE id')) {
                cb(null, this.users.find(u => u.id === params[0]) || null);
            } else {
                cb(null, null);
            }
        }
        all(sql, params = [], cb) {
            if (sql.includes('FROM chat_history')) {
                let results = this.history.filter(h => h.user_id === params[0]);
                if (sql.includes('session_id = ?') && params[1]) results = results.filter(h => h.session_id === params[1]);
                if (sql.includes('ORDER BY timestamp DESC')) results = [...results].reverse();
                if (sql.includes('GROUP BY session_id')) {
                    const seen = {};
                    results = this.history.filter(h => h.user_id === params[0] && h.sender === 'user' && !seen[h.session_id] && (seen[h.session_id] = true));
                }
                cb(null, results);
            } else {
                cb(null, []);
            }
        }
    }
    return new MockDB();
};

if (isVercel) {
    db = initializeMockDB();
} else {
    try {
        console.log('[DB] Using SQLite file database (local mode)');
        const sqlite3 = require('sqlite3').verbose();
        const dbFile = path.join(__dirname, '..', 'chatbot.db');
        db = new sqlite3.Database(dbFile);
        db.serialize(() => {
            db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT, last_name TEXT, email TEXT UNIQUE, password TEXT)");
            db.run("CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message TEXT, sender TEXT, session_id TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
        });
    } catch (err) {
        console.error('[DB] SQLite failed, falling back to MockDB:', err.message);
        db = initializeMockDB();
    }
}

// --- Root Route ---
app.get('/', (req, res) => {
    const fs = require('fs');
    const indexPath = path.join(process.cwd(), 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send('<h1>Server is running!</h1><p>index.html not found at: ' + indexPath + '</p><p>cwd: ' + process.cwd() + '</p><p>__dirname: ' + __dirname + '</p>');
    }
});

// --- Auth Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- Register ---
app.post('/api/register', async (req, res) => {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (first_name, last_name, email, password) VALUES (?, ?, ?, ?)",
            [first_name, last_name, email, hashedPassword],
            function (err) {
                if (err) return res.status(400).json({ error: 'Email already registered' });
                res.json({ message: 'User registered', userId: this.lastID });
            }
        );
    } catch (err) {
        res.status(500).json({ error: 'Registration failed: ' + err.message });
    }
});

// --- Login ---
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });
        try {
            const valid = await bcrypt.compare(password, user.password);
            if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
            const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
            res.json({ token, userId: user.id });
        } catch (e) {
            res.status(500).json({ error: 'Login failed: ' + e.message });
        }
    });
});

// --- Chat History ---
app.get('/api/history', authenticateToken, (req, res) => {
    const query = `SELECT session_id, message, timestamp FROM chat_history WHERE id IN (SELECT MIN(id) FROM chat_history WHERE user_id = ? AND sender = 'user' GROUP BY session_id) ORDER BY timestamp DESC`;
    db.all(query, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// --- Session History ---
app.get('/api/session/:sessionId', authenticateToken, (req, res) => {
    const { sessionId } = req.params;
    let query = "SELECT message, sender, timestamp FROM chat_history WHERE user_id = ? AND session_id = ? ORDER BY timestamp ASC";
    let params = [req.user.id, sessionId];
    if (sessionId === 'null' || sessionId === 'undefined') {
        query = "SELECT message, sender, timestamp FROM chat_history WHERE user_id = ? AND session_id IS NULL ORDER BY timestamp ASC";
        params = [req.user.id];
    }
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// --- Cached genAI instance (initialized once, not per-request) ---
let _genAI = null;
const getGenAI = () => {
    if (!_genAI) {
        const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (!key) return null;
        _genAI = new GoogleGenerativeAI(key);
    }
    return _genAI;
};

const SYSTEM_PROMPT = `You are Jojo, a tech assistant. ONLY answer tech questions: coding, web dev, software, hardware, networking, AI/ML, cybersecurity.
For non-tech questions say: "I'm Jojo, your tech assistant! Ask me about coding, software, or hardware!"
Be brief and direct.`;

const GENERATION_CONFIG = {
    maxOutputTokens: 1024,
    temperature: 0.7,
};

// --- Chat ---
app.post('/api/chat', authenticateToken, async (req, res) => {
    try {
        const genAI = getGenAI();
        if (!genAI) {
            return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
        }
        const { message, files, history } = req.body;

        if (!message && (!files || files.length === 0)) {
            return res.status(400).json({ error: 'Message or file is required' });
        }

        // Use client-sent history for multi-turn context (last 10 messages max)
        const formattedHistory = Array.isArray(history) ? history.slice(-10) : [];

        let currentParts = [];
        if (message) currentParts.push({ text: message });
        if (files && files.length > 0) {
            files.forEach(file => {
                if (file.isText) {
                    currentParts.push({ text: `\n\n[File: ${file.name}]\n${file.content}\n` });
                } else {
                    currentParts.push({ inlineData: { mimeType: file.type, data: file.content } });
                }
            });
        }


        // Stream response via SSE
        const models = ["gemini-2.0-flash-lite", "gemini-2.0-flash", "gemini-flash-latest"];
        let lastError;
        let streamed = false;

        for (const modelName of models) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName, systemInstruction: SYSTEM_PROMPT, generationConfig: GENERATION_CONFIG });
                const chat = model.startChat({ history: formattedHistory });

                // Set SSE headers before first chunk
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                const result = await chat.sendMessageStream(currentParts);
                for await (const chunk of result.stream) {
                    const chunkText = chunk.text();
                    if (chunkText) {
                        res.write(`data: ${JSON.stringify({ chunk: chunkText })}\n\n`);
                    }
                }
                res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                res.end();
                streamed = true;
                break;
            } catch (err) {
                console.warn(`Model ${modelName} failed:`, err.message.substring(0, 80));
                lastError = err;
            }
        }

        if (!streamed) throw lastError || new Error("All models failed");

    } catch (error) {
        console.error('Chat error:', error.message);
        if (!res.headersSent) {
            if (error.message.includes('429') || error.message.includes('Quota')) {
                return res.status(429).json({ error: "Too many requests. Please wait a moment." });
            }
            res.status(500).json({ error: "AI Error: " + error.message });
        }
    }
});

// --- Error Handlers ---
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// --- Start Server (local only) ---
if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        console.log('GEMINI_API_KEY:', (process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) ? 'SET' : 'MISSING');
    });
}

module.exports = app;

