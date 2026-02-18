require('dotenv').config();
const https = require('https');

const apiKey = process.env.GEMINI_API_KEY;
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

https.get(url, (res) => {
    let data = '';

    res.on('data', (chunk) => {
        data += chunk;
    });

    res.on('end', () => {
        try {
            const jsonData = JSON.parse(data);
            if (jsonData.models) {
                console.log("Available 'flash' or 'pro' models:");
                jsonData.models.forEach(model => {
                    if (model.name.includes('flash') || model.name.includes('pro')) {
                        console.log(model.name);
                    }
                });
            } else {
                console.log("No models found or error:", JSON.stringify(jsonData, null, 2));
            }
        } catch (e) {
            console.error(e.message);
        }
    });

}).on('error', (err) => {
    console.error('Error: ' + err.message);
});
