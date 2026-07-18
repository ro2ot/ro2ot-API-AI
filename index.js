const express = require('express');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const dotenv = require('dotenv');
const path = require('path');
const OpenAI = require('openai');
const cheerio = require('cheerio');

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
            pendingMessage TEXT
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
        await db.run('INSERT INTO users (chatId, sessions, currentSessionIndex, waitingFor, currentAI, memory, pendingMessage) VALUES (?, ?, ?, ?, ?, ?, ?)', 
            chatId, defaultSessions, 0, null, 'gemini', '[]', null);
        user = { chatId, sessions: defaultSessions, currentSessionIndex: 0, waitingFor: null, currentAI: 'gemini', memory: '[]', pendingMessage: null };
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
    await db.run('UPDATE users SET sessions = ?, currentSessionIndex = ?, waitingFor = ?, currentAI = ?, memory = ?, pendingMessage = ? WHERE chatId = ?',
        JSON.stringify(data.sessions), data.currentSessionIndex, data.waitingFor || null, data.currentAI, JSON.stringify(data.memory), data.pendingMessage || null, chatId);
}

async function* askGeminiStream(history, systemInstruction, photoBase64 = null) {
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
        throw new Error(`Gemini Error (${response.status}): ${errMsg}`);
    }
    const fullReply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!fullReply) throw new Error('پاسخی از Gemini دریافت نشد.');

    const words = fullReply.split(' ');
    let accumulated = '';
    for (const word of words) {
        accumulated += word + ' ';
        yield accumulated.trim();
        await sleep(30);
    }
}

