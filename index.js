const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { OpenAI } = require('openai');
const cheerio = require('cheerio');
const PDFJson = require('pdf2json');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ==========================================
// ۱. تنظیمات اولیه و پیکربندی متغیرها
// ==========================================
const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// راه‌اندازی دیتابیس SQLite
const db = new sqlite3.Database(path.join(__dirname, 'bot_database.db'), (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to SQLite Database.');
});

// ایجاد جدول کاربران با فیلد لغو مکالمه (is_cancelled)
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            chat_id TEXT PRIMARY KEY,
            model TEXT DEFAULT 'gemini',
            history TEXT DEFAULT '[]',
            is_cancelled INTEGER DEFAULT 0
        )
    `);
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// تابع کمکی ایجاد تاخیر
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// ۲. توابع دیتابیس و مدیریت وضعیت کاربر
// ==========================================
function getUser(chatId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE chat_id = ?", [chatId], (err, row) => {
            if (err) reject(err);
            if (!row) {
                db.run("INSERT INTO users (chat_id) VALUES (?)", [chatId], function(err) {
                    if (err) reject(err);
                    resolve({ chat_id: chatId, model: 'gemini', history: '[]', is_cancelled: 0 });
                });
            } else {
                resolve(row);
            }
        });
    });
}

function updateUserModel(chatId, model) {
    return new Promise((resolve, reject) => {
        db.run("UPDATE users SET model = ? WHERE chat_id = ?", [model, chatId], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
}

function updateHistory(chatId, historyArray) {
    return new Promise((resolve, reject) => {
        const historyStr = JSON.stringify(historyArray);
        db.run("UPDATE users SET history = ? WHERE chat_id = ?", [historyStr, chatId], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
}

function setCancelStatus(chatId, status) {
    return new Promise((resolve, reject) => {
        db.run("UPDATE users SET is_cancelled = ? WHERE chat_id = ?", [status, chatId], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
}

function checkCancelled(chatId) {
    return new Promise((resolve) => {
        db.get("SELECT is_cancelled FROM users WHERE chat_id = ?", [chatId], (err, row) => {
            if (err || !row) resolve(false);
            resolve(row.is_cancelled === 1);
        });
    });
}

// ==========================================
// ۳. توابع ارتباطی با API تلگرام
// ==========================================
async function sendTelegram(method, data) {
    try {
        const response = await fetch(`${TELEGRAM_API}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await response.json();
    } catch (error) {
        console.error(`Error in sendTelegram (${method}):`, error);
        return null;
    }
}

async function sendMessage(chatId, text, replyMarkup = null) {
    const data = { chat_id: chatId, text: text, parse_mode: 'Markdown' };
    if (replyMarkup) data.reply_markup = replyMarkup;
    return await sendTelegram('sendMessage', data);
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const data = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'Markdown' };
    if (replyMarkup) data.reply_markup = replyMarkup;
    return await sendTelegram('editMessageText', data);
}

