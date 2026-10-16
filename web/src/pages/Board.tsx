import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  api,
  categoryLabel,
  CATEGORIES,
  isClosingSoon,
  timeLeft,
  zatsToZec,
  type Auction,
} from '../api';
import Countdown from '../components/Countdown';
import FlapText from '../components/FlapText';

export default function Board() {
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(() => Date.now() / 1000);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const list = await api.auctions();
      setAuctions(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      refresh();
      setNow(Date.now() / 1000);
    }, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const openLots = auctions.filter((a) => a.status === 'open' && a.closes_at > now);
  const nearest = openLots.length
    ? openLots.reduce((a, b) => (a.closes_at < b.closes_at ? a : b))
    : null;
  const q = search.trim().toLowerCase();
  const filtered = auctions.filter((a) => {
    if (categoryFilter !== 'all' && a.category !== categoryFilter) return false;
    if (!q) return true;
    return (
      a.title.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.category.toLowerCase().includes(q) ||
      a.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
  const usedCategories = [...new Set(auctions.map((a) => a.category))];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Auction board</h1>
          <p className="page-sub">
            Sealed-bid Vickrey lots. Bids are shielded ZEC payments escrowed by the auctioneer
            wallet; nothing about a bid is visible to other bidders until the hammer falls.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Close counter' : 'New lot'}
        </button>
      </div>

      {nearest && (
        <div className="monument-band">
          <div>
            <div className="label">Next departure</div>
            <div className="lot">{nearest.title}</div>
          </div>
          <div>
            <div className="label">Gate closes in</div>
            <div className={`countdown-monument${isClosingSoon(nearest.closes_at, now) ? ' urgent' : ''}`}>
              <Countdown closesAt={nearest.closes_at} id={nearest.id} />
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateLotPanel
          onCreated={(id) => {
            setShowCreate(false);
            navigate(`/auctions/${id}`);
          }}
        />
      )}

      {error && <div className="error-line">Board unreachable: {error}</div>}

      <div className="board-search" role="search">
        <label className="sr-only" htmlFor="board-search-input">
          Search lots
        </label>
        <input
          id="board-search-input"
          className="board-search-input"
          type="search"
          placeholder="Search lots — title, description, tag…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
        />
        {search && (
          <button
            type="button"
            className="board-search-clear"
            onClick={() => setSearch('')}
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {usedCategories.length > 1 && (
        <div className="chip-row" style={{ margin: '0 0 14px' }} role="group" aria-label="Filter by category">
          <button
            type="button"
            className={`chip${categoryFilter === 'all' ? ' active' : ''}`}
            onClick={() => setCategoryFilter('all')}
          >
            All
          </button>
          {usedCategories.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip${categoryFilter === c ? ' active' : ''}`}
              onClick={() => setCategoryFilter(c)}
            >
              {categoryLabel(c)}
            </button>
          ))}
        </div>
      )}

      <div className="board" role="table" aria-label="Live auctions">
        <div className="board-head" role="row">
          <span role="columnheader">Lot</span>
          <span role="columnheader">Reserve</span>
          <span role="columnheader">Closes in</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Gate</span>
        </div>
        {filtered.length === 0 && !error && (
          <div className="empty-board">
            <strong>{q ? 'No matching lots' : 'Board empty'}</strong>
            {q
              ? `Nothing matches “${search.trim()}”. Try a different term or clear the search.`
              : 'Open the counter and list the first lot — the chain is warm.'}
          </div>
        )}
        {filtered.map((a, i) => (
          <Link
            key={a.id}
            to={`/auctions/${a.id}`}
            className="board-row rows-enter"
            style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
            role="row"
          >
            <span className="lot-cell" role="cell">
              {a.images[0] && (
                <img className="lot-thumb" src={a.images[0]} alt="" loading="lazy" />
              )}
              <span>
                <span className="lot-name">{a.title}</span>
                <span className="badge-row">
                  <span className="badge">{categoryLabel(a.category)}</span>
                  {a.tags.map((t) => (
                    <span className="badge badge-dim" key={t}>
                      {t}
                    </span>
                  ))}
                  {a.bin_price_zats != null && <span className="badge badge-buy">Buy now</span>}
                  {a.has_hidden_reserve && <span className="badge badge-secret">Hidden floor</span>}
                </span>
                {a.description && <div className="lot-desc">{a.description}</div>}
              </span>
            </span>
            <span className="cell-mono" role="cell">
              <span className="col-label">Reserve</span>
              {zatsToZec(a.reserve_zats)} ZEC
            </span>
            <span role="cell">
              <span className="col-label">Closes</span>
              <Countdown closesAt={a.closes_at} id={a.id} stopped={a.status !== 'open'} />
            </span>
            <span role="cell">
              <span className="col-label">Status</span>
              <FlapText text={a.status} />
            </span>
            <span className="cell-mono" role="cell">
              {a.status === 'open' ? 'OPEN →' : 'VIEW →'}
            </span>
          </Link>
        ))}
      </div>
    </>
  );
}

const CLOSE_PRESETS = [
  { key: '5m', label: '5 min', secs: 5 * 60 },
  { key: '15m', label: '15 min', secs: 15 * 60 },
  { key: '1h', label: '1 hour', secs: 60 * 60 },
  { key: '4h', label: '4 hours', secs: 4 * 3600 },
  { key: '24h', label: '24 hours', secs: 24 * 3600 },
] as const;

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CreateLotPanel({ onCreated }: { onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [tagsRaw, setTagsRaw] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [newImage, setNewImage] = useState('');
  const [reserve, setReserve] = useState('0.20');
  const [hiddenReserve, setHiddenReserve] = useState('');
  const [binPrice, setBinPrice] = useState('');
  const [collateral, setCollateral] = useState('');
  const [payload, setPayload] = useState('');
  const [refundPolicy, setRefundPolicy] = useState('');
  const [sellerContact, setSellerContact] = useState('');
  const [deliveryKind, setDeliveryKind] = useState<'digital' | 'physical'>('digital');
  const [seller, setSeller] = useState('');
  const [preset, setPreset] = useState<string>('15m');
  const [closeLocal, setCloseLocal] = useState(() =>
    toLocalInput(new Date(Date.now() + 15 * 60_000)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeDate = new Date(closeLocal);
  const closeSec = Math.floor(closeDate.getTime() / 1000);
  const durationSecs = closeSec - Math.floor(Date.now() / 1000);
  const closeValid = Number.isFinite(closeSec) && durationSecs >= 30;
  const needsCollateral = Number(collateral) > 0;

  const pickPreset = (key: string, secs: number) => {
    setPreset(key);
    setCloseLocal(toLocalInput(new Date(Date.now() + secs * 1000)));
  };

  const addImage = () => {
    const u = newImage.trim();
    if (!u.startsWith('https://')) {
      setError('Image URLs must start with https://');
      return;
    }
    if (images.length >= 6) {
      setError('At most 6 images per lot.');
      return;
    }
    setImages([...images, u]);
    setNewImage('');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!closeValid) {
      setError('Closing time must be at least 30 seconds from now.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const tags = tagsRaw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const created = await api.createAuction({
        title: title.trim(),
        description: description.trim(),
        reserve_zec: reserve.trim(),
        duration_secs: durationSecs,
        seller_address: seller.trim(),
        images,
        category,
        tags,
        hidden_reserve_zec: hiddenReserve.trim() || undefined,
        bin_price_zec: binPrice.trim() || undefined,
        collateral_zec: collateral.trim() || undefined,
        delivery_payload: payload.trim() || undefined,
        refund_policy: refundPolicy.trim() || undefined,
        seller_contact: sellerContact.trim() || undefined,
        delivery_kind: deliveryKind,
      });
      setTitle('');
      setDescription('');
      setTagsRaw('');
      setImages([]);
      setHiddenReserve('');
      setBinPrice('');
      setCollateral('');
      setPayload('');
      setRefundPolicy('');
      setSellerContact('');
      setDeliveryKind('digital');
      onCreated(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2 className="panel-title">Counter — list a lot</h2>

      <div className="form-section-title">Public listing</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="lot-title">Lot title</label>
          <input
            id="lot-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Genesis WL spot · Tier 1"
            required
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor="lot-category">Category</label>
          <select
            id="lot-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="lot-tags">Tags (comma-separated)</label>
          <input
            id="lot-tags"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder="tier-1, kyc-free, gaming"
            maxLength={200}
          />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="lot-desc">Full description</label>
          <textarea
            id="lot-desc"
            className="textarea-tall"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={
              'What is being sold, condition, provenance, how delivery works.\nFor a wallet: what is inside, since when, any locked claims.\nFor a WL: project name, tier, registration mechanics.\nThis text is public forever.'
            }
            maxLength={4000}
          />
          <span className="field-hint">{description.length} / 4000 chars</span>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="lot-image">Image gallery (https URLs, max 6)</label>
          {images.length > 0 && (
            <div className="gallery-strip">
              {images.map((u, i) => (
                <div className="gallery-strip-item" key={`${u}-${i}`}>
                  <img src={u} alt={`Lot image ${i + 1}`} />
                  <button
                    type="button"
                    className="gallery-remove"
                    aria-label={`Remove image ${i + 1}`}
                    onClick={() => setImages(images.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="image-add-row">
            <input
              id="lot-image"
              value={newImage}
              onChange={(e) => setNewImage(e.target.value)}
              placeholder="https://i.imgur.com/… or IPFS gateway URL"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addImage();
                }
              }}
            />
            <button type="button" className="btn btn-small" onClick={addImage}>
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="form-section-title">Pricing</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="lot-reserve">Public reserve (ZEC)</label>
          <input id="lot-reserve" value={reserve} onChange={(e) => setReserve(e.target.value)} required />
          <span className="field-hint">Bidders see this floor.</span>
        </div>
        <div className="field">
          <label htmlFor="lot-hidden">Hidden reserve (ZEC, optional)</label>
          <input
            id="lot-hidden"
            value={hiddenReserve}
            onChange={(e) => setHiddenReserve(e.target.value)}
            placeholder="leave empty for none"
          />
          <span className="field-hint">
            Sealed floor: bidders only see that one exists. If the top sealed bid clears the public
            reserve but not this, the lot is not sold.
          </span>
        </div>
        <div className="field">
          <label htmlFor="lot-bin">Buy-it-now price (ZEC, optional)</label>
          <input
            id="lot-bin"
            value={binPrice}
            onChange={(e) => setBinPrice(e.target.value)}
            placeholder="leave empty for sealed-only"
          />
          <span className="field-hint">
            A confirmed payment at this price ends the Vickrey round immediately — the buyer pays
            exactly this, no second-price discount.
          </span>
        </div>
      </div>

      <div className="form-section-title">Trust &amp; delivery</div>
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>How the winner receives the goods</label>
          <div className="chip-row" role="radiogroup" aria-label="Delivery kind">
            <button
              type="button"
              className={`chip${deliveryKind === 'digital' ? ' active' : ''}`}
              onClick={() => setDeliveryKind('digital')}
              aria-pressed={deliveryKind === 'digital'}
            >
              Digital — payload / contact
            </button>
            <button
              type="button"
              className={`chip${deliveryKind === 'physical' ? ' active' : ''}`}
              onClick={() => setDeliveryKind('physical')}
              aria-pressed={deliveryKind === 'physical'}
            >
              Physical — shipping
            </button>
          </div>
          <span className="field-hint">
            Your proceeds and collateral are held until the winner confirms delivery, or until a
            deadline passes. Digital lots auto-release after 24h; physical lots after 7 days to
            allow for shipping.
          </span>
        </div>
        <div className="field">
          <label htmlFor="lot-collateral">Seller collateral (ZEC, optional)</label>
          <input
            id="lot-collateral"
            value={collateral}
            onChange={(e) => setCollateral(e.target.value)}
            placeholder="0 = none"
          />
          <span className="field-hint">
            Skin in the game: after listing, you&apos;ll be asked to escrow this amount with the
            auctioneer (one click from your hosted wallet, or a ZIP-321 invoice for an external
            wallet). Bids stay closed until it confirms; it is returned to you with your
            proceeds at settlement.
          </span>
        </div>
        <div className="field">
          <label htmlFor="lot-seller">Seller shielded UA (proceeds destination)</label>
          <input
            id="lot-seller"
            value={seller}
            onChange={(e) => setSeller(e.target.value)}
            placeholder="u1…"
            required
          />
          <span className="field-hint">
            A shielded UA you control — the auctioneer&apos;s escrow address is rejected. Winning
            proceeds (hammer price less Bidshield&apos;s commission) are paid here, sealed.
          </span>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="lot-payload">Delivery payload (optional — WL code, seed, invite…)</label>
          <textarea
            id="lot-payload"
            className="textarea-tall"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder="The secret the winner receives after settlement. Held server-side; only the winning bid ID can claim it."
            maxLength={4000}
          />
          <span className="field-hint">
            For WL spots and wallet sales: paste the registration code / seed here. Released only
            to the winning bid after the hammer falls — you lose access once delivered.
          </span>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="lot-refund-policy">Refund policy (optional — public on the listing)</label>
          <textarea
            id="lot-refund-policy"
            value={refundPolicy}
            onChange={(e) => setRefundPolicy(e.target.value)}
            placeholder="e.g. Full refund if the WL spot is not delivered within 72h of settlement."
            maxLength={500}
          />
          <span className="field-hint">
            Stated plainly to bidders before they commit. Bidshield cannot enforce it on-chain —
            it is a transparency promise, backed by your collateral rather than by code.
          </span>
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="lot-seller-contact">Contact note for the winner (optional — escrowed)</label>
          <input
            id="lot-seller-contact"
            value={sellerContact}
            onChange={(e) => setSellerContact(e.target.value)}
            placeholder="Telegram @handle, email, or Signal number"
            maxLength={300}
          />
          <span className="field-hint">
            Escrowed server-side and readable only by the winning bidder once the lot settles and
            sells. Never public. One-shot: it cannot be changed after the winner reads it.
          </span>
        </div>
      </div>

      <div className="form-section-title">Gate</div>
      <div className="form-grid">
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="lot-closes">Gate closes at</label>
          <div className="chip-row" role="group" aria-label="Closing time presets">
            {CLOSE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`chip${preset === p.key ? ' active' : ''}`}
                onClick={() => pickPreset(p.key, p.secs)}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              className={`chip${preset === 'custom' ? ' active' : ''}`}
              onClick={() => setPreset('custom')}
            >
              Custom
            </button>
          </div>
          <input
            id="lot-closes"
            type="datetime-local"
            step={60}
            value={closeLocal}
            min={toLocalInput(new Date(Date.now() + 30_000))}
            onChange={(e) => {
              setPreset('custom');
              setCloseLocal(e.target.value);
            }}
            required
          />
          <span className="field-hint">
            {closeValid
              ? `Closes ${closeDate.toLocaleString()} · in ${timeLeft(closeSec)} · bidding window stays open ${Math.max(1, Math.round(durationSecs / 60))} min`
              : 'Closing time must be at least 30 seconds from now.'}
          </span>
        </div>
      </div>

      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" type="submit" disabled={busy || !closeValid}>
          {busy ? 'Filing…' : 'Open the gate'}
        </button>
        {needsCollateral && (
          <span className="field-hint" style={{ alignSelf: 'center' }}>
            You&apos;ll pay the collateral invoice after listing — bids stay closed until it
            confirms.
          </span>
        )}
      </div>
      {error && <div className="error-line">{error}</div>}
    </form>
  );
}
