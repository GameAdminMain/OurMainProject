const cheerio = require("cheerio");
/*{ok: true,
    providerKey: "telebirr",
    resolvedUrl: "https://transactioninfo.ethiotelecom.et/receipt/CJF7HITHQF",
    httpStatus: 200,
    fetchedAt: "2026-09-06T09:40:07.363Z",
    receipt: 
    {
        source: "telebirr-html",
        payerName: "BEKELE GARED GEBRE HIWOT",
        receiptNo: "CJF7HITHQF",
        serviceFee: "7.83 Birr",
        paymentDate: "15-10-2025 15:26:23",
        paymentMode: "telebirr",
        paymentReason: "Customer Transfer from Mobile Money to Bank",
        serviceFeeVAT: "1.17 Birr",
        settledAmount: "2,500 Birr",
        paymentChannel: "API/App",
        payerTelebirrNo: "2519****7808",
        totalPaidAmount: "2,509 Birr",
        payerAccountType: "Individual Customer",
        bankAccountNumber: "1000277825078   BEMERI MISRAKE TSEHAY MEKANE KIDIST",
        creditedPartyName: "Commercial Bank of Ethiopia",
        transactionStatus: "Completed",
        creditedPartyAccountNo: "0003"
    },
    rawHtmlLength: 27445,
    egressSource: null,
    error: null,
    cached: true
}*/

// ─────────────────────────────────────────────
// Transaction (receipt) number from what the customer pasted.
// Handles all of these for telebirr:
//   1. the full SMS  ("... Your transaction number is DJ56G0WKVM. ...")
//   2. the full SMS that also contains the receipt link (".../receipt/DJ92KW2GFW.")
//   3. just the link  "https://transactioninfo.ethiotelecom.et/receipt/DJ92KW2GFW"
//   4. a markdown link "[DJ92KW2GFW](https://transactioninfo.ethiotelecom.et/receipt/DJ92KW2GFW)"
//   5. just the number "DJ92KW2GFW"
// If the text contains two different numbers (for example the number in the sentence and a
// different one in the link) it is refused (returns null) instead of guessing.
// ─────────────────────────────────────────────
const RECEIPT_URL_BASE = {
  "telebirr": "(?:transactioninfo|apps)\\.ethiotelecom\\.et",
  "m-pesa": "m-pesabusiness\\.safaricom\\.et"
};
const RECEIPT_ID_RE = /^[A-Z0-9]{8,14}$/;

