import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
            waitingFor TEXT
        )
    `);
    console.log('✅ Database ready');
}
await initDb();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = 'gemini-3.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

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

async function getUser(chatId) {
    let user = await db.get('SELECT * FROM users WHERE chatId = ?', chatId);
    if (!user) {
        const defaultSessions = JSON.stringify([{
            id: 1,
            name: 'مکالمه اصلی',
            history: []
        }]);
        await db.run('INSERT INTO users (chatId, sessions, currentSessionIndex, waitingFor) VALUES (?, ?, ?, ?)', 
            chatId, defaultSessions, 0, null);
        user = { chatId, sessions: defaultSessions, currentSessionIndex: 0, waitingFor: null };
    }
    user.sessions = JSON.parse(user.sessions);
    return user;
}

async function saveUser(chatId, data) {
    await db.run('UPDATE users SET sessions = ?, currentSessionIndex = ?, waitingFor = ? WHERE chatId = ?',
        JSON.stringify(data.sessions), data.currentSessionIndex, data.waitingFor || null, chatId);
}

async function askGemini(history, photoBase64 = null) {
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

    const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents })
    });

    const data = await response.json();
    if (!response.ok) {
        let errMsg = data.error?.message || 'Unknown error';
        throw new Error(`Gemini Error (${response.status}): ${errMsg}`);
    }
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) throw new Error('پاسخی از Gemini دریافت نشد.');
    return reply;
}

function mainMenu() {
    return {
        inline_keyboard: [
            [{ text: '📜 تاریخچه فعلی', callback_data: 'view_history' }],
            [{ text: '📋 لیست مکالمه‌ها', callback_data: 'list_sessions' }],
            [{ text: '✏️ تغییر نام مکالمه', callback_data: 'rename_session' }],
            [{ text: '🗑️ حذف مکالمه فعلی', callback_data: 'delete_session' }],
            [{ text: '➕ مکالمه جدید', callback_data: 'new_session' }]
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
            if (data === 'back_main') {
                await editMessage(chatId, messageId, '🏠 **منوی اصلی:**', mainMenu());
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
                await editMessage(chatId, messageId, '🗑️ **مکالمه حذف شد.**', mainMenu());
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
                await editMessage(chatId, messageId, '✅ **مکالمه جدید ایجاد شد.**', mainMenu());
                return res.sendStatus(200);
            }

            if (data.startsWith('switch_')) {
                const index = parseInt(data.split('_')[1]);
                if (index >= 0 && index < user.sessions.length) {
                    user.currentSessionIndex = index;
                    await saveUser(chatId, user);
                    await editMessage(chatId, messageId, `✅ **به "${user.sessions[index].name}" تغییر کرد.**`, mainMenu());
                }
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

        if (user.waitingFor === 'rename') {
            if (!userText) {
                await sendMessage(chatId, '❌ **لطفاً یک نام معتبر وارد کنید.**');
                return res.sendStatus(200);
            }
            const session = user.sessions[user.currentSessionIndex];
            session.name = userText.slice(0, 50);
            user.waitingFor = null;
            await saveUser(chatId, user);
            await sendMessage(chatId, `✅ **نام مکالمه به "${session.name}" تغییر یافت.**`, mainMenu());
            return res.sendStatus(200);
        }

        if (userText === '/start') {
            const welcome = 
                '🌟 **به Gemrox خوش آمدید!** 🌟\n\n' +
                'من یک دستیار هوشمند با قدرت **Gemini** هستم.\n' +
                'می‌توانید سوال بپرسید، عکس بفرستید (برای تحلیل) یا از منو استفاده کنید.\n\n' +
                '📌 **دستورات سریع:**\n' +
                '/menu - نمایش منوی اصلی\n\n' +
                '🔽 برای شروع، دکمه‌ی منو را بزنید:';
            await sendMessage(chatId, welcome, {
                inline_keyboard: [
                    [{ text: '🏠 منوی اصلی', callback_data: 'back_main' }]
                ]
            });
            return res.sendStatus(200);
        }

        if (userText === '/menu') {
            await sendMessage(chatId, '🏠 **منوی اصلی:**', mainMenu());
            return res.sendStatus(200);
        }

        if (userText === '/clear_all' && chatId === 1111913932) {
            await db.run('DELETE FROM users');
            await sendMessage(chatId, '🧹 **کل دیتابیس پاک شد!**');
            return res.sendStatus(200);
        }

        await sendChatAction(chatId, 'typing');
        
        // تاخیر ۱.۵ ثانیه‌ای برای جلوگیری از Rate Limit
        await new Promise(resolve => setTimeout(resolve, 1500));

        try {
            const session = user.sessions[user.currentSessionIndex];
            const history = session.history || [];

            const userMsg = {
                role: 'user',
                parts: [{ text: userText || 'لطفاً این عکس را تحلیل کن.' }]
            };
            history.push(userMsg);

            let photoBase64 = null;
            if (photo) {
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
            }

            const reply = await askGemini(history, photoBase64);

            const modelMsg = {
                role: 'model',
                parts: [{ text: reply }]
            };
            history.push(modelMsg);

            if (history.length > 200) {
                session.history = history.slice(-200);
            } else {
                session.history = history;
            }

            await saveUser(chatId, user);
            await sendMessage(chatId, reply);

        } catch (error) {
            console.error('❌ Error processing message:', error);
            let errorMessage = error.message || 'خطای ناشناخته';
            
            // نمایش خطای ۴۲۹ به کاربر
            if (error.message && error.message.includes('429')) {
                errorMessage = '⚠️ **محدودیت درخواست Gemini پر شده است.**\nلطفاً چند دقیقه صبر کنید و دوباره تلاش کنید.';
            } else if (error.message && error.message.includes('عکس')) {
                errorMessage = '⚠️ **خطا در پردازش عکس.** لطفاً عکس را مجدداً ارسال کنید یا از عکس دیگری استفاده کنید.';
            } else if (error.message && error.message.includes('Gemini Error (401)')) {
                errorMessage = '⚠️ **خطا در احراز هویت Gemini.** لطفاً کلید API را بررسی کنید.';
            } else if (error.message && error.message.includes('Gemini Error (503)')) {
                errorMessage = '⚠️ **سرور Gemini شلوغ است.** لطفاً چند دقیقه دیگر تلاش کنید.';
            } else if (error.message && error.message.includes('Gemini')) {
                errorMessage = `⚠️ **خطا از سرویس Gemini:**\n${error.message}`;
            } else {
                errorMessage = `❌ **خطا:** ${errorMessage}`;
            }
            await sendMessage(chatId, errorMessage);
        }

        return res.sendStatus(200);
    }

    res.sendStatus(200);
});

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
    console.log(`📡 Model: ${MODEL_NAME}`);
});
