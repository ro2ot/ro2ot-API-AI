const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const dotenv = require('dotenv');
const path = require('path');
const OpenAI = require('openai');
const cheerio = require('cheerio');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const PDFParser = require('pdf2json');

dotenv.config();

const app = express();
app.use(express.json());

let db;
async function initDb() {
    db = await open({
        filename: path.join(__dirname, 'bot.db'),
        driver: sqlite3.Database
    });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            chatId TEXT PRIMARY KEY,
            sessions TEXT DEFAULT '[]',
            currentSessionIndex INTEGER DEFAULT 0,
            waitingFor TEXT,
            currentAI TEXT DEFAULT 'gemini',
            memory TEXT DEFAULT '[]',
            pendingMessage TEXT,
            cancelled INTEGER DEFAULT 0
        )
    `);
    console.log('✅ Database ready');
}
initDb();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GAPGPT_API_KEY = process.env.OPENAI_API_KEY;

const MODEL_NAME = 'gemini-3.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

const gapgptClient = new OpenAI({
    apiKey: GAPGPT_API_KEY,
    baseURL: 'https://api.gapgpt.app/v1'
});

async function sendMessage(chatId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return res.json();
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return res.json();
}

async function sendChatAction(chatId, action = 'typing') {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendChatAction`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action })
    });
    return res.json();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function splitLongMessage(text, maxLength = 4096) {
    if (text.length <= maxLength) return [text];
    const parts = [];
    let current = '';
    const lines = text.split('\n');
    for (const line of lines) {
        if ((current + line).length > maxLength) {
            parts.push(current);
            current = '';
        }
        current += line + '\n';
    }
    if (current) parts.push(current);
    return parts;
}

async function getUser(chatId) {
    let user = await db.get('SELECT * FROM users WHERE chatId = ?', chatId);
    if (!user) {
        const defaultSessions = JSON.stringify([{
            id: 1,
            name: 'مکالمه اصلی',
            history: []
        }]);
        await db.run('INSERT INTO users (chatId, sessions, currentSessionIndex, waitingFor, currentAI, memory, pendingMessage, cancelled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
            chatId, defaultSessions, 0, null, 'gemini', '[]', null, 0);
        user = { chatId, sessions: defaultSessions, currentSessionIndex: 0, waitingFor: null, currentAI: 'gemini', memory: '[]', pendingMessage: null, cancelled: 0 };
    }
    user.sessions = JSON.parse(user.sessions);
    user.memory = JSON.parse(user.memory);
    if (!user.currentAI) {
        user.currentAI = 'gemini';
        await db.run('UPDATE users SET currentAI = ? WHERE chatId = ?', user.currentAI, chatId);
    }
    return user;
}

async function saveUser(chatId, data) {
    await db.run('UPDATE users SET sessions = ?, currentSessionIndex = ?, waitingFor = ?, currentAI = ?, memory = ?, pendingMessage = ?, cancelled = ? WHERE chatId = ?',
        JSON.stringify(data.sessions), data.currentSessionIndex, data.waitingFor || null, data.currentAI, JSON.stringify(data.memory), data.pendingMessage || null, data.cancelled || 0, chatId);
}

// ============================
// دریافت کامل پاسخ از Gemini (با Retry)
// ============================
async function askGeminiFull(history, systemInstruction, photoBase64 = null, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const contents = history.map(msg => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: msg.parts
            }));

            if (photoBase64 && contents.length > 0) {
                const last = contents[contents.length - 1];
                last.parts.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: photoBase64
                    }
                });
            }

            const payload = { contents };
            if (systemInstruction && systemInstruction.length > 0) {
                payload.systemInstruction = {
                    parts: [{ text: systemInstruction }]
                };
            }

            const response = await fetch(GEMINI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await response.json();
            if (!response.ok) {
                let errMsg = data.error?.message || 'Unknown error';
                if (response.status === 429 || response.status === 503) {
                    const waitTime = Math.min(1000 * Math.pow(2, attempt), 8000);
                    console.warn(`⚠️ Gemini (تلاش ${attempt}/${maxRetries}) خطا: ${response.status}, صبر ${waitTime}ms`);
                    await sleep(waitTime);
                    continue;
                }
                throw new Error(`Gemini Error (${response.status}): ${errMsg}`);
            }

            const fullReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!fullReply) throw new Error('پاسخی از Gemini دریافت نشد.');
            return fullReply;
        } catch (error) {
            lastError = error;
            if (error.message && (error.message.includes('429') || error.message.includes('503'))) {
                continue;
            }
            throw error;
        }
    }
    throw new Error(`Gemini بعد از ${maxRetries} تلاش پاسخ نداد: ${lastError?.message || 'Unknown'}`);
}

