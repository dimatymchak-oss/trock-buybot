require("dotenv").config();
process.env.NTBA_FIX_350 = "1";

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const { Address } = require("@ton/core");

const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
const GROUP_CHAT_ID = String(process.env.GROUP_CHAT_ID || "").trim();
const ADMIN_IDS = String(process.env.ADMIN_IDS || process.env.ADMIN_ID || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const TONAPI_KEY = String(process.env.TONAPI_KEY || "").trim();
const TONCENTER_API_KEY = String(process.env.TONCENTER_API_KEY || "").trim();
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS || 30000);

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!GROUP_CHAT_ID) throw new Error("GROUP_CHAT_ID missing");
if (!ADMIN_IDS.length) throw new Error("ADMIN_IDS missing");

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const BOT_STARTED_AT = Math.floor(Date.now() / 1000);

let isMonitoring = false;
const state = {};

function defaultDb() {
  return {
    token: {
      name: "TonRocket",
      symbol: "TROCK",

      jettonMaster: "",
      dexPoolAddress: "",
      burnWallet: "",
      rewardWallet: "",

      buyLink: "https://app.dedust.io/",
      chartLink: "https://dexscreener.com/",
      nftLink: "https://getgems.io/",

      buyPhotoFileId: "",
      burnPhotoFileId: "",
      rewardPhotoFileId: "",

      minBuyTokens: 1,
      minBurnTokens: 1,
      minRewardTon: 0.01,

      price: "0",
      marketCap: "0",
      tonUsd: "0",

      buyLastLt: "0",
      buyLastHash: "",
      burnLastLt: "0",
      burnLastHash: "",
      rewardLastLt: "0",
      rewardLastHash: "",

      totalBuyPosts: 0,
      totalBurnPosts: 0,
      totalRewardPosts: 0,

      rewardTotalTon: "0",
      burnedTotal: "0",

      processed: [],
      lastError: ""
    }
  };
}

function loadDb() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const init = defaultDb();
      fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2), "utf8");
      return init;
    }

    return {
      ...defaultDb(),
      ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
    };
  } catch (e) {
    console.log("DB ERROR:", e.message);
    return defaultDb();
  }
}

let db = loadDb();

function saveDb() {
  fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
}

function t() {
  return db.token;
}

function isAdmin(id) {
  return ADMIN_IDS.includes(String(id));
}

