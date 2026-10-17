import { API_BASE } from './apibase';
import { mintEphemeralSession } from './session';

export interface Auction {
  id: string;
  title: string;
  description: string;
  reserve_zats: number;
  seller_address: string;
  seller_pubkey?: string | null;
  created_at: number;
  closes_at: number;
  status: 'open' | 'closed' | 'settled' | 'canceled';
  settled_at: number | null;
  sold: boolean | null;
  price_zats: number | null;
  winner_bid_id: string | null;
  settlement_txid: string | null;
  /** The exact payments executed at settlement. Present once settled. */
  settlement?: Settlement | null;
  bids?: Bid[];
  registered_count?: number;
  images: string[];
  category: string;
  tags: string[];
  has_hidden_reserve: boolean;
  bin_price_zats: number | null;
  collateral_zats: number;
  collateral_txid: string | null;
  has_delivery_payload: boolean;
  payload_claimed: boolean;
  /** Seller's declared refund policy (public transparency label). */
  refund_policy: string | null;
  /** Whether the winning bidder has claimed the seller's contact note. */
  contact_claimed: boolean;
  /** How the winner receives the goods: 'digital' (payload/contact) or
   *  'physical' (shipping). Drives the seller-payout auto-release window. */
  delivery_kind: 'digital' | 'physical';
  /** Two-phase seller payout: 'held' (awaiting winner confirm/dispute or
   *  auto-release), 'released' (paid to seller), 'slashed' (disputed).
   *  Null before a sold lot settles. */
  payout_state: 'held' | 'disputed' | 'released' | 'slashed' | null;
  /** When the held payout auto-releases to the seller (null = no deadline). */
  payout_deadline: number | null;
  payout_txid: string | null;
  /** Winner's non-delivery claim, recorded when the payout was disputed. */
  dispute_reason: string | null;
  /** Seller's delivery proof submitted during the dispute evidence window. */
  delivery_proof: string | null;
  /** When the dispute was opened (freezes auto-release). */
  dispute_opened_at: number | null;
}

export const CATEGORIES = [
  { key: 'wl', label: 'Whitelist' },
  { key: 'wallet', label: 'Wallet' },
  { key: 'nft', label: 'NFT' },
  { key: 'alpha', label: 'Alpha' },
  { key: 'collectible', label: 'Collectible' },
  { key: 'other', label: 'Other' },
] as const;

export function categoryLabel(key: string): string {
  return CATEGORIES.find((c) => c.key === key)?.label ?? key;
}

export interface Bid {
  id: string;
  auction_id: string;
  refund_address: string;
  registered_amount_zats: number;
  created_at: number;
  status: string;
  txid: string | null;
  confirmed_amount_zats: number | null;
  detected_at: number | null;
  confirmations: number;
  refund_txid: string | null;
  refund_amount_zats: number | null;
  /** Identity the bid was bound to (the bidder's pubkey). */
  user_pubkey?: string | null;
  is_buy_now?: boolean;
}

export interface BidStatus {
  id: string;
  auction_id: string;
  status: string;
  confirmations: number;
  registered_amount_zats: number;
  confirmed_amount_zats: number | null;
  txid: string | null;
  refund_txid: string | null;
  refund_amount_zats: number | null;
}

export interface PlaceBidResponse {
  bid_id: string;
  auction_id: string;
  memo: string;
  zip321_uri: string;
  /** What this invoice adds right now — not the running total. */
  amount_zats: number;
  /** Running total this identity has escrowed on this lot, including prior deposits. */
  registered_amount_zats: number;
  buy_now: boolean;
}

export interface CollateralInvoice {
  auction_id: string;
  amount_zats: number;
  memo: string;
  zip321_uri: string;
  paid_txid: string | null;
}

export interface SellerView {
  auction: Auction;
  hidden_reserve_zats: number | null;
  delivery_payload: string | null;
}

/** Post-settlement winner↔seller contact escrow. */
export interface ContactExchange {
  role: 'seller' | 'winner';
  counterparty_contact: string | null;
  seller_contact_escrowed?: boolean;
  winner_contact_escrowed?: boolean;
}

export interface SettlementPayment {
  bid_id: string | null;
  to: string;
  amount_zats: number;
  kind: 'bid_refund' | 'winner_excess_refund' | 'seller_proceeds' | 'collateral_refund';
}

export interface Settlement {
  sold: boolean;
  price_zats: number;
  winner_bid_id: string | null;
  payments: SettlementPayment[];
}

export interface SettleResponse {
  settlement: Settlement;
  settlement_txid: string | null;
}

