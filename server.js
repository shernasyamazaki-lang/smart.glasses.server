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

// **********************************************
// * ВАЖНО: Разрешаем серверу читать входящий JSON *
app.use(express.json()); 
// **********************************************

// Настройка клиента DeepSeek
const deepseek = new DeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });

// Настройка клиента Google TTS (Синтез речи)
// Используем GoogleAuth для работы с переменной GOOGLE_APPLICATION_CREDENTIALS
const auth = new GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform']
});
const ttsClient = new TextToSpeechClient({ auth });

// --- НОВЫЙ МАРШРУТ: ПРИЕМ ГОТОВОГО ТЕКСТА ---
app.post('/api/text', async (req, res) => {
    // 1. Получение готового текста от клиента (ESP32)
    const prompt = req.body.text; // Ожидаем JSON: { "text": "Ваш вопрос" }

    if (!prompt) {
        // Ошибка, если текст не пришел
        return res.status(400).send('Text prompt missing. Expected JSON body: { "text": "..." }');
    }

    console.log(`[USER PROMPT]: ${prompt}`);

    try {
        // 2. LLM (DeepSeek): Получение ответа
        const llmResponse = await deepseek.chat.completions.create({
            model: 'deepseek-chat', 
            messages: [{ role: 'user', content: prompt }],
        });
        const textResponse = llmResponse.choices[0].message.content;
        console.log(`[LLM RESPONSE]: ${textResponse}`);

        // 3. TTS (Google Cloud): Озвучивание ответа
        // ***************************************************************
        // * ВСТАВЬТЕ СЮДА ВАШ РАБОЧИЙ КОД ДЛЯ TTS (СИНТЕЗ РЕЧИ)       *
        // ***************************************************************
        
        // Пример блока, который вы должны заменить на свой:
        /*
        const ttsRequest = {
            input: { text: textResponse },
            voice: { languageCode: 'ru-RU', name: process.env.TTS_VOICE_ID },
            audioConfig: { audioEncoding: 'MP3' },
        };
        const [ttsResponse] = await ttsClient.synthesizeSpeech(ttsRequest);
        
        // Отправка MP3-файла клиенту
        res.set('Content-Type', 'audio/mpeg');
        res.send(ttsResponse.audioContent);
        */

    } catch (error) {
        console.error("Error processing request:", error);
        res.status(500).send("Server error during AI processing.");
    }
});

// --- ЗАПУСК СЕРВЕРА ---
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});