// ============================
// استریم واقعی برای Weak Model (گپ‌جی‌پی‌تی)
// ============================
async function* askGapGPTStream(history, photoBase64 = null) {
    if (photoBase64) {
        throw new Error('این مدل قابلیت تحلیل عکس را ندارد.');
    }

    const messages = history.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.parts[0]?.text || ''
    }));

    const stream = await gapgptClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages,
        stream: true,
    });

    let accumulated = '';
    for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
            accumulated += content;
            yield accumulated;
        }
    }

    if (!accumulated) throw new Error('پاسخی از گپ‌جی‌پی‌تی دریافت نشد.');
}

async function extractTextFromFile(buffer, mimeType, fileName) {
    try {
        let text = '';
        
        if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
            const pdfParser = new PDFParser();
            let pdfText = '';
            const result = await new Promise((resolve, reject) => {
                pdfParser.on('pdfParser_dataError', reject);
                pdfParser.on('pdfParser_dataReady', (pdfData) => {
                    resolve(pdfData);
                });
                pdfParser.parseBuffer(buffer);
            });
            if (result && result.Pages) {
                result.Pages.forEach(page => {
                    if (page.Texts) {
                        page.Texts.forEach(textItem => {
                            pdfText += decodeURIComponent(textItem.R[0].T) + ' ';
                        });
                    }
                });
            }
            text = pdfText;
        }
        else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || fileName.endsWith('.docx')) {
            const result = await mammoth.extractRawText({ buffer });
            text = result.value;
        }
        else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
                 mimeType === 'application/vnd.ms-excel' ||
                 fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            let allText = '';
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                json.forEach(row => {
                    allText += row.join(' ') + '\n';
                });
            });
            text = allText;
        }
        else if (mimeType === 'text/plain' || fileName.endsWith('.txt')) {
            text = buffer.toString('utf-8');
        }
        else {
            throw new Error('فرمت فایل پشتیبانی نمی‌شود. فقط PDF، Word، Excel و TXT.');
        }

        if (!text || text.trim().length === 0) {
            throw new Error('متن قابل استخراجی از این فایل وجود ندارد.');
        }

        if (text.length > 10000) {
            text = text.slice(0, 10000) + '...\n\n(متن طولانی بود، بخشی از آن نمایش داده شده است.)';
        }

        return text;
    } catch (error) {
        console.error('❌ خطا در استخراج متن:', error);
        throw new Error(`خطا در استخراج متن: ${error.message}`);
    }
}

async function processMessageWithAI(chatId, user, history, userText, photoBase64 = null) {
    const systemInstruction = user.memory.join('\n');
    
    if (user.currentAI === 'gapgpt') {
        const streamGenerator = askGapGPTStream(history, photoBase64);
        return streamGenerator;
    }

    try {
        // دریافت کامل پاسخ از Gemini
        const fullReply = await askGeminiFull(history, systemInstruction, photoBase64, 3);
        // شبیه‌سازی پخش سریع با تکه‌های ۵ کلمه‌ای و تاخیر ۱ میلی‌ثانیه
        return (async function*() {
            const words = fullReply.split(' ');
            let accumulated = '';
            let chunkSize = 5; // هر بار ۵ کلمه اضافه کن
            for (let i = 0; i < words.length; i += chunkSize) {
                const chunk = words.slice(i, i + chunkSize).join(' ');
                accumulated += (i > 0 ? ' ' : '') + chunk;
                yield accumulated.trim();
                await sleep(1); // تاخیر ۱ میلی‌ثانیه (بسیار کم)
            }
        })();
    } catch (error) {
        if (error.message && (error.message.includes('429') || error.message.includes('503'))) {
            user.pendingMessage = userText || 'عکس';
            await saveUser(chatId, user);
            throw new Error('SWITCH_TO_WEAK');
        }
        throw error;
    }
}

