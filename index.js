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

const ARTICLES_PER_SOURCE = 10;   // P2補完用に多めに取得
const TOP_N               = 10;
const RECENT_DAYS         = 3;    // この日数以内を「新着」とみなす
const HISTORY_DAYS        = 30;
const SENT_PATH           = path.join(__dirname, 'sent_articles.json');
const DOCS_DIR            = path.join(__dirname, 'docs');
const DOCS_INDEX          = path.join(DOCS_DIR, 'index.html');

// P3 補完キーワード
const SEARCH_KEYWORDS = [
  'デジタル広告', '運用型広告', '消費者庁 広告', '景品表示法 広告',
  '広告代理店', 'Meta広告', 'Google広告', 'TikTok広告',
];

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

// ─── 既読管理 ─────────────────────────────────────────────────
function loadSentData() {
  try {
    const raw = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));
    return { urls: raw.urls || {}, titles: raw.titles || [], articles: raw.articles || [] };
  } catch {
    return { urls: {}, titles: [], articles: [] };
  }
}

function saveSentData(data) {
  const cutoff = daysAgo(HISTORY_DAYS);
  data.urls     = Object.fromEntries(Object.entries(data.urls).filter(([, d]) => d >= cutoff));
  data.titles   = data.titles.filter(t => t.date >= cutoff);
  data.articles = data.articles.filter(a => a.date >= cutoff);
  fs.writeFileSync(SENT_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// ─── 類似度・重複排除 ─────────────────────────────────────────
// Jaccard係数（文字レベル）
function titleSimilarity(a, b) {
  const norm = s => new Set([...s.replace(/[\s\u3000・【】「」『』（）()\-_\/|]/g, '').toLowerCase()]);
  const A = norm(a), B = norm(b);
  const inter = [...A].filter(c => B.has(c)).length;
  const union  = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

const JACCARD_THRESHOLD    = 0.70; // ユーザー指定
const PERIODIC_RE = /\d+月.*(?:アップデート|まとめ|変更点|更新|ニュース)|月次|週次まとめ|定期レポート/;

// バッチ内マージ（同一ソース内の重複除去）
function deduplicateBatch(articles) {
  const kept = [];
  for (const a of articles) {
    if (kept.some(k => titleSimilarity(a.title, k.title) >= JACCARD_THRESHOLD)) {
      console.log(`  [MERGE] ${a.title.slice(0, 50)}`);
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
    if (a.link && sentData.urls[a.link]) {
      console.log(`  [SKIP-URL] ${a.title.slice(0, 50)}`);
      continue;
    }
    if (PERIODIC_RE.test(a.title)) {
      const hit = sentData.titles.find(
        t => t.date >= sevenDaysCutoff && titleSimilarity(a.title, t.title) >= JACCARD_THRESHOLD
      );
      if (hit) { console.log(`  [SKIP-PERIODIC] ${a.title.slice(0, 50)}`); continue; }
    }
    if (sentData.titles.some(t => titleSimilarity(a.title, t.title) >= JACCARD_THRESHOLD)) {
      console.log(`  [SKIP-SIMILAR] ${a.title.slice(0, 50)}`);
      continue;
    }
    result.push(a);
  }
  return result;
}

// 選出済み記事との重複チェック（P2/P3追加時に使用）
function filterSimilarToSelected(articles, selected) {
  return articles.filter(a =>
    !selected.some(s => titleSimilarity(a.title, s.title) >= JACCARD_THRESHOLD)
  );
}

// 新着記事判定（RECENT_DAYS以内 or pubDate不明=スクレイプ当日）
function isRecent(article) {
  if (!article.pubDate) return true; // 日付不明はスクレイプ当日とみなす
  const d = new Date(article.pubDate);
  return !isNaN(d.getTime()) && d.getTime() >= Date.now() - RECENT_DAYS * 86400000;
}

// スコア結合＆ソート
function mergeAndSort(articles, scores) {
  const scoreMap = Object.fromEntries(scores.map(s => [s.id, s]));
  return articles
    .map((a, i) => ({ ...a, ...(scoreMap[i] || { score: 5, reason: '' }) }))
    .sort((a, b) => b.score - a.score);
}

function recordSent(articles, sentData) {
  const today = new Date().toISOString().slice(0, 10);
  for (const a of articles) {
    if (a.link) sentData.urls[a.link] = today;
    sentData.titles.push({ title: a.title, date: today });
    sentData.articles.push({
      source: a.source, title: a.title, link: a.link,
      summary: a.summary || '', score: a.score || 0,
      reason: a.reason || '', date: today,
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
    const href  = $(el).attr('href');
    const title = $(el).text().trim();
    if (!href || !title) return;
    const excerpt = $(el).closest('[data-url]').find('p.card-excerpt').text().trim();
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
      a.content = $a('meta[property="og:description"]').attr('content') ||
                  $a('meta[name="description"]').attr('content') ||
                  $a('.field--name-body p').first().text().trim() || a.title;
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
      a.content = $a('meta[property="og:description"]').attr('content') ||
                  $a('meta[name="description"]').attr('content') || a.title;
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
    'article h2 a', 'article h3 a', '.entry-title a', '.post-title a',
    'h2.entry-title a', 'h3.entry-title a', '.blog-title a', '.article-title a',
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

async function fetchSource(source) {
  try {
    return source.type === 'rss' ? await fetchRSS(source) : await source.fetch(source);
  } catch (err) {
    console.error(`  [SKIP] ${source.name}: ${err.message.split('\n')[0]}`);
    return [];
  }
}

// ─── P3: Google News 検索（RSS）────────────────────────────────
async function fetchGoogleNews(keyword) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=ja&gl=JP&ceid=JP:ja`;
  try {
    const feed = await rssParser.parseURL(url);
    return feed.items.slice(0, 3).map(item => ({
      source:  'Google News',
      title:   item.title          || '',
      link:    item.link           || '',
      content: item.contentSnippet || '',
      pubDate: item.pubDate        || item.isoDate || '',
    })).filter(a => a.title && a.link);
  } catch {
    return [];
  }
}

// ─── P3: Yahoo!ニュース 検索（スクレイプ）────────────────────
async function fetchYahooNews(keyword) {
  const url = `https://news.yahoo.co.jp/search?p=${encodeURIComponent(keyword)}&ei=UTF-8`;
  try {
    const { data } = await axios.get(url, { ...HTTP, timeout: 10000 });
    const $ = cheerio.load(data);
    const seen = new Set();
    const articles = [];

    // Yahoo!ニュース記事リンクは /articles/[ハッシュ] の形式
    $('a[href]').each((_, el) => {
      if (articles.length >= 3) return false;
      const href = $(el).attr('href') || '';
      if (!href.includes('/articles/')) return;
      const fullUrl = href.startsWith('http') ? href : `https://news.yahoo.co.jp${href}`;
      // クエリパラメータを除いたURLで重複排除
      const baseUrl = fullUrl.split('?')[0];
      if (seen.has(baseUrl)) return;
      seen.add(baseUrl);

      const $el = $(el);
      // タイトルを取得（h2/h3 > テキスト > title属性の優先順）
      const title = (
        $el.find('h2, h3').first().text() ||
        $el.attr('title') ||
        $el.text()
      ).trim().replace(/\s+/g, ' ');

      if (!title || title.length < 8 || title.length > 200) return;
      articles.push({ source: 'Yahoo!ニュース', title, link: fullUrl, content: '', pubDate: '' });
    });
    return articles;
  } catch {
    return [];
  }
}

// ─── P3: 全キーワード検索をまとめて実行 ────────────────────────
async function fetchSearchSupplement(needed, selected, sentData) {
  console.log(`  キーワード検索（${SEARCH_KEYWORDS.length}語 × Google+Yahoo）...`);

  // 全キーワードを並列実行
  const tasks = SEARCH_KEYWORDS.flatMap(kw => [
    fetchGoogleNews(kw),
    fetchYahooNews(kw),
  ]);
  const raw = (await Promise.all(tasks)).flat();
  console.log(`  検索ヒット: ${raw.length}件（重複除去前）`);

  // バッチ内重複除去 → 送信済み除外 → 選出済みとの類似除外
  const deduped  = deduplicateBatch(raw);
  const fresh    = filterSent(deduped, sentData);
  const filtered = filterSimilarToSelected(fresh, selected);

  console.log(`  検索補完候補: ${filtered.length}件`);
  return filtered;
}

// ─── Claude バッチスコアリング ────────────────────────────────
async function scoreArticles(articles) {
  if (articles.length === 0) return [];
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
          '【重要】JSON配列のみ返してください。コードブロック・説明文は不要です。',
          `出力形式（id=0からid=${list.length - 1}まで全${list.length}件必須）:`,
          '[{"id":0,"score":8,"reason":"30字以内の理由"},...]',
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

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let raw = text.trim();
  const cb = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (cb) raw = cb[1].trim();
  const start = raw.indexOf('['), end = raw.lastIndexOf(']');
  if (start === -1 || end < start) {
    console.error('  [WARN] JSON配列が見つかりません:', text.slice(0, 300));
    return articles.map((_, i) => ({ id: i, score: 5, reason: '(スコア取得失敗)' }));
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed.map(item => ({
      id:     typeof item.id === 'number' ? item.id : 0,
      score:  Math.round(Math.max(1, Math.min(10, Number(item.score) || 5))),
      reason: String(item.reason || ''),
    }));
  } catch (err) {
    console.error('  [WARN] JSON.parse失敗:', err.message, raw.slice(start, start + 200));
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
function scoreStars(n) { return '★'.repeat(n) + '☆'.repeat(10 - n); }

function slackHeaders() {
  return { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' };
}

async function postParentMessage(count) {
  const today = new Date().toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  const res = await axios.post('https://slack.com/api/chat.postMessage', {
    channel: process.env.SLACK_CHANNEL_ID,
    text:    `🗞️ 本日のマーケティングニュース ${count}件 (${today})`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🗞️ 本日のマーケティングニュース　${count}件`, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `${today} ｜ 運用型広告実務担当者向け厳選記事 スコア上位${count}件` }] },
      { type: 'section', text: { type: 'mrkdwn', text: `詳細はダッシュボードで確認→ <https://tokuda-vegimax.github.io/slack-marketing-bot/|📊 Marketing News Dashboard>` } },
    ],
  }, { headers: slackHeaders(), timeout: 10000 });
  if (!res.data.ok) throw new Error(`Slack API error: ${res.data.error}`);
  return res.data.ts;
}

async function postArticleToThread(article, threadTs, rank) {
  const res = await axios.post('https://slack.com/api/chat.postMessage', {
    channel:   process.env.SLACK_CHANNEL_ID,
    thread_ts: threadTs,
    text:      `[${article.source}] ${article.title}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*#${rank} [${article.source}]* <${article.link}|${article.title}>` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*スコア:* ${scoreStars(article.score)}  *${article.score}/10*` },
        { type: 'mrkdwn', text: `*有用な理由:* ${article.reason}` },
      ]},
      { type: 'section', text: { type: 'mrkdwn', text: article.summary } },
    ],
  }, { headers: slackHeaders(), timeout: 10000 });
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
    --bg:#f0f2f5;--card:#fff;--text:#1a1a2e;--sub:#555;--accent:#4361ee;--border:#e0e0e0;
    --score-high:#22c55e;--score-mid:#f59e0b;--score-low:#ef4444;
    --header-bg:#1a1a2e;--header-text:#fff;
    --filter-bg:#e8ecff;--filter-active:#4361ee;--filter-active-text:#fff;
  }
  @media (prefers-color-scheme:dark){:root{
    --bg:#0f0f1a;--card:#1e1e30;--text:#e8e8f0;--sub:#9090b0;--accent:#7b93ff;--border:#2e2e48;
    --header-bg:#0a0a18;--header-text:#e8e8f0;
    --filter-bg:#2a2a44;--filter-active:#7b93ff;--filter-active-text:#0f0f1a;
  }}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
  header{background:var(--header-bg);color:var(--header-text);padding:20px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;}
  header h1{font-size:1.3rem;font-weight:700;}
  header p{font-size:.85rem;opacity:.7;}
  .dark-toggle{background:transparent;border:1px solid rgba(255,255,255,.3);color:var(--header-text);padding:6px 12px;border-radius:20px;cursor:pointer;font-size:.8rem;}
  .controls{padding:16px 24px;background:var(--card);border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
  .controls span{font-size:.8rem;color:var(--sub);margin-right:4px;}
  .filter-btn{padding:5px 14px;border-radius:20px;border:1px solid var(--border);background:var(--filter-bg);color:var(--text);cursor:pointer;font-size:.8rem;transition:all .15s;white-space:nowrap;}
  .filter-btn.active{background:var(--filter-active);color:var(--filter-active-text);border-color:var(--filter-active);}
  .stats{margin-left:auto;font-size:.8rem;color:var(--sub);}
  .grid{display:grid;padding:20px 24px;gap:16px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px;transition:box-shadow .2s;}
  .card:hover{box-shadow:0 4px 20px rgba(0,0,0,.12);}
  .card-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}
  .source-badge{font-size:.72rem;font-weight:600;padding:3px 10px;border-radius:12px;background:var(--filter-bg);color:var(--accent);white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis;}
  .score-badge{font-size:.8rem;font-weight:700;padding:3px 10px;border-radius:12px;color:#fff;white-space:nowrap;flex-shrink:0;}
  .score-high{background:var(--score-high);}.score-mid{background:var(--score-mid);}.score-low{background:var(--score-low);}
  .card-title{font-size:.95rem;font-weight:600;line-height:1.4;}
  .card-title a{color:var(--text);text-decoration:none;}
  .card-title a:hover{color:var(--accent);text-decoration:underline;}
  .card-stars{font-size:.85rem;color:#f59e0b;letter-spacing:1px;}
  .card-reason{font-size:.78rem;color:var(--sub);font-style:italic;}
  .card-summary{font-size:.82rem;color:var(--sub);line-height:1.6;border-left:3px solid var(--border);padding-left:10px;}
  .card-footer{display:flex;justify-content:space-between;align-items:center;font-size:.75rem;color:var(--sub);margin-top:4px;}
  .card-footer a{color:var(--accent);text-decoration:none;font-weight:600;}
  .card-footer a:hover{text-decoration:underline;}
  .empty{text-align:center;padding:60px;color:var(--sub);grid-column:1/-1;}
  @media(max-width:600px){header,.controls,.grid{padding:12px 16px;}.grid{grid-template-columns:1fr;}}
</style>
</head>
<body>
<header>
  <div><h1>📊 マーケティングニュース ダッシュボード</h1><p>運用型広告実務担当者向け 直近${HISTORY_DAYS}日間の記事</p></div>
  <button class="dark-toggle" onclick="toggleDark()">🌙 ダークモード切替</button>
</header>
<div class="controls" id="controls">
  <span>ソース:</span>
  <button class="filter-btn active" onclick="setSource('all',this)">すべて</button>
  ${sources.map(s => `<button class="filter-btn" onclick="setSource(${JSON.stringify(s)},this)">${s}</button>`).join('\n  ')}
  <div class="stats" id="stats"></div>
</div>
<div class="grid" id="grid"></div>
<script>
const DATA=${dataJson};
let cur='all';
const sc=n=>n>=8?'score-high':n>=5?'score-mid':'score-low';
const st=n=>'★'.repeat(n)+'☆'.repeat(10-n);
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function render(){
  const items=DATA.filter(a=>cur==='all'||a.source===cur).sort((a,b)=>b.date.localeCompare(a.date)||b.score-a.score);
  document.getElementById('stats').textContent=items.length+'件';
  const g=document.getElementById('grid');
  if(!items.length){g.innerHTML='<div class="empty">該当する記事がありません</div>';return;}
  g.innerHTML=items.map(a=>\`<div class="card">
  <div class="card-top"><span class="source-badge">\${esc(a.source)}</span><span class="score-badge \${sc(a.score)}">\${a.score}/10</span></div>
  <div class="card-title"><a href="\${esc(a.link)}" target="_blank" rel="noopener">\${esc(a.title)}</a></div>
  <div class="card-stars">\${st(a.score)}</div>
  \${a.reason?\`<div class="card-reason">💡 \${esc(a.reason)}</div>\`:''}
  \${a.summary?\`<div class="card-summary">\${esc(a.summary).replace(/\\n/g,'<br>')}</div>\`:''}
  <div class="card-footer"><span>📅 \${a.date.replace(/-/g,'/')}</span><a href="\${esc(a.link)}" target="_blank" rel="noopener">記事を読む →</a></div>
</div>\`).join('');
}
function setSource(s,btn){cur=s;document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');render();}
function toggleDark(){document.body.classList.toggle('force-dark');}
const ds=document.createElement('style');
ds.textContent='.force-dark{--bg:#0f0f1a;--card:#1e1e30;--text:#e8e8f0;--sub:#9090b0;--accent:#7b93ff;--border:#2e2e48;--header-bg:#0a0a18;--header-text:#e8e8f0;--filter-bg:#2a2a44;--filter-active:#7b93ff;--filter-active-text:#0f0f1a;}';
document.head.appendChild(ds);
render();
</script>
</body>
</html>`;
  if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(DOCS_INDEX, html, 'utf8');
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
  const sentData = loadSentData();

  // ────────────────────────────────────────────────────────────
  // ① 登録ソースから記事取得
  // ────────────────────────────────────────────────────────────
  console.log('① 登録ソースから記事取得中...');
  const results     = await Promise.all(SOURCES.map(fetchSource));
  const allFetched  = results.flat();
  SOURCES.forEach((s, i) => {
    const n = results[i].length;
    console.log(`  ${n > 0 ? '✓' : '✗'} ${s.name}: ${n}件`);
  });
  console.log(`  合計: ${allFetched.length}件\n`);

  // ────────────────────────────────────────────────────────────
  // ② 重複排除 → 新着(P1) / 過去(P2) に分類
  // ────────────────────────────────────────────────────────────
  console.log('② 重複排除 & 分類...');
  const deduped = deduplicateBatch(allFetched);
  const fresh   = filterSent(deduped, sentData);
  const p1      = fresh.filter(isRecent);
  const p2      = fresh.filter(a => !isRecent(a));
  console.log(`  合計: ${allFetched.length}件 → バッチ内マージ後 ${deduped.length}件 → 新規 ${fresh.length}件`);
  console.log(`  【P1】新着(${RECENT_DAYS}日以内): ${p1.length}件  【P2】過去未送信: ${p2.length}件\n`);

  // ────────────────────────────────────────────────────────────
  // ③ 優先度順に候補を積み上げる
  // ────────────────────────────────────────────────────────────
  let candidates = [];

  // P1: 新着記事をスコアリング
  if (p1.length > 0) {
    console.log(`③ 【P1】${p1.length}件をスコアリング中...`);
    const scores = await scoreArticles(p1);
    candidates   = mergeAndSort(p1, scores);
    console.log(`  P1選出: ${Math.min(candidates.length, TOP_N)}件`);
  }

  // P2: 不足分を過去記事で補完
  if (candidates.length < TOP_N && p2.length > 0) {
    const need = TOP_N - candidates.length;
    console.log(`\n  【P2】${p2.length}件から最大${need}件補完中...`);
    const p2Filtered = filterSimilarToSelected(p2, candidates);
    const scores     = await scoreArticles(p2Filtered);
    const p2Scored   = mergeAndSort(p2Filtered, scores);
    candidates       = [...candidates, ...p2Scored.slice(0, need)];
    console.log(`  P2補完後: ${candidates.length}件`);
  }

  // P3: まだ不足ならキーワード検索で補完
  if (candidates.length < TOP_N) {
    const need = TOP_N - candidates.length;
    console.log(`\n  【P3】キーワード検索で${need}件補完中...`);
    const searchResults = await fetchSearchSupplement(need, candidates, sentData);
    if (searchResults.length > 0) {
      const scores    = await scoreArticles(searchResults);
      const p3Scored  = mergeAndSort(searchResults, scores);
      candidates      = [...candidates, ...p3Scored.slice(0, need)];
      console.log(`  P3補完後: ${candidates.length}件`);
    } else {
      console.log(`  P3: 候補なし`);
    }
  }

  const ranked = candidates.slice(0, TOP_N);
  console.log(`\n④ 送信候補 ${ranked.length}件:`);
  ranked.forEach((a, i) => console.log(`  ${i + 1}. [${a.score}/10] ${a.source} | ${a.title.slice(0, 50)}`));

  if (ranked.length === 0) {
    console.log('\n送信できる記事がありませんでした。終了します。');
    return;
  }

  // ────────────────────────────────────────────────────────────
  // ⑤ 要約生成
  // ────────────────────────────────────────────────────────────
  console.log('\n⑤ 要約生成中...');
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

  // ────────────────────────────────────────────────────────────
  // ⑥ Slack スレッド送信
  // ────────────────────────────────────────────────────────────
  console.log('\n⑥ Slack に送信中...');
  const threadTs = await postParentMessage(ranked.length);
  console.log(`  親メッセージ投稿完了 (ts: ${threadTs})`);

  let sentCount = 0;
  for (const [i, article] of ranked.entries()) {
    try {
      await postArticleToThread(article, threadTs, i + 1);
      sentCount++;
      console.log(`  [${i + 1}/${ranked.length}] ✓ ${article.title.slice(0, 55)}`);
    } catch (err) {
      console.error(`  [${i + 1}/${ranked.length}] ✗ ${err.message}`);
    }
    if (i < ranked.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  // ────────────────────────────────────────────────────────────
  // ⑦ 既読記録保存 & ダッシュボード更新
  // ────────────────────────────────────────────────────────────
  recordSent(ranked, sentData);
  saveSentData(sentData);
  console.log('\n  sent_articles.json を更新しました');

  console.log('\n⑦ ダッシュボード生成中...');
  generateDashboard(sentData.articles);

  console.log(`\n=== 完了: ${sentCount}/${ranked.length} 件を送信しました ===`);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
