import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import { fetchNearPoolWorkerPolicy, type PartyRole, type VerifiedWorkerBinding } from "@air-otc/shared-types";
import { BrowserDealClient } from "./privacy-client.js";
import { connectedAccount, createNearWalletUi, signTokenChallenge, type NearWalletUi } from "./wallet.js";

const API_URL = import.meta.env.VITE_PRIVACY_API_URL ?? "http://127.0.0.1:8090";
const POOL_ID = import.meta.env.VITE_POOL_CONTRACT_ID ?? "airotc-hackathon-pool-20261023-25646d5e.testnet";
const NEAR_RPC_URL = import.meta.env.VITE_NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
const ALLOW_DEVELOPMENT_ATTESTATION = import.meta.env.VITE_ALLOW_UNVERIFIED_DEV_ATTESTATION === "true";
const EXPLORER = "https://testnet.nearblocks.io";

const DEPLOYMENT_TRANSACTIONS = [
  { label: "Pool contract deployed", hash: "HdtMh7AfnUcYh7AW9sKVmmNF2H7aGEvwZ84PnCApvrBw" },
  { label: "Pool initialized", hash: "A84u4kKxiDyDYM5zzZqzNccDYjfx1MKt7o2b1SaQ3QFJ" },
  { label: "Pool paused for TEE activation", hash: "HckYftByhoPaKkHcGwfWGqgkZ9uvMjvob48Zu4uNund6" },
] as const;

const ROLE_SCOPES: Record<PartyRole, string[]> = {
  BUYER: ["marketplace:read", "tickets:read", "tickets:write", "terms:submit", "pool:read", "pool:write", "delivery:read", "delivery:write", "withdrawals:write", "tokens:rotate", "tokens:revoke"],
  SELLER: ["marketplace:read", "marketplace:write", "tickets:read", "tickets:write", "terms:submit", "pool:read", "pool:write", "delivery:read", "delivery:write", "withdrawals:write", "tokens:rotate", "tokens:revoke"],
};

type TabId = "overview" | "marketplace" | "deals" | "agents" | "explorer";
type ServiceState = "checking" | "online" | "offline";
type PoolState = "loading" | "available" | "unavailable";
type IconName = "home" | "market" | "deals" | "agent" | "explorer" | "wallet" | "lock" | "copy" | "external" | "check" | "shield" | "search" | "menu" | "close" | "key" | "cube" | "activity" | "eye" | "arrow" | "refresh" | "chevron";

interface ListingRecord {
  listingRef: string;
  sellerHandle?: string;
  sellerId?: string;
  kind: "API_ACCESS" | "DIGITAL_ASSET" | "SERVICE" | "OTHER";
  tagHashes?: string[];
  status: "ACTIVE" | "CLOSED";
  createdAtNs: string;
}

interface TicketRecord {
  ticketRef: string;
  listingRef: string;
  buyerHandle?: string;
  sellerHandle?: string;
  buyerId?: string;
  sellerId?: string;
  status: "NEGOTIATING" | "TERMS_PENDING" | "FUNDED" | "DELIVERED" | "COMPLETED" | "CANCELLED";
  createdAtNs: string;
}

interface PoolConfig {
  version: string;
  owner_id: string;
  tee_worker_id: string;
  tee_measurement_hash: string;
  tee_encryption_key_hash: string;
  paused: boolean;
  pool_liability: string;
  latest_ledger_root: string;
  latest_ledger_sequence: string;
  min_deposit: string;
  max_withdrawal: string;
  max_withdrawal_per_window: string;
}

interface TokenIssue {
  token: string;
  tokenId: string;
  walletId: string;
  scopes: string[];
  roles: PartyRole[];
  policy: { maxWithdrawalAtomic: string; maxCumulativeWithdrawalAtomic: string };
  expiresAtNs: string;
  rotation: number;
}

const NAV_ITEMS: Array<{ id: TabId; label: string; icon: IconName }> = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "marketplace", label: "Marketplace", icon: "market" },
  { id: "deals", label: "Deals", icon: "deals" },
  { id: "agents", label: "Agents", icon: "agent" },
  { id: "explorer", label: "Explorer", icon: "explorer" },
];

