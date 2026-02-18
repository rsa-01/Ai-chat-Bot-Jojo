require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { TOTP, generateURI } = require('otplib');
const { crypto } = require('@otplib/plugin-crypto-noble');
const { base32 } = require('@otplib/plugin-base32-scure');
const qrcode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-this';

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'))); // Serve frontend files

// Database Setup
const isVercel = process.env.VERCEL === '1';
const dbFile = isVercel ? ':memory:' : path.join(__dirname, '..', 'chatbot.db');
const db = new sqlite3.Database(dbFile);

console.log(`Database source: ${isVercel ? 'In-Memory (Vercel)' : 'Local File'}`);

// Explicit Root Route for Vercel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT, last_name TEXT, email TEXT UNIQUE, password TEXT, secret_2fa TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS chat_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, message TEXT, sender TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id))");
});

// Initialize Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Authentication Middleware
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

// Initialize TOTP Authenticator
const authenticator = new TOTP({
    crypto,
    base32
});

// --- Auth Routes ---

// Register
app.post('/api/register', async (req, res) => {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password) return res.status(400).json({ error: 'All fields are required' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const secret = authenticator.generateSecret(); // Generate 2FA secret immediately
    console.log(`[Register] Generated secret for ${email}: ${secret}`);

    db.run("INSERT INTO users (first_name, last_name, email, password, secret_2fa) VALUES (?, ?, ?, ?, ?)", [first_name, last_name, email, hashedPassword, secret], function (err) {
        if (err) {
            console.error('[Register] DB Error:', err);
            return res.status(400).json({ error: 'Email already registered' });
        }
        console.log(`[Register] User created with ID: ${this.lastID}`);
        // Return the secret so frontend can generate QR code immediately
        res.json({ message: 'User registered', userId: this.lastID, secret: secret });
    });
});

// Setup 2FA (Generate QR Code)
app.post('/api/2fa/setup', (req, res) => {
    const { secret, email } = req.body;

    const otpauth = generateURI({
        label: email,
        issuer: 'Jojo',
        secret
    });

    qrcode.toDataURL(otpauth, (err, imageUrl) => {
        if (err) return res.status(500).json({ error: 'Error generating QR code' });
        res.json({ imageUrl });
    });
});

// Login (Step 1: Verify Password)
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Invalid credentials' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

        // Password correct, require 2FA
        res.json({ message: '2FA required', userId: user.id });
    });
});

// Verify 2FA & Get Token (Step 2)
app.post('/api/2fa/verify', (req, res) => {
    const { userId, token } = req.body;
    console.log(`[2FA Verify] Verifying for details:`, { userId, token });

    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }

    db.get("SELECT * FROM users WHERE id = ?", [userId], async (err, user) => {
        if (err || !user) {
            console.error('[2FA Verify] User not found or DB error:', err);
            return res.status(401).json({ error: 'User not found' });
        }

        console.log(`[2FA Verify] Found user: ${user.email}, hasSecret: ${!!user.secret_2fa}`);

        if (!user.secret_2fa) {
            console.error('[2FA Verify] User has no 2FA secret.');
            return res.status(400).json({ error: '2FA not set up. Please re-register.' });
        }

        // Verify TOTP
        try {
            const isValid = authenticator.verify({ token, secret: user.secret_2fa });
            if (!isValid) return res.status(401).json({ error: 'Invalid 2FA code' });

            // Generate JWT
            const sessionToken = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
            console.log('[2FA Verify] Success, token generated');
            res.json({ token: sessionToken });
        } catch (e) {
            console.error('2FA Verify Error:', e);
            if (e.message.includes('Secret is required')) {
                console.error('[2FA Verify] CRITICAL: Secret is missing for user', userId);
            }
            return res.status(401).json({ error: 'Invalid 2FA code' });
        }
    });
});



// 6. Get Chat Sessions (Unique conversations)
app.get('/api/history', authenticateToken, (req, res) => {
    const query = `
        SELECT session_id, message, timestamp 
        FROM chat_history 
        WHERE id IN (
            SELECT MIN(id) 
            FROM chat_history 
            WHERE user_id = ? AND sender = 'user' 
            GROUP BY session_id
        ) 
        ORDER BY timestamp DESC
    `;

    db.all(query, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        console.log("History rows:", rows);
        res.json(rows);
    });
});

// 7. Get Specific Session History (Continue conversation)
app.get('/api/session/:sessionId', authenticateToken, (req, res) => {
    const { sessionId } = req.params;

    let query = "SELECT message, sender, timestamp FROM chat_history WHERE user_id = ? AND session_id = ? ORDER BY timestamp ASC";
    let params = [req.user.id, sessionId];

    // Handle legacy chats (NULL session_id)
    if (sessionId === 'null' || sessionId === 'undefined') {
        query = "SELECT message, sender, timestamp FROM chat_history WHERE user_id = ? AND session_id IS NULL ORDER BY timestamp ASC";
        params = [req.user.id];
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(rows);
    });
});

