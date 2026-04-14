require('dotenv').config();
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
const TOP_N               = 10; // Slackに送信する上位件数

const HTTP = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
  },
  timeout: 15000,
};

// ─── ソース定義 ───────────────────────────────────────────────
// ※ Yahoo!広告・LINE for Business は 2023年10月 LINEヤフー for Business に統合済み
//    → www.lycbiz.com/jp/column/ を参照
// ※ アイレップ は Hakuhodo DY ONE の ONEDER に統合済み
//    → oneder.hakuhodody-one.co.jp を参照
// ※ Bプラン(bplan.co.jp)・オーリーズ(aulys.jp) は現環境でDNS不達
//    → GitHub Actions 等から実行時は取得できる可能性あり / 失敗は graceful skip
const SOURCES = [
  // ── 媒体公式ブログ ──────────────────────────────────────────
  {
    name: 'Google広告',
    type: 'rss',
    url:  'https://www.blog.google/products/ads-commerce/rss/',
  },
  {
    name: 'Meta for Business',
    type: 'rss',
    url:  'https://www.facebook.com/business/news/rss/',
  },
  {
    name:  'TikTok for Business',
    type:  'scrape',
    url:   'https://ads.tiktok.com/business/en/blog',
    fetch: fetchTikTok,
  },
  {
    name:  'Yahoo!広告 (LINEヤフー for Business)',
    type:  'scrape',
    url:   'https://www.lycbiz.com/jp/column/ly-ads/',
    fetch: fetchLYCBiz,
  },
  {
    name:  'LINE for Business (LINEヤフー for Business)',
    type:  'scrape',
    url:   'https://www.lycbiz.com/jp/column/',
    fetch: fetchLYCBiz,
  },
  // ── 代理店ブログ ────────────────────────────────────────────
  {
    name: 'アナグラム',
    type: 'rss',
    url:  'https://anagrams.jp/blog/feed/',
  },
  {
    name: 'アイレップ (ONEDER / Hakuhodo DY ONE)',
    type: 'rss',
    url:  'https://oneder.hakuhodody-one.co.jp/blog/rss.xml',
  },
  {
    name:  '電通デジタル',
    type:  'scrape',
    url:   'https://dentsudigital.co.jp/news/release',
    fetch: fetchDentsuDigital,
  },
  {
    name:  'Bプラン',
    type:  'scrape',
    url:   'https://bplan.co.jp/blog/',
    fetch: fetchWordPressBlog,
  },
  {
    name:  'オーリーズ',
    type:  'scrape',
    url:   'https://aulys.jp/blog/',
    fetch: fetchWordPressBlog,
  },
];

// ─── RSS フェッチャー ──────────────────────────────────────────
async function fetchRSS(source) {
  const parsed = await rssParser.parseURL(source.url);
  return parsed.items.slice(0, ARTICLES_PER_SOURCE).map(item => ({
    source:  source.name,
    title:   item.title   || '(タイトルなし)',
    link:    item.link    || '',
    content: item.contentSnippet || item.content || item.summary || '',
    pubDate: item.pubDate || item.isoDate || '',
  }));
}

// ─── TikTok スクレイパー ──────────────────────────────────────
// SSRページ: h3.card-title a + p.card-excerpt
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
    articles.push({
      source:  source.name,
      title,
      link:    `https://ads.tiktok.com${href}`,
      content: excerpt,
      pubDate: '',
    });
  });
  return articles;
}

// ─── LYCBiz スクレイパー (Yahoo!広告 / LINE for Business) ─────
// li.columnList__item → a.pagePannel__inner + p.pagePannel__txt
// 各記事ページから og:description を取得
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
    articles.push({
      source:  source.name,
      title,
      link:    `https://www.lycbiz.com${href}`,
      content: '',
      pubDate: date,
    });
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
// li.m-panel → a.m-panel__wrap + em.m-panel__title
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
    articles.push({
      source:  source.name,
      title,
      link:    `https://dentsudigital.co.jp${href}`,
      content: '',
      pubDate: date,
    });
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