async function downloadTelegramFile(fileId, destPath) {
    const fileInfo = await sendTelegram('getFile', { file_id: fileId });
    if (!fileInfo || !fileInfo.ok) return false;
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.result.file_path}`;
    const res = await fetch(fileUrl);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buffer));
    return true;
}

// کیبوردهای بهینه‌شده منوها به همراه دکمه لغو مکالمه
const getMainMenu = () => ({
    inline_keyboard: [
        [{ text: "🤖 انتخاب مدل هوش مصنوعی", callback_data: "menu_model" }],
        [{ text: "📁 پردازش فایل و لینک", callback_data: "menu_file" }],
        [{ text: "🧹 پاک کردن حافظه مکالمه", callback_data: "clear_history" }]
    ]
});

const getCancelMenu = () => ({
    inline_keyboard: [
        [{ text: "❌ لغو و قطع پاسخ جاری", callback_data: "cancel_stream" }]
    ]
});

// ==========================================
// ۴. موتورهای استخراج متن و داده (فرمت‌های مختلف)
// ==========================================
async function extractTextFromFile(filePath, fileMime) {
    return new Promise((resolve) => {
        if (fileMime === 'application/pdf') {
            const pdfParser = new PDFJson();
            pdfParser.on("pdfParser_dataError", err => { console.error(err); resolve(""); });
            pdfParser.on("pdfParser_dataReady", pdfData => {
                let text = "";
                pdfData.Pages.forEach(page => {
                    page.Texts.forEach(t => {
                        text += decodeURIComponent(t.R[0].T);
                    });
                });
                resolve(text);
            });
            pdfParser.loadPDF(filePath);
        } else if (fileMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            mammoth.extractRawText({ path: filePath })
                .then(result => resolve(result.value))
                .catch(() => resolve(""));
        } else if (fileMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || fileMime === 'application/vnd.ms-excel') {
            try {
                const workbook = XLSX.readFile(filePath);
                let text = "";
                workbook.SheetNames.forEach(sheetName => {
                    text += XLSX.utils.sheet_to_txt(workbook.Sheets[sheetName]);
                });
                resolve(text);
            } catch { resolve(""); }
        } else {
            resolve("");
        }
    });
}

async function scrapeUrl(url) {
    try {
        const res = await fetch(url);
        const html = await res.text();
        const $ = cheerio.load(html);
        $('script, style, nav, footer').remove();
        return $('body').text().replace(/\s+/g, ' ').trim().substring(0, 8000);
    } catch {
        return null;
    }
}

function splitLongMessage(text, maxLength = 4000) {
    const chunks = [];
    let current = "";
    const lines = text.split('\n');
    for (const line of lines) {
        if ((current + '\n' + line).length > maxLength) {
            chunks.push(current);
            current = line;
        } else {
            current = current ? current + '\n' + line : line;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

// ==========================================
// ۵. کانال‌های ارتباطی با مدل‌های هوش مصنوعی (Streaming)
// ==========================================
async function askGapGPTStream(chatId, prompt, history, onChunk, onEnd) {
    try {
        const messages = history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text }));
        messages.push({ role: 'user', content: prompt });

        const stream = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages,
            stream: true,
        });

        let fullText = "";
        for await (const chunk of stream) {
            // چک کردن وضعیت لغو در هر چانک
            const isCancelled = await checkCancelled(chatId);
            if (isCancelled) {
                break;
            }
            const content = chunk.choices[0]?.delta?.content || "";
            if (content) {
                fullText += content;
                await onChunk(content, fullText);
            }
        }
        onEnd(fullText);
    } catch (error) {
        console.error("GapGPT Stream Error:", error);
        onEnd("خطا در ارتباط با سرور چت‌جی‌پ‌ی‌تی.");
    }
}

async function askGeminiStream(chatId, prompt, history, onChunk, onEnd) {
    try {
        const contents = history.map(h => ({
            role: h.role === 'user' ? 'user' : 'model',
            parts: [{ text: h.text }]
        }));
        contents.push({ role: 'user', parts: [{ text: prompt }] });

        const url = `https://generatelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents })
        });

        const data = await response.json();
        const fullAnswer = data.candidates?.[0]?.content?.parts?.[0]?.text || "پاسخی دریافت نشد.";
        
        // شبیه‌سازی استریم با سرعت بسیار بالا و بهینه (تایپ روان بدون اتلاف وقت)
        const words = fullAnswer.split(/(\s+)/);
        let currentText = "";
        
        for (let i = 0; i < words.length; i++) {
            const isCancelled = await checkCancelled(chatId);
            if (isCancelled) break;

            currentText += words[i];
            
            // افزایش سرعت رندر: هر ۴ کلمه یک‌بار ادیت فرستاده می‌شود و اسلیپ به ۱۰ میلی‌ثانیه کاهش یافته
            if (i % 4 === 0 || i === words.length - 1) {
                await onChunk(words[i], currentText);
                await sleep(10); 
            }
        }
        onEnd(currentText);
    } catch (error) {
        console.error("Gemini Stream Error:", error);
        onEnd("خطا در ارتباط با سرور جمینای.");
    }
}