function parseReceiptNumber(typeName, text) {
  const type = String(typeName || "").toLowerCase();
  const host = RECEIPT_URL_BASE[type];
  if (!host || typeof text !== "string") return null;

  // invisible characters, non-breaking spaces and surrounding whitespace
  const t = text.replace(/[​-‍﻿]/g, "").replace(/ /g, " ").trim();
  if (!t) return null;

  const found = new Set();

  // (2)(3)(4) a receipt link anywhere in the text; the id ends at the first character that is not a letter/digit
  const urlRe = new RegExp("https?:\\/\\/" + host + "\\/receipt\\/([A-Za-z0-9]+)", "gi");
  for (const m of t.matchAll(urlRe)) found.add(m[1].toUpperCase());

  // (1) "Your transaction number is XXXXXXXXXX"  (also "transaction no", "transaction id", "receipt no")
  const phraseRe = /(?:transaction|receipt)\s*(?:number|no\.?|id)\s*(?:is|:|-)?\s*([A-Za-z0-9]{8,14})(?![A-Za-z0-9])/gi;
  for (const m of t.matchAll(phraseRe)) found.add(m[1].toUpperCase());

  // (5)(4) nothing found yet: the text is only the number, optionally in [ ] or ( ) or quotes
  if (found.size === 0) {
    const bare = t.replace(/^[\s\[\]\(\)"'`<>*_]+|[\s\[\]\(\)"'`<>*_.,;:]+$/g, "");
    if (RECEIPT_ID_RE.test(bare.toUpperCase())) found.add(bare.toUpperCase());
  }

  const ids = [...found].filter(id => RECEIPT_ID_RE.test(id));
  if (ids.length !== 1) return null;      // none, or two different numbers
  // telebirr receipt numbers are 10 letters/digits starting with a letter (DJ92KW2GFW, CJF7HITHQF, DJI10YQMC7)
  if (type === "telebirr" && !/^[A-Z][A-Z0-9]{9}$/.test(ids[0])) return null;
  return ids[0];
}

async function extractInvoiceNumber(typeName, sms) 
{
  const invoiceNo = parseReceiptNumber(typeName, sms);
  console.log("Invoice No:", invoiceNo);
  return invoiceNo;
}

async function builURLfromInvoiceNo(typeName, invoiceNo) 
{
  let url = "";
  if(typeName.toLowerCase() === "telebirr")
  {
    url = `https://transactioninfo.ethiotelecom.et/receipt/${invoiceNo}`;
  }
  else if(typeName.toLowerCase() === "m-pesa")
  {
    url = `https://m-pesabusiness.safaricom.et/receipt/${invoiceNo}`;
  }
  else 
  {
    url = "";
  }
  console.log("Receipt URL:", url);
  return url;
}


async function checkUrl(url) {
  
try {
    const { response, error } = await fetchWithRetry(url);
    if (!response) throw error || new Error("No response");

    if (!response.ok) {
      console.log(`Invalid URL. HTTP status: ${response.status}`);
      return false;
    }

    console.log("URL is valid.");
    return true;

  } catch (error) {
    console.log("URL is invalid:", error.message);
    return false;
  }
}


async function extractTransactionInfo(url) {
  try {
    const { response, error } = await fetchWithRetry(url);
    if (!response) throw error || new Error("No response");

    if (!response.ok) {
      throw new Error(`HTTP error: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const result = {
      invoiceNo: null,
      payerName: null,
      payerTelebirrNo: null,
      creditedPartyName: null,
      creditedPartyAccountNo: null,
      paymentDate: null,
      amount: null
    };

    $("tr").each((index, row) => {

      const cells = $(row)
        .find("td")
        .map((i, cell) =>
          $(cell)
            .text()
            .replace(/\s+/g, " ")
            .trim()
        )
        .get();

      if (cells.length < 2) return;

      const label = cells[0].toLowerCase();
      const value = cells[1];

      // Invoice No.
      if (
        cells.some(cell =>
          cell.toLowerCase().includes("invoice no")
        )
      ) {
        const invoiceIndex = cells.findIndex(cell =>
          cell.toLowerCase().includes("invoice no")
        );

        const nextRow = $(row).next("tr");

        result.invoiceNo = nextRow
          .find("td")
          .eq(invoiceIndex)
          .text()
          .replace(/\s+/g, " ")
          .trim();
      }

      // Payer Name
      if (label.includes("payer name")) {
        result.payerName = value;
      }

      // Payer Telebirr No.
      if (label.includes("payer telebirr")) {
        result.payerTelebirrNo = value;
      }

      // Credited Party Name
      if (label.includes("credited party name")) {
        result.creditedPartyName = value;
      }

      // Credited Party Account No.
      if (label.includes("credited party account")) {
        result.creditedPartyAccountNo = value;
      }

      // Payment Date
      if (
        cells.some(cell =>
          cell.toLowerCase().includes("payment date")
        )
      ) {
        const paymentDateIndex = cells.findIndex(cell =>
          cell.toLowerCase().includes("payment date")
        );

        const nextRow = $(row).next("tr");

        result.paymentDate = nextRow
          .find("td")
          .eq(paymentDateIndex)
          .text()
          .replace(/\s+/g, " ")
          .trim();
      }

      // Settled Amount
      if (
        cells.some(cell =>
          cell.toLowerCase().includes("settled amount")
        )
      ) {
        const amountIndex = cells.findIndex(cell =>
          cell.toLowerCase().includes("settled amount")
        );

        const nextRow = $(row).next("tr");

        result.amount = nextRow
          .find("td")
          .eq(amountIndex)
          .text()
          .replace(/\s+/g, " ")
          .trim();
      }
    });

    return result;

  } catch (error) {
    console.error("Extraction Error:", error.message);
    return null;
  }
}

// 502 Bad Gateway / 503 Service Unavailable / 504 Gateway Timeout (and 429) are temporary:
// try again a few times with a short pause before telling the customer.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options = {}, { attempts = 3, baseDelayMs = 1000, timeoutMs = 10000 } = {}) {
  let lastResponse = null;
  let lastError = null;
  for (let i = 1; i <= attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!RETRY_STATUSES.has(response.status)) return { response, error: null, attempts: i };
      lastResponse = response;
      lastError = null;
      console.warn(`HTTP ${response.status} from ${new URL(url).host} (attempt ${i}/${attempts})`);
      try { await response.arrayBuffer(); } catch (e) {}       // free the connection
    } catch (error) {
      lastResponse = null;
      lastError = error;
      console.warn(`${error.name === "AbortError" ? "Timeout" : "Network error: " + error.message} calling ${new URL(url).host} (attempt ${i}/${attempts})`);
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts) await sleep(baseDelayMs * i);              // 1 s, 2 s, ...
  }
  return { response: lastResponse, error: lastError, attempts };
}

// ─────────────────────────────────────────────
// check.et  (https://check.et, docs: https://docs.check.et)
//   POST {CHECKET_API_URL}/verify   Authorization: Bearer chk_xxx
//   body {"bank":"telebirr","transaction_number":"DJ92KW2GFW"}   or   {"receipt_url":"https://..."}
//   200 {success, exists, duplicate, message, data:{bank, bank_name, transaction_number,
//        receipt:{status, amount, currency, transaction_date, payer_name, payer_account, receiver_name, receiver_account}}}
//   401/403 bad key, 402 monthly quota used up, 404 not found, 422 bad input, 429 slow down, 500 retry
//
//   CHECKET_API_KEY   the key from https://check.et/dashboard/api-keys (business account, Pro plan)
//   CHECKET_API_URL   default https://api.check.et/api/verify
// ─────────────────────────────────────────────
// CHECKET_API_URL may be the verify endpoint itself (".../api/verify") or its base (".../api/v1"); both work
const CHECKET_VERIFY_URL = (() => {
  const u = String(process.env.CHECKET_API_URL || "https://api.check.et/api/verify").trim().replace(/\/+$/, "");
  return /\/verify$/i.test(u) ? u : `${u}/verify`;
})();
const CHECKET_API_URL = CHECKET_VERIFY_URL.replace(/\/verify$/i, "");
const CHECKET_API_KEY = String(process.env.CHECKET_API_KEY || "").trim().replace(/^["']|["']$/g, "");
// how long to wait for check.et. It hangs on a number that does not exist, and is sometimes slow on a real one
// (Ethio Telecom is slow). One try only: if the customer sends the receipt again and check.et finished the first
// check meanwhile, it answers 409 "duplicate" with the receipt, and that is credited below.
const CHECKET_TIMEOUT_MS = Number(process.env.CHECKET_TIMEOUT_MS) > 0 ? Number(process.env.CHECKET_TIMEOUT_MS) : 25000;
if (!CHECKET_API_KEY) console.warn("[deposit] CHECKET_API_KEY is not set: check.et will refuse every receipt check");

// our payment method names -> check.et bank codes
const CHECKET_BANK_CODES = { "telebirr": "telebirr", "m-pesa": "mpesa", "mpesa": "mpesa", "cbebirr": "cbebirr", "cbe": "cbe" };
const CHECKET_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

// "2025-06-10T14:30:00+03:00" -> "10-06-2025 14:30:00" in Ethiopia time (UTC+3), the format bot.js reads
function toEthiopiaDateText(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso || null;
  const d = new Date(ms + 3 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// check.et answer -> the receipt fields bot.js / db.approveDeposit already use
function receiptFromCheckEt(json, fallbackReceiptNo) {
  const data = json.data || {};
  const r = data.receipt || {};
  const status = String(r.status || "");
  return {
    source: "check.et",
    receiptNo: String(data.transaction_number || fallbackReceiptNo || "").toUpperCase(),
    payerName: r.payer_name || null,
    payerTelebirrNo: r.payer_account || null,
    creditedPartyName: r.receiver_name || null,
    creditedPartyAccountNo: r.receiver_account || null,
    settledAmount: r.amount != null ? `${r.amount} ${r.currency || "ETB"}` : null,
    totalPaidAmount: r.amount != null ? `${r.amount} ${r.currency || "ETB"}` : null,
    paymentDate: toEthiopiaDateText(r.transaction_date),
    transactionStatus: status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : null,
    paymentMode: data.bank || null,
    paymentReason: r.description || r.transaction_type || null,
    bankName: data.bank_name || null,
    checkEt: { verificationId: data.verification_id || null, method: data.verification_method || null, duplicate: !!json.duplicate }
  };
}

// verify one receipt with check.et.
//   typeName  : our payment method name ("telebirr", "m-pesa", ...)
//   receiptId : the transaction number we read from the SMS / link, or null
//   receiptUrl: a receipt link to send as-is when we could not read the number from it
async function extractTransactionInfofromThirdParty(typeName, receiptId, receiptUrl = null) {
  const bank = CHECKET_BANK_CODES[String(typeName || "").toLowerCase()];
  const body = receiptId
    ? { bank, transaction_number: receiptId }
    : { receipt_url: receiptUrl };

  const url = CHECKET_VERIFY_URL;
  let response = null, error = null, attempts = 0;
  for (let i = 1; i <= 3; i++) {
    attempts = i;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECKET_TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${CHECKET_API_KEY}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      error = null;
    } catch (e) {
      response = null;
      error = e;
    } finally {
      clearTimeout(timer);
    }
    if (response && !CHECKET_RETRY_STATUSES.has(response.status)) break;
    // no answer in time: check.et does this for a number that does not exist, so do not wait for it again
    if (!response && error && error.name === "AbortError") break;
    if (i < 3) {
      // 429: wait what check.et asks (Retry-After seconds), otherwise 1 s, 2 s
      const retryAfter = response && Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1000 * i;
      if (response) { try { await response.arrayBuffer(); } catch (e) {} }
      console.warn(`check.et ${response ? "HTTP " + response.status : "no answer"} (attempt ${i}/3), retrying`);
      await sleep(waitMs);
    }
  }

  // no answer at all
  if (!response) {
    if (error && error.name === "AbortError") {
      console.error(`check.et gave no answer in ${CHECKET_TIMEOUT_MS / 1000} s (wrong number, or check.et is slow)`);
      return { ok: false, timeout: true, unavailable: false, error: "check.et timeout" };
    }
    console.error("check.et request failed:", error && error.message);
    return { ok: false, timeout: false, unavailable: true, error: error ? error.message : "No response" };
  }

  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}

  // our side: wrong key, no permission, quota used up, or check.et still failing -> "try again later", never "bad receipt"
  if (response.status === 401 || response.status === 403) {
    console.error(`check.et refused the API key (HTTP ${response.status}). Check CHECKET_API_KEY.`, text.slice(0, 300));
    return { ok: false, timeout: false, unavailable: true, authError: true, status: response.status, error: "API key rejected" };
  }
  if (response.status === 402) {
    console.error("check.et: monthly verification limit reached, upgrade the plan.", text.slice(0, 300));
    return { ok: false, timeout: false, unavailable: true, quotaError: true, status: 402, error: "check.et quota used up" };
  }
  if (CHECKET_RETRY_STATUSES.has(response.status)) {
    console.error(`check.et still returns HTTP ${response.status} after ${attempts} attempts`);
    return { ok: false, timeout: false, unavailable: true, status: response.status, error: `HTTP ${response.status}` };
  }

  if (!json) {
    console.error(`check.et returned non-JSON (HTTP ${response.status}):`, text.slice(0, 500));
    return { ok: false, timeout: false, unavailable: /bad gateway|service unavailable|gateway time-?out/i.test(text), error: "Non-JSON response" };
  }

  // already verified on our check.et account (HTTP 409 code "duplicate", or 200 with duplicate=true).
  // check.et will not verify it again; processDeposit() decides with our own deposits table.
  if (response.status === 409 || json.code === "duplicate" || json.duplicate === true) {
    const receiptNo = String((json.data && json.data.transaction_number) || receiptId || "").toUpperCase() || null;
    console.warn(`check.et: receipt ${receiptNo || receiptUrl} was already verified (verification ${json.existing_verification_id}, ${json.verified_at || "?"}, by ${json.verified_by || "?"})`);
    const receipt = json.data && json.data.receipt ? receiptFromCheckEt(json, receiptNo) : null;
    return { ok: false, duplicate: true, timeout: false, unavailable: false, receiptNo, existingVerificationId: json.existing_verification_id || null, receipt, data: json };
  }

  // 404 = not found, 400/422 = bad number or link: the customer's receipt, not our setup
  if (!response.ok || json.success !== true) {
    console.log(`check.et: not verified (HTTP ${response.status}):`, json.message || json);
    return { ok: false, timeout: false, unavailable: false, status: response.status, error: json.message || "Not verified", data: json };
  }

  if (!json.data || !json.data.receipt) {
    console.error("check.et verified the receipt but sent no receipt details:", text.slice(0, 500));
    return { ok: false, timeout: false, unavailable: false, error: "No receipt details", data: json };
  }

  return { ok: true, timeout: false, unavailable: false, data: { ok: true, receipt: receiptFromCheckEt(json, receiptId), checkEt: json } };
}

// GET {CHECKET_API_URL}/verifications/{id}: the stored result of an earlier check (amount, payer, status, date).
// It has no receiver name, so on its own it is not enough to credit a deposit.
async function getCheckEtVerification(id) {
  if (!id) return null;
  const { response, error } = await fetchWithRetry(
    `${CHECKET_API_URL}/verifications/${encodeURIComponent(id)}`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${CHECKET_API_KEY}` } },
    { attempts: 2, timeoutMs: 15000 }
  );
  if (!response || !response.ok) {
    console.error(`check.et verification ${id} could not be read:`, response ? `HTTP ${response.status}` : error && error.message);
    return null;
  }
  try { return (await response.json()).verification || null; } catch (e) { return null; }
}

// telebirr only: read the official receipt page directly (the same page check.et reads), for the receiver details
async function telebirrReceiptDirect(receiptNo) {
  const info = await extractTransactionInfo(`https://transactioninfo.ethiotelecom.et/receipt/${receiptNo}`);
  if (!info || !info.creditedPartyName || !info.amount) return null;
  return info;
}

// a receipt check.et says it already verified: build the receipt again so it can still be credited,
// unless our own deposits table shows it was credited already.
//   returns { used: true }  |  { receipt }  |  { receipt: null }
async function receiptForDuplicate(typeName, dup) {
  const receiptNo = dup.receiptNo;
  if (await receiptAlreadyCredited(receiptNo)) return { used: true };

  if (dup.receipt && dup.receipt.creditedPartyName) return { receipt: dup.receipt };

  const v = await getCheckEtVerification(dup.existingVerificationId);
  if (v && v.success === false) return { receipt: null };

  const direct = typeName === "telebirr" && receiptNo ? await telebirrReceiptDirect(receiptNo) : null;
  if (!direct) {
    console.error(`[deposit] receipt ${receiptNo} was verified on check.et before but its receiver details are not available; credit it by hand if it is ours`, v);
    return { receipt: null };
  }

  const amount = v && v.amount != null ? `${v.amount} ${v.currency || "ETB"}` : direct.amount;
  const status = String((v && v.status) || "completed");
  return {
    receipt: {
      source: "check.et (already verified)",
      receiptNo: receiptNo,
      payerName: (v && v.payer_name) || direct.payerName,
      payerTelebirrNo: direct.payerTelebirrNo,
      creditedPartyName: direct.creditedPartyName,
      creditedPartyAccountNo: direct.creditedPartyAccountNo,
      settledAmount: amount,
      totalPaidAmount: amount,
      paymentDate: v && v.transaction_date ? toEthiopiaDateText(v.transaction_date) : direct.paymentDate,
      transactionStatus: status.charAt(0).toUpperCase() + status.slice(1).toLowerCase(),
      paymentMode: "telebirr",
      checkEt: { verificationId: dup.existingVerificationId, duplicate: true }
    }
  };
}

// a receipt link anywhere in the text (any bank app share link), used when we could not read the number ourselves
function findReceiptUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s<>()\[\]"']+/i);
  return m ? m[0].replace(/[.,;:]+$/, "") : null;
}

// ─────────────────────────────────────────────
// Customer messages (English / Amharic). They are added to the bot's I18N table, so bot.js shows them with
// tr(lang, result.errorKey) in the user's language. bot.js only does that when result.timeout is true,
// which is why every customer-facing failure below sets timeout: true.
// ─────────────────────────────────────────────
// same limits bot.js checks (checkReceiptForDeposit); read here so the customer is told the real reason
const DEPOSIT_MAX_AGE_HOURS = Number(process.env.DEPOSIT_MAX_AGE_HOURS) || 24;
const DEPOSIT_MAX_ETB = Number(process.env.DEPOSIT_MAX_ETB) || 0;

const DEPOSIT_TEXTS = {
  dep_txn_not_found: {
    en: "❌ Transaction number not found. Please send the full SMS message or the transaction number.",
    am: "❌ የግብይት ቁጥር አልተገኘም። እባክዎ ሙሉውን የSMS መልእክት ወይም የግብይት ቁጥሩን ይላኩ"
  },
  dep_not_verified: {
    en: "❌ The receipt could not be verified. Please check the transaction number and try again.",
    am: "❌ ደረሰኙ ሊረጋገጥ አልቻለም። እባክዎ የግብይት ቁጥሩን አረጋግጠው እንደገና ይሞክሩ"
  },
  dep_verify_slow: {
    en: "❌ We could not verify the receipt right now. Please check that the transaction number is correct and send it again in 1 minute.",
    am: "❌ ደረሰኙን አሁን ማረጋገጥ አልተቻለም። እባክዎ የግብይት ቁጥሩ ትክክል መሆኑን አረጋግጠው ከ1 ደቂቃ በኋላ እንደገና ይላኩ"
  },
  dep_service_busy: {
    en: "❌ The server is busy. Please try again in a little while.",
    am: "❌ ሰርቨሩ ተጨናንቆአል ትንሽ ቆይተው እንደገና ይሞክሩ"
  },
  dep_receipt_used: {
    en: "❌ This receipt has already been used. Please send a new receipt.",
    am: "❌ ይህ ደረሰኝ ከዚህ በፊት ጥቅም ላይ ውሏል። እባክዎ አዲስ ደረሰኝ ይላኩ"
  },
  dep_old_receipt: {
    en: `❌ This receipt is too old. Only payments made in the last ${DEPOSIT_MAX_AGE_HOURS} hours are accepted. Please send a new receipt.`,
    am: `❌ ይህ ደረሰኝ ጊዜው ያለፈበት ነው። የሚቀበለው ባለፉት ${DEPOSIT_MAX_AGE_HOURS} ሰዓታት ውስጥ የተከፈለ ክፍያ ብቻ ነው። እባክዎ አዲስ ደረሰኝ ይላኩ`
  },
  dep_not_completed: {
    en: "❌ This payment is not completed. Only completed payments can be deposited.",
    am: "❌ ይህ ክፍያ አልተጠናቀቀም። ገቢ የሚደረገው የተጠናቀቀ ክፍያ ብቻ ነው።"
  },
  dep_bad_date: {
    en: "❌ The payment date on this receipt is not valid. Please contact support.",
    am: "❌ በደረሰኙ ላይ ያለው የክፍያ ቀን ትክክል አይደለም። እባክዎ ድጋፍን ያነጋግሩ።"
  },
  dep_amount_too_high: {
    en: `❌ This amount is above the ${DEPOSIT_MAX_ETB} ETB limit for one deposit. Please contact support.`,
    am: `❌ ይህ መጠን ለአንድ ገቢ ከተፈቀደው ${DEPOSIT_MAX_ETB} ብር በላይ ነው። እባክዎ ድጋፍን ያነጋግሩ።`
  },
  dep_dup_manual: {
    en: "❌ This receipt was already verified, but it could not be added automatically. Please contact support.",
    am: "❌ ይህ ደረሰኝ ከዚህ በፊት ተረጋግጧል፤ በራስ-ሰር ማስገባት አልተቻለም። እባክዎ ድጋፍን ያነጋግሩ"
  }
};
try {
  const { I18N } = require("./i18n");
  for (const [k, v] of Object.entries(DEPOSIT_TEXTS)) if (!I18N[k]) I18N[k] = v;   // i18n_flows.js wins if it has the key
} catch (e) {
  console.warn("[deposit] could not add deposit texts to i18n:", e.message);
}

// failure returned to bot.js: errorKey is shown in the user's language, errorMessage (Amharic) is the old fallback
function depositFail(key, extra = {}) {
  return { result: null, success: false, timeout: true, errorKey: key, errorMessage: DEPOSIT_TEXTS[key].am, ...extra };
}

// "15-10-2025 15:26:23" or "2025-10-15 15:26:23" (Ethiopia time, UTC+3) -> epoch ms, or null. Same as bot.js.
function parseReceiptDate(text) {
  const t = String(text || "");
  let y, mo, d, h, mi, se;
  let m = t.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) { [, d, mo, y, h, mi, se] = m.map(Number); }
  else {
    m = t.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    [, y, mo, d, h, mi, se] = m.map(Number);
  }
  const ms = Date.UTC(y, mo - 1, d, h - 3, mi, se || 0);
  return Number.isFinite(ms) ? ms : null;
}

