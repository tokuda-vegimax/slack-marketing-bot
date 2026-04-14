require('dotenv').config();
const Parser   = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const axios    = require('axios');
const cheerio  = require('cheerio');

// ─── 初期化 ───────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSSBot/1.0)' },
});
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ARTICLES_PER_SOURCE = 5;
const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.7,en;q=0.3',
};

// ─── ソース定義 ───────────────────────────────────────────────
// ※ lineforbusiness.com/ja/blog は日本語ルートが存在せずタイに転送されるため
//    LINEヤフー for Business (lycbiz.com) に変更
// ※ marketing.yahoo.co.jp/service/ads/blog は LINEヤフー for Business に統合済み
const SOURCES = [
  {
    name:  'Google広告',
    type:  'rss',
    url:   'https://www.blog.google/products/ads-commerce/rss/',
  },
  {
    name:  'Meta for Business',
    type:  'rss',
    url:   'https://www.facebook.com/business/news/rss/',
  },
  {
    name:  'TikTok for Business',
    type:  'scrape',
    url:   'https://ads.tiktok.com/business/en/blog',
    fetch: fetchTikTok,
  },
  {
    name:  'LINE広告 (LINEヤフー for Business)',
    type:  'scrape',
    url:   'https://www.lycbiz.com/jp/column/',
    fetch: fetchLYCBiz,
  },
  {
    name:  'Yahoo!広告 (LINEヤフー for Business)',
    type:  'scrape',
    url:   'https://www.lycbiz.com/jp/column/ly-ads/',
    fetch: fetchLYCBiz,
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
// SSRページから h3.card-title a + p.card-excerpt を抽出
async function fetchTikTok(source) {
  const { data } = await axios.get(source.url, { headers: HTTP_HEADERS, timeout: 15000 });
  const $ = cheerio.load(data);
  const articles = [];

  $('h3.card-title a[href*="/business/en/blog/"]').each((_, el) => {
    if (articles.length >= ARTICLES_PER_SOURCE) return false;
    const $el  = $(el);
    const href  = $el.attr('href');
    const title = $el.text().trim();
    if (!href || !title) return;

    // 直近の card コンテナから excerpt を取得
    const $card   = $el.closest('[data-url]');
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

// ─── LYCBiz スクレイパー (LINE広告 / Yahoo!広告) ──────────────
// li.columnList__item から記事タイトル・リンクを取得し
// 各記事の og:description を個別フェッチで補完
async function fetchLYCBiz(source) {
  const { data } = await axios.get(source.url, { headers: HTTP_HEADERS, timeout: 15000 });
  const $ = cheerio.load(data);
  const articles = [];

  $('li.columnList__item').each((_, el) => {
    if (articles.length >= ARTICLES_PER_SOURCE) return false;
    const $item = $(el);
    const href  = $item.find('a.pagePannel__inner').attr('href');
    const title = $item.find('p.pagePannel__txt').text().trim();
    const date  = $item.find('.pagePannel__date').first().text().trim();
    if (!href || !title) return;
    articles.push({
      source:  source.name,
      title,
      link:    `https://www.lycbiz.com${href}`,
      content: '',
      pubDate: date,
    });
  });

  // 記事ページから og:description を取得（並列）
  await Promise.all(articles.map(async article => {
    try {
      const { data: html } = await axios.get(article.link, { headers: HTTP_HEADERS, timeout: 10000 });
      const $a = cheerio.load(html);
      article.content =
        $a('meta[property="og:description"]').attr('content') ||
        $a('meta[name="description"]').attr('content')        ||
        $a('.field--name-body p').first().text().trim()       ||
        article.title;
    } catch {
      article.content = article.title;
    }
  }));

  return articles;
}

// ─── ソース取得ディスパッチャー ───────────────────────────────
async function fetchSource(source) {
  try {
    return source.type === 'rss' ? await fetchRSS(source) : await source.fetch(source);
  } catch (err) {
    console.error(`  [ERROR] ${source.name}: ${err.message}`);
    return [];
  }
}

// ─── Claude で3行要約 ─────────────────────────────────────────
// system prompt に cache_control を付与 → 複数記事処理時のコストを削減
async function summarizeArticle(article) {
  const response = await client.messages.create({
    model:   'claude-opus-4-6',
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
        content: `タイトル: ${article.title}\n\n内容: ${article.content.slice(0, 1500)}`,
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text.trim() : '(要約を取得できませんでした)';
}

// ─── Slack 通知 ───────────────────────────────────────────────
async function sendToSlack(article, summary) {
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
  console.log('記事を取得中...');

  // 全ソースを並列取得
  const results     = await Promise.all(SOURCES.map(fetchSource));
  const allArticles = results.flat();

  SOURCES.forEach((s, i) => console.log(`  ${s.name}: ${results[i].length} 件`));
  console.log(`  合計: ${allArticles.length} 件\n`);

  if (allArticles.length === 0) {
    console.log('取得できた記事がありませんでした。処理を終了します。');
    return;
  }

  // 記事ごとに要約 → Slack 送信（逐次・500ms間隔）
  let successCount = 0;
  for (const [i, article] of allArticles.entries()) {
    process.stdout.write(`[${i + 1}/${allArticles.length}] ${article.source} | 要約中... `);
    try {
      const summary = await summarizeArticle(article);
      await sendToSlack(article, summary);
      successCount++;
      console.log('✓ 送信完了');
    } catch (err) {
      console.log(`✗ 失敗: ${err.message}`);
    }
    if (i < allArticles.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n=== 完了: ${successCount}/${allArticles.length} 件を送信しました ===`);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