// ==========================================
// ۶. پردازشگر محوری پیام‌ها (Background Process)
// ==========================================
async function processNormalMessage(chatId, userText, fileObj = null) {
    // بازنشانی وضعیت لغو مکالمه در ابتدای پیام جدید
    await setCancelStatus(chatId, 0);

    const user = await getUser(chatId);
    let history = JSON.parse(user.history || '[]');
    let finalPrompt = userText || "";

    // اگر پیام حاوی فایل بود
    if (fileObj) {
        const initialMsg = await sendMessage(chatId, "⏳ در حال دانلود و آنالیز داکیومنت شما... لطفا منتظر بمانید.");
        const tempPath = path.join(__dirname, `temp_${fileObj.file_id}_${fileObj.file_name}`);
        
        const downloaded = await downloadTelegramFile(fileObj.file_id, tempPath);
        if (downloaded) {
            const extractedText = await extractTextFromFile(tempPath, fileObj.mime_type);
            fs.unlinkSync(tempPath); // پاکسازی بافر سرور

            if (extractedText.trim()) {
                finalPrompt = `[محتوای فایل ارسالی کاربر برای تحلیل]:\n${extractedText}\n\n[درخواست کاربر]:\n${userText || "این فایل را خلاصه و تحلیل کن."}`;
                await editMessage(chatId, initialMsg.result.message_id, "📁 فایل با موفقیت تحلیل شد. در حال تولید پاسخ هوش مصنوعی...");
            } else {
                await editMessage(chatId, initialMsg.result.message_id, "❌ متأسفانه متنی از این فایل استخراج نشد یا فرمت پشتیبانی نمی‌شود.");
                return;
            }
        } else {
            await editMessage(chatId, initialMsg.result.message_id, "❌ خطا در دانلود فایل از سرور تلگرام.");
            return;
        }
    }

    // شناسایی و کراول کردن لینک درون متن
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const match = finalPrompt.match(urlRegex);
    if (match && !fileObj) {
        const initialMsg = await sendMessage(chatId, "🌐 در حال واکشی و مطالعه محتوای لینک... ✍️");
        const scrapedData = await scrapeUrl(match[0]);
        if (scrapedData) {
            finalPrompt = `[محتوای وب‌سایت استخراج شده]:\n${scrapedData}\n\n[درخواست کاربر روی این لینک]:\n${finalPrompt}`;
            await editMessage(chatId, initialMsg.result.message_id, "⚡ محتوای لینک دریافت شد. در حال نوشتن پاسخ...");
        } else {
            await editMessage(chatId, initialMsg.result.message_id, "❌ قادر به خواندن محتوای لینک نبودم (احتمالاً سد ضد ربات یا فیلترینگ وجود دارد).");
        }
    }

    // ارسال پیام اولیه استریم به همراه دکمه لغو
    const draftMsg = await sendMessage(chatId, "در حال نوشتن... ✍️", getCancelMenu());
    let draftMessageId = draftMsg.result.message_id;

    let lastSentText = "";
    let chunkCount = 0;
    let baseText = ""; 

    const onChunkCallback = async (chunk, fullText) => {
        chunkCount++;
        
        // مدیریت سقف ۴۰۹۶ کاراکتری تلگرام در هنگام استریم جاری
        if (fullText.length - baseText.length > 4000) {
            baseText = fullText; 
            await editMessage(chatId, draftMessageId, lastSentText + "\n\n🔄 [ادامه در پیام بعد...]");
            const newDraft = await sendMessage(chatId, "⏳ ادامه پاسخ:\n...", getCancelMenu());
            draftMessageId = newDraft.result.message_id;
        }

        lastSentText = fullText.substring(baseText.length);

        // ارسال بهینه‌سازی شده برای افزایش چشمگیر سرعت نمایش
        if (chunkCount % 3 === 0 && lastSentText.trim()) {
            await editMessage(chatId, draftMessageId, lastSentText + " ✍️", getCancelMenu());
        }
    };

    const onEndCallback = async (finalText) => {
        const isCancelled = await checkCancelled(chatId);
        if (isCancelled) {
            await editMessage(chatId, draftMessageId, lastSentText + "\n\n❌ **مکالمه با موفقیت توسط کاربر قطع شد.**");
            await setCancelStatus(chatId, 0); // ریست کردن فلگ
            return;
        }

        const cleanFinalText = finalText.substring(baseText.length);
        await editMessage(chatId, draftMessageId, cleanFinalText || "پایان مکالمه.");
        
        // ذخیره در تاریخچه مکالمات دیتابیس
        history.push({ role: 'user', text: userText || "[فایل/لینک ارسالی]" });
        history.push({ role: 'model', text: finalText });
        if (history.length > 14) history = history.slice(history.length - 14); // حفظ ظرفیت حافظه
        await updateHistory(chatId, history);
    };

    // سوئیچینگ هوشمند بین کانال‌های مدل
    if (user.model === 'gapgpt') {
        await askGapGPTStream(chatId, finalPrompt, history, onChunkCallback, onEndCallback);
    } else {
        await askGeminiStream(chatId, finalPrompt, history, onChunkCallback, onEndCallback);
    }
}