function esc(v = "") {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmt(v, d = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString("en-US", { maximumFractionDigits: d });
}

function toFriendly(addr = "") {
  try {
    return Address.parse(addr).toString({
      urlSafe: true,
      bounceable: false,
      testOnly: false
    });
  } catch {
    return addr || "";
  }
}

function shortAddr(a = "") {
  const friendly = toFriendly(a);

  if (!friendly || friendly.length < 12) {
    return friendly || "-";
  }

  return `${friendly.slice(0, 5)}...${friendly.slice(-5)}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function toTon(nano) {
  const n = Number(nano);
  return Number.isFinite(n) ? n / 1e9 : 0;
}

function normalizeAddress(addr) {
  const s = String(addr || "").trim();
  if (!s || s === "-") return "";
  try {
    return Address.parse(s).toString({
      urlSafe: true,
      bounceable: true,
      testOnly: false
    });
  } catch {
    return s;
  }
}

function addressKey(addr) {
  const s = String(addr || "").trim();
  if (!s) return "";
  try {
    const a = Address.parse(s);
    return `${a.workChain}:${a.hash.toString("hex")}`.toLowerCase();
  } catch {
    return s.toLowerCase();
  }
}

function sameAddress(a, b) {
  return addressKey(a) && addressKey(a) === addressKey(b);
}

function normalizeAmount(raw, decimals = 9) {
  const s = String(raw || "0").trim();
  if (!s) return 0;
  if (s.includes(".")) return Number(s) || 0;
  if (/^\d+$/.test(s)) return Number(s) / Math.pow(10, decimals);
  return Number(s) || 0;
}

function tonviewerTx(hash) {
  if (!hash || String(hash).startsWith("test_")) return "https://tonviewer.com/";
  return `https://tonviewer.com/transaction/${hash}`;
}

function compareCursor(aLt, aHash, bLt, bHash) {
  const a = BigInt(String(aLt || "0"));
  const b = BigInt(String(bLt || "0"));

  if (a > b) return 1;
  if (a < b) return -1;

  return String(aHash || "").localeCompare(String(bHash || ""));
}

function isNew(item, lastLt, lastHash) {
  return compareCursor(item.lt, item.hash, lastLt, lastHash) > 0;
}

function buyEmojiByTon(tonAmount) {
  const count = Math.max(1, Math.floor(Number(tonAmount || 0) / 0.5));
  return "🚀".repeat(Math.min(count, 80));
}

function remember(key) {
  const token = t();
  if (!Array.isArray(token.processed)) token.processed = [];
  if (!token.processed.includes(key)) token.processed.push(key);
  if (token.processed.length > 10000) token.processed = token.processed.slice(-10000);
}

function hasProcessed(key) {
  return Array.isArray(t().processed) && t().processed.includes(key);
}

async function apiGet(config) {
  for (let i = 1; i <= 3; i++) {
    try {
      return await axios({ ...config, timeout: 20000 });
    } catch (e) {
      if (i === 3) throw e;
      await sleep(i * 1200);
    }
  }
}

async function refreshMarketData() {
  const token = t();

  if (!token.chartLink) return;

  try {
    const url = String(token.chartLink);

    const pair = url.split("/").pop();
    if (!pair) return;

    const res = await apiGet({
      method: "get",
      url: `https://api.dexscreener.com/latest/dex/pairs/ton/${pair}`
    });

    const p = res.data?.pair;
    if (!p) return;

    token.price = p.priceUsd || token.price || "0";
    token.marketCap = p.fdv || p.marketCap || token.marketCap || "0";

    token.holders =
  p.holders ||
  p.info?.holders ||
  token.holders ||
  0;

    saveDb();
  } catch (e) {
    console.log("DEX DATA ERROR:", e.message);
  }
}

async function refreshTonPrice() {
  const token = t();

  try {
    const res = await axios.get(
      "https://tonapi.io/v2/rates?tokens=ton&currencies=usd",
      {
        timeout: 15000,
        headers: TONAPI_KEY
          ? { Authorization: `Bearer ${TONAPI_KEY}` }
          : {}
      }
    );

    const tonUsd =
      res.data?.rates?.TON?.prices?.USD ||
      res.data?.rates?.TON?.price ||
      0;

    if (Number(tonUsd) > 0) {
      token.tonUsd = String(tonUsd);
      saveDb();
    }

  } catch (e) {
    console.log("TON PRICE ERROR:", e.message);
  }
}

async function tonapiJettonHistory(account, master, limit = 30) {
  const headers = {};

  if (TONAPI_KEY) {
    headers.Authorization = `Bearer ${TONAPI_KEY}`;
  }

  try {
    const res = await apiGet({
      method: "get",
      url: `https://tonapi.io/v2/accounts/${encodeURIComponent(account)}/jettons/${encodeURIComponent(master)}/history`,
      params: { limit },
      headers
    });

    const d = res.data || {};
    return d.events || d.history || d.transactions || d.items || (Array.isArray(d) ? d : []);
  } catch (e) {
    console.log("TONAPI HISTORY ERROR:", e.response?.status || "", e.message);
    return [];
  }
}

async function toncenterTxs(address, limit = 20, lt = undefined, hash = undefined) {
  const headers = {};

  if (TONCENTER_API_KEY) {
    headers["X-API-Key"] = TONCENTER_API_KEY;
  }

  const params = {
    address,
    limit,
    archival: true
  };

  if (lt) params.lt = lt;
  if (hash) params.hash = hash;

  try {
    const res = await apiGet({
      method: "get",
      url: "https://toncenter.com/api/v2/getTransactions",
      params,
      headers
    });

    if (!res.data?.ok) return [];
    return res.data.result || [];
  } catch (e) {
    console.log("TONCENTER ERROR:", e.response?.status || "", e.message);
    return [];
  }
}

function parseMaybeAddress(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  return v.address || v.account || v.owner || v.wallet_address || v.user_friendly || v.raw_form || "";
}

function extractTonAmount(item) {
  const variants = [
    item.tonAmount,
    item.ton_amount,
    item.ton,
    item.native_amount,
    item.nativeAmount,
    item.in_msg?.value,
    item.inMsg?.value,
    item.message?.value,
    item.tx?.in_msg?.value,
    item.transaction?.in_msg?.value
  ];

  for (const v of variants) {
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;

    if (n > 1000000) return n / 1e9;
    return n;
  }

  return 0;
}

function parseJettonItems(items) {
  const result = [];

  for (const item of items) {
    const tx = item.tx || item.transaction || item.event || {};

    const lt = String(
      item.lt ||
      item.logical_time ||
      item.transaction_lt ||
      tx.lt ||
      tx.logical_time ||
      "0"
    );

    const hash = String(
      item.hash ||
      item.tx_hash ||
      item.transaction_hash ||
      tx.hash ||
      tx.tx_hash ||
      item.event_id ||
      ""
    );

    const time = Number(
      item.utime ||
      item.timestamp ||
      item.time ||
      tx.utime ||
      0
    );

    const sender =
      parseMaybeAddress(item.sender) ||
      parseMaybeAddress(item.source) ||
      parseMaybeAddress(item.from) ||
      parseMaybeAddress(item.src);

    const recipient =
      parseMaybeAddress(item.recipient) ||
      parseMaybeAddress(item.destination) ||
      parseMaybeAddress(item.to) ||
      parseMaybeAddress(item.dst);

    const decimals = Number(
      item.decimals ||
      item.jetton?.decimals ||
      item.metadata?.decimals ||
      9
    );

    const amount = normalizeAmount(
      item.amount ||
      item.jetton_amount ||
      item.value ||
      item.quantity ||
      item.balance_change ||
      "0",
      decimals
    );

    if (!lt || lt === "0" || !hash || !amount) continue;

    result.push({
      lt,
      hash,
      time,
      sender: normalizeAddress(sender),
      recipient: normalizeAddress(recipient),
      amount,
      tonAmount: extractTonAmount(item)
    });
  }

  return result;
}

function filterBuys(items) {
  const token = t();
  const min = Number(token.minBuyTokens || 1);

  return items.filter(x => {
    if (!x.recipient) return false;
    if (x.amount < min) return false;

    if (token.burnWallet && sameAddress(x.recipient, token.burnWallet)) return false;
    if (token.dexPoolAddress && sameAddress(x.recipient, token.dexPoolAddress)) return false;

    return true;
  });
}

function filterBurns(items) {
  const token = t();
  const min = Number(token.minBurnTokens || 1);

  return items.filter(x => {
    if (!token.burnWallet) return false;
    if (!sameAddress(x.recipient, token.burnWallet)) return false;
    if (x.amount < min) return false;
    return true;
  });
}

function parseRewards(txs) {
  const token = t();
  const result = [];

  for (const tx of txs) {
    const lt = String(tx?.transaction_id?.lt || "0");
    const hash = String(tx?.transaction_id?.hash || "");
    const time = Number(tx?.utime || 0);
    const outMsgs = Array.isArray(tx?.out_msgs) ? tx.out_msgs : [];

    let total = 0;
    const receivers = new Set();

    for (const msg of outMsgs) {
      const amount = toTon(msg.value || 0);
      const dest = msg.destination || msg.destination_address || msg.to || "";

      if (amount >= Number(token.minRewardTon || 0.001) && dest) {
        total += amount;
        receivers.add(addressKey(dest));
      }
    }

    if (total >= Number(token.minRewardTon || 0.001) && receivers.size) {
      result.push({
        lt,
        hash,
        time,
        wallet: token.rewardWallet,
        amount: total,
        receivers: receivers.size
      });
    }
  }

  return result;
}

async function refreshDexData() {
  const token = t();

  if (!token.chartLink) return;

  try {
    const pairAddress = token.dexPoolAddress || String(token.chartLink).split("/").pop();

    if (!pairAddress || pairAddress === "ton") return;

    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/pairs/ton/${pairAddress}`,
      { timeout: 15000 }
    );

    const pair = res.data?.pair;
    if (!pair) return;

    token.price = pair.priceUsd || token.price || "0";
    token.priceNative = pair.priceNative || token.priceNative || "0";
    token.marketCap = pair.fdv || pair.marketCap || token.marketCap || "0";

    const currentMc = Number(token.marketCap || 0);

if (
  currentMc > 0 &&
  currentMc > Number(token.athMarketCap || 0)
) {
  token.athMarketCap = currentMc;
  token.newAthDetected = true;
}

    saveDb();
  } catch (e) {
    console.log("DEX DATA ERROR:", e.message);
  }
}

function sellCaption(data) {
  const token = t();

  const emojis = "🔥".repeat(
    Math.max(1, Math.min(80, Math.floor(Number(data.tonAmount || 0) / 0.5)))
  );

  return (
    `💥 <b>${esc(token.symbol)} Sell!</b>\n\n` +
    `${emojis}\n\n` +
    `💵 <b>${esc(fmt(data.tonAmount, 2))} TON</b>\n` +
    `↔️ <b>${esc(fmt(data.amount, 2))} ${esc(token.symbol)}</b>\n` +
    `👤 <a href="https://tonviewer.com/${esc(data.seller)}">${esc(shortAddr(data.seller))}</a> | <a href="${esc(tonviewerTx(data.hash))}">Txn</a>\n` +
    `🔍 Price: <b>$${esc(token.price)}</b>\n` +
    `🌊 MarketCap: <b>$${esc(fmt(token.marketCap, 0))}</b>\n\n` +
    `👥 Holders: <b>${esc(fmt(token.holders || 0, 0))}</b>\n\n` +
    `🪙 Jetton Master: <code>EQAUf_g-uQMCqJYwy9xGUVwrMmK20UsUJXVT3xjE67179QVw</code>\n\n` +
    `🖼 <a href="${esc(token.nftLink)}">NFT Collection</a> | ` +
    `📊 <a href="${esc(token.chartLink)}">Chart</a> | ` +
    `🛒 <a href="${esc(token.buyLink)}">Buy</a>` +
    `🤖 <a href="${esc(token.botLink)}">Bot</a>`
  );
}

function buyLevel(ton) {
  ton = Number(ton || 0);

  if (ton >= 20) return "👑 Whale Buy";
  if (ton >= 5) return "🦈 Big Buy";
  if (ton >= 1) return "🐬 Medium Buy";

  return "🐟 Small Buy";
}

function buyCaption(data) {
  const token = t();
  const tonAmount = Number(data.tonAmount || 0);
  const usdAmount = tonAmount * Number(token.tonUsd || 0);
  const emojis = buyEmojiByTon(tonAmount);
  const level = buyLevel(tonAmount);
  const newHolder = data.newHolder ? "🎖 New Holder\n" : "";
  const topBuyers = Object.entries(token.topBuyers || {})
  .filter(([addr, amount]) => addr && Number(amount) > 0)
  .sort((a, b) => Number(b[1]) - Number(a[1]))
  .slice(0, 3);

let topText = "";

if (topBuyers.length) {
  topText = "\n🐋 <b>Top Buyers</b>\n";

  topBuyers.forEach(([addr, amount], i) => {
    topText += `${i + 1}. <code>${esc(shortAddr(addr))}</code> — <b>${esc(fmt(amount, 2))} TON</b>\n`;
  });

  topText += "\n";
}

  return (
    `🚀 <b>${esc(token.symbol)} Buy!</b>\n\n` +
    `${emojis}\n` +
    `${newHolder}` +
    `🔥 ${level}\n\n` +
    `💵 <b>${esc(fmt(tonAmount || 0, 2))} TON</b>${usdAmount ? ` ($${esc(fmt(usdAmount, 2))})` : ""}\n` +
    `↔️ <b>${esc(fmt(data.amount, 2))} ${esc(token.symbol)}</b>\n` +
    `👤 <a href="https://tonviewer.com/${esc(data.recipient)}">${esc(shortAddr(data.recipient))}</a> | <a href="${esc(tonviewerTx(data.hash))}">Txn</a>\n` +
    `🔍 Price: <b>$${esc(token.price)}</b>\n` +
    `🌊 MarketCap: <b>$${esc(fmt(token.marketCap, 0))}</b>\n` +
    `${topText}` +
    `🪙 Jetton Master: <code>EQAUf_g-uQMCqJYwy9xGUVwrMmK20UsUJXVT3xjE67179QVw</code>\n\n` +
    `🖼 <a href="${esc(token.nftLink)}">NFT Collection</a> | ` +
    `📊 <a href="${esc(token.chartLink)}">Chart</a> | ` +
    `🛒 <a href="${esc(token.buyLink)}">Buy</a>` +
    `🤖 <a href="${esc(token.botLink)}">Bot</a>`
  );
}

function burnCaption(data) {
  const token = t();

  return (
    `🔥 <b>${esc(token.symbol)} Burn!</b>\n\n` +
    `🔥 Сожжено: <b>${esc(fmt(data.amount, 2))} ${esc(token.symbol)}</b>\n` +
    `📊 Total Burn: <b>${esc(fmt(data.totalBurn || token.burnedTotal || 0, 2))} ${esc(token.symbol)}</b>\n` +
    `👤 <code>${esc(shortAddr(data.sender))}</code> | <a href="${esc(tonviewerTx(data.hash))}">Txn</a>\n\n` +
    `🖼 <a href="${esc(token.nftLink)}">NFT Collection</a> | ` +
    `📊 <a href="${esc(token.chartLink)}">Chart</a> | ` +
    `🛒 <a href="${esc(token.buyLink)}">Buy</a>` +
    `🤖 <a href="${esc(token.botLink)}">Bot</a>`
  );
}

function rewardCaption(data) {
  const token = t();

  return (
    `💸 <b>${esc(token.symbol)} Rewards!</b>\n\n` +
    `💰 Выплачено: <b>${esc(fmt(data.amount, 4))} TON</b>\n` +
    `👛 Всего выплат: <b>${esc(fmt(data.totalRewardedTon || 0, 4))} TON</b>\n` +
    `👥 Получателей: <b>${esc(data.receivers)}</b>\n` +
    `💼 Wallet: <a href="https://tonviewer.com/${esc(data.wallet)}">${esc(shortAddr(data.wallet))}</a> | <a href="${esc(tonviewerTx(data.hash))}">Txn</a>\n\n` +
    `🖼 <a href="${esc(token.nftLink)}">NFT Collection</a> | ` +
    `📊 <a href="${esc(token.chartLink)}">Chart</a> | ` +
    `🛒 <a href="${esc(token.buyLink)}">Buy</a>` +
    `🤖 <a href="${esc(token.botLink)}">Bot</a>`
  );
}

async function sendPost(type, caption) {
  const token = t();

  const buttons = [
  [
    { text: "🖼 NFT", url: token.nftLink || "https://getgems.io/" },
    { text: "📊 Chart", url: token.chartLink || "https://dexscreener.com/" },
    { text: "🛒 Buy", url: token.buyLink || "https://app.dedust.io/" },
    { text: "🤖 Bot", url: token.botLink || "https://t.me/" }
  ]
];

if (type === "buy") {
  buttons.push([
    { text: "🚀 Dex", url: token.chartLink || "https://dexscreener.com/" },
    { text: "🦎 Gecko", url: token.geckoLink || token.chartLink || "https://www.geckoterminal.com/" },
    { text: "🛠 DEXTools", url: token.dexToolsLink || token.chartLink || "https://www.dextools.io/" }
  ]);
}

  const opt = {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons }
  };

  const photo =
    type === "buy" ? token.buyPhotoFileId :
    type === "sell" ? (token.sellPhotoFileId || token.buyPhotoFileId) :
    type === "burn" ? token.burnPhotoFileId :
    type === "reward" ? token.rewardPhotoFileId :
    "";

  if (photo) return bot.sendPhoto(GROUP_CHAT_ID, photo, { caption, ...opt });
  return bot.sendMessage(GROUP_CHAT_ID, caption, opt);
}

async function checkBuys() {
  const token = t();

  if (!token.jettonMaster || !token.dexPoolAddress) return;

  try {
    const headers = {};
    if (TONAPI_KEY) headers.Authorization = `Bearer ${TONAPI_KEY}`;

    const res = await axios.get(
      `https://tonapi.io/v2/accounts/${encodeURIComponent(token.dexPoolAddress)}/events`,
      {
        params: { limit: 20 },
        headers,
        timeout: 20000
      }
    );

    const events = res.data?.events || [];

    if (!token.buyInitialized) {
      for (const event of events) {
        const eventId = event.event_id || event.id || event.hash || "";
        if (eventId) remember(`buy_event_${eventId}`);
      }

      token.buyInitialized = true;
      saveDb();
      return;
    }

    for (const event of events.reverse()) {
      if (event.timestamp && event.timestamp < BOT_STARTED_AT - 30) {
        const oldEventId = event.event_id || event.id || event.hash || "";
        if (oldEventId) remember(`buy_event_${oldEventId}`);
        saveDb();
        continue;
      }

      const eventId = event.event_id || event.id || event.hash || "";
      if (!eventId) continue;

      const key = `buy_event_${eventId}`;
      if (hasProcessed(key)) continue;

      const actions = event.actions || [];

      console.log("EVENT:", JSON.stringify(event, null, 2));

      let tokenAmount = 0;
      let tonCalcAmount = 0;
      let tonAmount = 0;
      let buyer = "";
      let txHash = eventId;
      let tradeType = "buy";
      let seller = "";

      for (const action of actions) {
        const type = action.type || "";
        const payload =
          action.JettonTransfer ||
          action.FlawedJettonTransfer ||
          action.payload ||
          {};

        if (
          type === "JettonTransfer" ||
          type === "FlawedJettonTransfer" ||
          action.JettonTransfer ||
          action.FlawedJettonTransfer
        ) {
          const jettonAddress =
            payload.jetton?.address ||
            payload.jetton?.master ||
            payload.jetton ||
            "";

          if (jettonAddress && !sameAddress(jettonAddress, token.jettonMaster)) {
            continue;
          }

          const recipient =
            payload.recipient?.address ||
            payload.recipient ||
            payload.receiver?.address ||
            payload.receiver ||
            "";

          const sender =
            payload.sender?.address ||
            payload.sender ||
            "";

          const decimals = Number(payload.jetton?.decimals || 9);

const receivedAmount = normalizeAmount(
  payload.received_amount || payload.amount || payload.quantity || "0",
  decimals
);

const sentAmount = normalizeAmount(
  payload.sent_amount || payload.received_amount || payload.amount || "0",
  decimals
);

const amount = receivedAmount;
const amountForTon = sentAmount || receivedAmount;

          if (amount > 0) {
            tokenAmount = amount;
            tonCalcAmount = amountForTon;
      
            if (sameAddress(recipient, token.dexPoolAddress)) {
              tradeType = "sell";
              seller = sender;
              buyer = recipient;
            } else {
              tradeType = "buy";
              buyer = recipient;
            }
          }
        }
      }

      if (!tokenAmount) continue;
      if (token.burnWallet && sameAddress(buyer, token.burnWallet)) continue;
      if (tokenAmount < Number(token.minBuyTokens || 1)) continue;

      if (tradeType === "sell" && token.sellEnabled === false) {
        remember(key);
        saveDb();
        continue;
      }

   console.log("BUY DEBUG:", {
  tokenAmount,
  tonAmount,
  price: token.price,
  priceNative: token.priceNative,
  tonUsd: token.tonUsd
});

const nativePrice =
  Number(token.priceNative || 0) ||
  (
    Number(token.price || 0) > 0 && Number(token.tonUsd || 0) > 0
      ? Number(token.price) / Number(token.tonUsd)
      : 0
  );

if (
  (!tonAmount || tonAmount <= 0) &&
  tokenAmount > 0 &&
  nativePrice > 0
) {
  tonAmount = (tonCalcAmount || tokenAmount) * nativePrice;
  tonAmount = Number(tonAmount.toFixed(3));
}

  if (token.newAthDetected) {
  token.newAthDetected = false;

  await sendPost(
    "buy",
    `🏆 <b>NEW ATH!</b>\n\n` +
    `🚀 <b>${esc(token.symbol)}</b> reached a new ATH!\n\n` +
    `🌊 MarketCap: <b>$${esc(fmt(token.athMarketCap, 0))}</b>`
  );
}

      await sendPost(
        tradeType,
        tradeType === "sell"
          ? sellCaption({
              amount: tokenAmount,
              tonAmount,
              seller: seller || buyer,
              hash: txHash,
              lt: String(Date.now())
            })
          : buyCaption({
              amount: tokenAmount,
              tonAmount,
              recipient: buyer,
              sender: token.dexPoolAddress,
              hash: txHash,
              lt: String(Date.now())
            })
      );

      token.totalBuyPosts += 1;

      if (!token.topBuyers) token.topBuyers = {};

const buyerKey = String(buyer || "").toLowerCase();

token.topBuyers[buyerKey] =
  (Number(token.topBuyers[buyerKey]) || 0) +
  Number(tonAmount || 0);

      remember(key);
      saveDb();
    }
  } catch (e) {
    console.log("BUY CHECK ERROR:", e.response?.status || "", e.message);
    t().lastError = `BUY: ${e.response?.status || ""} ${e.message}`;
    saveDb();
  }
}

