require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const Parser    = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const axios     = require('axios');
const cheerio   = require('cheerio');

// ─── 初期化 ───────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSSBot/1.0)' },
});
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ARTICLES_PER_SOURCE = 5;
const TOP_N               = 10;
const SENT_PATH           = path.join(__dirname, 'sent_articles.json');
const DOCS_DIR            = path.join(__dirname, 'docs');
const DOCS_INDEX          = path.join(DOCS_DIR, 'index.html');
const HISTORY_DAYS        = 30; // ダッシュボードに表示する日数

const HTTP = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  },
  timeout: 15000,
};

// ─── ソース定義 ───────────────────────────────────────────────
const SOURCES = [
  { name: 'Google広告',    type: 'rss', url: 'https://www.blog.google/products/ads-commerce/rss/' },
  { name: 'Meta for Business', type: 'rss', url: 'https://www.facebook.com/business/news/rss/' },
  { name: 'TikTok for Business', type: 'scrape', url: 'https://ads.tiktok.com/business/en/blog', fetch: fetchTikTok },
  { name: 'Yahoo!広告 (LYCBiz)', type: 'scrape', url: 'https://www.lycbiz.com/jp/column/ly-ads/', fetch: fetchLYCBiz },
  { name: 'LINE for Business (LYCBiz)', type: 'scrape', url: 'https://www.lycbiz.com/jp/column/', fetch: fetchLYCBiz },
  { name: 'アナグラム',   type: 'rss', url: 'https://anagrams.jp/blog/feed/' },
  { name: 'アイレップ (ONEDER)', type: 'rss', url: 'https://oneder.hakuhodody-one.co.jp/blog/rss.xml' },
  { name: '電通デジタル', type: 'scrape', url: 'https://dentsudigital.co.jp/news/release', fetch: fetchDentsuDigital },
  { name: 'Bプラン',      type: 'scrape', url: 'https://bplan.co.jp/blog/', fetch: fetchWordPressBlog },
  { name: 'オーリーズ',   type: 'scrape', url: 'https://aulys.jp/blog/', fetch: fetchWordPressBlog },
];

// ─── 重複排除・既読管理 ───────────────────────────────────────
function loadSentData() {
  try {
    const raw = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));
    return {
      urls:     raw.urls     || {},
      titles:   raw.titles   || [],
      articles: raw.articles || [],
    };
  } catch {
    return { urls: {}, titles: [], articles: [] };
  }
}