// ─── WordPress 汎用スクレイパー (Bプラン / オーリーズ等) ─────
// WordPress の標準マークアップ: article h2/h3 a, .entry-title a 等を試みる
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
// 全記事を1回のAPIコールで1〜10点スコアリング
async function scoreArticles(articles) {
  const list = articles.map((a, i) => ({
    id: i,
    title: a.title,
    source: a.source,
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
          '必ずJSON配列のみを返してください（説明文・コードブロック不要）:',
          '[{"id":0,"score":8,"reason":"スマートビッディングの新ターゲットCPA機能を詳解し即適用可能"},...] ',
        ].join('\n'),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `以下${list.length}件の記事をスコアリングしてください:\n${JSON.stringify(list, null, 2)}`,
      },
    ],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '[]';
  // JSON部分だけ抽出（思考ブロック混在対応）
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return articles.map((_, i) => ({ id: i, score: 5, reason: '(スコア取得失敗)' }));

  try {
    return JSON.parse(match[0]);
  } catch {
    return articles.map((_, i) => ({ id: i, score: 5, reason: '(スコア取得失敗)' }));
  }
}

// ─── Claude で3行要約 ─────────────────────────────────────────
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
        role: 'user',
        content: `タイトル: ${article.title}\n\n内容: ${(article.content || '').slice(0, 1500)}`,
      },
    ],
  });
  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '(要約を取得できませんでした)';
}

// ─── Slack 通知 ───────────────────────────────────────────────
function scoreStars(score) {
  return '★'.repeat(score) + '☆'.repeat(10 - score);
}

async function sendToSlack(article, summary, score, reason) {
  const payload = {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*[${article.source}]* <${article.link}|${article.title}>`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*スコア:* ${scoreStars(score)} *${score}/10*`,
          },
          {
            type: 'mrkdwn',
            text: `*有用な理由:* ${reason}`,
          },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: summary },
      },
      { type: 'divider' },
    ],
  };
  await axios.post(process.env.SLACK_WEBHOOK_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

// ─── メイン処理 ───────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が設定されていません。');
  if (!process.env.SLACK_WEBHOOK_URL) throw new Error('SLACK_WEBHOOK_URL が設定されていません。');

  console.log('=== Slack マーケティングボット 起動 ===\n');
  console.log('① 記事を取得中...');

  const results     = await Promise.all(SOURCES.map(fetchSource));
  const allArticles = results.flat();

  SOURCES.forEach((s, i) => {
    const count = results[i].length;
    console.log(`  ${count > 0 ? '✓' : '✗'} ${s.name}: ${count} 件`);
  });
  console.log(`  合計: ${allArticles.length} 件\n`);

  if (allArticles.length === 0) {
    console.log('取得できた記事がありませんでした。処理を終了します。');
    return;
  }

  // ② 全記事を一括スコアリング
  console.log(`② ${allArticles.length}件を一括スコアリング中...`);
  const scores  = await scoreArticles(allArticles);
  const scoreMap = Object.fromEntries(scores.map(s => [s.id, s]));

  // ③ 上位 TOP_N 件を選出
  const ranked = allArticles
    .map((a, i) => ({ ...a, ...scoreMap[i] }))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, TOP_N);

  console.log(`\n③ 上位${TOP_N}件を要約・Slack送信中...\n`);
  ranked.forEach((a, i) => console.log(`  ${i + 1}. [${a.score}/10] ${a.title}`));
  console.log('');

  // ④ 各記事を要約 → Slack 送信
  let successCount = 0;
  for (const [i, article] of ranked.entries()) {
    process.stdout.write(`[${i + 1}/${TOP_N}] スコア:${article.score} | ${article.source} | 要約中... `);
    try {
      const summary = await summarizeArticle(article);
      await sendToSlack(article, summary, article.score, article.reason);
      successCount++;
      console.log('✓ 送信完了');
    } catch (err) {
      console.log(`✗ 失敗: ${err.message}`);
    }
    if (i < ranked.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== 完了: ${successCount}/${TOP_N} 件を送信しました ===`);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