// the checks bot.js makes before crediting (status, age, amount limit), so a refused receipt gets its own message
// instead of the general "not valid or not new". Returns a DEPOSIT_TEXTS key, or null when the receipt is fine.
// (The optional payer-phone match needs the player, so it stays in bot.js with the general message.)
function refusalKey(receipt) {
  const status = String(receipt.transactionStatus || "").trim().toLowerCase();
  if (status && status !== "completed") return "dep_not_completed";
  const when = parseReceiptDate(receipt.paymentDate);
  if (when !== null) {
    const ageH = (Date.now() - when) / 3600000;
    if (ageH > DEPOSIT_MAX_AGE_HOURS) return "dep_old_receipt";
    if (ageH < -1) return "dep_bad_date";
  }
  const amount = Number(String(receipt.settledAmount ?? "").replace(/[^0-9.]/g, ""));
  if (DEPOSIT_MAX_ETB > 0 && amount > DEPOSIT_MAX_ETB) return "dep_amount_too_high";
  return null;
}

// a verified receipt: refuse it here with the real reason, or hand it to bot.js
function depositOk(data, extra = {}) {
  const key = data && data.receipt ? refusalKey(data.receipt) : null;
  if (key) {
    console.warn(`[deposit] receipt ${data.receipt.receiptNo} refused: ${key} (date ${data.receipt.paymentDate}, status ${data.receipt.transactionStatus}, amount ${data.receipt.settledAmount})`);
    return depositFail(key, extra);
  }
  return { result: data, success: true, timeout: false, errorMessage: "Successful", ...extra };
}

