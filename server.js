// server.js

// --- 1. ИМПОРТЫ И НАСТРОЙКА ---
const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const { Readable } = require('stream'); // Для потоков
const FormData = require('form-data'); // Для отправки файла в Whisper
require('dotenv').config(); // Загрузка переменных из .env

// Импорт клиента Google Cloud TTS
const { TextToSpeechClient } = require('@google-cloud/text-to-speech'); 

const app = express();
const PORT = 5000;

// Конфигурация Multer: сохранение файлов во временной папке 'uploads'
const upload = multer({ dest: 'uploads/' });

// Получение ключей
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TTS_VOICE_ID = process.env.TTS_VOICE_ID; 

// Инициализация клиента TTS
const ttsClient = new TextToSpeechClient(); 

// Проверка и создание папки uploads
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// --- 2. ФУНКЦИИ API (МОСТЫ К ОБЛАКУ) ---

/**
 * ШАГ 1: Преобразование WAV в Текст с помощью Whisper (OpenAI API).
 */
async function callWhisperApi(filePath) {
    if (!OPENAI_API_KEY) {
        console.error("   [API] Error: OpenAI API Key not configured.");
        return null;
    }

    console.log(`   [API] Calling Whisper with file: ${filePath}`);
    
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('model', 'whisper-1');
    form.append('language', 'ru'); 

    try {
        const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
            },
        });
        return response.data.text;
    } catch (error) {
        console.error(`   [API] Whisper Error: ${error.message}`);
        return null;
    }
}

/**
 * ШАГ 2: Генерация ответа ИИ с помощью DeepSeek.
 */
async function callDeepseekApi(textPrompt) {
    console.log(`   [API] Calling DeepSeek with prompt: ${textPrompt}`);
    
    const SYSTEM_PROMPT = "Ты дружелюбный и краткий голосовой помощник в умных очках. Отвечай кратко, используя не более 40 слов, на русском языке.";
    
    try {
        const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
            model: "deepseek-chat", 
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: textPrompt }
            ],
            max_tokens: 100 
        }, {
            headers: {
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status !== 200 || !response.data.choices || response.data.choices.length === 0) {
            console.error(`   [API] DeepSeek Error: ${response.status}, ${JSON.stringify(response.data)}`);
            return "Извините, у меня проблемы с основным интеллектом.";
        }
        
        return response.data.choices[0].message.content;
        
    } catch (error) {
        console.error(`   [API] DeepSeek Request Error: ${error.message}`);
        return "Извините, я не могу подключиться к основному серверу.";
    }
}

/**
 * ШАГ 3: Генерация Аудио из Текста (TTS) с помощью Google Cloud TTS.
 * Возвращает Readable Stream (поток данных).
 */
async function callTtsApi(textToSpeak) {
    console.log(`   [API] Calling GCTTS with text: ${textToSpeak}`);

    const request = {
        input: { text: textToSpeak },
        // Используем настройки из .env
        voice: { languageCode: 'ru-RU', name: TTS_VOICE_ID || 'ru-RU-Wavenet-D' },
        // Формат MP3
        audioConfig: { audioEncoding: 'MP3' },
    };

    try {
        const [response] = await ttsClient.synthesizeSpeech(request);

        if (!response.audioContent) {
            throw new Error("TTS failed to generate audio.");
        }

        // Преобразование полученного аудио-буфера в поток (Stream)
        const audioBuffer = response.audioContent;
        const audioStream = new Readable();
        audioStream.push(audioBuffer);
        audioStream.push(null); // Сигнал конца потока
        
        return audioStream;

    } catch (error) {
        console.error(`   [API] GCTTS Request Error: ${error.message}`);
        throw new Error("TTS service failed."); 
    }
}


// --- 3. ОСНОВНОЙ ЭНДПОИНТ ДЛЯ ESP32 ---
app.post('/api/voice', upload.single('audio_file'), async (req, res) => {
    
    // Получение временного пути к файлу
    const filePath = req.file ? req.file.path : null;
    console.log(`\n[Core] New request received. File path: ${filePath}`);

    if (!filePath) {
        return res.status(400).send({ error: "No audio file provided. Field name must be 'audio_file'." });
    }

    try {
        // 2. ШАГ: STT (Whisper)
        const transcribedText = await callWhisperApi(filePath);
        
        let finalResponseText;
        if (!transcribedText || transcribedText.trim() === '') {
             console.log("[Core] STT failed or returned empty. Using fallback.");
             finalResponseText = "Извините, я не смог вас услышать. Повторите, пожалуйста.";
        } else {
             console.log(`[Core] Transcribed: "${transcribedText}"`);
             
             // 3. ШАГ: LLM (DeepSeek)
             finalResponseText = await callDeepseekApi(transcribedText);
        }
        
        // 4. ШАГ: TTS (Синтез Речи)
        const audioStream = await callTtsApi(finalResponseText); 

        // 5. ПОТОКОВЫЙ ОТВЕТ НА ESP32
        console.log("[Core] Starting stream response to ESP32...");
        
        // Настраиваем заголовки для потоковой передачи MP3
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Transfer-Encoding', 'chunked'); 
        
        // Перенаправляем аудиопоток напрямую в ответ (res)
        audioStream.pipe(res);
        
        // Обработка ошибок и завершения потока
        audioStream.on('error', (err) => {
            console.error("Audio stream error:", err);
            res.end();
        });
        
        audioStream.on('end', () => {
            console.log("[Core] Stream finished.");
        });

    } catch (e) {
        console.error(`[Core] Server Processing Error: ${e.message}`);
        res.status(500).send({ error: `Внутренняя ошибка сервера: ${e.message}` });
    } finally {
        // ОЧИСТКА: Удаление временного файла
        if (filePath && fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) console.error("File cleanup failed:", err);
                else console.log(`[Core] Cleaned up file: ${filePath}`);
            });
        }
    }
});


// --- 4. ЗАПУСК СЕРВЕРА ---
app.listen(PORT, '0.0.0.0', () => {
    console.log("-----------------------------------------------------");
    console.log(`🔥 AI RELAY SERVER (NODE.JS) IS RUNNING ON http://0.0.0.0:${PORT} 🔥`);
    console.log("Connect ESP32 to http://[YOUR_IP]:5000/api/voice");
    console.log("-----------------------------------------------------");
});