function saveSentData(data) {
  const cutoff = daysAgo(HISTORY_DAYS);
  // 古いエントリを定期削除（30日超）
  data.urls     = Object.fromEntries(Object.entries(data.urls).filter(([, d]) => d >= cutoff));
  data.titles   = data.titles.filter(t => t.date >= cutoff);
  data.articles = data.articles.filter(a => a.date >= cutoff);
  fs.writeFileSync(SENT_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// Jaccard係数ベースの文字レベル類似度
function titleSimilarity(a, b) {
  const norm = s => [...s.replace(/[\s\u3000・【】「」『』（）()\-_]/g, '').toLowerCase()];
  const setA = new Set(norm(a));
  const setB = new Set(norm(b));
  const inter = [...setA].filter(c => setB.has(c)).length;
  const union  = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

// 定期更新記事パターン（月次/週次系）
const PERIODIC_RE = /\d+月.*(?:アップデート|まとめ|変更点|更新|ニュース)|月次|週次まとめ|定期レポート/;

// バッチ内の類似記事をマージ（重複除去）
function deduplicateBatch(articles) {
  const kept = [];
  for (const a of articles) {
    if (kept.some(k => titleSimilarity(a.title, k.title) > 0.70)) {
      console.log(`  [MERGE] 類似記事: ${a.title.slice(0, 50)}`);
    } else {
      kept.push(a);
    }
  }
  return kept;
}

// 送信済み履歴との照合
function filterSent(articles, sentData) {
  const sevenDaysCutoff = daysAgo(7);
  const result = [];
  for (const a of articles) {
    // URL完全一致
    if (a.link && sentData.urls[a.link]) {
      console.log(`  [SKIP-URL] ${a.title.slice(0, 50)}`);
      continue;
    }
    // 定期更新記事は7日以内に類似タイトルがあればスキップ
    if (PERIODIC_RE.test(a.title)) {
      const hit = sentData.titles.find(
        t => t.date >= sevenDaysCutoff && titleSimilarity(a.title, t.title) > 0.50
      );
      if (hit) { console.log(`  [SKIP-PERIODIC] ${a.title.slice(0, 50)}`); continue; }
    }
    // 高類似タイトル（全期間）
    if (sentData.titles.some(t => titleSimilarity(a.title, t.title) > 0.78)) {
      console.log(`  [SKIP-SIMILAR] ${a.title.slice(0, 50)}`);
      continue;
    }
    result.push(a);
  }
  return result;
}

function recordSent(articles, sentData) {
  const today = new Date().toISOString().slice(0, 10);
  for (const a of articles) {
    if (a.link) sentData.urls[a.link] = today;
    sentData.titles.push({ title: a.title, date: today });
    sentData.articles.push({
      source:  a.source,
      title:   a.title,
      link:    a.link,
      summary: a.summary || '',
      score:   a.score   || 0,
      reason:  a.reason  || '',
      date:    today,
    });
  }
}

// ─── RSS フェッチャー ──────────────────────────────────────────
async function fetchRSS(source) {
  const parsed = await rssParser.parseURL(source.url);
  return parsed.items.slice(0, ARTICLES_PER_SOURCE).map(item => ({
    source:  source.name,
    title:   item.title          || '(タイトルなし)',
    link:    item.link           || '',
    content: item.contentSnippet || item.content || item.summary || '',
    pubDate: item.pubDate        || item.isoDate || '',
  }));
}

// ─── TikTok スクレイパー ──────────────────────────────────────
async function fetchTikTok(source) {
  const { data } = await axios.get(source.url, HTTP);
  const $ = cheerio.load(data);
  const articles = [];
  $('h3.card-title a[href*="/business/en/blog/"]').each((_, el) => {
    if (articles.length >= ARTICLES_PER_SOURCE) return false;
    const href    = $(el).attr('href');
    const title   = $(el).text().trim();
    if (!href || !title) return;
    const $card   = $(el).closest('[data-url]');
    const excerpt = $card.find('p.card-excerpt').text().trim();
    articles.push({ source: source.name, title, link: `https://ads.tiktok.com${href}`, content: excerpt, pubDate: '' });
  });
  return articles;
}

// ─── LYCBiz スクレイパー ─────────────────────────────────────
async function fetchLYCBiz(source) {
  const { data } = await axios.get(source.url, HTTP);
  const $ = cheerio.load(data);
  const articles = [];
  $('li.columnList__item').each((_, el) => {
    if (articles.length >= ARTICLES_PER_SOURCE) return false;
    const href  = $(el).find('a.pagePannel__inner').attr('href');
    const title = $(el).find('p.pagePannel__txt').text().trim();
    const date  = $(el).find('.pagePannel__date').first().text().trim();
    if (!href || !title) return;
    articles.push({ source: source.name, title, link: `https://www.lycbiz.com${href}`, content: '', pubDate: date });
  });
  await Promise.all(articles.map(async a => {
    try {
      const { data: html } = await axios.get(a.link, { ...HTTP, timeout: 10000 });
      const $a = cheerio.load(html);
      a.content =
        $a('meta[property="og:description"]').attr('content') ||
        $a('meta[name="description"]').attr('content')        ||
        $a('.field--name-body p').first().text().trim()       ||
        a.title;
    } catch { a.content = a.title; }
  }));
  return articles;
}

// ─── 電通デジタル スクレイパー ────────────────────────────────
async function fetchDentsuDigital(source) {
  const { data } = await axios.get(source.url, HTTP);
  const $ = cheerio.load(data);
  const articles = [];
  $('li.m-panel').each((_, el) => {
    if (articles.length >= ARTICLES_PER_SOURCE) return false;
    const $item = $(el);
    const href  = $item.find('a.m-panel__wrap').attr('href');
    const title = $item.find('em.m-panel__title').text().trim();
    const date  = $item.find('time.m-panel__subTitle').text().trim();
    if (!href || !title) return;
    articles.push({ source: source.name, title, link: `https://dentsudigital.co.jp${href}`, content: '', pubDate: date });
  });
  await Promise.all(articles.map(async a => {
    try {
      const { data: html } = await axios.get(a.link, { ...HTTP, timeout: 10000 });
      const $a = cheerio.load(html);
      a.content =
        $a('meta[property="og:description"]').attr('content') ||
        $a('meta[name="description"]').attr('content')        ||
        a.title;
    } catch { a.content = a.title; }
  }));
  return articles;
}

// ─── WordPress 汎用スクレイパー ───────────────────────────────
async function fetchWordPressBlog(source) {
  const { data } = await axios.get(source.url, HTTP);
  const $ = cheerio.load(data);
  const articles = [];
  const seen = new Set();
  const selectors = [
    'article h2 a', 'article h3 a',
    '.entry-title a', '.post-title a',
    'h2.entry-title a', 'h3.entry-title a',
    '.blog-title a', '.article-title a',
  ];
  for (const sel of selectors) {
    if (articles.length >= ARTICLES_PER_SOURCE) break;
    $(sel).each((_, el) => {
      if (articles.length >= ARTICLES_PER_SOURCE) return false;
      const href  = $(el).attr('href');
      const title = $(el).text().trim();
      if (!href || !title || seen.has(href)) return;
      seen.add(href);
      const link = href.startsWith('http') ? href : new URL(href, source.url).href;
      articles.push({ source: source.name, title, link, content: title, pubDate: '' });
    });
    if (articles.length > 0) break;
  }
  return articles;
}

// ─── ソース取得ディスパッチャー ───────────────────────────────
async function fetchSource(source) {
  try {
    return source.type === 'rss' ? await fetchRSS(source) : await source.fetch(source);
  } catch (err) {
    console.error(`  [SKIP] ${source.name}: ${err.message.split('\n')[0]}`);
    return [];
  }
}

// ─── Claude バッチスコアリング ────────────────────────────────
async function scoreArticles(articles) {
  const list = articles.map((a, i) => ({
    id:          i,
    title:       a.title,
    source:      a.source,
    description: (a.content || '').slice(0, 300),
  }));

  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 8192,
    thinking:   { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: [
          'あなたは運用型広告の専門家です。以下の記事リストを読み、',
          '「日本の運用型広告実務担当者にとっての有用度」を1〜10点で採点してください。',
          '',
          '採点基準:',
          '9〜10: 主要プラットフォームの重大アップデート・新機能発表（即実務影響あり）',
          '7〜8 : 実践的な運用テクニック・事例・アルゴリズム変更の解説',
          '5〜6 : マーケティング全般の知見・業界動向',
          '3〜4 : 企業プレスリリース・受賞報告・採用情報',
          '1〜2 : 広告運用と無関係・汎用コンテンツ',
          '',
          '【重要】JSON配列のみを返してください。説明文・コードブロック（```）は絶対に含めないでください。',
          `出力形式（id=0からid=${list.length - 1}まで全${list.length}件必須）:`,
          '[{"id":0,"score":8,"reason":"理由を30字以内で記述"},{"id":1,"score":5,"reason":"..."},...]',
        ].join('\n'),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role:    'user',
        content: `以下${list.length}件の記事をスコアリングしてください:\n${JSON.stringify(list, null, 2)}`,
      },
    ],
  });

  // thinkingブロックを除外してtextブロックだけ結合
  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // ① コードブロック除去 (```json ... ``` or ``` ... ```)
  let raw = text.trim();
  const cbMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cbMatch) raw = cbMatch[1].trim();

  // ② JSON配列を抽出（最初の [ から最後の ] まで）
  const start = raw.indexOf('[');
  const end   = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    console.error('  [WARN] JSON配列が見つかりません。先頭500字:', text.slice(0, 500));
    return articles.map((_, i) => ({ id: i, score: 5, reason: '(スコア取得失敗)' }));
  }

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('空配列');
    return parsed.map(item => ({
      id:     typeof item.id === 'number' ? item.id : 0,
      score:  Math.round(Math.max(1, Math.min(10, Number(item.score) || 5))),
      reason: String(item.reason || ''),
    }));
  } catch (err) {
    console.error('  [WARN] JSON.parse失敗:', err.message);
    console.error('  抽出文字列(先頭300字):', raw.slice(start, start + 300));
    return articles.map((_, i) => ({ id: i, score: 5, reason: '(スコア取得失敗)' }));
  }
}