export default function App() {
  const client = useMemo(() => new BrowserDealClient(API_URL, fetch, () => fetchNearPoolWorkerPolicy({
    rpcUrl: NEAR_RPC_URL,
    contractId: POOL_ID,
    allowDevelopment: ALLOW_DEVELOPMENT_ATTESTATION,
  })), []);
  const [activeTab, setActiveTab] = useState<TabId>(tabFromHash());
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [walletUi, setWalletUi] = useState<NearWalletUi | null>(null);
  const [accountId, setAccountId] = useState("");
  const [serviceState, setServiceState] = useState<ServiceState>("checking");
  const [poolState, setPoolState] = useState<PoolState>("loading");
  const [poolConfig, setPoolConfig] = useState<PoolConfig | null>(null);
  const [workerIdentity, setWorkerIdentity] = useState<{ workerId: string; encryptionKeyId: string; encryptionPublicKey: string } | null>(null);
  const [workerBinding, setWorkerBinding] = useState<VerifiedWorkerBinding | null>(null);
  const [listings, setListings] = useState<ListingRecord[]>([]);
  const [tickets, setTickets] = useState<TicketRecord[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [dealsLoading, setDealsLoading] = useState(false);
  const [tokenIssue, setTokenIssue] = useState<TokenIssue | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const onHash = () => setActiveTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void createNearWalletUi(POOL_ID).then((ui) => {
      setWalletUi(ui);
      void refreshWallet(ui.selector);
      ui.selector.store.observable.subscribe(() => { void refreshWallet(ui.selector); });
    }).catch((error: unknown) => setNotice(errorMessage(error)));
  }, []);

  useEffect(() => {
    void refreshPublicStatus();
  }, []);

  async function refreshWallet(selector: WalletSelector): Promise<void> {
    setAccountId(await connectedAccount(selector));
  }

  async function refreshPublicStatus(): Promise<void> {
    setServiceState("checking");
    setPoolState("loading");
    const [health, config, identity] = await Promise.allSettled([
      fetch(`${API_URL}/health`, { headers: { accept: "application/json" } }).then((response) => {
        if (!response.ok) throw new Error("Privacy API unavailable");
        return response.json();
      }),
      fetchPoolConfig(),
      client.identity(),
    ]);
    setServiceState(health.status === "fulfilled" ? "online" : "offline");
    if (config.status === "fulfilled") {
      setPoolConfig(config.value);
      setPoolState("available");
    } else {
      setPoolState("unavailable");
    }
    if (identity.status === "fulfilled") setWorkerIdentity(identity.value);
  }

  async function fetchPoolConfig(): Promise<PoolConfig> {
    const response = await fetch(NEAR_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "airotc-observer",
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: POOL_ID, method_name: "get_config", args_base64: "e30=" },
      }),
    });
    const value = await response.json() as { result?: { result?: number[] }; error?: { message?: string } };
    const bytes = value.result?.result;
    if (!response.ok || !bytes) throw new Error(value.error?.message ?? "Could not read the NEAR pool");
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as PoolConfig;
  }

  function navigate(tab: TabId): void {
    window.location.hash = tab;
    setActiveTab(tab);
    setMobileNavOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refreshMarketplace(): Promise<void> {
    setMarketLoading(true);
    try {
      const result = await client.listings() as { listings: ListingRecord[] };
      setListings(result.listings);
      setNotice("Marketplace data refreshed.");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setMarketLoading(false);
    }
  }

  async function refreshDeals(): Promise<void> {
    setDealsLoading(true);
    try {
      const result = await client.tickets() as { tickets: TicketRecord[] };
      setTickets(result.tickets);
      setNotice("Private deal index refreshed.");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setDealsLoading(false);
    }
  }

  async function verifyWorker(): Promise<void> {
    setNotice("Checking a fresh, nonce-bound TEE attestation…");
    setWorkerBinding(null);
    try {
      const binding = await client.verifyWorker();
      setWorkerBinding(binding);
      setNotice("TEE identity matches the worker approved by the NEAR contract.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function createToken(role: PartyRole, maxPerWithdrawal: string, maxCumulative: string, lifetimeDays: number): Promise<void> {
    if (!walletUi || !accountId) throw new Error("Connect a NEAR testnet wallet first.");
    const expiresAtNs = (BigInt(Date.now()) * 1_000_000n + BigInt(lifetimeDays) * 24n * 60n * 60n * 1_000_000_000n).toString();
    const challenge = await client.challenge({
      version: 1,
      walletId: accountId,
      roles: [role],
      scopes: ROLE_SCOPES[role],
      policy: {
        maxWithdrawalAtomic: nearToYocto(maxPerWithdrawal),
        maxCumulativeWithdrawalAtomic: nearToYocto(maxCumulative),
      },
      expiresAtNs,
    });
    const proof = await signTokenChallenge(walletUi.selector, challenge);
    const issue = await client.issue({ challengeId: challenge.challengeId, ...proof }) as TokenIssue;
    client.setToken(issue.token);
    setTokenIssue(issue);
    setHasToken(true);
    setNotice("MCP token created. Copy it now; AIR OTC does not store the raw secret.");
    void Promise.all([refreshMarketplace(), refreshDeals()]);
  }

  async function rotateToken(): Promise<void> {
    try {
      const issue = await client.rotate() as TokenIssue;
      setTokenIssue(issue);
      setHasToken(true);
      setNotice("Token rotated. The old token is invalid; copy the new secret now.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function revokeToken(): Promise<void> {
    try {
      await client.revoke();
      setTokenIssue(null);
      setHasToken(false);
      setListings([]);
      setTickets([]);
      setNotice("Token revoked. Its agent can no longer access AIR OTC.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  const poolLabel = poolState === "loading"
    ? "Reading pool state"
    : poolState === "unavailable"
      ? "Pool state unavailable"
      : poolConfig?.paused
        ? "Pool paused — TEE activation pending"
        : "Pool active";

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNavOpen ? "mobile-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /></div>
          <div><strong>AIR OTC</strong><small>Agent Market</small></div>
        </div>
        <nav className="primary-nav" aria-label="Primary navigation">
          <span className="nav-caption">Observatory</span>
          {NAV_ITEMS.map((item) => (
            <button key={item.id} className={activeTab === item.id ? "active" : ""} onClick={() => navigate(item.id)}>
              <Icon name={item.icon} /><span>{item.label}</span>{item.id === "agents" && hasToken && <span className="nav-live-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="network-card">
          <div className="network-heading"><span className={`status-dot ${serviceState === "online" ? "live" : ""}`} /><span>NEAR Testnet</span></div>
          <p>{poolLabel}</p>
          <button onClick={() => navigate("explorer")}>View network <Icon name="arrow" /></button>
        </div>
        <div className="sidebar-footer"><Icon name="shield" /><span>Private by design</span></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileNavOpen((open) => !open)} aria-label="Toggle navigation"><Icon name={mobileNavOpen ? "close" : "menu"} /></button>
          <div className="breadcrumbs"><span>AIR OTC</span><Icon name="chevron" /><strong>{NAV_ITEMS.find((item) => item.id === activeTab)?.label}</strong></div>
          <div className="topbar-actions">
            <div className="service-indicator"><span className={`status-dot ${serviceState === "online" ? "live" : ""}`} />{serviceState === "checking" ? "Checking services" : serviceState === "online" ? "Services live" : "Services offline"}</div>
            <button className="wallet-button" onClick={() => walletUi?.modal.show()}><Icon name="wallet" /><span>{accountId ? shorten(accountId, 20) : "Connect wallet"}</span></button>
          </div>
        </header>

        <main className="page">
          {notice && <Notice onClose={() => setNotice("")}>{notice}</Notice>}
          {activeTab === "overview" && <Overview listings={listings} tickets={tickets} hasToken={hasToken} poolConfig={poolConfig} serviceState={serviceState} onNavigate={navigate} />}
          {activeTab === "marketplace" && <Marketplace listings={listings} hasToken={hasToken} loading={marketLoading} onRefresh={refreshMarketplace} onCreateToken={() => navigate("agents")} />}
          {activeTab === "deals" && <Deals tickets={tickets} hasToken={hasToken} loading={dealsLoading} onRefresh={refreshDeals} onCreateToken={() => navigate("agents")} />}
          {activeTab === "agents" && <Agents accountId={accountId} issue={tokenIssue} hasToken={hasToken} onConnect={() => walletUi?.modal.show()} onCreate={createToken} onRotate={rotateToken} onRevoke={revokeToken} onDismissSecret={() => setTokenIssue(null)} />}
          {activeTab === "explorer" && <Explorer poolConfig={poolConfig} poolState={poolState} workerIdentity={workerIdentity} workerBinding={workerBinding} serviceState={serviceState} onRefresh={refreshPublicStatus} onVerify={verifyWorker} />}
        </main>
      </section>
    </div>
  );
}

function Overview({ listings, tickets, hasToken, poolConfig, serviceState, onNavigate }: { listings: ListingRecord[]; tickets: TicketRecord[]; hasToken: boolean; poolConfig: PoolConfig | null; serviceState: ServiceState; onNavigate: (tab: TabId) => void }) {
  const completed = tickets.filter((ticket) => ticket.status === "COMPLETED").length;
  return <div className="overview-stack">
    <section className="overview-hero">
      <div className="hero-glow" />
      <div className="hero-copy">
        <span className="eyebrow"><span className="eyebrow-dot" /> Private commerce infrastructure</span>
        <h1>Private markets,<br />operated by agents.</h1>
        <p>A human observatory for an agent-first OTC market. Discover encrypted listings, authorize scoped MCP access, and verify settlement on NEAR.</p>
        <div className="hero-actions"><button className="primary-button" onClick={() => onNavigate("agents")}><Icon name="key" />{hasToken ? "Manage agent" : "Create MCP token"}</button><button className="ghost-button" onClick={() => onNavigate("marketplace")}>Browse market <Icon name="arrow" /></button></div>
      </div>
      <div className="hero-orbit" aria-hidden="true">
        <div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" />
        <div className="orbit-core"><div className="brand-mark large"><span /><span /></div><small>AIR OTC</small></div>
        <div className="orbit-node node-one"><Icon name="agent" /></div><div className="orbit-node node-two"><Icon name="shield" /></div><div className="orbit-node node-three"><Icon name="cube" /></div>
      </div>
    </section>

    <section className="metric-grid">
      <MetricCard label="Open listings" value={hasToken ? String(listings.length) : "—"} note={hasToken ? "Available to this agent" : "Connect an agent token"} icon="market" />
      <MetricCard label="Observed deals" value={hasToken ? String(tickets.length) : "—"} note={hasToken ? `${completed} completed` : "Private to each party"} icon="deals" />
      <MetricCard label="Agent access" value={hasToken ? "Active" : "Not linked"} note={hasToken ? "Scoped MCP capability" : "Create in Agents"} icon="key" />
      <MetricCard label="Settlement pool" value={poolConfig ? (poolConfig.paused ? "Paused" : "Active") : "Checking"} note={poolConfig ? `Ledger sequence ${poolConfig.latest_ledger_sequence}` : "Reading NEAR testnet"} icon="cube" />
    </section>

    <section className="two-column-grid">
      <div className="panel">
        <PanelHeader eyebrow="Architecture" title="A verifiable trust chain" action={<span className="live-label"><span className={`status-dot ${serviceState === "online" ? "live" : ""}`} /> Testnet</span>} />
        <div className="trust-chain">
          <TrustStep number="01" icon="wallet" title="You authorize" text="Your wallet signs a role, expiry, and spending policy." />
          <div className="trust-connector" />
          <TrustStep number="02" icon="agent" title="Agents execute" text="Buyer and seller agents use MCP to negotiate and act." />
          <div className="trust-connector" />
          <TrustStep number="03" icon="shield" title="TEE decides" text="Exact terms and private balances are processed confidentially." />
          <div className="trust-connector" />
          <TrustStep number="04" icon="cube" title="NEAR settles" text="The public contract enforces roots and authorized withdrawals." />
        </div>
      </div>
      <div className="panel">
        <PanelHeader eyebrow="Control boundary" title="Built for humans and agents" />
        <div className="boundary-list">
          <BoundaryRow icon="eye" title="Humans observe" text="Browse, monitor, authorize, and verify from this dashboard." />
          <BoundaryRow icon="agent" title="Agents transact" text="Listings, tickets, terms, delivery, and settlement flow through MCP." />
          <BoundaryRow icon="lock" title="Private data stays hidden" text="Product details, exact terms, messages, and ledger balances remain encrypted." />
        </div>
      </div>
    </section>

    <section className="panel activity-panel">
      <PanelHeader eyebrow="Public evidence" title="Testnet deployment" action={<button className="text-button" onClick={() => onNavigate("explorer")}>Open explorer <Icon name="arrow" /></button>} />
      <div className="activity-list">{DEPLOYMENT_TRANSACTIONS.map((tx, index) => <TransactionRow key={tx.hash} {...tx} last={index === DEPLOYMENT_TRANSACTIONS.length - 1} />)}</div>
    </section>
  </div>;
}

function Marketplace({ listings, hasToken, loading, onRefresh, onCreateToken }: { listings: ListingRecord[]; hasToken: boolean; loading: boolean; onRefresh: () => Promise<void>; onCreateToken: () => void }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("ALL");
  const filtered = listings.filter((listing) => (kind === "ALL" || listing.kind === kind) && `${listing.kind} ${listing.listingRef} ${listing.sellerHandle ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="content-stack">
    <PageHeading eyebrow="Marketplace" title="Discover what agents can trade" description="Public metadata is visible here. Product details are encrypted for the parties and revealed only inside the deal flow." action={<button className="secondary-button" disabled={!hasToken || loading} onClick={() => { void onRefresh(); }}><Icon name="refresh" /> Refresh</button>} />
    <div className="observatory-note"><Icon name="eye" /><div><strong>Discovery only</strong><p>Copy a listing reference and give it to your buyer agent. Trades cannot be executed from this interface.</p></div></div>
    {hasToken && <div className="toolbar"><label className="search-field"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search kind, seller, or reference" /></label><select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Filter listing type"><option value="ALL">All products</option><option value="API_ACCESS">API access</option><option value="DIGITAL_ASSET">Digital assets</option><option value="SERVICE">Services</option><option value="OTHER">Other</option></select><span className="result-count">{filtered.length} {filtered.length === 1 ? "listing" : "listings"}</span></div>}
    {!hasToken ? <AccessEmpty title="Connect a scoped agent token" text="Marketplace access is capability protected. Create an MCP token from a connected NEAR wallet to browse." onAction={onCreateToken} /> : loading ? <CardSkeletons /> : filtered.length === 0 ? <EmptyState icon="market" title="No listings found" text="Your agent has access, but there are no matching active listings yet." /> : <div className="listing-grid">{filtered.map((listing) => <ListingCard key={listing.listingRef} listing={listing} />)}</div>}
  </div>;
}

function Deals({ tickets, hasToken, loading, onRefresh, onCreateToken }: { tickets: TicketRecord[]; hasToken: boolean; loading: boolean; onRefresh: () => Promise<void>; onCreateToken: () => void }) {
  const [status, setStatus] = useState("ALL");
  const filtered = tickets.filter((ticket) => status === "ALL" || ticket.status === status);
  return <div className="content-stack">
    <PageHeading eyebrow="Deals" title="Follow private deals, without handling them" description="This view shows status and opaque references for deals belonging to the connected agent. Negotiation and execution remain in MCP." action={<button className="secondary-button" disabled={!hasToken || loading} onClick={() => { void onRefresh(); }}><Icon name="refresh" /> Refresh</button>} />
    <div className="observatory-note"><Icon name="lock" /><div><strong>Private fields stay private</strong><p>Prices, collateral, terms, messages, private balances, and delivery contents do not appear in this dashboard.</p></div></div>
    {!hasToken ? <AccessEmpty title="No agent context" text="Create or rotate a token to view the deals available to that wallet and role." onAction={onCreateToken} /> : <>
      <div className="deal-filters">{["ALL", "NEGOTIATING", "TERMS_PENDING", "FUNDED", "DELIVERED", "COMPLETED", "CANCELLED"].map((value) => <button key={value} className={status === value ? "active" : ""} onClick={() => setStatus(value)}>{value === "ALL" ? "All" : statusLabel(value)}</button>)}</div>
      {loading ? <TableSkeleton /> : filtered.length === 0 ? <EmptyState icon="deals" title="No deals in this view" text="Deals created by the buyer or seller agent will appear here as read-only status records." /> : <div className="deal-table"><div className="deal-table-head"><span>Deal</span><span>Listing</span><span>Counterparties</span><span>Status</span><span>Created</span></div>{filtered.map((ticket) => <div className="deal-row" key={ticket.ticketRef}><div className="deal-reference"><Icon name="lock" /><code>{shorten(ticket.ticketRef, 18)}</code></div><code>{shorten(ticket.listingRef, 16)}</code><span>{shorten(ticket.buyerHandle ?? ticket.buyerId ?? "Private", 10)} ↔ {shorten(ticket.sellerHandle ?? ticket.sellerId ?? "Private", 10)}</span><StatusPill status={ticket.status} /><span>{formatNsDate(ticket.createdAtNs)}</span></div>)}</div>}
    </>}
  </div>;
}

function Agents({ accountId, issue, hasToken, onConnect, onCreate, onRotate, onRevoke, onDismissSecret }: { accountId: string; issue: TokenIssue | null; hasToken: boolean; onConnect: () => void; onCreate: (role: PartyRole, maxPerWithdrawal: string, maxCumulative: string, lifetimeDays: number) => Promise<void>; onRotate: () => Promise<void>; onRevoke: () => Promise<void>; onDismissSecret: () => void }) {
  const [role, setRole] = useState<PartyRole>("BUYER");
  const [maxWithdrawal, setMaxWithdrawal] = useState("1");
  const [maxCumulative, setMaxCumulative] = useState("5");
  const [lifetime, setLifetime] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); setBusy(true); setError(""); setCopied(false);
    try { await onCreate(role, maxWithdrawal, maxCumulative, lifetime); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function copySecret(): Promise<void> {
    if (!issue) return;
    await navigator.clipboard.writeText(issue.token);
    setCopied(true);
  }

  return <div className="content-stack">
    <PageHeading eyebrow="Agents" title="Issue the keys your agents operate with" description="Create a wallet-signed, role-scoped MCP token. You choose its permissions, limits, and lifetime before an agent can act." />
    <div className="agent-layout">
      <section className="panel agent-form-panel">
        <PanelHeader eyebrow="New capability" title="Create an MCP token" />
        {!accountId ? <AccessEmpty title="Connect a NEAR wallet" text="Your wallet signs the token grant so the platform cannot invent permissions on your behalf." actionLabel="Connect wallet" onAction={onConnect} /> : <form className="agent-form" onSubmit={(event) => { void submit(event); }}>
          <div className="connected-wallet"><span className="status-dot live" /><div><small>Authorizing wallet</small><code>{accountId}</code></div></div>
          <fieldset><legend>Agent role</legend><div className="role-cards"><button type="button" className={role === "BUYER" ? "selected" : ""} onClick={() => setRole("BUYER")}><Icon name="search" /><span><strong>Buyer agent</strong><small>Discover, negotiate, fund, and confirm</small></span><span className="radio" /></button><button type="button" className={role === "SELLER" ? "selected" : ""} onClick={() => setRole("SELLER")}><Icon name="market" /><span><strong>Seller agent</strong><small>List, negotiate, fund, and deliver</small></span><span className="radio" /></button></div></fieldset>
          <div className="form-grid"><label><span>Per-withdrawal limit</span><div className="unit-input"><input value={maxWithdrawal} onChange={(event) => setMaxWithdrawal(event.target.value)} inputMode="decimal" required /><b>NEAR</b></div></label><label><span>Cumulative limit</span><div className="unit-input"><input value={maxCumulative} onChange={(event) => setMaxCumulative(event.target.value)} inputMode="decimal" required /><b>NEAR</b></div></label><label><span>Token lifetime</span><select value={lifetime} onChange={(event) => setLifetime(Number(event.target.value))}><option value={1}>24 hours</option><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option></select></label></div>
          <div className="permission-block"><div><strong>Included permissions</strong><small>Fixed by the selected role</small></div><div className="scope-cloud">{ROLE_SCOPES[role].map((scope) => <span key={scope}>{scope}</span>)}</div></div>
          <button className="primary-button wide" disabled={busy}>{busy ? "Waiting for wallet…" : "Review and sign token"}<Icon name="arrow" /></button>
          {error && <p className="form-error">{error}</p>}
        </form>}
      </section>

      <aside className="agent-side">
        <section className="panel token-card">
          <PanelHeader eyebrow="Current secret" title={issue ? "Token ready" : hasToken ? "Token active" : "No active token"} />
          {issue ? <div className="token-details"><div className="token-meta"><span><small>Role</small><strong>{issue.roles.join(", ")}</strong></span><span><small>Expires</small><strong>{formatNsDate(issue.expiresAtNs)}</strong></span><span><small>Rotation</small><strong>{issue.rotation}</strong></span></div><div className={`secret-box ${copied ? "secret-copied" : ""}`}><Icon name={copied ? "check" : "key"} /><code>{copied ? "Copied — secret hidden" : issue.token}</code><button onClick={() => { void copySecret(); }} disabled={copied} aria-label="Copy token"><Icon name="copy" /></button></div><p className="secret-warning"><Icon name="lock" /> The raw token is held only in page memory. Copy it into your agent now.</p><div className="token-actions"><button className="secondary-button" onClick={() => { setCopied(false); void onRotate(); }}><Icon name="refresh" /> Rotate</button><button className="danger-button" onClick={() => { void onRevoke(); }}>Revoke</button><button className="text-button" onClick={onDismissSecret}>I saved it</button></div></div> : <div className="token-empty"><div className="token-icon"><Icon name="key" /></div><p>{hasToken ? "A token is active in this browser session. Its raw secret is hidden." : "Create a token to connect a buyer or seller agent through MCP."}</p>{hasToken && <div className="token-actions"><button className="secondary-button" onClick={() => { void onRotate(); }}><Icon name="refresh" /> Rotate</button><button className="danger-button" onClick={() => { void onRevoke(); }}>Revoke</button></div>}</div>}
        </section>
        <section className="security-note"><Icon name="shield" /><div><strong>Least-privilege access</strong><p>Every token is bound to one wallet, one role, exact scopes, spending limits, and an expiry.</p></div></section>
      </aside>
    </div>
  </div>;
}

function Explorer({ poolConfig, poolState, workerIdentity, workerBinding, serviceState, onRefresh, onVerify }: { poolConfig: PoolConfig | null; poolState: PoolState; workerIdentity: { workerId: string; encryptionKeyId: string; encryptionPublicKey: string } | null; workerBinding: VerifiedWorkerBinding | null; serviceState: ServiceState; onRefresh: () => Promise<void>; onVerify: () => Promise<void> }) {
  return <div className="content-stack">
    <PageHeading eyebrow="Explorer" title="Verify the public settlement boundary" description="Inspect the live NEAR contract, worker identity, and deployment evidence without exposing deal contents." action={<button className="secondary-button" onClick={() => { void onRefresh(); }}><Icon name="refresh" /> Refresh state</button>} />
    <section className="explorer-summary panel">
      <div><span className="eyebrow">Settlement readiness</span><h2>{poolState === "loading" ? "Reading testnet…" : poolState === "unavailable" ? "Testnet state unavailable" : poolConfig?.paused ? "Pool paused" : "Pool active"}</h2><p>{poolState === "unavailable" ? "The dashboard could not read the NEAR testnet contract. Refresh to try again." : poolConfig?.paused ? "The contract is safely paused while the hosted TEE identity is finalized. Deposits and worker settlement are disabled." : poolConfig ? "The pool is accepting contract operations from its registered worker." : "Reading the final contract state from NEAR testnet."}</p></div>
      <div className={`big-status ${workerBinding ? "verified" : poolConfig?.paused ? "pending" : "neutral"}`}><Icon name={workerBinding ? "check" : "shield"} /><span>{workerBinding ? "TEE attested" : poolConfig?.paused ? "Activation pending" : "Not verified"}</span></div>
      <div className="explorer-actions"><a className="primary-button" href={`${EXPLORER}/address/${POOL_ID}`} target="_blank" rel="noreferrer">Open NEAR explorer <Icon name="external" /></a><button className="secondary-button" onClick={() => { void onVerify(); }} disabled={serviceState !== "online"}>Verify fresh attestation</button></div>
    </section>

    <section className="explorer-grid">
      <div className="panel config-card"><PanelHeader eyebrow="NEAR contract" title="Shared private pool" action={<span className="network-chip">Testnet</span>} /><dl className="detail-list"><Detail label="Contract" value={POOL_ID} link={`${EXPLORER}/address/${POOL_ID}`} /><Detail label="Version" value={poolConfig?.version ?? "—"} /><Detail label="Status" value={poolConfig ? (poolConfig.paused ? "Paused" : "Active") : "Unavailable"} tone={poolConfig?.paused ? "warning" : undefined} /><Detail label="Pool liability" value={poolConfig ? `${formatNear(poolConfig.pool_liability)} NEAR` : "—"} /><Detail label="Ledger sequence" value={poolConfig?.latest_ledger_sequence ?? "—"} /><Detail label="Ledger root" value={poolConfig?.latest_ledger_root || "No roots anchored"} mono /></dl></div>
      <div className="panel config-card"><PanelHeader eyebrow="Confidential worker" title="TEE identity" action={workerBinding ? <span className="verified-chip"><Icon name="check" /> Attested</span> : undefined} /><dl className="detail-list"><Detail label="Worker account" value={poolConfig?.tee_worker_id ?? workerIdentity?.workerId ?? "—"} link={poolConfig?.tee_worker_id ? `${EXPLORER}/address/${poolConfig.tee_worker_id}` : undefined} /><Detail label="API identity" value={workerIdentity?.workerId ?? "Worker API offline"} /><Detail label="Encryption key ID" value={workerIdentity?.encryptionKeyId ?? "—"} mono /><Detail label="Measurement hash" value={poolConfig?.tee_measurement_hash ?? "—"} mono /><Detail label="Binding" value={workerBinding ? "Nonce-bound identity verified" : poolConfig?.paused ? "Pending hosted TEE activation" : "Not verified this session"} tone={workerBinding ? "verified" : "warning"} /></dl></div>
    </section>

    <section className="panel"><PanelHeader eyebrow="On-chain activity" title="Deployment transactions" /><div className="activity-list">{DEPLOYMENT_TRANSACTIONS.map((tx, index) => <TransactionRow key={tx.hash} {...tx} last={index === DEPLOYMENT_TRANSACTIONS.length - 1} />)}</div></section>
    <section className="privacy-grid"><div className="privacy-card private"><Icon name="lock" /><span className="eyebrow">Inside the TEE</span><h3>Private by default</h3><p>Product details, messages, exact terms, deal prices, collateral, balances, delivery contents, and deal-to-deposit links.</p></div><div className="privacy-card public"><Icon name="eye" /><span className="eyebrow">On NEAR</span><h3>Public and auditable</h3><p>Pool account, deposits, withdrawals, transaction timing, ledger roots, worker policy, contract state, and fees.</p></div></section>
  </div>;
}

function ListingCard({ listing }: { listing: ListingRecord }) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> { await navigator.clipboard.writeText(listing.listingRef); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
  return <article className="listing-card"><div className="listing-card-top"><span className="listing-kind"><Icon name={listing.kind === "API_ACCESS" ? "key" : listing.kind === "SERVICE" ? "agent" : "cube"} />{kindLabel(listing.kind)}</span><span className="status-pill matched">Active</span></div><h3>Encrypted {kindLabel(listing.kind).toLowerCase()}</h3><p className="listing-seller">Seller <code>{shorten(listing.sellerHandle ?? listing.sellerId ?? "Private seller", 18)}</code></p><div className="encrypted-preview"><Icon name="lock" /><div className="frosted-lines"><span /><span /><span /></div><small>Product details encrypted</small></div><div className="listing-tags">{(listing.tagHashes ?? []).slice(0, 2).map((tag) => <span key={tag}>#{shorten(tag, 7)}</span>)}{(listing.tagHashes?.length ?? 0) === 0 && <span>#private</span>}<span>#{kindLabel(listing.kind).toLowerCase().replace(" ", "-")}</span></div><footer><div><small>Listing reference</small><code>{shorten(listing.listingRef, 22)}</code></div><button onClick={() => { void copy(); }} aria-label="Copy listing reference"><Icon name={copied ? "check" : "copy"} /></button></footer></article>;
}

function MetricCard({ label, value, note, icon }: { label: string; value: string; note: string; icon: IconName }) { return <article className="metric-card"><div className="metric-icon"><Icon name={icon} /></div><div><span>{label}</span><strong>{value}</strong><small>{note}</small></div></article>; }
function PanelHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) { return <header className="panel-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>{action}</header>; }
function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) { return <header className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</header>; }
function TrustStep({ number, icon, title, text }: { number: string; icon: IconName; title: string; text: string }) { return <article className="trust-step"><span>{number}</span><div className="trust-icon"><Icon name={icon} /></div><div><strong>{title}</strong><p>{text}</p></div></article>; }
function BoundaryRow({ icon, title, text }: { icon: IconName; title: string; text: string }) { return <article className="boundary-row"><div><Icon name={icon} /></div><span><strong>{title}</strong><p>{text}</p></span></article>; }
function TransactionRow({ label, hash, last }: { label: string; hash: string; last: boolean }) { return <a className="transaction-row" href={`${EXPLORER}/txns/${hash}`} target="_blank" rel="noreferrer"><div className="transaction-track"><span className="transaction-icon"><Icon name={last ? "shield" : "check"} /></span>{!last && <i />}</div><div><strong>{label}</strong><code>{shorten(hash, 30)}</code></div><span className="transaction-network">NEAR <Icon name="external" /></span></a>; }
function StatusPill({ status }: { status: TicketRecord["status"] }) { return <span className={`status-pill ${statusClass(status)}`}>{statusLabel(status)}</span>; }
function Detail({ label, value, link, mono, tone }: { label: string; value: string; link?: string | undefined; mono?: boolean | undefined; tone?: "warning" | "verified" | undefined }) { const content = <span className={`${mono ? "mono" : ""} ${tone ?? ""}`}>{shorten(value, 32)}</span>; return <div><dt>{label}</dt><dd>{link ? <a href={link} target="_blank" rel="noreferrer">{content}<Icon name="external" /></a> : content}</dd></div>; }
function Notice({ children, onClose }: { children: ReactNode; onClose: () => void }) { return <div className="notice" role="status"><Icon name="activity" /><span>{children}</span><button onClick={onClose} aria-label="Dismiss"><Icon name="close" /></button></div>; }
function AccessEmpty({ title, text, actionLabel = "Create MCP token", onAction }: { title: string; text: string; actionLabel?: string; onAction: () => void }) { return <div className="empty-state access-empty"><div className="empty-icon"><Icon name="key" /></div><h3>{title}</h3><p>{text}</p><button className="primary-button" onClick={onAction}>{actionLabel}<Icon name="arrow" /></button></div>; }
function EmptyState({ icon, title, text }: { icon: IconName; title: string; text: string }) { return <div className="empty-state"><div className="empty-icon"><Icon name={icon} /></div><h3>{title}</h3><p>{text}</p></div>; }
function CardSkeletons() { return <div className="listing-grid" aria-label="Loading listings">{[1, 2, 3].map((item) => <div className="listing-card skeleton-card" key={item}><span /><span /><span /><span /></div>)}</div>; }
function TableSkeleton() { return <div className="deal-table skeleton-table" aria-label="Loading deals">{[1, 2, 3].map((item) => <div key={item}><span /><span /><span /><span /></div>)}</div>; }

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>,
    market: <><path d="M4 9v11h16V9M3 4h18l-2 5H5L3 4Z"/><path d="M8 9V4m8 5V4"/></>,
    deals: <><path d="M4 5h16v14H4z"/><path d="M8 9h8m-8 4h5m-5 3h7"/></>,
    agent: <><rect x="5" y="7" width="14" height="12" rx="3"/><path d="M9 11h.01M15 11h.01M9 15h6M12 7V3m-2 0h4"/></>,
    explorer: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5m-10-7 3-6-6 3 3 3Z"/></>,
    wallet: <><path d="M4 6h15a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h13"/><path d="M16 11h5v4h-5a2 2 0 0 1 0-4Z"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></>,
    external: <><path d="M14 4h6v6m0-6-9 9"/><path d="M18 13v7H4V6h7"/></>,
    check: <path d="m4 12 5 5L20 6"/>,
    shield: <><path d="M12 2 20 5v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5l8-3Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
    search: <><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
    key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9m-3 3 3 3m-6 0 3 3"/></>,
    cube: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 7 9 5 9-5v10l-9 5-9-5V7Zm9 5v10"/></>,
    activity: <path d="M3 12h4l2-7 4 14 2-7h6"/>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
  };
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function tabFromHash(): TabId { const value = window.location.hash.replace("#", "") as TabId; return NAV_ITEMS.some((item) => item.id === value) ? value : "overview"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Request failed"; }
function shorten(value: string, length: number): string { if (value.length <= length) return value; const left = Math.max(4, Math.ceil((length - 1) / 2)); const right = Math.max(4, Math.floor((length - 1) / 2)); return `${value.slice(0, left)}…${value.slice(-right)}`; }
function kindLabel(kind: ListingRecord["kind"]): string { return ({ API_ACCESS: "API access", DIGITAL_ASSET: "Digital asset", SERVICE: "Service", OTHER: "Other" })[kind]; }
function statusLabel(status: string): string { return ({ NEGOTIATING: "Negotiating", TERMS_PENDING: "Matched", FUNDED: "Funded", DELIVERED: "Delivered", COMPLETED: "Completed", CANCELLED: "Failed" } as Record<string, string>)[status] ?? status; }
function statusClass(status: TicketRecord["status"]): string { return ({ NEGOTIATING: "negotiating", TERMS_PENDING: "matched", FUNDED: "funded", DELIVERED: "delivered", COMPLETED: "completed", CANCELLED: "failed" })[status]; }
function formatNsDate(value: string): string { try { return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(Number(BigInt(value) / 1_000_000n)); } catch { return "—"; } }
function nearToYocto(value: string): string { if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?$/.test(value)) throw new Error("Enter a valid NEAR amount with up to 24 decimals."); const [whole = "0", fraction = ""] = value.split("."); return (BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, "0"))).toString(); }
function formatNear(value: string): string { try { const atomic = BigInt(value); const whole = atomic / 10n ** 24n; const fraction = (atomic % 10n ** 24n).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, ""); return fraction ? `${whole}.${fraction}` : whole.toString(); } catch { return "0"; } }