// --- Fallback Model Strategy ---
// ... (existing code) ...

// --- Chat Route (Protected) ---
app.post('/api/chat', authenticateToken, async (req, res) => {
    console.log('Received chat request from ' + req.user.email);
    try {
        const { message, files, sessionId } = req.body;

        if (!message && (!files || files.length === 0)) {
            return res.status(400).json({ error: 'Message or file is required' });
        }

        // 1. Fetch Chat History (Last 20 messages for THIS SESSION)
        // If sessionId is missing (old frontend), it falls back to global history or empty
        const historyRows = await new Promise((resolve, reject) => {
            const query = sessionId
                ? "SELECT message, sender FROM chat_history WHERE user_id = ? AND session_id = ? ORDER BY timestamp DESC LIMIT 20"
                : "SELECT message, sender FROM chat_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20";

            const params = sessionId ? [req.user.id, sessionId] : [req.user.id];

            db.all(query, params, (err, rows) => {
                if (err) resolve([]);
                else resolve(rows ? rows.reverse() : []);
            });
        });

        // 2. Format History for Gemini
        let formattedHistory = historyRows.map(row => ({
            role: row.sender === 'user' ? 'user' : 'model',
            parts: [{ text: row.message }]
        }));

        // Validate History: First message must be from 'user'
        while (formattedHistory.length > 0 && formattedHistory[0].role === 'model') {
            formattedHistory.shift();
        }

        // 3. Construct Current Message Parts
        let currentParts = [];
        if (message) {
            currentParts.push({ text: message });
        }
        if (files && files.length > 0) {
            console.log(`Processing ${files.length} attached files...`);
            files.forEach(file => {
                if (file.isText) {
                    currentParts.push({ text: `\n\n[Attached File: ${file.name}]\n${file.content}\n` });
                } else {
                    currentParts.push({
                        inlineData: {
                            mimeType: file.type,
                            data: file.content
                        }
                    });
                }
            });
        }

        // 4. Save User Message to DB with Session ID
        const dbMessage = message + (files ? ` [Attached ${files.length} file(s)]` : '');
        db.run("INSERT INTO chat_history (user_id, message, sender, session_id) VALUES (?, ?, ?, ?)", [req.user.id, dbMessage, 'user', sessionId]);

        // 5. Generate Response with Fallback
        const generateWithFallback = async (history, newParts) => {
            // Expanded model list to avoid rate limits
            const models = [
                "gemini-2.5-flash",
                "gemini-2.5-pro",
                "gemini-2.0-flash",
                "gemini-2.0-flash-lite",
                "gemini-flash-latest"
            ];
            let lastError;

            const systemInstruction = `You are a helpful AI assistant specializing in technology.
            Your goal is to provide accurate, up-to-date, and technical answers.
            If files are attached, analyze them as requested.`;

            for (const modelName of models) {
                try {
                    console.log(`Trying model: ${modelName}`);
                    // System instruction is passed during model initialization
                    const model = genAI.getGenerativeModel({
                        model: modelName,
                        systemInstruction: systemInstruction
                    });

                    const chat = model.startChat({
                        history: history
                    });

                    const result = await chat.sendMessage(newParts);
                    const response = await result.response;
                    return response.text();
                } catch (error) {
                    console.warn(`Model ${modelName} failed:`, error.message);
                    lastError = error;
                    if (error.message.includes('404') || error.message.includes('not found')) {
                        continue;
                    }
                }
            }
            throw lastError || new Error("All models failed");
        };

        const text = await generateWithFallback(formattedHistory, currentParts);

        // 6. Save AI Response
        db.run("INSERT INTO chat_history (user_id, message, sender, session_id) VALUES (?, ?, ?, ?)", [req.user.id, text, 'ai', sessionId]);

        console.log('Response generated successfully');
        res.json({ reply: text });

    } catch (error) {
        console.error('Error with Gemini API:', error);
        if (error.message.includes('429') || error.message.includes('Quota') || error.message.includes('Too Many Requests')) {
            return res.status(429).json({ error: "You are chatting too fast! Please wait a minute before sending another message." });
        }
        res.status(500).json({ error: "AI Server Error: " + (error.message || 'Failed to generate response') });
    }
});

// Prevent crashes from unhandled exceptions
process.on('uncaughtException', (err) => {
    console.error('CRITICAL SERVER ERROR (Uncaught Exception):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL SERVER ERROR (Unhandled Rejection) at:', promise, 'reason:', reason);
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        if (process.env.GEMINI_API_KEY) {
            console.log('API Key detected:', process.env.GEMINI_API_KEY.substring(0, 8) + '...');
        } else {
            console.error('CRITICAL ERROR: GEMINI_API_KEY is missing in environment variables!');
        }
    });
}

module.exports = app;