async function summarizeLink(url) {
    try {
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (!response.ok) throw new Error('خطا در دریافت صفحه');
        const html = await response.text();
        const $ = cheerio.load(html);
        
        $('script, style, nav, footer, header, aside, .ad, .ads, .banner').remove();
        
        let text = $('body').text();
        text = text.replace(/\s+/g, ' ').trim();
        
        if (text.length > 10000) {
            text = text.slice(0, 10000) + '...';
        }
        
        if (text.length < 100) {
            throw new Error('محتوای کافی برای خلاصه‌سازی وجود ندارد.');
        }

        const summaryPrompt = `لطفاً متن زیر را به‌صورت مختصر و مفید خلاصه کن. خلاصه باید شامل مهم‌ترین نکات باشد:\n\n${text}`;

        let summary = null;
        try {
            const history = [{ role: 'user', parts: [{ text: summaryPrompt }] }];
            const contents = history.map(msg => ({
                role: msg.role === 'user' ? 'user' : 'model',
                parts: msg.parts
            }));
            const payload = { contents };
            const geminiRes = await fetch(GEMINI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await geminiRes.json();
            if (geminiRes.ok) {
                summary = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (summary) return summary;
            }
        } catch (error) {
            console.warn('⚠️ Gemini Error, falling back to Weak Model:', error.message);
        }

        const messages = [
            { role: 'system', content: 'تو یک دستیار خلاصه‌ساز هستی.' },
            { role: 'user', content: summaryPrompt }
        ];
        const weakRes = await gapgptClient.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: messages,
            stream: false,
        });
        summary = weakRes.choices?.[0]?.message?.content;
        if (!summary) throw new Error('خلاصه‌سازی با Weak Model انجام نشد.');
        return summary;
    } catch (error) {
        console.error('❌ خطا در خلاصه‌سازی لینک:', error);
        throw new Error(`خطا در خلاصه‌سازی: ${error.message}`);
    }
}

function mainMenu(currentAI) {
    const aiLabel = currentAI === 'gemini' ? '🤖 Gemini' : '⚡ Weak Model';
    return {
        inline_keyboard: [
            [{ text: `📌 مدل فعلی: ${aiLabel}`, callback_data: 'noop' }],
            [{ text: '🔄 انتخاب مدل', callback_data: 'switch_ai' }],
            [{ text: '📎 خلاصه‌سازی لینک', callback_data: 'summary_link' }],
            [{ text: '📄 پردازش فایل', callback_data: 'file_menu' }],
            [{ text: '🧠 حافظه (Memory)', callback_data: 'memory_menu' }],
            [{ text: '📂 مدیریت مکالمه‌ها', callback_data: 'session_menu' }],
            [{ text: '⛔ لغو پاسخ (Cancel)', callback_data: 'cancel_response' }]
        ]
    };
}

function fileMenu() {
    return {
        inline_keyboard: [
            [{ text: '📝 خلاصه‌سازی فایل', callback_data: 'file_summary' }],
            [{ text: '❓ پرسش از فایل', callback_data: 'file_question' }],
            [{ text: '🔙 برگشت به منو', callback_data: 'back_main' }]
        ]
    };
}

function sessionMenu() {
    return {
        inline_keyboard: [
            [{ text: '📜 تاریخچه فعلی', callback_data: 'view_history' }],
            [{ text: '📋 لیست مکالمه‌ها', callback_data: 'list_sessions' }],
            [{ text: '✏️ تغییر نام مکالمه', callback_data: 'rename_session' }],
            [{ text: '🗑️ حذف مکالمه فعلی', callback_data: 'delete_session' }],
            [{ text: '➕ مکالمه جدید', callback_data: 'new_session' }],
            [{ text: '🔙 برگشت به منو', callback_data: 'back_main' }]
        ]
    };
}

function memoryMenu() {
    return {
        inline_keyboard: [
            [{ text: '📝 افزودن حافظه جدید', callback_data: 'add_memory' }],
            [{ text: '📋 مشاهده حافظه‌ها', callback_data: 'view_memory' }],
            [{ text: '🗑️ حذف یک حافظه', callback_data: 'delete_memory' }],
            [{ text: '🔙 برگشت به منو', callback_data: 'back_main' }]
        ]
    };
}

function aiSelectionMenu() {
    return {
        inline_keyboard: [
            [{ text: '🤖 Gemini', callback_data: 'set_ai_gemini' }],
            [{ text: '⚡ Weak Model', callback_data: 'set_ai_gapgpt' }],
            [{ text: '🔙 برگشت به منو', callback_data: 'back_main' }]
        ]
    };
}

function sessionsListMenu(sessions, currentIndex) {
    const buttons = sessions.map((s, index) => {
        const isActive = index === currentIndex;
        return [{ text: `${isActive ? '✅ ' : ''}${s.name}`, callback_data: `switch_${index}` }];
    });
    buttons.push([{ text: '🔙 برگشت به منو', callback_data: 'back_main' }]);
    return { inline_keyboard: buttons };
}

function backToMenuButton() {
    return {
        inline_keyboard: [
            [{ text: '🔙 برگشت به منو', callback_data: 'back_main' }]
        ]
    };
}