export interface Health {
  ok: boolean;
  wallet_ready: boolean;
  wallet_balance_zats: number;
  /** Sum of every hosted identity's balance — what the hosted wallet owes. */
  wallet_ledger_zats: number;
  /** Funder shielded notes backing that ledger. Must be >= wallet_ledger_zats. */
  funder_shielded_zats: number;
  auctioneer_ua: string;
  network: string;
  chain: string;
  conf_target: number;
}

/** The signed-in identity's hosted wallet. */
export interface WalletView {
  address: string | null;
  balance_zats: number;
  faucet_zats: number;
  faucet_ready: boolean;
  faucet_wait_secs: number;
  network: string;
  hosted: boolean;
}

export interface FaucetResponse {
  status: string;
  txid: string | null;
  amount_zats: number;
  address: string;
}

export interface WalletMoveResponse {
  status: string;
  txid: string | null;
  amount_zats: number;
  to?: string;
  memo?: string;
}

export interface NetworkEntry {
  name: string;
  chain: string;
  ready: boolean;
  active: boolean;
}

export interface SwitchNetworkResponse {
  active: string;
  chain: string;
  auctioneer_ua: string;
}

export interface PrivacyInfo {
  chain: string;
  pool: string;
  conf_target: number;
  commission_bps: number;
  min_bid_zats: number;
  min_bid_zec: string;
  auctioneer_ua: string;
  rpc_auth: string;
  ip_logging: string;
  bid_confidentiality: string;
  memo_channel: string;
  onchain_view: string;
}

export interface DashboardAuction {
  auction: Auction;
  bids: Bid[];
}