// ─── Claude 3行要約 ──────────────────────────────────────────
async function summarizeArticle(article) {
  const response = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 400,
    thinking:   { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: [
          'あなたはマーケティング・デジタル広告専門のニュースアシスタントです。',
          '与えられた記事を必ず日本語で3行に要約してください。',
          '各行は「・」から始め、1行あたり40〜60字程度で、具体的かつ情報密度の高い内容にしてください。',
          '余計な前置きや後書きは不要です。3行のみ出力してください。',
        ].join('\n'),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role:    'user',
        content: `タイトル: ${article.title}\n\n内容: ${(article.content || '').slice(0, 1500)}`,
      },
    ],
  });
  const tb = response.content.find(b => b.type === 'text');
  return tb ? tb.text.trim() : '(要約を取得できませんでした)';
}

// ─── Slack スレッド送信 ───────────────────────────────────────
function scoreStars(n) {
  return '★'.repeat(n) + '☆'.repeat(10 - n);
}

function slackHeaders() {
  return {
    Authorization:  `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

async function postParentMessage(count) {
  const today = new Date().toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const res = await axios.post(
    'https://slack.com/api/chat.postMessage',
    {
      channel: process.env.SLACK_CHANNEL_ID,
      text:    `🗞️ 本日のマーケティングニュース ${count}件 (${today})`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `🗞️ 本日のマーケティングニュース　${count}件`, emoji: true },
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `${today} ｜ 運用型広告実務担当者向け厳選記事 スコア上位${count}件`,
          }],
        },
      ],
    },
    { headers: slackHeaders(), timeout: 10000 }
  );
  if (!res.data.ok) throw new Error(`Slack API error: ${res.data.error}`);
  return res.data.ts; // thread_ts
}

async function postArticleToThread(article, threadTs, rank) {
  const res = await axios.post(
    'https://slack.com/api/chat.postMessage',
    {
      channel:   process.env.SLACK_CHANNEL_ID,
      thread_ts: threadTs,
      text:      `[${article.source}] ${article.title}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*#${rank} [${article.source}]* <${article.link}|${article.title}>`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*スコア:* ${scoreStars(article.score)}  *${article.score}/10*` },
            { type: 'mrkdwn', text: `*有用な理由:* ${article.reason}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: article.summary },
        },
      ],
    },
    { headers: slackHeaders(), timeout: 10000 }
  );
  if (!res.data.ok) throw new Error(`Slack API error: ${res.data.error}`);
}

// ─── GitHub Pages ダッシュボード生成 ─────────────────────────
function generateDashboard(allArticles) {
  const sources  = [...new Set(allArticles.map(a => a.source))].sort();
  const dataJson = JSON.stringify(allArticles);

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>マーケティングニュース ダッシュボード</title>
<style>
  :root {
    --bg: #f0f2f5; --card: #ffffff; --text: #1a1a2e; --sub: #555;
    --accent: #4361ee; --border: #e0e0e0;
    --score-high: #22c55e; --score-mid: #f59e0b; --score-low: #ef4444;
    --header-bg: #1a1a2e; --header-text: #fff;
    --filter-bg: #e8ecff; --filter-active: #4361ee; --filter-active-text: #fff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f0f1a; --card: #1e1e30; --text: #e8e8f0; --sub: #9090b0;
      --accent: #7b93ff; --border: #2e2e48;
      --header-bg: #0a0a18; --header-text: #e8e8f0;
      --filter-bg: #2a2a44; --filter-active: #7b93ff; --filter-active-text: #0f0f1a;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
         background: var(--bg); color: var(--text); min-height: 100vh; }
  header { background: var(--header-bg); color: var(--header-text); padding: 20px 24px;
           display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  header h1 { font-size: 1.3rem; font-weight: 700; }
  header p  { font-size: 0.85rem; opacity: 0.7; }
  .dark-toggle { background: transparent; border: 1px solid rgba(255,255,255,0.3);
                 color: var(--header-text); padding: 6px 12px; border-radius: 20px;
                 cursor: pointer; font-size: 0.8rem; }
  .controls { padding: 16px 24px; background: var(--card); border-bottom: 1px solid var(--border);
              display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .controls span { font-size: 0.8rem; color: var(--sub); margin-right: 4px; }
  .filter-btn { padding: 5px 14px; border-radius: 20px; border: 1px solid var(--border);
                background: var(--filter-bg); color: var(--text); cursor: pointer;
                font-size: 0.8rem; transition: all 0.15s; white-space: nowrap; }
  .filter-btn.active { background: var(--filter-active); color: var(--filter-active-text);
                       border-color: var(--filter-active); }
  .stats { margin-left: auto; font-size: 0.8rem; color: var(--sub); }
  .grid { display: grid; padding: 20px 24px; gap: 16px;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
          padding: 18px; display: flex; flex-direction: column; gap: 10px;
          transition: box-shadow 0.2s; }
  .card:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.12); }
  .card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .source-badge { font-size: 0.72rem; font-weight: 600; padding: 3px 10px; border-radius: 12px;
                  background: var(--filter-bg); color: var(--accent); white-space: nowrap; max-width: 160px;
                  overflow: hidden; text-overflow: ellipsis; }
  .score-badge { font-size: 0.8rem; font-weight: 700; padding: 3px 10px; border-radius: 12px; color: #fff;
                 white-space: nowrap; flex-shrink: 0; }
  .score-high { background: var(--score-high); }
  .score-mid  { background: var(--score-mid); }
  .score-low  { background: var(--score-low); }
  .card-title { font-size: 0.95rem; font-weight: 600; line-height: 1.4; }
  .card-title a { color: var(--text); text-decoration: none; }
  .card-title a:hover { color: var(--accent); text-decoration: underline; }
  .card-stars { font-size: 0.85rem; color: #f59e0b; letter-spacing: 1px; }
  .card-reason { font-size: 0.78rem; color: var(--sub); font-style: italic; }
  .card-summary { font-size: 0.82rem; color: var(--sub); line-height: 1.6;
                  border-left: 3px solid var(--border); padding-left: 10px; }
  .card-footer { display: flex; justify-content: space-between; align-items: center;
                 font-size: 0.75rem; color: var(--sub); margin-top: 4px; }
  .card-footer a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .card-footer a:hover { text-decoration: underline; }
  .empty { text-align: center; padding: 60px; color: var(--sub); grid-column: 1/-1; }
  @media (max-width: 600px) {
    header { padding: 14px 16px; }
    .controls, .grid { padding: 12px 16px; }
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>📊 マーケティングニュース ダッシュボード</h1>
    <p>運用型広告実務担当者向け 直近${HISTORY_DAYS}日間の記事</p>
  </div>
  <button class="dark-toggle" onclick="toggleDark()">🌙 ダークモード切替</button>
</header>
<div class="controls" id="controls">
  <span>ソース:</span>
  <button class="filter-btn active" onclick="setSource('all', this)">すべて</button>
  ${sources.map(s => `<button class="filter-btn" onclick="setSource(${JSON.stringify(s)}, this)">${s}</button>`).join('\n  ')}
  <div class="stats" id="stats"></div>
</div>
<div class="grid" id="grid"></div>
<script>
const DATA = ${dataJson};
let currentSource = 'all';

function scoreClass(s) {
  return s >= 8 ? 'score-high' : s >= 5 ? 'score-mid' : 'score-low';
}
function stars(n) {
  return '★'.repeat(n) + '☆'.repeat(10 - n);
}
function fmt(dateStr) {
  if (!dateStr) return '';
  return dateStr.replace(/-/g, '/');
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function render() {
  const items = DATA
    .filter(a => currentSource === 'all' || a.source === currentSource)
    .sort((a, b) => {
      if (b.date !== a.date) return b.date.localeCompare(a.date);
      return b.score - a.score;
    });
  document.getElementById('stats').textContent = items.length + '件';
  const grid = document.getElementById('grid');
  if (items.length === 0) {
    grid.innerHTML = '<div class="empty">該当する記事がありません</div>';
    return;
  }
  grid.innerHTML = items.map(a => \`
<div class="card" data-source="\${esc(a.source)}">
  <div class="card-top">
    <span class="source-badge">\${esc(a.source)}</span>
    <span class="score-badge \${scoreClass(a.score)}">\${a.score}/10</span>
  </div>
  <div class="card-title"><a href="\${esc(a.link)}" target="_blank" rel="noopener">\${esc(a.title)}</a></div>
  <div class="card-stars">\${stars(a.score)}</div>
  \${a.reason ? \`<div class="card-reason">💡 \${esc(a.reason)}</div>\` : ''}
  \${a.summary ? \`<div class="card-summary">\${esc(a.summary).replace(/\\n/g,'<br>')}</div>\` : ''}
  <div class="card-footer">
    <span>📅 \${fmt(a.date)}</span>
    <a href="\${esc(a.link)}" target="_blank" rel="noopener">記事を読む →</a>
  </div>
</div>\`).join('');
}

function setSource(src, btn) {
  currentSource = src;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
}

function toggleDark() {
  document.documentElement.classList.toggle('force-dark');
}

// 手動ダークモード
const style = document.createElement('style');
style.textContent = \`
  html.force-dark { filter: none; }
  html.force-dark body { --bg:#0f0f1a;--card:#1e1e30;--text:#e8e8f0;--sub:#9090b0;
    --accent:#7b93ff;--border:#2e2e48;--header-bg:#0a0a18;--header-text:#e8e8f0;
    --filter-bg:#2a2a44;--filter-active:#7b93ff;--filter-active-text:#0f0f1a; }
\`;
document.head.appendChild(style);

render();
</script>
</body>
</html>`;

  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(DOCS_INDEX, html, 'utf8');
  // Jekyll無効化
  const nojekyll = path.join(DOCS_DIR, '.nojekyll');
  if (!fs.existsSync(nojekyll)) fs.writeFileSync(nojekyll, '');
  console.log(`  📄 docs/index.html を更新しました（${allArticles.length}件）`);
}

// ─── メイン処理 ───────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  if (!process.env.SLACK_BOT_TOKEN)   throw new Error('SLACK_BOT_TOKEN が設定されていません');
  if (!process.env.SLACK_CHANNEL_ID)  throw new Error('SLACK_CHANNEL_ID が設定されていません');

  console.log('=== Slack マーケティングボット 起動 ===\n');

  // ① 記事取得
  console.log('① 記事を取得中...');
  const results     = await Promise.all(SOURCES.map(fetchSource));
  const allArticles = results.flat();
  SOURCES.forEach((s, i) => {
    const n = results[i].length;
    console.log(`  ${n > 0 ? '✓' : '✗'} ${s.name}: ${n}件`);
  });
  console.log(`  合計: ${allArticles.length}件\n`);

  if (allArticles.length === 0) {
    console.log('取得できた記事がありませんでした。終了します。');
    return;
  }

  // ② 重複排除
  console.log('② 重複排除...');
  const sentData  = loadSentData();
  const deduped   = deduplicateBatch(allArticles);     // バッチ内類似マージ
  const fresh     = filterSent(deduped, sentData);     // 送信済み除外
  console.log(`  ${allArticles.length}件 → バッチ内マージ後 ${deduped.length}件 → 新規 ${fresh.length}件\n`);

  if (fresh.length === 0) {
    console.log('新規記事がありませんでした。終了します。');
    generateDashboard(sentData.articles);
    return;
  }

  // ③ バッチスコアリング
  console.log(`③ ${fresh.length}件を一括スコアリング中...`);
  const scores   = await scoreArticles(fresh);
  const scoreMap = Object.fromEntries(scores.map(s => [s.id, s]));

  // ④ 上位 TOP_N 件を選出
  const ranked = fresh
    .map((a, i) => ({ ...a, ...(scoreMap[i] || { score: 5, reason: '' }) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  console.log(`\n④ 上位${ranked.length}件:`);
  ranked.forEach((a, i) => console.log(`  ${i + 1}. [${a.score}/10] ${a.source} | ${a.title}`));
  console.log('');

  // ⑤ 要約
  console.log('⑤ 要約生成中...');
  for (const article of ranked) {
    process.stdout.write(`  [${article.score}/10] ${article.source} | 要約中... `);
    try {
      article.summary = await summarizeArticle(article);
      console.log('✓');
    } catch (err) {
      article.summary = '(要約失敗)';
      console.log(`✗ ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // ⑥ Slack スレッド送信
  console.log('\n⑥ Slack に送信中...');
  const threadTs = await postParentMessage(ranked.length);
  console.log(`  親メッセージ投稿完了 (ts: ${threadTs})`);

  let sentCount = 0;
  for (const [i, article] of ranked.entries()) {
    try {
      await postArticleToThread(article, threadTs, i + 1);
      sentCount++;
      console.log(`  [${i + 1}/${ranked.length}] ✓ ${article.title.slice(0, 50)}`);
    } catch (err) {
      console.error(`  [${i + 1}/${ranked.length}] ✗ ${err.message}`);
    }
    if (i < ranked.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  // ⑦ 既読記録に追加
  recordSent(ranked, sentData);
  saveSentData(sentData);
  console.log(`\n  sent_articles.json を更新しました`);

  // ⑧ ダッシュボード生成（直近30日分）
  console.log('\n⑦ ダッシュボード生成中...');
  generateDashboard(sentData.articles);

  console.log(`\n=== 完了: ${sentCount}/${ranked.length} 件を送信しました ===`);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