function switchToWeakMenu(pendingMessage) {
    return {
        inline_keyboard: [
            [{ text: '✅ بله، سوئیچ کن', callback_data: 'confirm_switch_to_weak' }],
            [{ text: '❌ نه، فقط خطا رو نشون بده', callback_data: 'cancel_switch_to_weak' }]
        ]
    };
}

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

    const body = req.body;
    if (!body) return;

    if (body.callback_query) {
        const query = body.callback_query;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const data = query.data;
        let user = await getUser(chatId);

        try {
            if (data === 'noop') return;

            if (data === 'back_main') {
                await editMessage(chatId, messageId, '🏠 **منوی اصلی:**', mainMenu(user.currentAI));
                return;
            }

            if (data === 'switch_ai') {
                await editMessage(chatId, messageId, '🤖 **انتخاب هوش مصنوعی:**', aiSelectionMenu());
                return;
            }

            if (data === 'set_ai_gemini') {
                user.currentAI = 'gemini';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '✅ **هوش مصنوعی به Gemini تغییر یافت.**', mainMenu('gemini'));
                return;
            }

            if (data === 'set_ai_gapgpt') {
                user.currentAI = 'gapgpt';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '✅ **هوش مصنوعی به Weak Model تغییر یافت.**', mainMenu('gapgpt'));
                return;
            }

            if (data === 'summary_link') {
                user.waitingFor = 'summary_link';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '📎 **لینک مورد نظر را ارسال کنید تا خلاصه‌سازی کنم.**', backToMenuButton());
                return;
            }

            if (data === 'file_menu') {
                await editMessage(chatId, messageId, '📄 **پردازش فایل:**\n\n' +
                    '• **خلاصه‌سازی:** فایل رو بفرستید تا خلاصه کنم.\n' +
                    '• **پرسش از فایل:** فایل رو بفرستید و سوال خودتون رو بپرسید.\n\n' +
                    '📌 فرمت‌های پشتیبانی‌شده: PDF, Word, Excel, TXT',
                    fileMenu()
                );
                return;
            }

            if (data === 'file_summary') {
                user.waitingFor = 'file_summary';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '📝 **لطفاً فایل را ارسال کنید تا خلاصه‌سازی کنم.**\n\n' +
                    '📌 فرمت‌های پشتیبانی‌شده: PDF, Word, Excel, TXT', backToMenuButton());
                return;
            }

            if (data === 'file_question') {
                user.waitingFor = 'file_question';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '❓ **لطفاً فایل را ارسال کنید و سپس سوال خود را بپرسید.**\n\n' +
                    'مثال: بعد از ارسال فایل، سوال خود را به صورت متن بنویسید.', backToMenuButton());
                return;
            }

            if (data === 'memory_menu') {
                await editMessage(chatId, messageId, '🧠 **مدیریت حافظه:**\n\n' +
                    'حافظه‌ها دستورات سیستمی هستند که Gemini همیشه به خاطر می‌سپارد.\n' +
                    'مثال: "من برنامه‌نویس هستم" یا "پاسخ‌ها را کوتاه بده".',
                    memoryMenu()
                );
                return;
            }

            if (data === 'add_memory') {
                user.waitingFor = 'add_memory';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '📝 **متن حافظه جدید را وارد کنید:**', backToMenuButton());
                return;
            }

            if (data === 'view_memory') {
                const memoryList = user.memory;
                if (memoryList.length === 0) {
                    await sendMessage(chatId, '🧠 **هیچ حافظه‌ای ذخیره نشده است.**', backToMenuButton());
                } else {
                    const formatted = memoryList.map((m, i) => `${i+1}. ${m}`).join('\n');
                    await sendMessage(chatId, `🧠 **حافظه‌های شما:**\n\n${formatted}`, backToMenuButton());
                }
                return;
            }

            if (data === 'delete_memory') {
                const memoryList = user.memory;
                if (memoryList.length === 0) {
                    await sendMessage(chatId, '🧠 **هیچ حافظه‌ای برای حذف وجود ندارد.**', backToMenuButton());
                } else {
                    user.waitingFor = 'delete_memory';
                    await saveUser(chatId, user);
                    const formatted = memoryList.map((m, i) => `${i+1}. ${m}`).join('\n');
                    await editMessage(chatId, messageId, `🗑️ **شماره حافظه‌ای که می‌خواهید حذف کنید را وارد کنید:**\n\n${formatted}`,
                        backToMenuButton()
                    );
                }
                return;
            }

            if (data === 'session_menu') {
                await editMessage(chatId, messageId, '📂 **مدیریت مکالمه‌ها:**', sessionMenu());
                return;
            }

            if (data === 'view_history') {
                const session = user.sessions[user.currentSessionIndex];
                const history = session.history || [];
                if (history.length === 0) {
                    await sendMessage(chatId, '📭 **تاریخچه‌ای وجود ندارد.**', backToMenuButton());
                } else {
                    const lastMessages = history.slice(-5).map(m => 
                        `**${m.role}**: ${m.parts[0]?.text?.slice(0, 150) || '...'}`
                    ).join('\n\n');
                    await sendMessage(chatId, `📜 **تاریخچه (۵ پیام آخر) از "${session.name}":**\n\n${lastMessages}`, backToMenuButton());
                }
                return;
            }

            if (data === 'list_sessions') {
                if (user.sessions.length === 0) {
                    await sendMessage(chatId, '📭 **هیچ مکالمه‌ای ذخیره نشده است.**', backToMenuButton());
                } else {
                    await editMessage(chatId, messageId, '📋 **لیست مکالمه‌ها:**', sessionsListMenu(user.sessions, user.currentSessionIndex));
                }
                return;
            }

            if (data === 'rename_session') {
                user.waitingFor = 'rename';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '✏️ **نام جدید مکالمه را وارد کنید:**', backToMenuButton());
                return;
            }

            if (data === 'delete_session') {
                if (user.sessions.length === 1) {
                    await sendMessage(chatId, '⚠️ **شما فقط یک مکالمه دارید و نمی‌توانید آن را حذف کنید.**', backToMenuButton());
                    return;
                }
                const currentIndex = user.currentSessionIndex;
                user.sessions.splice(currentIndex, 1);
                if (currentIndex >= user.sessions.length) {
                    user.currentSessionIndex = user.sessions.length - 1;
                }
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '🗑️ **مکالمه حذف شد.**', mainMenu(user.currentAI));
                return;
            }

            if (data === 'new_session') {
                if (user.sessions.length >= 20) {
                    await sendMessage(chatId, '⚠️ **حداکثر ۲۰ مکالمه مجاز است.**', backToMenuButton());
                    return;
                }
                const newSession = {
                    id: Date.now(),
                    name: `مکالمه ${user.sessions.length + 1}`,
                    history: []
                };
                user.sessions.push(newSession);
                user.currentSessionIndex = user.sessions.length - 1;
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '✅ **مکالمه جدید ایجاد شد.**', mainMenu(user.currentAI));
                return;
            }

            if (data === 'cancel_response') {
                user.cancelled = 1;
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '⛔ **درخواست لغو پاسخ ثبت شد.**\n' +
                    'اگر ربات در حال تولید پاسخ بود، به‌زودی متوقف می‌شود.', mainMenu(user.currentAI));
                return;
            }

            if (data.startsWith('switch_')) {
                const index = parseInt(data.split('_')[1]);
                if (index >= 0 && index < user.sessions.length) {
                    user.currentSessionIndex = index;
                    await saveUser(chatId, user);
                    await editMessage(chatId, messageId, `✅ **به "${user.sessions[index].name}" تغییر کرد.**`, mainMenu(user.currentAI));
                }
                return;
            }

            if (data === 'confirm_switch_to_weak') {
                user.currentAI = 'gapgpt';
                const pendingMsg = user.pendingMessage;
                user.pendingMessage = null;
                await saveUser(chatId, user);

                await editMessage(chatId, messageId, '✅ **سوئیچ به Weak Model انجام شد.**\nدر حال پردازش مجدد پیام...');

                const session = user.sessions[user.currentSessionIndex];
                if (session.history.length > 0 && session.history[session.history.length - 1].role === 'user') {
                    session.history.pop();
                }
                await saveUser(chatId, user);

                setTimeout(async () => {
                    await processNormalMessage(chatId, pendingMsg, null);
                }, 1000);
                return;
            }

            if (data === 'cancel_switch_to_weak') {
                user.pendingMessage = null;
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '❌ **سوئیچ انجام نشد.**\n\nمی‌توانید بعداً از منوی «انتخاب مدل» به Weak Model سوئیچ کنید.', backToMenuButton());
                return;
            }

        } catch (error) {
            console.error('❌ Error in callback:', error);
            await sendMessage(chatId, '❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
        }
        return;
    }

    if (body.message) {
        const message = body.message;
        const chatId = message.chat.id;
        const text = message.text;
        const photo = message.photo;
        const caption = message.caption;
        const document = message.document;

        let user = await getUser(chatId);
        const userText = text || caption || '';

        if (user.cancelled === 1) {
            user.cancelled = 0;
            await saveUser(chatId, user);
        }

        if (document) {
            const fileName = document.file_name || 'unknown';
            const mimeType = document.mime_type || '';

            if (user.waitingFor === 'file_summary' || user.waitingFor === 'file_question') {
                try {
                    await sendChatAction(chatId, 'typing');
                    
                    const fileId = document.file_id;
                    const fileInfo = await fetch(
                        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
                    ).then(r => r.json());
                    if (!fileInfo.ok) {
                        throw new Error('خطا در دریافت فایل');
                    }
                    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
                    const fileRes = await fetch(fileUrl);
                    if (!fileRes.ok) {
                        throw new Error('خطا در دانلود فایل');
                    }
                    const buffer = await fileRes.arrayBuffer();
                    const fileBuffer = Buffer.from(buffer);

                    const extractedText = await extractTextFromFile(fileBuffer, mimeType, fileName);
                    
                    const session = user.sessions[user.currentSessionIndex];
                    const history = session.history || [];
                    
                    if (user.waitingFor === 'file_question') {
                        user.waitingFor = 'file_question_answer';
                        user.pendingMessage = extractedText;
                        await saveUser(chatId, user);
                        await sendMessage(chatId, `✅ **متن فایل استخراج شد.** (${extractedText.length} کاراکتر)\n\n📝 **حالا سوال خود را بپرسید.**`, backToMenuButton());
                        return;
                    }

                    if (user.waitingFor === 'file_summary') {
                        user.waitingFor = null;
                        await saveUser(chatId, user);

                        const summaryPrompt = `لطفاً متن زیر را به‌صورت مختصر و مفید خلاصه کن:\n\n${extractedText}`;
                        history.push({ role: 'user', parts: [{ text: summaryPrompt }] });
                        
                        try {
                            const streamGenerator = await processMessageWithAI(chatId, user, history, summaryPrompt, null);
                            await sendStreamingResponse(chatId, streamGenerator, user, summaryPrompt);
                            
                            history.push({ role: 'model', parts: [{ text: global.fullReply || 'پاسخی دریافت نشد.' }] });
                            if (history.length > 10) {
                                session.history = history.slice(-10);
                            } else {
                                session.history = history;
                            }
                            await saveUser(chatId, user);
                        } catch (error) {
                            console.error('❌ Error in file summary:', error);
                            await sendMessage(chatId, `❌ **خطا:** ${error.message}`, backToMenuButton());
                        }
                        return;
                    }
                } catch (error) {
                    console.error('❌ خطا در پردازش فایل:', error);
                    user.waitingFor = null;
                    await saveUser(chatId, user);
                    await sendMessage(chatId, `❌ **خطا در پردازش فایل:** ${error.message}`, backToMenuButton());
                }
                return;
            } else {
                await sendMessage(chatId, '📄 **فایل دریافت شد.**\n\nبرای پردازش فایل، ابتدا از منوی «📄 پردازش فایل» گزینه مورد نظر را انتخاب کنید.', backToMenuButton());
                return;
            }
        }

        if (user.waitingFor === 'file_question_answer' && user.pendingMessage) {
            const extractedText = user.pendingMessage;
            const question = userText;
            if (!question || question.length < 2) {
                await sendMessage(chatId, '❌ **لطفاً یک سوال معتبر بپرسید.**');
                return;
            }

            user.waitingFor = null;
            const session = user.sessions[user.currentSessionIndex];
            const history = session.history || [];
            
            const questionPrompt = `متن زیر را بخوان و به سوال پاسخ بده:\n\nفایل: ${extractedText}\n\nسوال: ${question}`;
            history.push({ role: 'user', parts: [{ text: questionPrompt }] });

            try {
                const streamGenerator = await processMessageWithAI(chatId, user, history, questionPrompt, null);
                await sendStreamingResponse(chatId, streamGenerator, user, questionPrompt);
                
                history.push({ role: 'model', parts: [{ text: global.fullReply || 'پاسخی دریافت نشد.' }] });
                if (history.length > 10) {
                    session.history = history.slice(-10);
                } else {
                    session.history = history;
                }
                await saveUser(chatId, user);

                user.pendingMessage = null;
                await saveUser(chatId, user);

            } catch (error) {
                console.error('❌ Error processing question:', error);
                user.pendingMessage = null;
                await saveUser(chatId, user);
                await sendMessage(chatId, `❌ **خطا:** ${error.message}`);
            }
            return;
        }

        if (user.waitingFor === 'rename') {
            if (!userText) {
                await sendMessage(chatId, '❌ **لطفاً یک نام معتبر وارد کنید.**');
                return;
            }
            const session = user.sessions[user.currentSessionIndex];
            session.name = userText.slice(0, 50);
            user.waitingFor = null;
            await saveUser(chatId, user);
            await sendMessage(chatId, `✅ **نام مکالمه به "${session.name}" تغییر یافت.**`, mainMenu(user.currentAI));
            return;
        }

        if (user.waitingFor === 'add_memory') {
            if (!userText) {
                await sendMessage(chatId, '❌ **لطفاً یک متن معتبر وارد کنید.**');
                return;
            }
            user.memory.push(userText);
            user.waitingFor = null;
            await saveUser(chatId, user);
            await sendMessage(chatId, `✅ **حافظه جدید اضافه شد:**\n"${userText}"`, mainMenu(user.currentAI));
            return;
        }

        if (user.waitingFor === 'delete_memory') {
            const index = parseInt(userText) - 1;
            if (isNaN(index) || index < 0 || index >= user.memory.length) {
                await sendMessage(chatId, '❌ **شماره نامعتبر. لطفاً شماره درست را وارد کنید.**');
                return;
            }
            const deleted = user.memory[index];
            user.memory.splice(index, 1);
            user.waitingFor = null;
            await saveUser(chatId, user);
            await sendMessage(chatId, `🗑️ **حافظه حذف شد:**\n"${deleted}"`, mainMenu(user.currentAI));
            return;
        }

        if (user.waitingFor === 'summary_link') {
            if (!userText || !userText.startsWith('http')) {
                await sendMessage(chatId, '❌ **لطفاً یک لینک معتبر ارسال کنید.**');
                return;
            }
            user.waitingFor = null;
            await saveUser(chatId, user);
            await sendChatAction(chatId, 'typing');
            try {
                const summary = await summarizeLink(userText);
                const parts = splitLongMessage(summary);
                for (const part of parts) {
                    await sendMessage(chatId, `📎 **خلاصه‌ی لینک:**\n\n${part}`, backToMenuButton());
                }
            } catch (error) {
                await sendMessage(chatId, `❌ **خطا در خلاصه‌سازی:** ${error.message}`, backToMenuButton());
            }
            return;
        }

        if (userText === '/start') {
            const welcome = '🌟 **به Gemrox خوش آمدید!** 🌟';
            await sendMessage(chatId, welcome, {
                inline_keyboard: [
                    [{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]
                ]
            });
            return;
        }

        if (userText === '/menu') {
            await sendMessage(chatId, '🏠 **منوی اصلی:**', mainMenu(user.currentAI));
            return;
        }

        if (userText === '/stop') {
            user.cancelled = 1;
            await saveUser(chatId, user);
            await sendMessage(chatId, '⛔ **درخواست لغو پاسخ ثبت شد.** اگر ربات در حال تولید پاسخ بود، به‌زودی متوقف می‌شود.', mainMenu(user.currentAI));
            return;
        }

        if (userText === '/clear_all' && chatId === 1111913932) {
            await db.run('DELETE FROM users');
            await sendMessage(chatId, '🧹 **کل دیتابیس پاک شد!**');
            return;
        }

        await processNormalMessage(chatId, userText, photo);
        return;
    }
});