async function checkBurns() {
  const token = t();

  if (!token.jettonMaster || !token.burnWallet) return;

  try {
    const headers = {};
    if (TONAPI_KEY) headers.Authorization = `Bearer ${TONAPI_KEY}`;

    const res = await axios.get(
      `https://tonapi.io/v2/accounts/${encodeURIComponent(token.burnWallet)}/events`,
      {
        params: { limit: 20 },
        headers,
        timeout: 20000
      }
    );

    const events = res.data?.events || [];

    if (!token.burnInitialized) {

    for (const event of events) {
  const eventId = event.event_id || event.id || event.hash || "";

  if (eventId) {
    remember(`burn_event_${eventId}`);
  }
}

token.burnInitialized = true;
saveDb();

console.log("✅ Burn history initialized");

return;
}

    for (const event of events.reverse()) {
      const eventId = event.event_id || event.id || event.hash || "";
      if (!eventId) continue;

      const key = `burn_event_${eventId}`;
      if (hasProcessed(key)) continue;

      const actions = event.actions || [];

      let burnAmount = 0;
      let sender = "";
      let txHash = eventId;

      for (const action of actions) {
        const type = action.type || "";
        const payload =
          action.JettonTransfer ||
          action.FlawedJettonTransfer ||
          action.payload ||
          {};

        if (
          type === "JettonTransfer" ||
          type === "FlawedJettonTransfer" ||
          action.JettonTransfer ||
          action.FlawedJettonTransfer
        ) {

          const recipient =
            payload.recipient?.address ||
            payload.recipient ||
            payload.receiver?.address ||
            payload.receiver ||
            "";

          if (!sameAddress(recipient, token.burnWallet)) continue;

          console.log("BURN MATCH:", {
  recipient,
  burnWallet: token.burnWallet
});

          sender =
            payload.sender?.address ||
            payload.sender ||
            "";

          const amountRaw =
            payload.received_amount ||
            payload.sent_amount ||
            payload.amount ||
            payload.quantity ||
            "0";

          const decimals = Number(payload.jetton?.decimals || 9);
          burnAmount = normalizeAmount(amountRaw, decimals);
        }
      }

if (!burnAmount || burnAmount <= 0 || !sender) {  remember(key);
  saveDb();
  continue;
}

      token.burnedTotal = String(
  Number(Number(token.burnedTotal || 0) + Number(burnAmount || 0)).toFixed(9)
);

await sendPost(
  "burn",
  burnCaption({
    amount: burnAmount,
    totalBurn: token.burnedTotal,
    sender,
    hash: txHash,
    lt: String(Date.now())
  })
);

      token.totalBurnPosts += 1;
      remember(key);
      saveDb();
    }
  } catch (e) {
    console.log("BURN CHECK ERROR:", e.response?.status || "", e.message);
    t().lastError = `BURN: ${e.response?.status || ""} ${e.message}`;
    saveDb();
  }
}

