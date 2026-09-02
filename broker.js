import { accountConfiguration } from './accounts.config.js';

const GITHUB_API = 'https://api.github.com';
const OPTION_CHAIN_MINI_URL = 'https://mksapi.kotaksecurities.com/30newserviceapi/watchlist/v1/optionchain_mini';
const OPTION_CHAIN_UNDERLYINGS = Object.freeze({
  SENSEX: Object.freeze({ exchangeSegment: 'bse_cm', exchangeId: 'SENSEX', derivativeSegment: 'bse_fo' }),
  NIFTY: Object.freeze({ exchangeSegment: 'nse_cm', exchangeId: 'Nifty 50', derivativeSegment: 'nse_fo' }),
});
const accountCache = new Map();
const expiryCache = new Map();

function safeText(value) {
  return String(value ?? '')
    .replace(/github_pat_[A-Za-z0-9_]+/gi, '[GitHub token redacted]')
    .replace(/\b(?:Bearer|Sid|Auth|Authorization)\s+[^\s,;]+/gi, (match) => `${match.split(/\s+/)[0]} [redacted]`)
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 400);
}

function event(step, status, message, responseCode = 'LOCAL') {
  return {
    step: safeText(step),
    status,
    message: safeText(message),
    responseCode: safeText(responseCode),
    timestamp: new Date().toISOString(),
  };
}

function indiaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dataRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.data?.data)) return value.data.data;
  if (Array.isArray(value?.result)) return value.result;
  return [];
}

