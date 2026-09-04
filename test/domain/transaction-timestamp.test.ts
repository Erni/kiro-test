import { Decimal } from 'decimal.js';

import { applyTransaction } from '../../src/domain/transactions';

import type { PortfolioState, Transaction, ValidTransactionInput } from '../../src/domain/types';

/**
 * Recording-time timestamp assignment (Req 2.9).
 *
 * The System, not the caller, supplies a Transaction's timestamp. That is not a
 * universal property so much as a single observable fact: the timestamp must
 * describe the instant at which the Transaction was recorded. The test pins it
 * down by bracketing the call with a "before" and an "after" reading of the
 * clock and asserting the assigned timestamp falls inside that window.
 *
 * `applyTransaction` accepts an injectable `now` hook, but injecting a fake
 * clock here would only prove the hook is wired up — it would not show that the
 * *default* behavior reads the real clock. So these tests deliberately call
 * `applyTransaction` with no options.
 *
 * Bounds are inclusive: timer resolution is coarse (on Windows `Date.now()`
 * advances in ~15ms steps), so all three readings routinely land on the same
 * millisecond. Strict comparisons would make this test flaky for no gain.
 */

/** An empty Portfolio: no Holdings, no Transactions. */
function emptyState(): PortfolioState {
  return { holdings: new Map(), transactions: [] };
}

/** A Portfolio holding `quantity` of `symbol`, so a Sell has something to reduce. */
function stateWithHolding(symbol: string, quantity: string): PortfolioState {
  return {
    holdings: new Map([
      [symbol, { symbol, quantity: new Decimal(quantity), currentPrice: new Decimal('30000') }],
    ]),
    transactions: [],
  };
}

/** Validated Transaction input, as the validators would have produced it. */
function transactionInput(
  symbol: string,
  type: 'Buy' | 'Sell',
  quantity: string,
  pricePerUnit: string,
): ValidTransactionInput {
  return {
    symbol,
    type,
    quantity: new Decimal(quantity),
    pricePerUnit: new Decimal(pricePerUnit),
  };
}

/**
 * Applies a Transaction against the real clock and returns it together with the
 * instants captured immediately before and after the call.
 */
function recordWithClockWindow(
  state: PortfolioState,
  input: ValidTransactionInput,
): { transaction: Transaction; before: number; after: number } {
  const before = Date.now();
  const result = applyTransaction(state, input);
  const after = Date.now();

  if (!result.ok) {
    throw new Error(`expected the transaction to be recorded but got: ${result.error.message}`);
  }

  return { transaction: result.value.transaction, before, after };
}

describe('applyTransaction timestamp assignment (Req 2.9)', () => {
  it('assigns a Buy transaction a timestamp at the moment it was recorded', () => {
    const { transaction, before, after } = recordWithClockWindow(
      emptyState(),
      transactionInput('BTC', 'Buy', '1.5', '30000'),
    );

    expect(transaction.timestamp).toBeInstanceOf(Date);
    expect(transaction.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(transaction.timestamp.getTime()).toBeLessThanOrEqual(after);
  });

  it('assigns a Sell transaction a timestamp at the moment it was recorded', () => {
    const { transaction, before, after } = recordWithClockWindow(
      stateWithHolding('BTC', '2'),
      transactionInput('BTC', 'Sell', '0.5', '31000'),
    );

    expect(transaction.timestamp).toBeInstanceOf(Date);
    expect(transaction.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(transaction.timestamp.getTime()).toBeLessThanOrEqual(after);
  });

  it('records the same timestamp on the Transaction appended to the new state', () => {
    const state = emptyState();
    const before = Date.now();
    const result = applyTransaction(state, transactionInput('ETH', 'Buy', '10', '2000'));
    const after = Date.now();

    if (!result.ok) {
      throw new Error(`expected the transaction to be recorded but got: ${result.error.message}`);
    }

    expect(result.value.state.transactions).toHaveLength(1);

    const appended = result.value.state.transactions[0];
    if (appended === undefined) {
      throw new Error('expected the transaction to be appended to the new state');
    }

    expect(appended.timestamp.getTime()).toBe(result.value.transaction.timestamp.getTime());
    expect(appended.timestamp.getTime()).toBeGreaterThanOrEqual(before);
    expect(appended.timestamp.getTime()).toBeLessThanOrEqual(after);
  });
});
