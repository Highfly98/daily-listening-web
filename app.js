"use strict";

const $ = (id) => document.getElementById(id);
const storageKey = "daily-listening.articles.v1";
const preferencesKey = "daily-listening.preferences.v2";
const synthesis = window.speechSynthesis;
const speechAvailable = Boolean(synthesis && window.SpeechSynthesisUtterance);
const preferences = {
  loop: ["all", "one"], "repeat-count": ["infinite", "1", "2", "3", "5", "10"],
  speed: ["1", "0.85", "0.7"], voice: ["en-US", "en-GB"], gap: ["0", "2", "5"]
};
const state = {
  items: [], active: null, editing: null, utterance: null, timer: null,
  parts: [], chunk: 0, queue: [], position: 0, completed: 0, limit: Infinity, mode: "idle"
};
let wakeLock = null;
let wakeRequest = false;

function show(id, message) {
  const element = $(id);
  element.textContent = message;
  element.hidden = !message;
}

function storageNotice(message, error = false) {
  $("storage-message").dataset.error = String(error);
  show("storage-message", message);
}

function dateValue(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function articleValue(article) {
  return article && typeof article.id === "string" && article.id.length > 0 && dateValue(article.date) &&
    typeof article.text === "string" && article.text.trim().length > 0 &&
    (article.title === undefined || typeof article.title === "string");
}

function loadArticles() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    if (!Array.isArray(saved) || !saved.every(articleValue)) throw new Error("Invalid saved articles");
    state.items = saved;
    return true;
  } catch {
    storageNotice("暂时无法读取文章。请使用正常浏览窗口，已有数据会保留。", true);
    return false;
  }
}

const storageReady = loadArticles();
$("add").disabled = $("import").disabled = !storageReady;

function saveArticles(items) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(items));
    state.items = items;
    return true;
  } catch {
    return false;
  }
}

function restorePreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(preferencesKey) ?? "{}");
    for (const [key, allowed] of Object.entries(preferences)) {
      if (allowed.includes(saved?.[key])) $(key).value = saved[key];
    }
    $("awake").checked = saved?.awake === true;
  } catch {
    // Playback remains available with the default choices.
  }
}

function savePreferences() {
  try {
    const data = Object.fromEntries(Object.keys(preferences).map((key) => [key, $(key).value]));
    localStorage.setItem(preferencesKey, JSON.stringify({ ...data, awake: $("awake").checked }));
  } catch {
    // The current playback choices still apply for this session.
  }
}

function today() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

function ordered() {
  return [...state.items].sort((a, b) => a.date.localeCompare(b.date));
}

function title(article) {
  return (article.title?.trim() || article.text.trim().split(/\r?\n/)[0]).slice(0, 100);
}