async function requestJson(url, options, label, events) {
  events.push(event(label, 'info', `${options?.method || 'GET'} request started.`, 'PENDING'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? `${label} timed out after 20 seconds.`
      : `${label} could not be reached.`;
    events.push(event(label, 'error', message, error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'));
    throw new Error(message);
  } finally {
    clearTimeout(timeout);
  }
  const body = (await response.text()).replace(/^\uFEFF/, '').trim();
  if (!response.ok) {
    events.push(event(label, 'error', `${label} failed.`, response.status));
    throw new Error(`${label} failed (${response.status}).`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    events.push(event(label, 'error', `${label} returned unreadable data.`, response.status));
    throw new Error(`${label} returned unreadable data.`);
  }
  events.push(event(label, 'success', `${options?.method || 'GET'} request completed.`, response.status));
  return parsed;
}

function parseConfiguration() {
  const config = accountConfiguration;
  if (config.version !== 1 || !Array.isArray(config.accountPairs) || !config.accountPairs.length) {
    throw new Error('Gateway account configuration is invalid.');
  }
  const expectedSources = {
    funds: 'read', positions: 'read', holdings: 'read', orderLog: 'read',
    signalContract: 'trade', signalLtp: 'trade', orderPlacement: 'trade',
  };
  for (const [card, role] of Object.entries(expectedSources)) {
    if (config.cardSources?.[card] !== role) throw new Error(`Credential role mismatch for ${card}.`);
  }
  const safeFileName = /^[A-Za-z0-9._-]+\.txt$/;
  const seen = new Set();
  const accounts = config.accountPairs.map((entry, index) => {
    const parts = String(entry).split('|').map((value) => value.trim());
    if (parts.length !== 2 || parts.some((value) => !safeFileName.test(value))) {
      throw new Error(`Account pair ${index + 1} must be tradeFile.txt|readFile.txt.`);
    }
    const [tradeFile, readFile] = parts;
    if (!/neo\.txt$/i.test(tradeFile) || !/^neo/i.test(readFile) || tradeFile.toLowerCase() === readFile.toLowerCase()) {
      throw new Error(`Account pair ${index + 1} does not follow the configured read/trade naming rules.`);
    }
    const id = tradeFile.replace(/neo\.txt$/i, '').replace(/[^A-Za-z0-9_-]/g, '').toLowerCase() || `account-${index + 1}`;
    if (seen.has(id)) throw new Error(`Duplicate account ID: ${id}.`);
    seen.add(id);
    return { id, label: id.charAt(0).toUpperCase() + id.slice(1), tradeFile, readFile };
  });
  return {
    accounts,
    refreshMs: {
      positions: Math.max(2000, number(config.refreshMs?.positions, 2000)),
      accountDetails: Math.max(10000, number(config.refreshMs?.accountDetails, 30000)),
    },
  };
}

function decodeAccountFile(content, role, fileName) {
  let decoded;
  try {
    decoded = atob(String(content || '').replace(/\s/g, ''));
  } catch {
    throw new Error(`${fileName} is not valid encoded content.`);
  }
  const [sid = '', authToken = '', roleKey = '', baseURL = ''] = decoded.split('|');
  if (!sid || !authToken || !baseURL) throw new Error(`${fileName} is missing required session fields.`);
  let brokerUrl;
  try {
    brokerUrl = new URL(baseURL.trim());
  } catch {
    throw new Error(`${fileName} contains an invalid broker URL.`);
  }
  const allowedHost = brokerUrl.hostname === 'kotaksecurities.com' || brokerUrl.hostname.endsWith('.kotaksecurities.com');
  if (brokerUrl.protocol !== 'https:' || !allowedHost) throw new Error(`${fileName} contains a disallowed broker URL.`);
  return {
    role,
    fileName,
    sid: sid.trim(),
    authToken: authToken.trim(),
    deviceId: role === 'read' ? roleKey.trim() : '',
    consumerKey: role === 'trade' ? roleKey.trim() : '',
    baseURL: baseURL.trim().replace(/\/$/, ''),
  };
}

async function loadGitHubFile(env, fileName, role, events) {
  const repository = String(env.GITHUB_REPOSITORY || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GitHub repository is not configured.');
  const response = await requestJson(
    `${GITHUB_API}/repos/${repository}/contents/${encodeURIComponent(fileName)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_PAT}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'NeoPilot-Secure-Gateway',
      },
    },
    `GitHub ${role} file ${fileName}`,
    events,
  );
  return decodeAccountFile(response.content, role, fileName);
}

async function accountContext(env, accountId, events, force = false) {
  const config = parseConfiguration();
  const meta = config.accounts.find((account) => account.id === accountId) || config.accounts[0];
  if (!meta) throw new Error('No configured account was found.');
  const cacheKey = `${env.GITHUB_REPOSITORY}|${meta.id}`;
  const cached = accountCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.loadedAt < 30000) return { ...cached, config };
  const [readAccount, tradeAccount] = await Promise.all([
    loadGitHubFile(env, meta.readFile, 'read', events),
    loadGitHubFile(env, meta.tradeFile, 'trade', events),
  ]);
  const context = { meta, readAccount, tradeAccount, loadedAt: Date.now() };
  accountCache.set(cacheKey, context);
  events.push(event(`${meta.label} credentials`, 'success', 'Read and trade roles validated; raw values stayed inside the gateway.'));
  return { ...context, config };
}

function readHeaders(account, formEncoded = false) {
  if (account.role !== 'read') throw new Error('Read credential role is required.');
  return {
    Accept: formEncoded ? '*/*' : 'application/json',
    ...(formEncoded ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    Sid: account.sid,
    Auth: account.authToken,
  };
}

function neoUrl(account, path) {
  return new URL(String(path).replace(/^\/+/, ''), `${account.baseURL}/`).toString();
}

function assertNeoResponse(label, response) {
  const status = String(response?.stat ?? response?.status ?? '').trim().toLowerCase();
  const statusCode = Number(response?.stCode ?? response?.statusCode ?? 0);
  const message = String(response?.emsg ?? response?.message ?? response?.error ?? '').trim();
  if (statusCode === 5203 || /no data|data not found/i.test(message)) return { ...response, data: [] };
  if (['not_ok', 'not ok', 'error', 'failed', 'failure'].includes(status) || statusCode >= 400) {
    if (statusCode === 401 || statusCode === 403 || /session|login|auth|token|expired/i.test(message)) {
      throw new Error(`${label} was rejected because the Kotak session is invalid or expired.`);
    }
    throw new Error(`${label} was rejected by Kotak${statusCode ? ` (${statusCode})` : ''}.`);
  }
  return response;
}

function normalizeSnapshot(positionsResponse, holdingsResponse, ordersResponse, limitsResponse) {
  const positions = dataRows(positionsResponse).flatMap((position, index) => {
    const hasParts = [position.cfBuyQty, position.flBuyQty, position.cfSellQty, position.flSellQty]
      .some((value) => value != null && value !== '');
    const buyQuantity = number(position.cfBuyQty) + number(position.flBuyQty);
    const sellQuantity = number(position.cfSellQty) + number(position.flSellQty);
    const quantity = hasParts ? buyQuantity - sellQuantity : number(position.qty ?? position.netQty);
    if (!quantity && !buyQuantity && !sellQuantity) return [];
    const lotSize = Math.max(1, number(position.lotSz ?? position.brdLtQty, 1));
    const priceFactor = (number(position.multiplier, 1) || 1)
      * ((number(position.genNum, 1) || 1) / (number(position.genDen, 1) || 1))
      * ((number(position.prcNum, 1) || 1) / (number(position.prcDen, 1) || 1));
    const buyAmount = number(position.cfBuyAmt) + number(position.buyAmt);
    const sellAmount = number(position.cfSellAmt) + number(position.sellAmt);
    const buyAveragePrice = buyQuantity && priceFactor ? buyAmount / (buyQuantity * priceFactor) : 0;
    const sellAveragePrice = sellQuantity && priceFactor ? sellAmount / (sellQuantity * priceFactor) : 0;
    const ltpValue = position.ltp ?? position.lastTradedPrice;
    const ltp = ltpValue == null || ltpValue === '' ? null : number(ltpValue);
    const reportedPnl = position.pnl ?? position.urmtom ?? position.unRealizedMtom;
    const pnl = reportedPnl == null || reportedPnl === ''
      ? sellAmount - buyAmount + (ltp == null ? 0 : quantity * ltp * priceFactor)
      : number(reportedPnl);
    const exchangeId = String(position.tok ?? position.exchangeId ?? position.instrumentToken ?? '').trim();
    return [{
      id: exchangeId || String(position.trdSym ?? `position-${index}`),
      exchangeId,
      instrumentToken: exchangeId,
      exchangeSegment: String(position.exSeg ?? position.exchangeSegment ?? ''),
      tradingSymbol: String(position.trdSym ?? position.sym ?? ''),
      displaySymbol: String(position.trdSym ?? position.sym ?? ''),
      expiry: String(position.expDt ?? ''),
      product: String(position.prod ?? ''),
      side: quantity > 0 ? 'LONG' : quantity < 0 ? 'SHORT' : 'CLOSED',
      status: quantity === 0 ? 'CLOSED' : 'OPEN',
      quantity: Math.abs(quantity), netQuantity: quantity, buyQuantity, sellQuantity,
      lots: quantity ? Math.max(1, Math.ceil(Math.abs(quantity) / lotSize)) : 0,
      lotSize,
      averagePrice: quantity > 0 ? buyAveragePrice : quantity < 0 ? sellAveragePrice : 0,
      buyAveragePrice, sellAveragePrice, ltp, pnl,
      pnlAvailable: reportedPnl != null && reportedPnl !== '' || quantity === 0 || ltp != null,
      pnlPercent: buyAmount ? (pnl / buyAmount) * 100 : 0,
      squareOffAllowed: false,
    }];
  });
  const holdings = dataRows(holdingsResponse).map((holding, index) => {
    const holdingCost = number(holding.holdingCost ?? holding.investedValue);
    const marketValue = number(holding.mktValue ?? holding.marketValue);
    const exchangeId = String(holding.scripId ?? holding.instrumentToken ?? holding.tok ?? '').trim();
    return {
      id: exchangeId || `holding-${index}`,
      exchangeId,
      instrumentToken: exchangeId,
      displaySymbol: String(holding.displaySymbol ?? holding.symbol ?? ''),
      exchangeSegment: String(holding.exchangeSegment ?? holding.exSeg ?? ''),
      instrumentType: String(holding.instrumentType ?? holding.series ?? ''),
      quantity: number(holding.quantity ?? holding.qty),
      sellableQuantity: number(holding.sellableQuantity ?? holding.sellableQty),
      averagePrice: number(holding.averagePrice ?? holding.avgPrc),
      closingPrice: number(holding.closingPrice ?? holding.closePrice),
      holdingCost, marketValue, pnl: marketValue - holdingCost,
    };
  });
  const orders = dataRows(ordersResponse).map((order) => ({
    id: String(order.nOrdNo ?? order.orderId ?? ''),
    time: String(order.ordDtTm ?? order.flDtTm ?? ''),
    symbol: String(order.trdSym ?? order.symbol ?? ''),
    side: String(order.trnsTp ?? 'B').toUpperCase().startsWith('B') ? 'BUY' : 'SELL',
    quantity: number(order.qty), price: number(order.avgPrc ?? order.prc),
    status: String(order.ordSt ?? order.stat ?? '').toUpperCase(),
  }));
  const rows = dataRows(limitsResponse);
  const limit = rows[0] || limitsResponse?.data || limitsResponse || {};
  return {
    mode: 'readonly', sessionSource: 'secure-gateway', bridgeConnected: true,
    updatedAt: new Date().toISOString(),
    funds: {
      available: number(limit.Net ?? limit.net ?? limit.availableCash ?? limit.cash),
      marginUsed: number(limit.MarginUsed ?? limit.marginUsed ?? limit.marginUtilized),
      amountUtilized: number(limit.AmountUtilizedPrsnt ?? limit.AmtUntilizedPrsnt ?? limit.amountUtilized),
    },
    positions, holdings, orders,
  };
}

async function fetchPositions(account, meta, events) {
  const label = `${meta.label} positions`;
  return assertNeoResponse(label, await requestJson(neoUrl(account, 'quick/user/positions'), {
    headers: readHeaders(account),
  }, label, events));
}

async function fetchHoldings(account, meta, events) {
  const label = `${meta.label} holdings`;
  return assertNeoResponse(label, await requestJson(neoUrl(account, 'portfolio/v1/holdings'), {
    headers: readHeaders(account, true),
  }, label, events));
}

async function fetchOrders(account, meta, events) {
  const label = `${meta.label} order report`;
  return assertNeoResponse(label, await requestJson(neoUrl(account, 'quick/user/orders'), {
    headers: readHeaders(account),
  }, label, events));
}

async function fetchLimits(account, meta, events) {
  const label = `${meta.label} limits`;
  const body = new URLSearchParams({ jData: JSON.stringify({ seg: 'ALL', exch: 'ALL', prod: 'ALL' }) });
  return assertNeoResponse(label, await requestJson(neoUrl(account, 'quick/user/limits'), {
    method: 'POST', headers: readHeaders(account, true), body,
  }, label, events));
}

function optionExpiryDate(value) {
  const match = String(value || '').trim().toUpperCase().match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (!match) return null;
  const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(match[2]);
  if (month < 0) return null;
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function expiryKey(date) { return date.toISOString().slice(0, 10); }
function displayExpiry(date) {
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}
function normalizedSymbol(value) { return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function optionChainUrl(exchangeSegment, exchangeId) {
  const url = new URL(OPTION_CHAIN_MINI_URL);
  url.searchParams.set('exch_seg', exchangeSegment);
  url.searchParams.set('exch_id', exchangeId);
  url.searchParams.set('count', '40');
  return url.toString();
}
function chainData(response, label) {
  if (!response?.data || typeof response.data !== 'object' || Array.isArray(response.data)) throw new Error(`${label} did not return option-chain data.`);
  return response.data;
}
function nearestExpiry(expiries) {
  const upcoming = (Array.isArray(expiries) ? expiries : []).flatMap((expiry) => {
    const date = optionExpiryDate(expiry?.expiryDt);
    const exchangeId = String(expiry?.exchId || '').trim();
    return !date || !exchangeId || expiryKey(date) < indiaDate() ? [] : [{ date, dateKey: expiryKey(date), displayDate: displayExpiry(date), exchangeId }];
  }).sort((left, right) => left.date - right.date || left.exchangeId.localeCompare(right.exchangeId));
  if (!upcoming.length) throw new Error('Kotak did not return an upcoming expiry.');
  return upcoming[0];
}
function selectContract(data, signal, expiry) {
  const optionType = String(signal.optionType || '').toUpperCase();
  const strike = Number(signal.strike);
  const rows = optionType === 'CE' ? data.call : data.put;
  if (!Array.isArray(rows)) throw new Error('Kotak did not return the requested option list.');
  const returnedExpiry = optionExpiryDate(data.common_data?.expiryDt);
  if (!returnedExpiry || expiryKey(returnedExpiry) !== expiry.dateKey) throw new Error('Kotak returned a different expiry than selected.');
  const expectedUnderlying = normalizedSymbol(signal.underlying);
  const contract = rows.find((row) => String(row?.optionType || '').toUpperCase() === optionType
    && Math.abs(Number(row?.strikePrice) - strike) < 0.001
    && String(row?.symbol || '').toUpperCase().endsWith(optionType)
    && normalizedSymbol(row?.symbol).startsWith(expectedUnderlying)
    && !/FUT/i.test(String(row?.symbol || '')));
  if (!contract) throw new Error(`No ${expectedUnderlying} ${strike} ${optionType} contract was returned for ${expiry.displayDate}.`);
  return {
    tradingSymbol: String(contract.symbol), instrumentToken: String(contract.exchId),
    exchangeSegment: expiry.derivativeSegment, optionType, strike,
    lotSize: number(data.common_data?.mktLot, expiry.lotSize),
  };
}

async function resolveSignal(signal, events) {
  const underlying = normalizedSymbol(signal?.underlying);
  const optionType = String(signal?.optionType || '').toUpperCase();
  const strike = Number(signal?.strike);
  if (!OPTION_CHAIN_UNDERLYINGS[underlying] || !['CE', 'PE'].includes(optionType) || !Number.isFinite(strike) || strike <= 0) {
    throw new Error('Signal must contain SENSEX or NIFTY, strike price, and CE/PE.');
  }
  const source = OPTION_CHAIN_UNDERLYINGS[underlying];
  const cacheKey = `${underlying}|${indiaDate()}`;
  let cached = expiryCache.get(cacheKey);
  if (!cached) {
    const label = `${underlying} mini option-chain expiries`;
    const data = chainData(await requestJson(optionChainUrl(source.exchangeSegment, source.exchangeId), { headers: { Accept: '*/*' } }, label, events), label);
    const expiry = nearestExpiry(data.expiries);
    const derivativeSegment = String(data.common_data?.exSeg || '').toLowerCase();
    if (derivativeSegment !== source.derivativeSegment) throw new Error('Kotak returned an unexpected derivatives segment.');
    cached = { ...expiry, derivativeSegment, lotSize: number(data.common_data?.mktLot, 1), initialChainData: data };
    expiryCache.set(cacheKey, cached);
  }
  let contract;
  try {
    contract = selectContract(cached.initialChainData, { underlying, optionType, strike }, cached);
  } catch {
    const label = `${underlying} ${cached.displayDate} mini option-chain`;
    const data = chainData(await requestJson(optionChainUrl(cached.derivativeSegment, cached.exchangeId), { headers: { Accept: '*/*' } }, label, events), label);
    contract = selectContract(data, { underlying, optionType, strike }, cached);
  }
  return {
    ...contract, exchangeId: contract.instrumentToken,
    expiry: cached.displayDate, expiryDate: cached.dateKey,
    ltp: null, ltpStatus: 'paused', quoteTime: '',
    selectionRule: 'nearest-upcoming-mini-option-chain-expiry',
  };
}

export async function bootstrap(env, events, force = false) {
  const config = parseConfiguration();
  const contexts = await Promise.all(config.accounts.map((account) => accountContext(env, account.id, events, force)));
  return {
    accounts: contexts.map(({ meta, readAccount, tradeAccount }) => ({
      id: meta.id, label: meta.label, readFile: meta.readFile, tradeFile: meta.tradeFile,
      readReady: Boolean(readAccount.sid && readAccount.authToken),
      tradeReady: Boolean(tradeAccount.sid && tradeAccount.authToken && tradeAccount.consumerKey),
    })),
    refreshMs: config.refreshMs,
  };
}

export async function snapshot(env, accountId, events, force = false) {
  const context = await accountContext(env, accountId, events, force);
  const [positions, holdings, orders, limits] = await Promise.all([
    fetchPositions(context.readAccount, context.meta, events),
    fetchHoldings(context.readAccount, context.meta, events),
    fetchOrders(context.readAccount, context.meta, events),
    fetchLimits(context.readAccount, context.meta, events),
  ]);
  return { ...normalizeSnapshot(positions, holdings, orders, limits), accountId: context.meta.id, accountLabel: context.meta.label };
}

export async function positions(env, accountId, events) {
  const context = await accountContext(env, accountId, events);
  const response = await fetchPositions(context.readAccount, context.meta, events);
  const normalized = normalizeSnapshot(response, null, null, null);
  return { accountId: context.meta.id, positions: normalized.positions, updatedAt: normalized.updatedAt };
}

export async function details(env, accountId, events) {
  const context = await accountContext(env, accountId, events);
  const [holdings, orders, limits] = await Promise.all([
    fetchHoldings(context.readAccount, context.meta, events),
    fetchOrders(context.readAccount, context.meta, events),
    fetchLimits(context.readAccount, context.meta, events),
  ]);
  const normalized = normalizeSnapshot(null, holdings, orders, limits);
  return {
    accountId: context.meta.id, funds: normalized.funds,
    holdings: normalized.holdings, orders: normalized.orders, updatedAt: normalized.updatedAt,
  };
}

export async function signalContract(env, accountId, signal, events) {
  await accountContext(env, accountId, events);
  return resolveSignal(signal, events);
}

export { event, parseConfiguration };
