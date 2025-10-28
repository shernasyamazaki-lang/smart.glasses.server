// --- ИМПОРТЫ ---
const express = require('express');
const dotenv = require('dotenv');
const { GoogleAuth } = require('google-auth-library');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const DeepSeek = require('deepseek'); 

// --- НАСТРОЙКА ---
dotenv.config();

const app = express();
const port = 5000;

// Разрешаем серверу читать входящий JSON (для получения текста)
app.use(express.json()); 

// Настройка клиента DeepSeek
const deepseek = new DeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });

// Настройка клиента Google TTS (Синтез речи)
const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});
const ttsClient = new TextToSpeechClient({ auth });

// --- ПЕРЕМЕННЫЕ ПАМЯТИ И КЭША (НОВОЕ!) ---
// 1. ПАМЯТЬ: Хранит историю разговора
let conversationHistory = [];
const MAX_HISTORY_MESSAGES = 10; // Сколько последних сообщений (пар вопрос-ответ) помнить

// 2. КЭШ: Хранит ответы на частые вопросы
const cache = {}; 
const CACHE_EXPIRY_TIME_MS = 3600000; // Кэш действует 1 час (3.6 млн миллисекунд)
// ------------------------------------


// --- НОВЫЙ МАРШРУТ: ПРИЕМ ГОТОВОГО ТЕКСТА ---
app.post('/api/text', async (req, res) => {
    // 1. Получение готового текста от клиента (ESP32)
    const prompt = req.body.text; 

    if (!prompt) {
        return res.status(400).send('Text prompt missing. Expected JSON body: { "text": "..." }');
    }

    // **********************************
    // 2. ПРОВЕРКА КЭША
    // **********************************
    if (cache[prompt] && Date.now() < cache[prompt].expiry) {
        console.log("[CACHE HIT]: Returning cached response.");
        const textResponse = cache[prompt].text;
        
        // Переходим сразу к TTS
        const ttsRequest = {
            input: { text: textResponse },
            voice: { languageCode: 'ru-RU', name: process.env.TTS_VOICE_ID },
            audioConfig: { audioEncoding: 'MP3' },
        };
        const [ttsResponse] = await ttsClient.synthesizeSpeech(ttsRequest);
        
        res.set('Content-Type', 'audio/mpeg');
        res.send(ttsResponse.audioContent);
        
        return; // Заканчиваем, не вызывая DeepSeek
    }


    // **********************************
    // 3. ФОРМИРОВАНИЕ КОНТЕКСТА (ПАМЯТЬ)
    // **********************************
    let messages = [
        // Системное сообщение (инструкции ИИ)
        { role: "system", content: "You are a helpful smart glasses assistant. Keep your answers concise." },
    ];
    
    // Добавляем историю разговора для Памяти
    messages = messages.concat(conversationHistory); 

    // Добавляем новый пользовательский запрос
    messages.push({ role: "user", content: prompt });
    
    
    console.log(`[USER PROMPT]: ${prompt}`);

    try {
        // 4. LLM (DeepSeek): Отправляем сообщения вместе с контекстом
        const llmResponse = await deepseek.chat.completions.create({
            model: 'deepseek-chat', 
            messages: messages, // Используем массив с историей
        });
        const textResponse = llmResponse.choices[0].message.content;
        console.log(`[LLM RESPONSE]: ${textResponse}`);

        // **********************************
        // 5. ОБНОВЛЕНИЕ ПАМЯТИ И КЭША
        // **********************************
        
        // Добавляем ответ в кэш
        cache[prompt] = {
            text: textResponse,
            expiry: Date.now() + CACHE_EXPIRY_TIME_MS
        };

        // Обновляем историю разговора
        conversationHistory.push({ role: "user", content: prompt });
        conversationHistory.push({ role: "assistant", content: textResponse });

        // Ограничиваем историю (оставляем только последние 10 пар)
        if (conversationHistory.length > MAX_HISTORY_MESSAGES * 2) {
            conversationHistory = conversationHistory.slice(conversationHistory.length - MAX_HISTORY_MESSAGES * 2);
        }

        // 6. TTS (Google Cloud): Озвучивание ответа
        const ttsRequest = {
            input: { text: textResponse },
            voice: { languageCode: 'ru-RU', name: process.env.TTS_VOICE_ID },
            audioConfig: { audioEncoding: 'MP3' },
        };
        const [ttsResponse] = await ttsClient.synthesizeSpeech(ttsRequest);
        
        res.set('Content-Type', 'audio/mpeg');
        res.send(ttsResponse.audioContent);

    } catch (error) {
        console.error("Error processing request:", error);
        res.status(500).send("Server error during AI processing.");
    }
});

// --- ЗАПУСК СЕРВЕРА ---
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});