async function* askGapGPTStream(history, photoBase64 = null) {
    if (photoBase64) {
        throw new Error('این مدل قابلیت تحلیل عکس را ندارد. لطفاً از Gemini استفاده کنید.');
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

// ============================
// تابع پردازش پیام (با مدیریت خطا و پیشنهاد سوئیچ)
// ============================
async function processMessageWithAI(chatId, user, history, userText, photoBase64 = null) {
    const systemInstruction = user.memory.join('\n');
    
    // اگر مدل فعلی Weak Model هست، مستقیم برو
    if (user.currentAI === 'gapgpt') {
        const streamGenerator = askGapGPTStream(history, photoBase64);
        return streamGenerator;
    }

    // اگر مدل فعلی Gemini هست، امتحان کن
    try {
        const streamGenerator = askGeminiStream(history, systemInstruction, photoBase64);
        // یکبار تکرار کن تا ببینیم خطا میده یا نه
        const first = await streamGenerator.next();
        if (first.done) {
            throw new Error('پاسخی از Gemini دریافت نشد.');
        }
        // اگر رسیدیم اینجا، یعنی کار میکنه
        // یه generator جدید برمیگردونیم که از اول شروع کنه
        return (async function*() {
            yield first.value;
            for await (const chunk of streamGenerator) {
                yield chunk;
            }
        })();
    } catch (error) {
        // اگر خطای ۴۲۹ یا ۵۰۳ بود، پیشنهاد سوئیچ به Weak Model بده
        if (error.message && (error.message.includes('429') || error.message.includes('503'))) {
            // ذخیره پیام معلق برای پردازش بعدی
            user.pendingMessage = userText || 'عکس';
            await saveUser(chatId, user);
            throw new Error('SWITCH_TO_WEAK');
        }
        // خطای دیگه رو پرتاب کن
        throw error;
    }
}

// ============================
// خلاصه‌سازی لینک (با Fallback به Weak Model)
// ============================
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

        // امتحان با Gemini اول
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

        // Fallback به Weak Model
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

// ============================
// منوها
// ============================
function mainMenu(currentAI) {
    const aiLabel = currentAI === 'gemini' ? '🤖 Gemini' : '⚡ Weak Model';
    return {
        inline_keyboard: [
            [{ text: `📌 مدل فعلی: ${aiLabel}`, callback_data: 'noop' }],
            [{ text: '🔄 انتخاب مدل', callback_data: 'switch_ai' }],
            [{ text: '📎 خلاصه‌سازی لینک', callback_data: 'summary_link' }],
            [{ text: '🧠 حافظه (Memory)', callback_data: 'memory_menu' }],
            [{ text: '📂 مدیریت مکالمه‌ها', callback_data: 'session_menu' }]
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

// ============================
// Webhook اصلی
// ============================
app.post('/webhook', async (req, res) => {
    const body = req.body;
    if (!body) return res.sendStatus(200);

    if (body.callback_query) {
        const query = body.callback_query;
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const data = query.data;
        let user = await getUser(chatId);

        try {
            if (data === 'noop') {
                return res.sendStatus(200);
            }

            if (data === 'back_main') {
                await editMessage(chatId, messageId, '🏠 **منوی اصلی:**', mainMenu(user.currentAI));
                return res.sendStatus(200);
            }

            if (data === 'switch_ai') {
                await editMessage(chatId, messageId, '🤖 **انتخاب هوش مصنوعی:**', aiSelectionMenu());
                return res.sendStatus(200);
            }

            if (data === 'set_ai_gemini') {
                user.currentAI = 'gemini';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '✅ **هوش مصنوعی به Gemini تغییر یافت.**', mainMenu('gemini'));
                return res.sendStatus(200);
            }

            if (data === 'set_ai_gapgpt') {
                user.currentAI = 'gapgpt';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '✅ **هوش مصنوعی به Weak Model تغییر یافت.**', mainMenu('gapgpt'));
                return res.sendStatus(200);
            }

            if (data === 'summary_link') {
                user.waitingFor = 'summary_link';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '📎 **لینک مورد نظر را ارسال کنید تا خلاصه‌سازی کنم.**', backToMenuButton());
                return res.sendStatus(200);
            }

            if (data === 'memory_menu') {
                await editMessage(chatId, messageId, '🧠 **مدیریت حافظه:**\n\n' +
                    'حافظه‌ها دستورات سیستمی هستند که Gemini همیشه به خاطر می‌سپارد.\n' +
                    'مثال: "من برنامه‌نویس هستم" یا "پاسخ‌ها را کوتاه بده".',
                    memoryMenu()
                );
                return res.sendStatus(200);
            }

            if (data === 'add_memory') {
                user.waitingFor = 'add_memory';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '📝 **متن حافظه جدید را وارد کنید:**', backToMenuButton());
                return res.sendStatus(200);
            }

            if (data === 'view_memory') {
                const memoryList = user.memory;
                if (memoryList.length === 0) {
                    await sendMessage(chatId, '🧠 **هیچ حافظه‌ای ذخیره نشده است.**', backToMenuButton());
                } else {
                    const formatted = memoryList.map((m, i) => `${i+1}. ${m}`).join('\n');
                    await sendMessage(chatId, `🧠 **حافظه‌های شما:**\n\n${formatted}`, backToMenuButton());
                }
                return res.sendStatus(200);
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
                return res.sendStatus(200);
            }

            if (data === 'session_menu') {
                await editMessage(chatId, messageId, '📂 **مدیریت مکالمه‌ها:**', sessionMenu());
                return res.sendStatus(200);
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
                return res.sendStatus(200);
            }

            if (data === 'list_sessions') {
                if (user.sessions.length === 0) {
                    await sendMessage(chatId, '📭 **هیچ مکالمه‌ای ذخیره نشده است.**', backToMenuButton());
                } else {
                    await editMessage(chatId, messageId, '📋 **لیست مکالمه‌ها:**', sessionsListMenu(user.sessions, user.currentSessionIndex));
                }
                return res.sendStatus(200);
            }

            if (data === 'rename_session') {
                user.waitingFor = 'rename';
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '✏️ **نام جدید مکالمه را وارد کنید:**', backToMenuButton());
                return res.sendStatus(200);
            }

            if (data === 'delete_session') {
                if (user.sessions.length === 1) {
                    await sendMessage(chatId, '⚠️ **شما فقط یک مکالمه دارید و نمی‌توانید آن را حذف کنید.**', backToMenuButton());
                    return res.sendStatus(200);
                }
                const currentIndex = user.currentSessionIndex;
                user.sessions.splice(currentIndex, 1);
                if (currentIndex >= user.sessions.length) {
                    user.currentSessionIndex = user.sessions.length - 1;
                }
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '🗑️ **مکالمه حذف شد.**', mainMenu(user.currentAI));
                return res.sendStatus(200);
            }

            if (data === 'new_session') {
                if (user.sessions.length >= 20) {
                    await sendMessage(chatId, '⚠️ **حداکثر ۲۰ مکالمه مجاز است.**', backToMenuButton());
                    return res.sendStatus(200);
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
                return res.sendStatus(200);
            }

            if (data.startsWith('switch_')) {
                const index = parseInt(data.split('_')[1]);
                if (index >= 0 && index < user.sessions.length) {
                    user.currentSessionIndex = index;
                    await saveUser(chatId, user);
                    await editMessage(chatId, messageId, `✅ **به "${user.sessions[index].name}" تغییر کرد.**`, mainMenu(user.currentAI));
                }
                return res.sendStatus(200);
            }

            // ====== مدیریت سوئیچ به Weak Model ======
            if (data === 'confirm_switch_to_weak') {
                // تغییر مدل به Weak Model
                user.currentAI = 'gapgpt';
                const pendingMsg = user.pendingMessage;
                user.pendingMessage = null;
                await saveUser(chatId, user);

                await editMessage(chatId, messageId, '✅ **سوئیچ به Weak Model انجام شد.**\nدر حال پردازش مجدد پیام...');

                // پردازش مجدد پیام با Weak Model
                const session = user.sessions[user.currentSessionIndex];
                // حذف آخرین پیام کاربر از تاریخچه (چون با خطا مواجه شده بود)
                if (session.history.length > 0 && session.history[session.history.length - 1].role === 'user') {
                    session.history.pop();
                }
                await saveUser(chatId, user);

                // ارسال پیام جدید برای پردازش (با تاخیر)
                setTimeout(async () => {
                    await processNormalMessage(chatId, pendingMsg, null);
                }, 1000);
                return res.sendStatus(200);
            }

            if (data === 'cancel_switch_to_weak') {
                user.pendingMessage = null;
                await saveUser(chatId, user);
                await editMessage(chatId, messageId, '❌ **سوئیچ انجام نشد.**\n\nمی‌توانید بعداً از منوی «انتخاب مدل» به Weak Model سوئیچ کنید.', backToMenuButton());
                return res.sendStatus(200);
            }

        } catch (error) {
            console.error('❌ Error in callback:', error);
            await sendMessage(chatId, '❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
        }
        return res.sendStatus(200);
    }

    if (body.message) {
        const message = body.message;
        const chatId = message.chat.id;
        const text = message.text;
        const photo = message.photo;
        const caption = message.caption;

        let user = await getUser(chatId);
        const userText = text || caption || '';

        // --- Waiting states ---
        if (user.waitingFor === 'rename') {
            if (!userText) {
                await sendMessage(chatId, '❌ **لطفاً یک نام معتبر وارد کنید.**');
                return res.sendStatus(200);
            }
            const session = user.sessions[user.currentSessionIndex];
            session.name = userText.slice(0, 50);
            user.waitingFor = null;
            await saveUser(chatId, user);
            await sendMessage(chatId, `✅ **نام مکالمه به "${session.name}" تغییر یافت.**`, mainMenu(user.currentAI));
            return res.sendStatus(200);
        }

        if (user.waitingFor === 'add_memory') {
            if (!userText) {
                await sendMessage(chatId, '❌ **لطفاً یک متن معتبر وارد کنید.**');
                return res.sendStatus(200);
            }
            user.memory.push(userText);
            user.waitingFor = null;
            await saveUser(chatId, user);
            await sendMessage(chatId, `✅ **حافظه جدید اضافه شد:**\n"${userText}"`, mainMenu(user.currentAI));
            return res.sendStatus(200);
        }

        if (user.waitingFor === 'delete_memory') {
            const index = parseInt(userText) - 1;
            if (isNaN(index) || index < 0 || index >= user.memory.length) {
                await sendMessage(chatId, '❌ **شماره نامعتبر. لطفاً شماره درست را وارد کنید.**');
                return res.sendStatus(200);
            }
            const deleted = user.memory[index];
            user.memory.splice(index, 1);
            user.waitingFor = null;
            await saveUser(chatId, user);
            await sendMessage(chatId, `🗑️ **حافظه حذف شد:**\n"${deleted}"`, mainMenu(user.currentAI));
            return res.sendStatus(200);
        }

        if (user.waitingFor === 'summary_link') {
            if (!userText || !userText.startsWith('http')) {
                await sendMessage(chatId, '❌ **لطفاً یک لینک معتبر ارسال کنید.**');
                return res.sendStatus(200);
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
            return res.sendStatus(200);
        }

        // --- Commands ---
        if (userText === '/start') {
            const welcome = '🌟 **به Gemrox خوش آمدید!** 🌟';
            await sendMessage(chatId, welcome, {
                inline_keyboard: [
                    [{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]
                ]
            });
            return res.sendStatus(200);
        }

        if (userText === '/menu') {
            await sendMessage(chatId, '🏠 **منوی اصلی:**', mainMenu(user.currentAI));
            return res.sendStatus(200);
        }

        if (userText === '/clear_all' && chatId === 1111913932) {
            await db.run('DELETE FROM users');
            await sendMessage(chatId, '🧹 **کل دیتابیس پاک شد!**');
            return res.sendStatus(200);
        }

        // ====== پردازش پیام معمولی ======
        await processNormalMessage(chatId, userText, photo);

        return res.sendStatus(200);
    }

    res.sendStatus(200);
});

// ============================
// تابع پردازش پیام (جدا شده برای استفاده مجدد)
// ============================
async function processNormalMessage(chatId, userText, photo) {
    let user = await getUser(chatId);
    const session = user.sessions[user.currentSessionIndex];
    const history = session.history || [];

    // اضافه کردن پیام کاربر به تاریخچه
    const userMsg = {
        role: 'user',
        parts: [{ text: userText || 'لطفاً این عکس را تحلیل کن.' }]
    };
    history.push(userMsg);
    await saveUser(chatId, user);

    // پردازش عکس
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
        // استفاده از تابع processMessageWithAI
        const streamGenerator = await processMessageWithAI(chatId, user, history, userText, photoBase64);

        let firstChunk = true;
        let draftMessageId = null;
        let fullReply = '';
        let chunkCount = 0;

        for await (const chunk of streamGenerator) {
            fullReply = chunk;
            chunkCount++;
            
            if (firstChunk) {
                const initialMsg = await sendMessage(chatId, chunk + ' ✍️');
                draftMessageId = initialMsg.result.message_id;
                firstChunk = false;
            } else if (chunkCount % 2 === 0) {
                await editMessage(chatId, draftMessageId, chunk + ' ✍️');
                await sleep(100);
            }
        }

        if (draftMessageId) {
            await editMessage(chatId, draftMessageId, fullReply);
        } else {
            // اگر هیچ chunkی نرسید، احتمالاً خطایی رخ داده
            throw new Error('پاسخی دریافت نشد.');
        }

        // اضافه کردن پاسخ به تاریخچه
        const modelMsg = {
            role: 'model',
            parts: [{ text: fullReply }]
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
        
        // اگر خطای SWITCH_TO_WEAK بود، پیشنهاد سوئیچ بده
        if (error.message === 'SWITCH_TO_WEAK') {
            await sendMessage(chatId, 
                '⚠️ **Gemini به محدودیت درخواست (Rate Limit) خورده است.**\n\n' +
                'می‌خواهید به **Weak Model** سوئیچ کنید و مکالمه را ادامه دهید؟\n\n' +
                '🔹 Weak Model سریع‌تر است ولی قابلیت تحلیل عکس را ندارد.',
                switchToWeakMenu(userText)
            );
            return;
        }

        // خطاهای دیگه
        let errorMessage = error.message || 'خطای ناشناخته';
        if (error.message && error.message.includes('429')) {
            errorMessage = '⚠️ **محدودیت درخواست Gemini پر شده است.** لطفاً چند دقیقه صبر کنید یا از منو به Weak Model سوئیچ کنید.';
        } else if (error.message && error.message.includes('503')) {
            errorMessage = '⚠️ **سرور Gemini شلوغ است.** لطفاً چند دقیقه دیگر تلاش کنید یا از منو به Weak Model سوئیچ کنید.';
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

async function setCommands() {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`;
    const commands = [
        { command: 'start', description: 'شروع مجدد' },
        { command: 'menu', description: 'نمایش منوی اصلی' }
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
    console.log(`📡 Models: Gemini + Weak Model (گپ‌جی‌پی‌تی)`);
    console.log(`📎 Link summarizer enabled.`);
});