async function checkRewards() {
  const token = t();

  if (!token.rewardWallet) return;

  try {
    const headers = {};
    if (TONAPI_KEY) headers.Authorization = `Bearer ${TONAPI_KEY}`;

    const res = await axios.get(
      `https://tonapi.io/v2/accounts/${encodeURIComponent(token.rewardWallet)}/events`,
      {
        params: { limit: 20 },
        headers,
        timeout: 20000
      }
    );

    const events = res.data?.events || [];

    if (!token.rewardInitialized) {
  for (const event of events) {
    const eventId = event.event_id || event.id || event.hash || "";
    if (eventId) remember(`reward_event_${eventId}`);
  }

  token.rewardInitialized = true;
  saveDb();
  return;
}

    for (const event of events.reverse()) {
      const eventId = event.event_id || event.id || event.hash || "";
      if (!eventId) continue;

      const key = `reward_event_${eventId}`;
      if (hasProcessed(key)) continue;

      const actions = event.actions || [];

      let totalTon = 0;
      let receivers = 0;

      for (const action of actions) {
        const type = action.type || "";
        const payload =
          action.TonTransfer ||
          action.payload ||
          {};

        if (type === "TonTransfer" || action.TonTransfer) {
          const sender =
            payload.sender?.address ||
            payload.sender ||
            "";

          if (sender && !sameAddress(sender, token.rewardWallet)) continue;

          const amountRaw = payload.amount || payload.value || "0";
          const amountTon =
            Number(amountRaw) > 1000000
              ? Number(amountRaw) / 1e9
              : Number(amountRaw);

          if (amountTon >= Number(token.minRewardTon || 0.001)) {
            totalTon += amountTon;
            receivers += 1;
          }
        }
      }

      if (!totalTon || !receivers) continue;

      token.rewardTotalTon = String(
        Number(Number(token.rewardTotalTon || 0) + totalTon).toFixed(9)
      );

      await sendPost(
        "reward",
        rewardCaption({
          amount: totalTon,
          totalRewardedTon: token.rewardTotalTon,
          receivers,
          wallet: token.rewardWallet,
          hash: eventId,
          lt: String(Date.now())
        })
      );

      token.totalRewardPosts += 1;
      remember(key);
      saveDb();
    }
  } catch (e) {
    console.log("REWARD CHECK ERROR:", e.response?.status || "", e.message);
    t().lastError = `REWARD: ${e.response?.status || ""} ${e.message}`;
    saveDb();
  }
}

