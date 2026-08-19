// ─────────────────────────────────────────────────────────────────────────────
// BROKER SIMULATOR  (v1.0.0)
//
// A deterministic fake broker that replaces angelOneTrading.ts and
// binanceTrading.ts during testing. Produces realistic responses,
// delays, partial fills, rejections, and timeouts without touching
// the real network.
//
// Design:
//   • Implements the exact same function signatures as the real broker clients
//   • Controlled by a SimulatorConfig — tests inject scenarios explicitly
//   • All state is in-memory — no AsyncStorage, no network
//   • Resets cleanly between tests via reset()
//   • Every call is logged to SimulatorCallLog for test assertions
//
// Scenarios supported:
//   SUCCESS          → order fills at requestedPrice after fillDelayMs
//   PARTIAL_FILL     → fills partialFillPct of qty, remainder stays open
//   REJECTION        → broker rejects order immediately (bad symbol, etc.)
//   TIMEOUT          → order placed but waitForFill times out
//   NETWORK_ERROR    → connection error before broker receives order
//   ACK_THEN_TIMEOUT → broker acknowledges but fill never arrives
//
// Usage in tests:
//   import { simulator, SimulatorScenario } from '../brokerSimulator';
//   simulator.configure({ scenario: 'REJECTION', rejectReason: 'Insufficient funds' });
//   await expect(placeLiveOrder(req)).rejects.toThrow('Insufficient funds');
//   expect(simulator.callLog).toHaveLength(1);
//   simulator.reset();
// ─────────────────────────────────────────────────────────────────────────────

import type { AOSession }           from '../api/angelOne';
import type { AOPlaceOrderParams, AOOrderResponse, AOOrderStatus, AOPosition }
  from '../api/angelOneTrading';
import type { BinancePlaceOrderParams, BinanceOrderResponse, BinanceOrderStatus }
  from '../api/binanceTrading';

// ── Configuration ─────────────────────────────────────────────────────────────

export type SimulatorScenario =
  | 'SUCCESS'
  | 'PARTIAL_FILL'
  | 'REJECTION'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'ACK_THEN_TIMEOUT'
  | 'DUPLICATE_REJECTED';

export type SimulatorConfig = {
  scenario:         SimulatorScenario;
  fillDelayMs:      number;     // how long until fill arrives
  fillPrice:        number;     // price at which order fills
  partialFillPct:   number;     // 0–1, only used by PARTIAL_FILL
  rejectReason:     string;     // only used by REJECTION
  openPositions:    AOPosition[]; // positions returned by getPositions
};

const DEFAULT_CONFIG: SimulatorConfig = {
  scenario:       'SUCCESS',
  fillDelayMs:    50,
  fillPrice:      100.00,
  partialFillPct: 0.5,
  rejectReason:   'Insufficient funds',
  openPositions:  [],
};

// ── Call log entry ─────────────────────────────────────────────────────────────

export type SimulatorCall = {
  fn:        string;
  params:    Record<string, any>;
  result:    'success' | 'error' | 'timeout';
  error?:    string;
  calledAt:  number;
};

// ── Order registry — tracks placed orders ─────────────────────────────────────

type SimulatedOrder = {
  orderId:           string;
  clientOrderId:     string;
  symbol:            string;
  side:              string;
  qty:               number;
  requestedPrice:    number;
  filledQty:         number;
  filledPrice:       number;
  status:            'NEW' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED' | 'REJECTED';
};

// ── Simulator class ────────────────────────────────────────────────────────────

class BrokerSimulator {
  private config: SimulatorConfig = { ...DEFAULT_CONFIG };
  private orders: Map<string, SimulatedOrder> = new Map();
  private nextOrderId = 1000;
  callLog: SimulatorCall[] = [];

  configure(overrides: Partial<SimulatorConfig>): void {
    this.config = { ...DEFAULT_CONFIG, ...overrides };
  }

  reset(): void {
    this.config    = { ...DEFAULT_CONFIG };
    this.orders    = new Map();
    this.nextOrderId = 1000;
    this.callLog   = [];
  }