// ==========================================
// ۷. کنترلر مرکزی وب‌هووک (Webhook Handler)
// ==========================================
app.post('/webhook', (req, res) => {
    // گام اول (حیاتی): پاسخ فوری وضعیت ۲۰۰ به تلگرام جهت قطع قطعیِ لوپ ارسال پیام تکراری
    res.sendStatus(200);

    // گام دوم: پردازش کلابک‌ها و پیام‌ها به صورت کاملاً غیرمسدودکننده (Background Asynchronous)
    const update = req.body;
    if (!update) return;

    // الف) مدیریت کالبک دکمه‌های اینلاین (Inline Keyboards)
    if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message.chat.id;
        const data = cb.data;
        const msgId = cb.message.message_id;

        getUser(chatId).then(async (user) => {
            if (data === "menu_model") {
                const text = `مدل فعلی شما: *${user.model === 'gemini' ? 'Gemini 1.5 Flash' : 'GapGPT (GPT-4o)'}*\nیکی از مدل‌های زیر را انتخاب کنید:`;
                const markup = {
                    inline_keyboard: [
                        [{ text: "✨ Gemini 1.5 Flash (رایگان/سریع)", callback_data: "set_gemini" }],
                        [{ text: "🧠 GapGPT (دقیق/هوشمند)", callback_data: "set_gapgpt" }],
                        [{ text: "🔙 بازگشت به منوی اصلی", callback_data: "main_menu" }]
                    ]
                };
                await editMessage(chatId, msgId, text, markup);
            } 
            else if (data === "set_gemini") {
                await updateUserModel(chatId, 'gemini');
                await editMessage(chatId, msgId, "✅ مدل شما با موفقیت به *Gemini 1.5 Flash* تغییر یافت.", getMainMenu());
            } 
            else if (data === "set_gapgpt") {
                await updateUserModel(chatId, 'gapgpt');
                await editMessage(chatId, msgId, "✅ مدل شما با موفقیت به *GapGPT (GPT-4o Mini)* تغییر یافت.", getMainMenu());
            } 
            else if (data === "menu_file") {
                const text = "📁 **راهنمای ارسال فایل و لینک:**\n\nشما می‌توانید فایل‌های خود را با فرمت‌های زیر برای من بفرستید:\n• `PDF` (کتاب، مقاله و داکیومنت)\n• `Word (DOCX)` \n• `Excel (XLSX)`\n\nهمچنین با فرستادن مستقیم یک لینک وب‌سایت، ربات به طور خودکار متن آن را استخراج و خلاصه می‌کند.";
                await editMessage(chatId, msgId, text, getMainMenu());
            } 
            else if (data === "clear_history") {
                await updateHistory(chatId, []);
                await editMessage(chatId, msgId, "🧹 حافظه مکالمات شما کاملاً پاکسازی شد. می‌توانید مکالمه جدیدی را شروع کنید.", getMainMenu());
            } 
            else if (data === "main_menu" || data === "back_to_main") {
                await editMessage(chatId, msgId, "🤖 به منوی اصلی مدیریت ربات خوش آمدید. گزینه مورد نظر را انتخاب کنید:", getMainMenu());
            }
            else if (data === "cancel_stream") {
                // تریگر آنی فلگ لغو به محض کلیک کاربر روی دکمه شیشه‌ای
                await setCancelStatus(chatId, 1);
            }
        }).catch(console.error);
        return;
    }

    // ب) مدیریت پیام‌های متنی و داکیومنت‌های ارسالی
    if (update.message) {
        const message = update.message;
        const chatId = message.chat.id;
        const text = message.text;

        // هندل کردن دستور صریح لغو مکالمه جاری
        if (text === '/cancel' || text === '/stop') {
            setCancelStatus(chatId, 1).then(() => {
                sendMessage(chatId, "❌ دستور لغو صادر شد. مکالمه جاری در حال متوقف شدن است...");
            });
            return;
        }

        if (text === '/start' || text === '/menu') {
            sendMessage(chatId, "🤖 سلام! به ربات هوش مصنوعی همه‌کاره خوش آمدید. لطفاً یک گزینه را انتخاب کنید یا پیام خود را بفرستید:", getMainMenu());
            return;
        }

        // بررسی وجود فایل پیوست در پیام
        let fileObj = null;
        if (message.document) {
            fileObj = {
                file_id: message.document.file_id,
                file_name: message.document.file_name,
                mime_type: message.document.mime_type
            };
        }

        // هدایت پیام به پردازشگر پس‌زمینه بدون استفاده از await جهت جلوگیری از بلاک شدن سرور
        processNormalMessage(chatId, text, fileObj).catch(err => {
            console.error("Critical error in background processor:", err);
            sendMessage(chatId, "⚠️ مشکلی در پردازش پیام شما به وجود آمد.");
        });
    }
});

// راه‌اندازی لوکال سرور وب‌هووک
app.listen(PORT, () => {
    console.log(`Webhook Server running beautifully on port ${PORT}`);
});