async function monitorLoop() {
  if (isMonitoring) return;
  isMonitoring = true;

  try {
    t().lastError = "";

    await refreshMarketData();
    await refreshTonPrice();

    await checkBuys();
    await checkBurns();
    await checkRewards();

    saveDb();
  } catch (e) {
    t().lastError = e.message;
    saveDb();
    console.log("MONITOR ERROR:", e.message);
  } finally {
    isMonitoring = false;
  }
}

function mainMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "⚙️ Основные настройки", callback_data: "noop" }],
        [
          { text: "🧾 Jetton", callback_data: "edit:jettonMaster" },
          { text: "🏊 DEX Pool", callback_data: "edit:dexPoolAddress" }
        ],
        [
          { text: "🔥 Burn Wallet", callback_data: "edit:burnWallet" },
          { text: "💸 Reward Wallet", callback_data: "edit:rewardWallet" }
        ],

        [{ text: "🔗 Ссылки", callback_data: "noop" }],
        [
          { text: "🖼 NFT", callback_data: "edit:nftLink" },
          { text: "📊 Chart", callback_data: "edit:chartLink" }
        ],
        [
          { text: "🛒 Buy", callback_data: "edit:buyLink" },
          { text: "🤖 Bot", callback_data: "edit:botLink" }
        ],
        [
          { text: "🦎 Gecko", callback_data: "edit:geckoLink" },
          { text: "🛠 DEXTools", callback_data: "edit:dexToolsLink" }
        ],
        

        [{ text: "🖼 Медиа", callback_data: "noop" }],
        [
          { text: "📷 Buy Photo", callback_data: "photo:buy" },
          { text: "📷 Sell Photo", callback_data: "photo:sell" }
        ],
        [
          { text: "📷 Burn Photo", callback_data: "photo:burn" },
          { text: "📷 Reward Photo", callback_data: "photo:reward" }
        ],

        [{ text: "🧪 Тесты", callback_data: "noop" }],
        [
          { text: "🚀 Test Buy", callback_data: "test_buy" },
          { text: "🔥 Test Burn", callback_data: "test_burn" },
          { text: "💸 Test Reward", callback_data: "test_reward" }
        ],

        [{ text: "🔴 Sell Posts On/Off", callback_data: "toggle:sellEnabled" }],
        [{ text: "🔄 Проверить сейчас", callback_data: "force_check" }],
        [{ text: "📊 Статус бота", callback_data: "status" }]
      ]
    }
  };
}