export interface Dashboard {
  auctions: DashboardAuction[];
  wallet_balance_zats: number;
  auctioneer_ua: string;
  conf_target: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const doFetch = () =>
    fetch(API_BASE + path, {
      // Cross-origin cookies (split frontend): send the session cookie on
      // every request, otherwise the backend never sees our session.
      credentials: 'include',
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
  let res = await doFetch();
  // Reads are session-gated; a missing/expired cookie means the ephemeral
  // read session never minted or timed out — mint one and retry once.
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    const id = await mintEphemeralSession();
    if (id) res = await doFetch();
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      /* keep raw */
    }
    throw new Error(message);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  health: () => request<Health>('/api/health'),
  privacy: () => request<PrivacyInfo>('/api/privacy'),
  networks: () => request<NetworkEntry[]>('/api/networks'),
  switchNetwork: (name: string) =>
    request<SwitchNetworkResponse>('/api/network', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  auctions: () => request<Auction[]>('/api/auctions'),
  auction: (id: string) => request<Auction>(`/api/auctions/${id}`),
  bid: (id: string) => request<BidStatus>(`/api/bids/${id}`),
  /** Bids bound to the signed-in identity — recovers a winner's bid ID when
   *  localStorage was cleared or the lot is viewed on another device. */
  myBids: () => request<Bid[]>('/api/me/bids'),
  dashboard: () => request<Dashboard>('/api/dashboard'),
  createAuction: (body: {
    title: string;
    description: string;
    reserve_zec: string;
    duration_secs: number;
    seller_address: string;
    images?: string[];
    category?: string;
    tags?: string[];
    hidden_reserve_zec?: string;
    bin_price_zec?: string;
    collateral_zec?: string;
    delivery_payload?: string;
    refund_policy?: string;
    seller_contact?: string;
    /** How the winner receives the goods: 'digital' or 'physical'. */
    delivery_kind?: 'digital' | 'physical';
  }) =>
    request<Auction>('/api/auctions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  placeBid: (
    auctionId: string,
    body: { refund_address: string; amount_zec: string; buy_now?: boolean },
  ) =>
    request<PlaceBidResponse>(`/api/auctions/${auctionId}/bids`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  collateralInvoice: (auctionId: string) =>
    request<CollateralInvoice>(`/api/auctions/${auctionId}/collateral`),
  sellerView: (auctionId: string) =>
    request<SellerView>(`/api/auctions/${auctionId}/seller`),
  claimPayload: (auctionId: string, bidId: string) =>
    request<{ payload: string }>(`/api/auctions/${auctionId}/payload`, {
      method: 'POST',
      body: JSON.stringify({ bid_id: bidId }),
    }),
  /** Seller escrows their contact note; returns the winner's if already there. */
  setSellerContact: (auctionId: string, contact: string) =>
    request<ContactExchange>(`/api/auctions/${auctionId}/contact`, {
      method: 'POST',
      body: JSON.stringify({ contact }),
    }),
  /** Seller reads the winning bidder's escrowed contact note. */
  getSellerContact: (auctionId: string) =>
    request<ContactExchange>(`/api/auctions/${auctionId}/contact`),
  /** Winning bidder escrows their contact note (bid ID is the capability). */
  setWinnerContact: (auctionId: string, bidId: string, contact: string) =>
    request<ContactExchange>(`/api/auctions/${auctionId}/contact`, {
      method: 'POST',
      body: JSON.stringify({ contact, bid_id: bidId }),
    }),
  /** Winning bidder reads the seller's escrowed contact note. */
  claimContact: (auctionId: string, bidId: string) =>
    request<ContactExchange>(`/api/auctions/${auctionId}/contact/claim`, {
      method: 'POST',
      body: JSON.stringify({ bid_id: bidId }),
    }),
  closeAuction: (id: string) => request<Auction>(`/api/auctions/${id}/close`, { method: 'POST' }),
  settleAuction: (id: string) => request<SettleResponse>(`/api/auctions/${id}/settle`, { method: 'POST' }),

  /** Hosted wallet: address + ledger balance + faucet availability. */
  wallet: () => request<WalletView>('/api/wallet'),
  /** Claim regtest ZEC for this identity (cooldown enforced server-side). */
  faucet: () => request<FaucetResponse>('/api/wallet/faucet', { method: 'POST' }),
  /** Shielded send from the identity's hosted balance. */
  walletSend: (body: { to: string; amount_zec: string; memo?: string }) =>
    request<WalletMoveResponse>('/api/wallet/send', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Pay a registered bid to auctioneer escrow with the `bid:<id>` memo. */
  payBid: (bidId: string) =>
    request<WalletMoveResponse>(`/api/bids/${bidId}/pay`, { method: 'POST' }),
  /** Escrow a lot's collateral with the `collateral:<id>` memo. */
  payCollateral: (auctionId: string) =>
    request<WalletMoveResponse>(`/api/auctions/${auctionId}/collateral/pay`, { method: 'POST' }),
  /** Winner confirms delivery: releases the held seller proceeds + collateral. */
  confirmPayout: (auctionId: string, bidId: string) =>
    request<{ payout_state: string }>(`/api/auctions/${auctionId}/payout/confirm`, {
      method: 'POST',
      body: JSON.stringify({ bid_id: bidId }),
    }),
  /** Winner disputes delivery: FREEZES the payout and opens an evidence
   *  window (no money moves until an operator resolves or the digital
   *  auto-rule fires). */
  disputePayout: (auctionId: string, bidId: string, reason?: string) =>
    request<{ payout_state: string }>(`/api/auctions/${auctionId}/payout/dispute`, {
      method: 'POST',
      body: JSON.stringify({ bid_id: bidId, reason }),
    }),
  /** Seller submits delivery proof during a dispute (one-shot). */
  submitDeliveryProof: (auctionId: string, proof: string) =>
    request<{ delivery_proof: string }>(`/api/auctions/${auctionId}/payout/delivery-proof`, {
      method: 'POST',
      body: JSON.stringify({ proof }),
    }),
  /** Operator resolves a dispute: 'release' (to seller) or 'slash' (to winner). */
  resolvePayout: (auctionId: string, action: 'release' | 'slash') =>
    request<{ payout_state: string }>(`/api/auctions/${auctionId}/payout/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
};

export function zatsToZec(zats: number): string {
  return (zats / 1e8).toFixed(8);
}

export function zecToZats(zec: string): number {
  return Math.round(Number(zec) * 1e8);
}

export function shortId(id: string, keep = 8): string {
  return id.length > keep + 4 ? `${id.slice(0, keep)}…` : id;
}

/** zecblock.com link for a txid on the given network (null on regtest/unknown). */
export function explorerTxUrl(network: string | null, txid: string): string | null {
  if (network === 'mainnet') return `https://zecblock.com/tx/${txid}`;
  if (network === 'testnet') return `https://testnet.zecblock.com/tx/${txid}`;
  return null;
}

export function timeLeft(closesAt: number, now = Date.now() / 1000): string {
  const delta = Math.max(0, Math.floor(closesAt - now));
  const h = Math.floor(delta / 3600);
  const m = Math.floor((delta % 3600) / 60);
  const s = delta % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function isClosingSoon(closesAt: number, now = Date.now() / 1000): boolean {
  const delta = closesAt - now;
  return delta > 0 && delta < 600;
}

export function bidStoreKey(auctionId: string): string {
  return `bidshield:bid:${auctionId}`;
}

export function rememberBid(auctionId: string, bidId: string): void {
  try {
    localStorage.setItem(bidStoreKey(auctionId), bidId);
  } catch {
    /* private mode */
  }
}

export function recallBid(auctionId: string): string | null {
  try {
    return localStorage.getItem(bidStoreKey(auctionId));
  } catch {
    return null;
  }
}
