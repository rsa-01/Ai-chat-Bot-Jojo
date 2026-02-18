require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function listModels() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    try {
        // For SDK versions that expose model listing via the client or similar
        // Note: The specific method might vary by SDK version, but let's try to infer or use a generic approach if possible.
        // Actually, the SDK usually has a `getGenerativeModel` but listing might be on the main class or unnecessary if we just test.

        // There isn't a direct "listModels" on the standard GoogleGenerativeAI instance in some versions.
        // However, if we look at the error message: "Call ListModels to see the list of available models".
        // This suggests we might be able to hit the REST API directly if the SDK doesn't make it easy, 
        // OR we can try to guess common ones.

        // Let's try to verify if 'gemini-1.5-flash' works with a simple generateContent call in isolation.
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Test");
        console.log("Success with gemini-1.5-flash");
    } catch (error) {
        console.log("Error with gemini-1.5-flash:", error.message);
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent("Test");
        console.log("Success with gemini-pro");
    } catch (error) {
        console.log("Error with gemini-pro:", error.message);
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro-latest" });
        const result = await model.generateContent("Test");
        console.log("Success with gemini-pro-latest");
    } catch (error) {
        console.log("Error with gemini-pro-latest:", error.message);
    }
}

listModels();