function statusText() {
  const token = t();

  return (
    `⚙️ <b>Bot status</b>\n\n` +
    `🪙 ${esc(token.name)} (${esc(token.symbol)})\n\n` +
    `Jetton: <code>${esc(shortAddr(token.jettonMaster))}</code>\n` +
    `DEX pool: <code>${esc(shortAddr(token.dexPoolAddress))}</code>\n` +
    `Burn: <code>${esc(shortAddr(token.burnWallet))}</code>\n` +
    `Reward: <code>${esc(shortAddr(token.rewardWallet))}</code>\n` +
    `NFT: ${token.nftLink ? "✅" : "❌"}\n\n` +
    `🛒 Buy posts: <b>${token.totalBuyPosts}</b>\n` +
    `🔥 Burn posts: <b>${token.totalBurnPosts}</b>\n` +
    `💸 Reward posts: <b>${token.totalRewardPosts}</b>\n\n` +
    `🧠 Error: <code>${esc(token.lastError || "-")}</code>`
  );
}

async function sendTestBuy(chatId) {
  await refreshDexData();

  const token = t();

  await sendPost(
    "buy",
    buyCaption({
      amount: Number(token.testBuyTokens || 173497.33),
      tonAmount: Number(token.testBuyTon || 10),
      recipient:
        token.rewardWallet ||
        token.burnWallet ||
        token.dexPoolAddress,
      sender: token.dexPoolAddress,
      hash: "test_buy",
      lt: String(Date.now())
    })
  );

  token.totalBuyPosts += 1;
  saveDb();

  await bot.sendMessage(chatId, "✅ Test Buy отправлен");
}

async function sendTestBurn(chatId) {
  const token = t();

  await sendPost(
    "burn",
    burnCaption({
      amount: Number(token.testBurnTokens || 5000),
      totalBurn: token.burnedTotal || 0,
      sender: token.burnWallet,
      hash: "test_burn",
      lt: String(Date.now())
    })
  );

  token.totalBurnPosts += 1;
  saveDb();

  await bot.sendMessage(chatId, "✅ Test Burn отправлен");
}

async function sendTestReward(chatId) {
  const token = t();

  await sendPost(
    "reward",
    rewardCaption({
      amount: Number(token.testRewardTon || 1),
      totalRewardedTon: token.rewardTotalTon || 0,
      receivers: Number(token.testRewardReceivers || 1),
      wallet: token.rewardWallet,
      hash: "test_reward",
      lt: String(Date.now())
    })
  );

  token.totalRewardPosts += 1;
  saveDb();

  await bot.sendMessage(chatId, "✅ Test Reward отправлен");
}

bot.onText(/\/start|\/admin/, async msg => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, "⛔ Нет доступа");
  }

  await bot.sendMessage(
    msg.chat.id,
    "⚙️ <b>TON Monitor Admin</b>\n\nВыберите настройку:",
    {
      parse_mode: "HTML",
      ...mainMenu()
    }
  );
});