function datestring(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

function progressText() {
  if (state.mode === "finished") return `已完成 ${state.completed} ${state.queue.length === 1 && $("loop").value === "one" ? "次" : "轮"}`;
  if (state.mode !== "playing" && state.mode !== "paused") return "";
  const unit = $("loop").value === "one" ? "次" : "轮";
  const round = Number.isFinite(state.limit)
    ? `第 ${state.completed + 1} / ${state.limit} ${unit}`
    : `第 ${state.completed + 1} ${unit} · 一直循环`;
  const article = state.queue.length > 1 ? ` · ${state.position + 1} / ${state.queue.length} 篇` : "";
  return round + article;
}

function updatePlayer() {
  const article = state.items.find((item) => item.id === state.active);
  const labels = { idle: "开始复习", playing: "暂停", paused: "继续播放", stopped: "播放", finished: "再听一遍" };
  $("play-label").textContent = labels[state.mode];
  $("play-symbol").textContent = state.mode === "playing" ? "❚❚" : "▶";
  $("toggle").disabled = !speechAvailable || !state.items.length;
  $("previous").disabled = $("next").disabled = !speechAvailable || state.items.length < 2;
  $("player-title").textContent = $("loop").value === "one" ? "单篇播放" : "按日期播放";
  $("now").textContent = article
    ? `${datestring(article.date)}  ·  ${title(article)}`
    : state.items.length ? "点「开始复习」，从最早的一篇听起。" : "保存文章后，就可以开始复习。";
  show("progress", progressText());
  for (const row of $("articles").children) row.classList.toggle("active", row.dataset.id === state.active);
}

function render() {
  const articles = $("articles");
  articles.replaceChildren();
  $("empty").hidden = state.items.length > 0;
  $("count").textContent = `${state.items.length} 篇`;
  $("export").disabled = !state.items.length;
  for (const article of ordered().reverse()) {
    const row = document.createElement("li");
    row.className = "article";
    row.dataset.id = article.id;
    const play = document.createElement("button");
    play.className = "article-play";
    play.disabled = !speechAvailable;
    play.setAttribute("aria-label", "朗读 " + title(article));
    play.addEventListener("click", () => begin(article));
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "▶";
    const copy = document.createElement("span");
    copy.className = "article-copy";
    const heading = document.createElement("span");
    heading.className = "article-title";
    heading.textContent = title(article);
    const date = document.createElement("time");
    date.className = "article-date";
    date.dateTime = article.date;
    date.textContent = datestring(article.date);
    copy.append(heading, date);
    play.append(mark, copy);
    const edit = document.createElement("button");
    edit.className = "edit";
    edit.textContent = "编辑";
    edit.setAttribute("aria-label", "编辑 " + title(article));
    edit.addEventListener("click", () => editArticle(article));
    row.append(play, edit);
    articles.append(row);
  }
  updatePlayer();
}

function speechParts(text) {
  const parts = [];
  let part = "";
  for (const word of text.trim().split(/\s+/)) {
    if (part && part.length + word.length > 215) {
      parts.push(part);
      part = "";
    }
    part += (part ? " " : "") + word;
  }
  if (part) parts.push(part);
  return parts;
}

function cancelSpeech() {
  clearTimeout(state.timer);
  state.timer = null;
  if (!state.utterance) return;
  state.utterance = null;
  synthesis.cancel();
}

async function refreshWakeLock() {
  const wantsWakeLock = $("awake").checked && state.mode === "playing" && document.visibilityState === "visible";
  if (!wantsWakeLock) {
    const previous = wakeLock;
    wakeLock = null;
    if (previous) await previous.release().catch(() => {});
    return;
  }
  if (!navigator.wakeLock || wakeLock || wakeRequest) return;
  wakeRequest = true;
  try {
    const acquired = await navigator.wakeLock.request("screen");
    if (!$("awake").checked || state.mode !== "playing" || document.visibilityState !== "visible") {
      await acquired.release();
    } else {
      wakeLock = acquired;
      acquired.addEventListener("release", () => {
        if (wakeLock === acquired) wakeLock = null;
      });
    }
  } catch {
    // Some devices disable screen wake locks in low power mode.
  } finally {
    wakeRequest = false;
  }
}

function voiceFor(language) {
  const english = synthesis.getVoices().filter((voice) => /^en[-_]/i.test(voice.lang));
  return english.find((voice) => voice.lang.replace("_", "-").toLowerCase() === language.toLowerCase());
}

function speakPart() {
  if (state.mode !== "playing") return;
  const text = state.parts[state.chunk];
  if (!text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const language = $("voice").value;
  const voice = voiceFor(language);
  utterance.lang = voice?.lang ?? language;
  if (voice) utterance.voice = voice;
  utterance.rate = Number($("speed").value);
  utterance.onend = () => {
    if (state.utterance !== utterance) return;
    state.utterance = null;
    state.chunk++;
    if (state.mode === "playing") nextPart();
  };
  utterance.onerror = () => {
    if (state.utterance !== utterance) return;
    state.utterance = null;
    state.mode = "stopped";
    show("play-error", "朗读中断了，点「播放」重试。");
    updatePlayer();
    void refreshWakeLock();
  };
  state.utterance = utterance;
  synthesis.speak(utterance);
}

function prepareArticle(gap = 0) {
  const article = state.queue[state.position];
  state.active = article.id;
  state.parts = speechParts(article.text);
  state.chunk = 0;
  updatePlayer();
  if (gap > 0) {
    state.timer = setTimeout(() => {
      state.timer = null;
      speakPart();
    }, gap);
  } else {
    speakPart();
  }
}

function nextPart() {
  if (state.chunk < state.parts.length) {
    speakPart();
    return;
  }
  state.position++;
  if (state.position === state.queue.length) {
    state.completed++;
    state.position = 0;
    if (state.completed === state.limit) {
      state.mode = "finished";
      updatePlayer();
      void refreshWakeLock();
      return;
    }
  }
  prepareArticle(Number($("gap").value) * 1000);
}

function begin(article) {
  if (!article || !speechAvailable) return;
  cancelSpeech();
  show("play-error", "");
  const articles = ordered();
  const at = articles.findIndex((item) => item.id === article.id);
  if (at < 0) return;
  state.queue = $("loop").value === "one" ? [article] : [...articles.slice(at), ...articles.slice(0, at)];
  state.position = 0;
  state.completed = 0;
  const count = $("repeat-count").value;
  state.limit = count === "infinite" ? Infinity : Number(count);
  state.mode = "playing";
  if (synthesis.paused) synthesis.resume();
  prepareArticle();
  void refreshWakeLock();
}

function move(offset) {
  const articles = ordered();
  if (!articles.length) return;
  const at = articles.findIndex((article) => article.id === state.active);
  const index = at < 0 ? (offset < 0 ? articles.length - 1 : 0)
    : (at + offset + articles.length) % articles.length;
  begin(articles[index]);
}

function currentArticle() {
  return state.items.find((item) => item.id === state.active);
}

$("toggle").addEventListener("click", () => {
  if (state.mode === "playing") {
    state.mode = "paused";
    clearTimeout(state.timer);
    state.timer = null;
    if (state.utterance) synthesis.pause();
  } else if (state.mode === "paused") {
    state.mode = "playing";
    synthesis.resume();
    if (!state.utterance) nextPart();
  } else {
    const previousStart = state.mode === "finished" ? state.queue[0]?.id : state.active;
    begin(state.items.find((item) => item.id === previousStart) ?? ordered()[0]);
  }
  updatePlayer();
  void refreshWakeLock();
});
$("previous").addEventListener("click", () => move(-1));
$("next").addEventListener("click", () => move(1));

for (const id of Object.keys(preferences)) $(id).addEventListener("change", () => {
  savePreferences();
  if (id === "loop" || id === "repeat-count") {
    if (state.mode === "playing") begin(currentArticle());
    else if (state.mode === "paused" || state.mode === "finished") {
      cancelSpeech();
      state.mode = "stopped";
    }
  } else if ((id === "voice" || id === "speed") && state.mode === "playing" && state.utterance) {
    cancelSpeech();
    speakPart();
  } else if ((id === "voice" || id === "speed") && state.mode === "paused") {
    cancelSpeech();
  }
  updatePlayer();
});
$("awake").addEventListener("change", () => {
  savePreferences();
  void refreshWakeLock();
});
document.addEventListener("visibilitychange", () => void refreshWakeLock());

function idForArticle() {
  return window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function editArticle(article) {
  state.editing = article?.id ?? null;
  $("edit-title").textContent = article ? "编辑文章" : "添加文章";
  $("date").value = article?.date ?? today();
  $("article-title").value = article?.title ?? "";
  $("body").value = article?.text ?? "";
  $("remove").hidden = !article;
  show("edit-error", "");
  $("editor").showModal();
  $("body").focus();
}

function stopForLibraryChange(id) {
  if (state.active !== id && !state.queue.some((article) => article.id === id)) return;
  cancelSpeech();
  state.queue = [];
  state.mode = currentArticle() ? "stopped" : "idle";
  if (state.mode === "idle") state.active = null;
  void refreshWakeLock();
}

$("add").addEventListener("click", () => editArticle());
$("cancel").addEventListener("click", () => $("editor").close());
$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("body").value.trim();
  if (!text || !dateValue($("date").value)) {
    show("edit-error", "请输入英文正文并选好日期。");
    return;
  }
  const entry = { id: state.editing ?? idForArticle(), date: $("date").value, text };
  const customTitle = $("article-title").value.trim();
  if (customTitle) entry.title = customTitle;
  const items = state.editing ? state.items.map((item) => item.id === state.editing ? entry : item)
    : [...state.items, entry];
  if (!saveArticles(items)) {
    show("edit-error", "保存失败，请检查浏览器存储空间后重试。");
    return;
  }
  stopForLibraryChange(entry.id);
  $("editor").close();
  render();
});

$("remove").addEventListener("click", () => {
  if (!window.confirm("删除这篇文章？")) return;
  if (!saveArticles(state.items.filter((item) => item.id !== state.editing))) {
    show("edit-error", "删除失败，文章仍保留。");
    return;
  }
  stopForLibraryChange(state.editing);
  $("editor").close();
  render();
});

$("export").addEventListener("click", () => {
  const snapshot = JSON.stringify({ format: "daily-listening", version: 1, articles: state.items }, null, 2);
  const url = URL.createObjectURL(new Blob([snapshot], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `每日听读-${today()}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

$("import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async () => {
  const file = $("import-file").files[0];
  $("import-file").value = "";
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup?.format !== "daily-listening" || backup.version !== 1 ||
        !Array.isArray(backup.articles) || !backup.articles.every(articleValue)) throw new Error("Invalid backup");
    const merged = [...state.items];
    const usedIDs = new Set(merged.map((article) => article.id));
    const signature = (article) => JSON.stringify([article.date, article.title ?? "", article.text]);
    const alreadySaved = new Set(merged.map(signature));
    for (const article of backup.articles) {
      const key = signature(article);
      if (alreadySaved.has(key)) continue;
      const entry = { id: usedIDs.has(article.id) ? idForArticle() : article.id, date: article.date, text: article.text };
      if (article.title) entry.title = article.title;
      merged.push(entry);
      usedIDs.add(entry.id);
      alreadySaved.add(key);
    }
    const added = merged.length - state.items.length;
    if (added && !saveArticles(merged)) {
      storageNotice("导入失败，请检查浏览器存储空间。原有文章仍保留。", true);
      return;
    }
    storageNotice(added ? `已导入 ${added} 篇，重复文章已跳过。` : "没有需要新增的文章。");
    render();
  } catch {
    storageNotice("无法读取此备份。请选择从「每日听读」导出的 JSON 文件。", true);
  }
});

window.addEventListener("pagehide", () => {
  cancelSpeech();
  if (state.mode === "playing" || state.mode === "paused") state.mode = "stopped";
  void refreshWakeLock();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) updatePlayer();
});

restorePreferences();
$("awake-option").hidden = !navigator.wakeLock;
if (!speechAvailable) show("play-error", "当前浏览器不支持朗读。请用 Safari 或 Chrome 打开。");
if (window.location.hostname.endsWith(".github.io") && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
render();
