const TelegramBot = require("node-telegram-bot-api");
const fs = require("node:fs");
const path = require("node:path");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const STATS_FILE = path.join(__dirname, "search-stats.json");
const MAX_RESULTS = 6;
const MAX_QUERY_LENGTH = 250;
let stats = loadStats();

function loadStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch {
    return { chats: {} };
  }
}

function saveStats() {
  const temp = STATS_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(stats, null, 2));
  fs.renameSync(temp, STATS_FILE);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"]/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[ch]);
}

function getChatStats(chatId) {
  const key = String(chatId);
  if (!stats.chats[key]) stats.chats[key] = { total: 0, users: {} };
  return stats.chats[key];
}

function countSearch(chat, from) {
  const chatStats = getChatStats(chat.id);
  const userKey = String(from.id);
  if (!chatStats.users[userKey]) {
    chatStats.users[userKey] = {
      id: from.id,
      name: [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || "Участник",
      username: from.username || "",
      count: 0
    };
  }
  const user = chatStats.users[userKey];
  user.name = [from.first_name, from.last_name].filter(Boolean).join(" ") || user.name;
  user.username = from.username || user.username;
  user.count += 1;
  chatStats.total += 1;
  saveStats();
}

function extractQuery(text, command) {
  return text.replace(new RegExp("^\\\\s*" + command + "(?:@\\\\w+)?\\\\s*", "i"), "").trim();
}

async function searchWeb(query) {
  // Preferred provider: Tavily, when TAVILY_API_KEY is configured.
  if (process.env.TAVILY_API_KEY) {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: MAX_RESULTS,
        include_answer: true
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error("Поисковый сервис вернул ошибку (" + response.status + ").");
    const data = await response.json();
    return {
      answer: data.answer || "",
      results: (data.results || []).map((item) => ({
        title: item.title || item.url,
        url: item.url,
        content: item.content || ""
      })).filter((item) => item.url)
    };
  }

  // Free fallback: DuckDuckGo HTML search. Availability/markup may change.
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ChatPoisk/1.0)" },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("Не удалось выполнить поиск. Попробуй позже.");
  const html = await response.text();
  const results = [];
  const blocks = html.split(/class="result results_links/).slice(1);

  for (const block of blocks) {
    if (results.length >= MAX_RESULTS) break;
    const linkMatch = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    let resultUrl = linkMatch[1].replace(/&amp;/g, "&");
    const redirect = resultUrl.match(/[?&]uddg=([^&]+)/);
    if (redirect) {
      try { resultUrl = decodeURIComponent(redirect[1]); } catch {}
    }
    if (!/^https?:\/\//i.test(resultUrl)) continue;
    const title = linkMatch[2].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim() : "";
    results.push({ title: title || resultUrl, url: resultUrl, content: snippet });
  }

  if (!results.length) {
    throw new Error("Поиск не вернул результаты. Попробуй добавить TAVILY_API_KEY в переменные окружения.");
  }
  return { answer: "", results };
}

function buildAnswer(query, data) {
  let output = "🔎 <b>ChatPoisk</b>\nЗапрос: <i>" + escapeHtml(query) + "</i>\n\n";
  if (data.answer) output += "💡 <b>Краткий ответ</b>\n" + escapeHtml(data.answer) + "\n\n";
  output += "<b>Найденные источники:</b>\n";
  data.results.forEach((item, index) => {
    output += "\n" + (index + 1) + ". <a href=\"" + escapeHtml(item.url) + "\">" +
      escapeHtml(item.title) + "</a>";
    if (item.content) output += "\n" + escapeHtml(item.content.slice(0, 350));
    output += "\n";
  });
  output += "\n<i>Проверяй важные сведения по источникам: результаты поиска могут быть неполными.</i>";
  return output.slice(0, 3900);
}

bot.onText(/^\s*\.поискчат(?:@\w+)?(?:\s+([\s\S]+))?$/i, async (msg, match) => {
  const query = (match[1] || "").trim();
  if (!query) {
    return bot.sendMessage(msg.chat.id, "Напиши запрос после команды:\n<code>.поискчат что такое искусственный интеллект</code>", {
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id
    });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return bot.sendMessage(msg.chat.id, "Запрос слишком длинный. Максимум " + MAX_QUERY_LENGTH + " символов.", {
      reply_to_message_id: msg.message_id
    });
  }

  const status = await bot.sendMessage(msg.chat.id, "🔎 Ищу информацию…", {
    reply_to_message_id: msg.message_id
  });

  try {
    const data = await searchWeb(query);
    countSearch(msg.chat, msg.from);
    const answer = buildAnswer(query, data);
    await bot.editMessageText(answer, {
      chat_id: msg.chat.id,
      message_id: status.message_id,
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error("Search failed:", error.message);
    await bot.editMessageText(
      "⚠️ Не получилось выполнить поиск.\n" + escapeHtml(error.message) +
      "\n\nПопробуй ещё раз чуть позже.",
      { chat_id: msg.chat.id, message_id: status.message_id, parse_mode: "HTML" }
    );
  }
});

bot.onText(/^\s*\.рейтингчат(?:@\w+)?\s*$/i, async (msg) => {
  const chatStats = getChatStats(msg.chat.id);
  const users = Object.values(chatStats.users).sort((a, b) => b.count - a.count);
  if (!users.length) {
    return bot.sendMessage(msg.chat.id, "📊 Пока поисковых запросов нет. Будь первым!\nПример: .поискчат погода на Марсе", {
      reply_to_message_id: msg.message_id
    });
  }

  const medals = ["🥇", "🥈", "🥉"];
  let output = "🏆 <b>Рейтинг ChatPoisk</b>\n";
  output += "Всего успешных запросов в этом чате: <b>" + chatStats.total + "</b>\n\n";
  users.slice(0, 20).forEach((user, index) => {
    const name = escapeHtml(user.name);
    const username = user.username ? " (@" + escapeHtml(user.username) + ")" : "";
    output += (medals[index] || (index + 1) + ".") + " " + name + username +
      " — <b>" + user.count + "</b>\n";
  });

  await bot.sendMessage(msg.chat.id, output, {
    parse_mode: "HTML",
    reply_to_message_id: msg.message_id
  });
});

bot.on("polling_error", (error) => console.error("Telegram polling error:", error.message));
bot.on("error", (error) => console.error("Telegram bot error:", error.message));

console.log("ChatPoisk is running.");