bot.onText(/\/debug/, async msg => {
  if (!isAdmin(msg.from.id)) return;

  const token = t();

  try {
    const headers = {};
    if (TONAPI_KEY) headers.Authorization = `Bearer ${TONAPI_KEY}`;

    const res = await axios.get(
      `https://tonapi.io/v2/accounts/${encodeURIComponent(token.dexPoolAddress)}/events`,
      {
        params: { limit: 10 },
        headers,
        timeout: 20000
      }
    );

    const events = res.data?.events || [];

    await bot.sendMessage(
      msg.chat.id,
      `🔍 DEBUG EVENTS\n\n` +
      `DEX pool: ${token.dexPoolAddress || "-"}\n` +
      `Jetton: ${token.jettonMaster || "-"}\n\n` +
      `Events: ${events.length}\n\n` +
      `Last error: ${token.lastError || "-"}`
    );
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ DEBUG ERROR:\n${e.response?.status || ""} ${e.message}`);
  }
});

bot.onText(/\/debugjson/, async msg => {
  if (!isAdmin(msg.from.id)) return;

  const token = t();

  try {
    const headers = {};
    if (TONAPI_KEY) headers.Authorization = `Bearer ${TONAPI_KEY}`;

    const res = await axios.get(
      `https://tonapi.io/v2/accounts/${encodeURIComponent(token.dexPoolAddress)}/events`,
      {
        params: { limit: 1 },
        headers,
        timeout: 20000
      }
    );

    const event = res.data?.events?.[0];

    await bot.sendMessage(
      msg.chat.id,
      "<pre>" + esc(JSON.stringify(event, null, 2).slice(0, 3500)) + "</pre>",
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ ${e.response?.status || ""} ${e.message}`
    );
  }
});

bot.onText(/\/recount_rewards/, async msg => {
  if (!isAdmin(msg.from.id)) return;

  const token = t();

  if (!token.rewardWallet) {
    return bot.sendMessage(msg.chat.id, "❌ Reward wallet не задан");
  }

  try {
    await bot.sendMessage(msg.chat.id, "🔄 Пересчитываю все транзакции...");

    let lt;
    let hash;
    let total = 0;
    let processed = 0;
    const processedTx = new Set();

    while (true) {
      const txs = await toncenterTxs(token.rewardWallet, 100, lt, hash);

      await new Promise(r => setTimeout(r, 1500));

      if (!txs.length) break;

      for (const tx of txs) {
        const txHash = tx.transaction_id?.hash || tx.hash || "";
        if (!txHash || processedTx.has(txHash)) continue;

        processedTx.add(txHash);

        const outMsgs = Array.isArray(tx.out_msgs) ? tx.out_msgs : [];

        for (const out of outMsgs) {
          const amountTon = Number(out.value || 0) / 1e9;
          if (amountTon > 0) total += amountTon;
        }

        processed++;
      }

      const lastTx = txs[txs.length - 1];
      const nextLt = lastTx.transaction_id?.lt || lastTx.lt;
const nextHash = lastTx.transaction_id?.hash || lastTx.hash;

if (!nextLt || !nextHash) break;

if (
  String(nextLt) === String(lt) &&
  String(nextHash) === String(hash)
) {
  console.log("RECOUNT STOP: same cursor");
  break;
}

lt = nextLt;
hash = nextHash;

      console.log(`RECOUNT: ${processed} tx | ${total.toFixed(4)} TON | next lt ${lt}`);
    }

    token.rewardTotalTon = total.toFixed(9);
    saveDb();

    await bot.sendMessage(
      msg.chat.id,
      `✅ Пересчитано по ВСЕМ транзакциям\n\n` +
      `👛 Реально отправлено: <b>${esc(fmt(total, 6))} TON</b>\n` +
      `📦 Транзакций: <b>${processed}</b>`,
      { parse_mode: "HTML" }
    );

  } catch (e) {
    console.log("RECOUNT ERROR:", e);

    await bot.sendMessage(
      msg.chat.id,
      `❌ Ошибка:\n${e.message}`
    );
  }
});

bot.onText(/\/recount_burn/, async msg => {
  if (!isAdmin(msg.from.id)) return;

  const token = t();

  if (!token.jettonMaster) {
    return bot.sendMessage(msg.chat.id, "❌ Jetton master не задан");
  }

  try {
    const headers = {};
    if (TONAPI_KEY) headers.Authorization = `Bearer ${TONAPI_KEY}`;

    const res = await axios.get(
      `https://tonapi.io/v2/jettons/${encodeURIComponent(token.jettonMaster)}/holders`,
      {
        params: { limit: 1000 },
        headers,
        timeout: 20000
      }
    );

    const holders = res.data?.addresses || res.data?.holders || [];

    let total = 0;

    for (const h of holders) {
      const holder =
        h.owner?.address ||
        h.wallet?.owner?.address ||
        h.address ||
        h.owner ||
        "";

      const name =
        h.owner?.name ||
        h.name ||
        "";

      const isZero =
        String(name).toLowerCase().includes("zero") ||
        sameAddress(holder, "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c");

      if (!isZero) continue;

      const raw =
        h.balance ||
        h.amount ||
        h.jetton_balance ||
        "0";

      total = normalizeAmount(raw, Number(h.jetton?.decimals || 9));
      break;
    }

    token.burnedTotal = String(total.toFixed(9));
    saveDb();

    await bot.sendMessage(
      msg.chat.id,
      `✅ Burn пересчитан\n\n🔥 Total Burn: ${fmt(token.burnedTotal, 2)} ${token.symbol}`
    );
  } catch (e) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ Ошибка пересчёта burn:\n${e.response?.status || ""} ${e.message}`
    );
  }
});

bot.onText(/\/debugjson/, async msg => {
  if (!isAdmin(msg.from.id)) return;

  const token = t();

  try {
    const headers = {};
    if (TONAPI_KEY) {
      headers.Authorization = `Bearer ${TONAPI_KEY}`;
    }

    const res = await axios.get(
      `https://tonapi.io/v2/accounts/${encodeURIComponent(token.dexPoolAddress)}/events`,
      {
        params: { limit: 1 },
        headers,
        timeout: 20000
      }
    );

    const event = res.data?.events?.[0];

    if (!event) {
      return bot.sendMessage(msg.chat.id, "❌ Events not found");
    }

    const json = JSON.stringify(event, null, 2);

    if (json.length < 4000) {
      return bot.sendMessage(msg.chat.id, `<pre>${esc(json)}</pre>`, {
        parse_mode: "HTML"
      });
    }

    const chunks = json.match(/[\s\S]{1,3500}/g) || [];

    for (const chunk of chunks) {
      await bot.sendMessage(msg.chat.id, `<pre>${esc(chunk)}</pre>`, {
        parse_mode: "HTML"
      });
    }

  } catch (e) {
    bot.sendMessage(
      msg.chat.id,
      `❌ DEBUG ERROR\n${e.message}`
    );
  }
});