// true when this receipt number is already in our deposits table (credited before)
async function receiptAlreadyCredited(receiptNo) {
  if (!receiptNo) return false;
  try {
    const db = require("./db");
    return await db.isReceiptReferenceUsed(receiptNo);
  } catch (e) {
    // the lookup failed: carry on, db.approveDeposit() still refuses a receipt that was already credited
    console.error("[deposit] could not look up receipt in deposits:", e.message);
    return false;
  }
}

// ─────────────────────────────────────────────
// links.et  (https://links.et, docs: https://links.et/docs, https://links.et/agents.md)
//   POST {LINKSET_API_URL}   x-api-key: vk_live_...
//   body {"reference":"DJ92KW2GFW"} (telebirr only)  or  {"url":"https://<receipt link>"}
//   200 {ok:true, providerKey, resolvedUrl, receipt:{source:"telebirr-html", payerName, payerTelebirrNo,
//        creditedPartyName, creditedPartyAccountNo, transactionStatus, receiptNo, paymentDate, settledAmount, ...}}
//   errors {ok:false, error:{code, message}}: 400 bad input or bank timeout, 401 key, 429 rate_limited/quota_exceeded,
//   502 receipt failed validation. A receipt checked before comes from links.et's cache, instantly and free.
//
//   LINKSET_API_KEY      the key from https://links.et/dashboard
//   LINKSET_API_URL      default https://links.et/api/verify
//   LINKSET_TIMEOUT_MS   default 40000 (links.et itself can take 30 s+ when the bank is slow)
// ─────────────────────────────────────────────
const LINKSET_API_URL = String(process.env.LINKSET_API_URL || "https://links.et/api/verify").trim();
const LINKSET_API_KEY = String(process.env.LINKSET_API_KEY || "").trim().replace(/^["']|["']$/g, "");
const LINKSET_TIMEOUT_MS = Number(process.env.LINKSET_TIMEOUT_MS) > 0 ? Number(process.env.LINKSET_TIMEOUT_MS) : 40000;

// which service verifies receipts: "linkset" (links.et, default), "checket" (check.et) or "checkit" (checkit.et)
const DEPOSIT_VERIFIER = String(process.env.DEPOSIT_VERIFIER || "linkset").trim().toLowerCase().replace(/[^a-z]/g, "");
if ((DEPOSIT_VERIFIER === "linkset" || (DEPOSIT_VERIFIER === "checkit" && (process.env.DEPOSIT_FALLBACK_VERIFIER || "linkset").toLowerCase() === "linkset")) && !LINKSET_API_KEY) console.warn("[deposit] LINKSET_API_KEY is not set: links.et will refuse every receipt check");

// links.et receipt -> the fields bot.js / db.approveDeposit use. telebirr already has exactly these names;
// other providers are filled from the closest field links.et returns.
function receiptFromLinksEt(json, fallbackReceiptNo) {
  const r = json.receipt || {};
  const pick = (...keys) => { for (const k of keys) if (r[k] != null && r[k] !== "") return r[k]; return null; };
  const amount = pick("settledAmount", "amount", "totalPaidAmount", "transferredAmount", "paidAmount");
  const status = String(pick("transactionStatus", "status") || "");
  return {
    ...r,
    source: r.source || "links.et",
    receiptNo: String(pick("receiptNo", "reference", "transactionId", "transactionNumber") || fallbackReceiptNo || "").toUpperCase(),
    payerName: pick("payerName", "senderName", "payer"),
    payerTelebirrNo: pick("payerTelebirrNo", "payerAccount", "payerPhone", "senderAccount", "senderPhone"),
    creditedPartyName: pick("creditedPartyName", "receiverName", "receiver", "creditedParty"),
    creditedPartyAccountNo: pick("creditedPartyAccountNo", "receiverAccount", "receiverPhone", "creditedAccount"),
    settledAmount: amount == null ? null : String(amount),
    totalPaidAmount: pick("totalPaidAmount", "settledAmount", "amount"),
    paymentDate: pick("paymentDate", "transactionDate", "date"),
    transactionStatus: status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : null,
    linksEt: { providerKey: json.providerKey || null, fetchedAt: json.fetchedAt || null }
  };
}

async function verifyWithLinksEt(typeName, receiptId, receiptUrl) {
  const type = String(typeName || "").toLowerCase();
  let body;
  if (receiptId && type === "telebirr") body = { reference: receiptId };
  else if (receiptId && type === "m-pesa") body = { url: `https://m-pesabusiness.safaricom.et/receipt/${receiptId}` };
  else body = { url: receiptUrl };

  let response = null, error = null, json = null;
  for (let i = 1; i <= 2; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINKSET_TIMEOUT_MS);
    try {
      response = await fetch(LINKSET_API_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": LINKSET_API_KEY },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      error = null;
      const text = await response.text();
      try { json = JSON.parse(text); } catch (e) { json = null; console.error(`links.et returned non-JSON (HTTP ${response.status}):`, text.slice(0, 300)); }
    } catch (e) {
      response = null; json = null; error = e;
    } finally {
      clearTimeout(timer);
    }
    // links.et asks for one more try only on 429 rate_limited (after Retry-After) and 502; never wait twice on a timeout
    const code = json && json.error && json.error.code;
    const again = response && ((response.status === 429 && code === "rate_limited") || response.status === 502);
    if (!again || i === 2) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 1500;
    console.warn(`links.et HTTP ${response.status}${code ? " " + code : ""}, trying once more`);
    await sleep(waitMs);
  }

  if (!response) {
    if (error && error.name === "AbortError") {
      console.error(`links.et gave no answer in ${LINKSET_TIMEOUT_MS / 1000} s`);
      return { ok: false, timeout: true };
    }
    console.error("links.et request failed:", error && error.message);
    return { ok: false, unavailable: true };
  }

  const code = json && json.error && json.error.code;
  const message = json && json.error && (json.error.message || json.error);

  if (response.ok && json && json.ok === true && json.receipt) {
    return { ok: true, data: { ok: true, receipt: receiptFromLinksEt(json, receiptId), linksEt: json } };
  }
  if (response.status === 202) {
    console.warn("links.et is still working on the receipt (202)");
    return { ok: false, timeout: true };
  }
  if (response.status === 401) {
    console.error(`links.et refused the API key (${code || "HTTP 401"}). Check LINKSET_API_KEY.`);
    return { ok: false, unavailable: true };
  }
  if (response.status === 429) {
    console.error(`links.et limit reached (${code || "HTTP 429"}):`, message, json && json.error && json.error.cap ? `${json.error.used}/${json.error.cap}` : "");
    return { ok: false, unavailable: true };
  }
  if (response.status === 400 && !code) {
    // links.et: a bad link or a bank timeout (no answer from the bank). Could be a wrong number or a slow bank.
    console.log("links.et could not get the receipt from the bank:", message);
    return { ok: false, timeout: true };
  }
  if (response.status >= 500 && response.status !== 502) {
    console.error(`links.et HTTP ${response.status}:`, message);
    return { ok: false, unavailable: true };
  }
  console.log(`links.et: not verified (HTTP ${response.status}${code ? " " + code : ""}):`, message);
  return { ok: false, data: json };
}

// ─────────────────────────────────────────────
// checkit.et  (our own receipt reader: https://checkit.et/api/process.php)
//   GET {CHECKIT_API_URL}?type=telebirr|m-pesa&receiptid=DJ92KW2GFW   (no API key)
//   200 {ok:true, providerKey, resolvedUrl, httpStatus, fetchedAt, receipt:{source:"telebirr-html", payerName,
//        payerTelebirrNo, creditedPartyName, creditedPartyAccountNo, transactionStatus, receiptNo, paymentDate,
//        settledAmount, totalPaidAmount, ...}}   same receipt shape as links.et
//   {ok:false, error:"..."}  bad type / bad receipt id / Ethio Telecom could not be reached. M-Pesa is not built yet.
//   It only takes a receipt number, not a link. When Ethio Telecom has no such receipt it still answers ok:true,
//   with every field empty, so an empty receiptNo is treated as "not found".
//
//   CHECKIT_API_URL      default https://checkit.et/api/process.php
//   CHECKIT_TIMEOUT_MS   default 40000 (it waits up to 30 s on Ethio Telecom)
// ─────────────────────────────────────────────
const CHECKIT_API_URL = String(process.env.CHECKIT_API_URL || "https://checkit.et/api/process.php").trim();
const CHECKIT_TIMEOUT_MS = Number(process.env.CHECKIT_TIMEOUT_MS) > 0 ? Number(process.env.CHECKIT_TIMEOUT_MS) : 40000;

async function verifyWithCheckIt(typeName, receiptId, receiptUrl) {
  const type = String(typeName || "").toLowerCase();
  // checkit.et takes only the number: take it from the link's last part when we only have a link
  let id = receiptId;
  if (!id && receiptUrl) {
    const m = String(receiptUrl).match(/\/([A-Za-z0-9]{8,20})\/?(?:[?#].*)?$/);
    id = m ? m[1].toUpperCase() : null;
  }
  if (!id) return { ok: false, data: { ok: false, error: "no receipt number to send to checkit.et" } };

  const url = new URL(CHECKIT_API_URL);
  url.searchParams.set("type", type);
  url.searchParams.set("receiptid", id);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECKIT_TIMEOUT_MS);
  let response = null, json = null;
  try {
    response = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
    const text = await response.text();
    try { json = JSON.parse(text); } catch (e) { console.error(`checkit.et returned non-JSON (HTTP ${response.status}):`, text.slice(0, 300)); }
  } catch (e) {
    if (e.name === "AbortError") {
      console.error(`checkit.et gave no answer in ${CHECKIT_TIMEOUT_MS / 1000} s`);
      return { ok: false, timeout: true };
    }
    console.error("checkit.et request failed:", e.message);
    return { ok: false, unavailable: true };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok || !json) {
    console.error(`checkit.et HTTP ${response.status}`);
    return { ok: false, unavailable: true };
  }
  if (json.ok === true && json.receipt) {
    if (!json.receipt.receiptNo) {
      console.log(`checkit.et: Ethio Telecom has no receipt ${id}`);
      return { ok: false, data: json };
    }
    return { ok: true, data: { ok: true, receipt: receiptFromLinksEt(json, id), checkIt: json } };
  }
  // could not reach Ethio Telecom: a slow bank, the customer can send it again
  if (json.httpCode !== undefined || json.curlError) {
    console.log("checkit.et could not get the receipt from Ethio Telecom:", json.error, json.curlError || "");
    return { ok: false, timeout: true };
  }
  console.log("checkit.et: not verified:", json.error);
  return { ok: false, data: json };
}

// checkit.et goes first when DEPOSIT_VERIFIER=checkit. If it cannot confirm the receipt (M-Pesa, not found,
// Ethio Telecom slow, checkit.et down), the receipt goes to the fallback: DEPOSIT_FALLBACK_VERIFIER =
// "linkset" (links.et, default), "checket" (check.et) or "none".
const DEPOSIT_FALLBACK_VERIFIER = String(process.env.DEPOSIT_FALLBACK_VERIFIER || "linkset").trim().toLowerCase().replace(/[^a-z]/g, "");

async function verifyWith(verifier, typeName, receiptId, receiptUrl) {
  // log which URL this receipt is checked against
  let where;
  if (verifier === "checkit") {
    const u = new URL(CHECKIT_API_URL);
    u.searchParams.set("type", String(typeName || "").toLowerCase());
    u.searchParams.set("receiptid", receiptId || "(taken from link)");
    where = `checkit.et GET ${u.toString()}`;
  } else if (verifier === "checket") {
    where = `check.et POST ${CHECKET_VERIFY_URL}`;
  } else {
    where = `links.et POST ${LINKSET_API_URL}`;
  }
  console.log(`[deposit] checking receipt ${receiptId || receiptUrl} via ${where}`);
  if (verifier === "checket") return extractTransactionInfofromThirdParty(typeName, receiptId, receiptUrl);
  if (verifier === "checkit") return verifyWithCheckIt(typeName, receiptId, receiptUrl);
  return verifyWithLinksEt(typeName, receiptId, receiptUrl);
}

async function verifyReceipt(typeName, receiptId, receiptUrl) {
  const label = { checket: "check.et", checkit: "checkit.et", linkset: "links.et" };
  let result = await verifyWith(DEPOSIT_VERIFIER, typeName, receiptId, receiptUrl);
  console.log(`Transaction Information for Type = ${typeName} (${label[DEPOSIT_VERIFIER] || "links.et"}):`, result);
  if (DEPOSIT_VERIFIER === "checkit" && !result.ok && DEPOSIT_FALLBACK_VERIFIER !== "none" && DEPOSIT_FALLBACK_VERIFIER !== "checkit") {
    console.log(`[deposit] checkit.et did not confirm the receipt, trying ${label[DEPOSIT_FALLBACK_VERIFIER] || "links.et"}`);
    result = await verifyWith(DEPOSIT_FALLBACK_VERIFIER, typeName, receiptId, receiptUrl);
    console.log(`Transaction Information for Type = ${typeName} (${label[DEPOSIT_FALLBACK_VERIFIER] || "links.et"}):`, result);
  }
  return result;
}

// ─────────────────────────────────────────────
// MAIN DEPOSIT PROCESS
// ─────────────────────────────────────────────

async function processDeposit(sms, pmName, pmAmharicName, ptName, ptAmharicName) 
{ 
  let invoiceNo = "";
  let result = null;
  if(sms.length < 10)
  {
    console.log("SMS or InvoiceNo length is lessthan 10.");
    return depositFail("dep_txn_not_found");
  }  
  if(ptName.toLowerCase() == "mobile" || ptAmharicName.toLowerCase() == "ሞባይል")
  {
    const isTelebirr = pmName.toLowerCase() == "telebirr" || pmAmharicName.toLowerCase() == "ቴሌብር";
    const isMpesa = pmName.toLowerCase() == "m-pesa" || pmAmharicName == "ኤም-ፔሳ";
    if(isTelebirr || isMpesa)
    {
      const typeName = isTelebirr ? "telebirr" : "m-pesa";
      invoiceNo = await extractInvoiceNumber(typeName, sms);
      // no number we can read, but there is a link: let the verifier read the link
      const receiptUrl = invoiceNo ? null : findReceiptUrl(sms);
      if(!invoiceNo && !receiptUrl)
      {
        return depositFail("dep_txn_not_found");
      }

      // credited before: say so straight away, without using a check on the verifier
      if (await receiptAlreadyCredited(invoiceNo)) {
        console.log(`[deposit] receipt ${invoiceNo} was already credited`);
        return depositFail("dep_receipt_used", { duplicate: true });
      }

      result = await verifyReceipt(typeName, invoiceNo, receiptUrl);

      // no answer in time: a wrong number, or the bank is slow. The customer can simply send it again.
      if (result.timeout) return depositFail("dep_verify_slow");
      // our side: key, quota, service down
      if (result.unavailable) return depositFail("dep_service_busy", { unavailable: true });

      if (result.ok) {
        const receiptNo = result.data && result.data.receipt && result.data.receipt.receiptNo;
        if (!invoiceNo && await receiptAlreadyCredited(receiptNo)) return depositFail("dep_receipt_used", { duplicate: true });
        return depositOk(result.data);
      }

      if (result.duplicate) {
        const dup = await receiptForDuplicate(typeName, result);
        if (dup.used) return depositFail("dep_receipt_used", { duplicate: true });
        if (dup.receipt) {
          return depositOk({ ok: true, receipt: dup.receipt, checkEt: result.data }, { duplicate: true });
        }
        return depositFail("dep_dup_manual", { duplicate: true });
      }

      return depositFail("dep_not_verified", { result: result.data || null });
    }
    else if(pmName.toLowerCase() == "cbebirr" || pmAmharicName == "ሲቢኢ ብር")
    {
      return null;
    }
    else
    {
      return null;
    }
  }
  else if(ptName.toLowerCase() == "bank" || ptAmharicName == "ባንክ")
  {
    if(pmName.toLowerCase() == "cbe" || pmAmharicName == "ኢትዮጵያ ንግድ ባንክ")
    {
        return null;
    }
  }
  else if(ptName.toLowerCase() == "mobile agent" || ptAmharicName == "ሞባይል ኤጀንት")
  {
      return null;
  }
  else
  {
      return null;
  }
}


// Export functions
module.exports = {
  extractInvoiceNumber,
  parseReceiptNumber,
  builURLfromInvoiceNo,
  checkUrl,
  extractTransactionInfo,
  processDeposit
};
