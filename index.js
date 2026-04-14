require('dotenv').config();
const Parser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const rssParser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSSBot/1.0)' },
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RSS_FEEDS = [
  { name: 'MarkeZine',     url: 'https://markezine.jp/rss/new/20/index.xml' },
  { name: 'DIGIDAY Japan', url: 'https://digiday.jp/feed/' },
];

// 各フィードから最大何件取得するか
const ARTICLES_PER_FEED = 5;

// ─── RSS取得 ──────────────────────────────────────────────────
async function fetchFeed(feed) {
  try {
    const parsed = await rssParser.parseURL(feed.url);
    return parsed.items.slice(0, ARTICLES_PER_FEED).map(item => ({
      source:   feed.name,
      title:    item.title   || '(タイトルなし)',
      link:     item.link    || '',
      content:  item.contentSnippet || item.content || item.summary || '',
      pubDate:  item.pubDate || item.isoDate || '',
    }));
  } catch (err) {
    console.error(`[ERROR] ${feed.name} の取得に失敗: ${err.message}`);
    return [];
  }
}

// ─── Claude で3行要約 ─────────────────────────────────────────
// システムプロンプトにプロンプトキャッシュを適用し、複数記事の処理コストを削減
async function summarizeArticle(article) {
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 400,
    thinking: { type: 'adaptive' },
    system: [
      {
        type: 'text',
        text: [
          'あなたはマーケティング・デジタル広告専門のニュースアシスタントです。',
          '与えられた記事を必ず日本語で3行に要約してください。',
          '各行は「・」から始め、1行あたり40〜60字程度で、具体的かつ情報密度の高い内容にしてください。',
          '余計な前置きや後書きは不要です。3行のみ出力してください。',
        ].join('\n'),
        cache_control: { type: 'ephemeral' }, // 複数記事処理時にキャッシュを再利用
      },
    ],
    messages: [
      {
        role: 'user',
        content: `タイトル: ${article.title}\n\n内容: ${article.content.slice(0, 1500)}`,
      },
    ],
  });

  // thinking ブロックをスキップして text ブロックだけ返す
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
        text: {
          type: 'mrkdwn',
          text: summary,
        },
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
  // 環境変数チェック
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません。.env ファイルを確認してください。');
  }
  if (!process.env.SLACK_WEBHOOK_URL) {
    throw new Error('SLACK_WEBHOOK_URL が設定されていません。.env ファイルを確認してください。');
  }

  console.log('=== Slack マーケティングボット 起動 ===\n');

  // 全フィードを並列取得
  console.log('RSSフィードを取得中...');
  const feedResults = await Promise.all(RSS_FEEDS.map(fetchFeed));
  const allArticles = feedResults.flat();

  RSS_FEEDS.forEach((feed, i) => {
    console.log(`  ${feed.name}: ${feedResults[i].length} 件`);
  });
  console.log(`  合計: ${allArticles.length} 件\n`);

  if (allArticles.length === 0) {
    console.log('取得できた記事がありませんでした。処理を終了します。');
    return;
  }

  // 記事ごとに要約 → Slack 送信（APIレート制限を考慮して逐次処理）
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

    // 連続リクエストを少し間隔を空ける
    if (i < allArticles.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`\n=== 完了: ${successCount}/${allArticles.length} 件を送信しました ===`);
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