bot.onText(/\/debugburn/, async msg => {
  if (!isAdmin(msg.from.id)) return;

  const token = t();

  try {
    const headers = {};
    if (TONAPI_KEY) headers.Authorization = `Bearer ${TONAPI_KEY}`;

    const res = await axios.get(
      `https://tonapi.io/v2/accounts/${encodeURIComponent(token.burnWallet)}/events`,
      {
        params: { limit: 1 },
        headers,
        timeout: 20000
      }
    );

    const event = res.data?.events?.[0];

    await bot.sendMessage(
      msg.chat.id,
      "<pre>" + esc(JSON.stringify(event, null, 2).slice(0, 3500)) + "</pre>",
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ ${e.response?.status || ""} ${e.message}`
    );
  }
});

bot.on("callback_query", async q => {
  if (!isAdmin(q.from.id)) {
    return bot.answerCallbackQuery(q.id, { text: "Нет доступа" });
  }

  const chatId = q.message.chat.id;
  const data = q.data;

  if (data === "noop") {
  await bot.answerCallbackQuery(q.id);
  return;
}

  if (data === "toggle:sellEnabled") {
  const token = t();
  token.sellEnabled = !token.sellEnabled;
  saveDb();

  await bot.answerCallbackQuery(q.id, {
    text: token.sellEnabled
      ? "✅ Sell posts включены"
      : "❌ Sell posts выключены"
  });

  await bot.sendMessage(chatId, "⚙️ Настройки обновлены", mainMenu());
  return;
}

  try {
    if (data.startsWith("edit:")) {
      const field = data.split(":")[1];
      state[q.from.id] = { mode: "edit", field };

      await bot.sendMessage(
        chatId,
        `✏️ Введите новое значение:\n<code>${esc(field)}</code>\n\nТекущее: <code>${esc(t()[field] || "-")}</code>`,
        { parse_mode: "HTML" }
      );
    }

    if (data.startsWith("photo:")) {
      const target = data.split(":")[1];
      state[q.from.id] = { mode: "photo", target };

      await bot.sendMessage(chatId, `📷 Пришлите фото для ${target}`);
    }

    if (data === "test_buy") await sendTestBuy(chatId);
    if (data === "test_burn") await sendTestBurn(chatId);
    if (data === "test_reward") await sendTestReward(chatId);

    if (data === "force_check") {
      await bot.sendMessage(chatId, "🔄 Проверяю...");
      await monitorLoop();
      await bot.sendMessage(chatId, "✅ Проверка завершена");
    }

    if (data === "status") {
      await bot.sendMessage(chatId, statusText(), {
        parse_mode: "HTML",
        ...mainMenu()
      });
    }

    await bot.answerCallbackQuery(q.id);
  } catch (e) {
    console.log("CALLBACK ERROR:", e.message);
    try {
      await bot.sendMessage(chatId, `❌ ${e.message}`);
    } catch {}
    try {
      await bot.answerCallbackQuery(q.id, { text: "Ошибка" });
    } catch {}
  }
});

bot.onText(/^\/?price$/i, async msg => {
  const token = t();

  await refreshDexData();
  await refreshTonPrice();

  const tonUsd = Number(token.tonUsd || 0);
  const trockUsd = Number(token.price || 0);

  const trockTon =
    tonUsd > 0 && trockUsd > 0
      ? trockUsd / tonUsd
      : Number(token.priceNative || 0);

  const text =
    `💎 <b>${esc(token.symbol)} Price</b>\n\n` +
    `💰 TON: <b>$${esc(tonUsd.toFixed(3))}</b>\n` +
    `🚀 ${esc(token.symbol)}: <b>$${esc(trockUsd.toFixed(8))}</b>\n` +
    `💎 ${esc(token.symbol)} / TON: <b>${esc(trockTon.toFixed(10))} TON</b>\n\n` +
    `🌊 MarketCap: <b>$${esc(fmt(token.marketCap, 0))}</b>`;

  await bot.sendMessage(msg.chat.id, text, {
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
});

bot.onText(/^\/?ca$/i, async msg => {
  const token = t();

  const text =
    `📜 <b>${esc(token.symbol)} Contract</b>\n\n` +
    `<code>${esc(token.jettonMaster)}</code>`;

  await bot.sendMessage(msg.chat.id, text, {
    parse_mode: "HTML"
  });
});

bot.on("message", async msg => {
  if (!isAdmin(msg.from?.id)) return;
  if (!msg.text || msg.text.startsWith("/")) return;

  const s = state[msg.from.id];
  if (!s || s.mode !== "edit") return;

  let value = msg.text.trim();
  if (value === "-") value = "";

  const addressFields = [
    "jettonMaster",
    "dexPoolAddress",
    "burnWallet",
    "rewardWallet"
  ];

  if (addressFields.includes(s.field)) {
    value = normalizeAddress(value);
  }

  t()[s.field] = value;
  saveDb();

  delete state[msg.from.id];

  await bot.sendMessage(
    msg.chat.id,
    `✅ Сохранено:\n<code>${esc(s.field)}</code>`,
    {
      parse_mode: "HTML",
      ...mainMenu()
    }
  );
});

bot.on("photo", async msg => {
  if (!isAdmin(msg.from?.id)) return;

  const s = state[msg.from.id];
  if (!s || s.mode !== "photo") return;

  const fileId = msg.photo?.[msg.photo.length - 1]?.file_id;
  if (!fileId) return bot.sendMessage(msg.chat.id, "❌ Фото не найдено");

  if (s.target === "buy") t().buyPhotoFileId = fileId;
  if (s.target === "burn") t().burnPhotoFileId = fileId;
  if (s.target === "reward") t().rewardPhotoFileId = fileId;

  saveDb();
  delete state[msg.from.id];

  await bot.sendMessage(msg.chat.id, `✅ Фото сохранено: ${s.target}`, mainMenu());
});

bot.on("polling_error", err => {
  console.log("POLLING ERROR:", err.message);
});

setInterval(monitorLoop, MONITOR_INTERVAL_MS);

(async () => {
  console.log("✅ TON MONITOR STARTED");
  saveDb();

  try {
    await monitorLoop();
  } catch (e) {
    console.log("START ERROR:", e.message);
  }
})();