let fullReply = '';

async function processNormalMessage(chatId, userText, photo) {
    let user = await getUser(chatId);
    const session = user.sessions[user.currentSessionIndex];
    const history = session.history || [];

    const userMsg = {
        role: 'user',
        parts: [{ text: userText || 'لطفاً این عکس را تحلیل کن.' }]
    };
    history.push(userMsg);
    await saveUser(chatId, user);

    let photoBase64 = null;
    if (photo) {
        try {
            const fileId = photo[photo.length - 1].file_id;
            const fileInfo = await fetch(
                `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
            ).then(r => r.json());
            if (!fileInfo.ok) {
                throw new Error(`خطا در دریافت اطلاعات عکس: ${fileInfo.description || 'Unknown'}`);
            }
            const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
            const imgRes = await fetch(fileUrl);
            if (!imgRes.ok) {
                throw new Error(`خطا در دانلود عکس: ${imgRes.status}`);
            }
            const buffer = await imgRes.arrayBuffer();
            photoBase64 = Buffer.from(buffer).toString('base64');
        } catch (error) {
            console.error('❌ خطا در پردازش عکس:', error);
            await sendMessage(chatId, `⚠️ **خطا در پردازش عکس:** ${error.message}`);
            return;
        }
    }

    try {
        const streamGenerator = await processMessageWithAI(chatId, user, history, userText, photoBase64);
        await sendStreamingResponse(chatId, streamGenerator, user, userText);
        
        const modelMsg = {
            role: 'model',
            parts: [{ text: global.fullReply || 'پاسخی دریافت نشد.' }]
        };
        history.push(modelMsg);

        if (history.length > 10) {
            session.history = history.slice(-10);
        } else {
            session.history = history;
        }

        await saveUser(chatId, user);

    } catch (error) {
        console.error('❌ Error processing message:', error);
        
        if (error.message === 'SWITCH_TO_WEAK') {
            // سوئیچ خودکار به Weak Model
            user.currentAI = 'gapgpt';
            user.pendingMessage = null;
            await saveUser(chatId, user);
            
            if (session.history.length > 0 && session.history[session.history.length - 1].role === 'user') {
                session.history.pop();
            }
            await saveUser(chatId, user);
            
            await sendMessage(chatId, '🔄 **سوئیچ خودکار به Weak Model انجام شد.**\nدر حال پردازش مجدد...');
            
            setTimeout(async () => {
                await processNormalMessage(chatId, userText, photo);
            }, 1500);
            return;
        }

        let errorMessage = error.message || 'خطای ناشناخته';
        if (error.message && error.message.includes('429')) {
            errorMessage = '⚠️ **محدودیت درخواست Gemini پر شده است.** لطفاً چند دقیقه صبر کنید.';
        } else if (error.message && error.message.includes('503')) {
            errorMessage = '⚠️ **سرور Gemini شلوغ است.** لطفاً چند دقیقه دیگر تلاش کنید.';
        } else if (error.message && error.message.includes('401')) {
            errorMessage = '⚠️ **خطا در احراز هویت.** لطفاً کلید API را بررسی کنید.';
        } else if (error.message && error.message.includes('عکس')) {
            errorMessage = `⚠️ **خطا در پردازش عکس.** ${error.message}`;
        } else {
            errorMessage = `❌ **خطا:** ${errorMessage}`;
        }
        await sendMessage(chatId, errorMessage);
    }
}

async function sendStreamingResponse(chatId, streamGenerator, user, userText) {
    let firstChunk = true;
    let draftMessageId = null;
    let fullReply = '';
    let currentMessageLength = 0;
    const MAX_MESSAGE_LENGTH = 3900;
    let messageCount = 0;

    try {
        for await (const chunk of streamGenerator) {
            // چک کردن لغو
            const freshUser = await getUser(chatId);
            if (freshUser.cancelled === 1) {
                freshUser.cancelled = 0;
                await saveUser(chatId, freshUser);
                if (draftMessageId) {
                    await editMessage(chatId, draftMessageId, fullReply + '\n\n⛔ **تولید پاسخ متوقف شد.**');
                } else {
                    await sendMessage(chatId, '⛔ **تولید پاسخ متوقف شد.**');
                }
                global.fullReply = fullReply || 'پاسخ متوقف شد.';
                return;
            }

            if (!chunk || chunk.trim() === '') continue;

            fullReply = chunk;
            currentMessageLength = fullReply.length;

            if (firstChunk) {
                const initialMsg = await sendMessage(chatId, chunk + ' ✍️');
                draftMessageId = initialMsg.result.message_id;
                firstChunk = false;
                messageCount = 1;
            } else if (currentMessageLength > MAX_MESSAGE_LENGTH) {
                // نهایی کردن پیام فعلی و شروع پیام جدید
                await sendMessage(chatId, fullReply);
                draftMessageId = null;
                firstChunk = true;
                fullReply = '';
                currentMessageLength = 0;
                messageCount++;
                continue;
            } else {
                try {
                    await editMessage(chatId, draftMessageId, chunk + ' ✍️');
                } catch (editError) {
                    // اگر خطا در ویرایش بود، پیام جدید بفرست
                    console.warn('⚠️ خطا در ویرایش، ارسال پیام جدید:', editError.message);
                    await sendMessage(chatId, chunk + ' ✍️');
                    draftMessageId = null;
                    firstChunk = true;
                    fullReply = '';
                    currentMessageLength = 0;
                    messageCount++;
                    continue;
                }
            }
        }
    } catch (error) {
        console.error('❌ خطا در استریم:', error);
        if (draftMessageId && fullReply) {
            await editMessage(chatId, draftMessageId, fullReply + '\n\n⚠️ **پاسخ ناقص دریافت شد.**');
        } else if (fullReply) {
            await sendMessage(chatId, fullReply + '\n\n⚠️ **پاسخ ناقص دریافت شد.**');
        }
        global.fullReply = fullReply || 'خطا در تولید پاسخ.';
        return;
    }

    // نهایی کردن آخرین پیام
    if (draftMessageId) {
        await editMessage(chatId, draftMessageId, fullReply);
    } else if (fullReply) {
        await sendMessage(chatId, fullReply);
    }

    global.fullReply = fullReply || 'پاسخی دریافت نشد.';
}

async function setCommands() {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`;
    const commands = [
        { command: 'start', description: 'شروع مجدد' },
        { command: 'menu', description: 'نمایش منوی اصلی' },
        { command: 'stop', description: 'لغو پاسخ در حال تولید' }
    ];
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands })
    });
    const data = await res.json();
    console.log('✅ Menu commands set:', data);
}

setCommands().catch(console.error);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 Gemrox bot running on port ${PORT}`);
    console.log(`📡 Models: Gemini (پاسخ کامل + پخش سریع) + Weak Model (استریم واقعی)`);
    console.log(`📎 Link summarizer enabled.`);
    console.log(`📄 File processor enabled (PDF, Word, Excel, TXT).`);
    console.log(`⛔ Cancel/Stop feature enabled.`);
    console.log(`🔄 Auto-retry on 429/503 errors (3 attempts)`);
    console.log(`⚡ Fast streaming: chunk size 5 words, 1ms delay`);
});