  private log(fn: string, params: Record<string, any>, result: 'success' | 'error' | 'timeout', error?: string): void {
    this.callLog.push({ fn, params, result, error, calledAt: Date.now() });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  private nextId(): string {
    return String(this.nextOrderId++);
  }

  // ── Angel One API surface ──────────────────────────────────────────────────

  async aoPlaceOrder(params: AOPlaceOrderParams, _session: AOSession): Promise<AOOrderResponse> {
    const p = { fn: 'aoPlaceOrder', symbol: params.tradingsymbol, side: params.transactiontype, qty: params.quantity };

    if (this.config.scenario === 'NETWORK_ERROR') {
      this.log('aoPlaceOrder', p, 'error', 'Network error');
      throw new Error('Network error: unable to reach Angel One');
    }

    if (this.config.scenario === 'REJECTION') {
      this.log('aoPlaceOrder', p, 'error', this.config.rejectReason);
      throw new Error(this.config.rejectReason);
    }

    // Duplicate client order ID check
    if (params.uniqueorderid) {
      for (const [, o] of this.orders) {
        if (o.clientOrderId === params.uniqueorderid) {
          if (this.config.scenario === 'DUPLICATE_REJECTED') {
            this.log('aoPlaceOrder', p, 'error', 'Duplicate order');
            throw new Error('Order already exists with this uniqueorderid');
          }
        }
      }
    }

    const orderId = this.nextId();
    const order: SimulatedOrder = {
      orderId,
      clientOrderId:  params.uniqueorderid ?? orderId,
      symbol:         params.tradingsymbol,
      side:           params.transactiontype,
      qty:            params.quantity,
      requestedPrice: params.price,
      filledQty:      0,
      filledPrice:    0,
      status:         'NEW'};
    this.orders.set(orderId, order);
    this.log('aoPlaceOrder', p, 'success');

    return { orderId, uniqueOrderId: order.clientOrderId, script: params.tradingsymbol };
  }

  async aoWaitForFill(orderId: string, _session: AOSession, timeoutMs = 30_000): Promise<AOOrderStatus> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found in simulator`);

    if (this.config.scenario === 'TIMEOUT' || this.config.scenario === 'ACK_THEN_TIMEOUT') {
      // Simulate waiting until timeout
      await this.delay(Math.min(timeoutMs + 10, 100));
      this.log('aoWaitForFill', { orderId }, 'timeout');
      throw new Error(`Order ${orderId} did not fill within ${timeoutMs / 1000}s`);
    }

    await this.delay(this.config.fillDelayMs);

    if (this.config.scenario === 'PARTIAL_FILL') {
      order.filledQty   = Math.floor(order.qty * this.config.partialFillPct);
      order.filledPrice = this.config.fillPrice;
      order.status      = 'PARTIALLY_FILLED';
    } else {
      order.filledQty   = order.qty;
      order.filledPrice = this.config.fillPrice;
      order.status      = 'FILLED';
    }

    this.log('aoWaitForFill', { orderId }, 'success');
    return {
      orderId,
      status:          order.status === 'FILLED' ? 'complete' : 'open',
      filledQty:       order.filledQty,
      unfilledQty:     order.qty - order.filledQty,
      avgFillPrice:    order.filledPrice,
      orderType:       'MARKET',
      transactionType: order.side};
  }

  async aoCancelOrder(orderId: string, _variety: string, _session: AOSession): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    order.status = 'CANCELED';
    this.log('aoCancelOrder', { orderId }, 'success');
  }

  async aoGetOrderStatus(orderId: string, _session: AOSession): Promise<AOOrderStatus | null> {
    const order = this.orders.get(orderId);
    if (!order) return null;
    return {
      orderId,
      status:          order.status === 'FILLED' ? 'complete' : order.status === 'CANCELED' ? 'cancelled' : 'pending',
      filledQty:       order.filledQty,
      unfilledQty:     order.qty - order.filledQty,
      avgFillPrice:    order.filledPrice,
      orderType:       'MARKET',
      transactionType: order.side};
  }

  async aoGetPositions(_session: AOSession): Promise<AOPosition[]> {
    this.log('aoGetPositions', {}, 'success');
    return this.config.openPositions;
  }

  // ── Binance API surface ────────────────────────────────────────────────────

  async bnPlaceOrder(params: BinancePlaceOrderParams, _apiKey: string, _secret: string): Promise<BinanceOrderResponse> {
    const p = { fn: 'bnPlaceOrder', symbol: params.symbol, side: params.side, qty: params.quantity };

    if (this.config.scenario === 'NETWORK_ERROR') {
      this.log('bnPlaceOrder', p, 'error', 'Network error');
      throw new Error('Network error: unable to reach Binance');
    }

    if (this.config.scenario === 'REJECTION') {
      this.log('bnPlaceOrder', p, 'error', this.config.rejectReason);
      throw new Error(`Binance ${params.symbol} 400: ${this.config.rejectReason}`);
    }

    // Duplicate newClientOrderId check
    if (params.newClientOrderId) {
      for (const [, o] of this.orders) {
        if (o.clientOrderId === params.newClientOrderId) {
          if (this.config.scenario === 'DUPLICATE_REJECTED') {
            this.log('bnPlaceOrder', p, 'error', 'Duplicate clientOrderId');
            throw new Error('Binance /api/v3/order -2010: duplicate order');
          }
        }
      }
    }

    const orderId = this.nextOrderId++;
    const isMarket = params.type === 'MARKET';
    const order: SimulatedOrder = {
      orderId:        String(orderId),
      clientOrderId:  params.newClientOrderId ?? String(orderId),
      symbol:         params.symbol,
      side:           params.side,
      qty:            params.quantity,
      requestedPrice: params.price ?? this.config.fillPrice,
      filledQty:      0,
      filledPrice:    0,
      status:         'NEW'};
    this.orders.set(String(orderId), order);

    if (this.config.scenario === 'NETWORK_ERROR') {
      this.log('bnPlaceOrder', p, 'error');
      throw new Error('Network error');
    }

    // Market orders: fill immediately in response
    if (isMarket && this.config.scenario === 'SUCCESS') {
      order.filledQty   = order.qty;
      order.filledPrice = this.config.fillPrice;
      order.status      = 'FILLED';
    }

    this.log('bnPlaceOrder', p, 'success');
    return {
      orderId,
      clientOrderId:       order.clientOrderId,
      symbol:              params.symbol,
      status:              order.status,
      executedQty:         order.filledQty,
      cummulativeQuoteQty: order.filledQty * order.filledPrice,
      fills:               order.filledQty > 0 ? [{
        price:      String(order.filledPrice),
        qty:        String(order.filledQty),
        commission: String(order.filledQty * order.filledPrice * 0.001)}] : []};
  }

  async bnWaitForFill(symbol: string, orderId: number, _ak: string, _sec: string, timeoutMs = 30_000): Promise<BinanceOrderStatus> {
    const order = this.orders.get(String(orderId));
    if (!order) throw new Error(`Order ${orderId} not found`);

    if (this.config.scenario === 'TIMEOUT' || this.config.scenario === 'ACK_THEN_TIMEOUT') {
      await this.delay(Math.min(timeoutMs + 10, 100));
      this.log('bnWaitForFill', { orderId }, 'timeout');
      throw new Error(`Order ${orderId} did not fill within ${timeoutMs / 1000}s`);
    }

    await this.delay(this.config.fillDelayMs);

    if (order.status !== 'FILLED') {
      const fillQty = this.config.scenario === 'PARTIAL_FILL'
        ? Math.floor(order.qty * this.config.partialFillPct)
        : order.qty;
      order.filledQty   = fillQty;
      order.filledPrice = this.config.fillPrice;
      order.status      = fillQty === order.qty ? 'FILLED' : 'PARTIALLY_FILLED';
    }

    this.log('bnWaitForFill', { orderId }, 'success');
    return {
      orderId,
      symbol,
      status:       order.status === 'FILLED' ? 'FILLED' : 'PARTIALLY_FILLED',
      executedQty:  order.filledQty,
      avgFillPrice: order.filledPrice,
      side:         order.side as any,
      type:         'MARKET'};
  }

  async bnCancelOrder(_sym: string, orderId: number, _ak: string, _sec: string): Promise<void> {
    const order = this.orders.get(String(orderId));
    if (!order) throw new Error(`Order ${orderId} not found`);
    order.status = 'CANCELED';
    this.log('bnCancelOrder', { orderId }, 'success');
  }

  async bnGetBalances(_ak: string, _sec: string): Promise<{ asset: string; free: number; locked: number }[]> {
    this.log('bnGetBalances', {}, 'success');
    // Return balances that match open positions
    return this.config.openPositions.map(p => ({
      asset:  p.tradingsymbol.replace(/USDT$|BUSD$/, ''),
      free:   Math.abs(p.netqty),
      locked: 0}));
  }

  async bnCancelAllOrders(_sym: string, _ak: string, _sec: string): Promise<void> {
    this.log('bnCancelAllOrders', { symbol: _sym }, 'success');
    for (const [, o] of this.orders) o.status = 'CANCELED';
  }

  // ── Inspection helpers (for test assertions) ───────────────────────────────

  getOrder(orderId: string): SimulatedOrder | undefined {
    return this.orders.get(orderId);
  }

  getAllOrders(): SimulatedOrder[] {
    return Array.from(this.orders.values());
  }

  totalOrderCount(): number {
    return this.orders.size;
  }
}

// Singleton — tests import this directly
export const simulator = new BrokerSimulator();
