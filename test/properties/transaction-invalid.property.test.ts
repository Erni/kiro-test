import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { ValidationError } from '../../src/domain/errors';
import { MAX_DECIMAL_PLACES } from '../../src/domain/types';
import type { Holding, PortfolioState, Transaction } from '../../src/domain/types';
import type { PortfolioRepository } from '../../src/persistence/portfolioRepository';
import { PortfolioService } from '../../src/service/portfolioService';

/**
 * Property 11: Invalid transactions are always rejected without side effects
 * (Requirements 2.5, 2.6).
 *
 * For any Transaction input where the Transaction_Type is neither "Buy" nor
 * "Sell", or the quantity is `<= 0`, or the price per unit is `< 0`, the
 * Transaction is rejected with a validation error and the Portfolio is left
 * unchanged.
 *
 * The submission goes through a real `PortfolioService` rather than
 * `validateTransactionInput` alone, because "without side effects" is a claim
 * about the System's observable state, not about what a pure validator returns.
 * The service is given a recording repository, so each run can assert the
 * stronger fact that nothing was persisted at all: a rejected Transaction must
 * not reach `save()`, and the Portfolio the next read is served from must be the
 * one that was there before.
 *
 * Every run targets a symbol that *is* already held, with a quantity large
 * enough that a Buy or a Sell of the generated quantity would go through. That
 * is deliberate: if the validator wrongly accepted one of these inputs, the
 * Transaction would then be applied and the Holding's quantity would move, so
 * the "unchanged" assertions have something to catch rather than being trivially
 * satisfied by a rejection further down the pipeline (Req 2.4's
 * insufficient-quantity path).
 *
 * One to three of the three constrained fields are corrupted per run, with the
 * remaining fields generated inside their valid ranges. That keeps every run
 * attributable: the reported field must be one of the fields deliberately made
 * invalid, so a validator that rejected everything with a fixed message — or
 * rejected a *valid* neighbouring field — would fail rather than pass by
 * accident. The symbol is always left valid, since a malformed symbol is
 * Req 1.11's concern and Property 3 already covers it.
 *
 * A Transaction's quantity and price per unit are deliberately *unbounded* above
 * (Req 2.6 constrains only the sign), unlike a Holding's. So no "above
 * 1,000,000,000,000" or "more than 8 decimal places" value appears among the
 * invalid generators here: those are perfectly valid Transaction values, and
 * generating them as violations would assert the opposite of the requirement.
 *
 * Values are generated and compared as decimal *strings*, never routed through a
 * JavaScript number, so a generated "just below zero" value really is below zero
 * rather than a float that rounded onto it.
 */

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** How many Holdings the Portfolio is seeded with. */
const SEEDED_HOLDINGS = 3;

/**
 * Quantity every seeded Holding carries: comfortably above any generated
 * Transaction quantity, so a Sell that slipped past validation would succeed and
 * visibly change the Portfolio instead of being stopped by Req 2.4.
 */
const SEEDED_QUANTITY = '999999999999';

/** The Transaction fields Req 2.5 / 2.6 constrain, any of which may be corrupted. */
type Field = 'type' | 'quantity' | 'pricePerUnit';

const FIELDS: readonly Field[] = ['type', 'quantity', 'pricePerUnit'];

/**
 * Decimal strings with up to 8 decimal places, biased towards small everyday
 * values and towards the extremes. Used for the fields a given run leaves valid,
 * and as the magnitude a negative value is derived from.
 *
 * `positive` additionally guarantees `> 0`, as a Transaction quantity requires
 * (Req 2.6).
 */
function decimalStrings(bound: 'positive' | 'nonNegative'): fc.Arbitrary<string> {
  const whole = fc.oneof(
    fc.bigInt({ min: 0n, max: 1000n }),
    fc.bigInt({ min: 0n, max: 1_000_000n }),
    fc.constantFrom(0n, 1n, 1_000_000n),
  );
  const fraction = fc.oneof(
    fc.integer({ min: 0, max: MAX_FRACTION }),
    fc.constantFrom(0, 1, MAX_FRACTION),
  );

  return fc.tuple(whole, fraction).map(([units, hundredMillionths]) => {
    if (units === 0n && hundredMillionths === 0) {
      return bound === 'positive' ? '0.00000001' : '0';
    }
    if (hundredMillionths === 0) {
      return units.toString();
    }
    return `${units}.${String(hundredMillionths).padStart(MAX_DECIMAL_PLACES, '0')}`;
  });
}

/** Symbols matching `[A-Z0-9]{1,10}` (Req 1.11). */
const symbolArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SYMBOL_CHARS), { minLength: 1, maxLength: 10 })
  .map((characters) => characters.join(''));

/**
 * Transaction_Types Req 2.5 rejects: anything that is not exactly `"Buy"` or
 * exactly `"Sell"`.
 *
 * Casing variants are generated explicitly because they are the likeliest way
 * for the rule to be implemented too loosely — a case-insensitive comparison
 * would accept `"buy"`, which Req 2.5 does not. Surrounding whitespace is
 * included for the same reason: `" Buy"` is not the literal the requirement
 * names. Free-form words are filtered against the two accepted literals so a run
 * can never generate a *valid* type and expect a rejection.
 */
const invalidTypeArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'buy',
    'BUY',
    'bUy',
    'sell',
    'SELL',
    'sEll',
    'Buy ',
    ' Buy',
    'Sell ',
    ' Sell',
    'Buys',
    'Sells',
    'Bu',
    'Sel',
    '',
    ' ',
    'Hold',
    'Transfer',
    'buy/sell',
    'Buy,Sell',
    '0',
    '1',
  ),
  fc.string().filter((value) => value !== 'Buy' && value !== 'Sell'),
  symbolArbitrary.filter((value) => value !== 'Buy' && value !== 'Sell'),
);

/**
 * Quantities Req 2.6 rejects: `<= 0`.
 *
 * Zero is generated in several textual forms because `'0.00000000'` and `'0'`
 * are the same value but different strings, and only a parse-then-compare
 * implementation treats them alike. `'-0'` is deliberately absent: it is not
 * `< 0`, so it belongs to the boundary unit tests rather than here.
 */
const invalidQuantityArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('0', '0.0', '0.00000000', '0.000000000000', '-0.00000001', '-1'),
  decimalStrings('positive').map((magnitude) => `-${magnitude}`),
);

/**
 * Prices per unit Req 2.6 rejects: `< 0`. Zero is *valid* for a price, so it is
 * deliberately absent here.
 */
const invalidPriceArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('-0.00000001', '-1', '-0.5'),
  decimalStrings('positive').map((magnitude) => `-${magnitude}`),
);

/** The submitted Transaction plus the fields that were deliberately corrupted. */
interface Submission {
  readonly input: {
    readonly symbol: string;
    readonly type: string;
    readonly quantity: string;
    readonly pricePerUnit: string;
  };
  readonly invalidFields: readonly Field[];
}

/**
 * A Portfolio to submit against, plus an invalid Transaction submission.
 *
 * The Portfolio is seeded with Holdings *and* Transactions, so "unchanged"
 * covers the Transaction history as well as the Holdings — a rejected submission
 * that nonetheless appended to the history would be caught.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, {
      minLength: SEEDED_HOLDINGS,
      maxLength: SEEDED_HOLDINGS,
    }),
    prices: fc.array(decimalStrings('nonNegative'), {
      minLength: SEEDED_HOLDINGS,
      maxLength: SEEDED_HOLDINGS,
    }),
    targetIndex: fc.nat({ max: SEEDED_HOLDINGS - 1 }),
    corrupt: fc.uniqueArray(fc.constantFrom(...FIELDS), { minLength: 1, maxLength: FIELDS.length }),
    validType: fc.constantFrom('Buy', 'Sell'),
    validQuantity: decimalStrings('positive'),
    validPrice: decimalStrings('nonNegative'),
    badType: invalidTypeArbitrary,
    badQuantity: invalidQuantityArbitrary,
    badPrice: invalidPriceArbitrary,
  })
  .map((generated) => {
    const holdings = new Map<string, Holding>();
    const transactions: Transaction[] = [];

    generated.symbols.forEach((symbol, index) => {
      const price = generated.prices[index] as string;
      holdings.set(symbol, {
        symbol,
        quantity: new Decimal(SEEDED_QUANTITY),
        currentPrice: new Decimal(price),
      });
      transactions.push({
        id: `seed-${index}`,
        symbol,
        type: 'Buy',
        quantity: new Decimal(SEEDED_QUANTITY),
        pricePerUnit: new Decimal(price),
        timestamp: new Date(Date.UTC(2024, 0, 1) + index * 60_000),
      });
    });

    const invalidFields = generated.corrupt;
    const submission: Submission = {
      input: {
        symbol: generated.symbols[generated.targetIndex] as string,
        type: invalidFields.includes('type') ? generated.badType : generated.validType,
        quantity: invalidFields.includes('quantity')
          ? generated.badQuantity
          : generated.validQuantity,
        pricePerUnit: invalidFields.includes('pricePerUnit')
          ? generated.badPrice
          : generated.validPrice,
      },
      invalidFields,
    };

    return {
      state: { holdings, transactions } as PortfolioState,
      symbols: generated.symbols,
      submission,
    };
  });

/**
 * A repository that records every `save()` instead of writing anywhere.
 *
 * A rejected Transaction must never reach persistence, so the recording is the
 * assertion: an empty log is the observable form of "no side effects". `load()`
 * is unreachable here — the service is constructed with its initial state
 * directly, exactly as startup does after loading once (Req 5.3).
 */
class RecordingRepository implements PortfolioRepository {
  readonly saves: PortfolioState[] = [];

  async load(): Promise<PortfolioState> {
    throw new Error('load() is not part of this property');
  }

  async save(state: PortfolioState): Promise<void> {
    this.saves.push(state);
  }
}

describe('recordTransaction with invalid input', () => {
  // Feature: crypto-portfolio-core, Property 11: Invalid transactions are always rejected without side effects
  it('rejects the Transaction with a field-level validation error and leaves the Portfolio unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ state, symbols, submission }) => {
        const repository = new RecordingRepository();
        const service = new PortfolioService(repository, state);

        const before = holdingsSnapshot([...state.holdings.values()]);
        const historiesBefore = symbols.map((symbol) => historySnapshot(state, symbol));

        const result = await service.recordTransaction(submission.input);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }

        // A validation error, naming one of the fields this run made invalid,
        // with a message the HTTP layer can surface as-is (Req 2.5, 2.6).
        const error = result.error;
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.kind).toBe('ValidationError');
        const field = (error as ValidationError).field;
        expect(submission.invalidFields).toContain(field);
        expect(error.message).toMatch(new RegExp(`^${field}: \\S`));

        // Nothing persisted: the rejection happened before the write path.
        expect(repository.saves).toEqual([]);

        // Nothing changed in what the next read would be served: no Holding
        // gained or lost quantity, and no Holding appeared or disappeared.
        const holdings = await service.listHoldings();
        expect(holdingsSnapshot(holdings)).toEqual(before);

        // The Transaction was not appended to any history (Req 2.8's view of it).
        for (const [index, symbol] of symbols.entries()) {
          const history = await service.getTransactionHistory(symbol);
          expect(history.map(transactionView)).toEqual(historiesBefore[index]);
        }
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});

/**
 * A comparable view of a set of Holdings.
 *
 * `Decimal`s are reduced to their exact textual form because two instances
 * holding the same value are not structurally equal, and it is the value that
 * "unchanged" is about. Holdings are sorted by symbol since map iteration order
 * is an implementation detail.
 */
function holdingsSnapshot(holdings: readonly Holding[]): unknown[] {
  return holdings
    .map((holding) => ({
      symbol: holding.symbol,
      quantity: holding.quantity.toFixed(),
      currentPrice: holding.currentPrice.toFixed(),
    }))
    .sort((left, right) => (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0));
}

/** A comparable view of one Transaction. */
function transactionView(transaction: Transaction): unknown {
  return {
    id: transaction.id,
    symbol: transaction.symbol,
    type: transaction.type,
    quantity: transaction.quantity.toFixed(),
    pricePerUnit: transaction.pricePerUnit.toFixed(),
    timestamp: transaction.timestamp.toISOString(),
  };
}

/** The Transaction history for `symbol`, oldest first, as it stands in `state`. */
function historySnapshot(state: PortfolioState, symbol: string): unknown[] {
  return state.transactions
    .filter((transaction) => transaction.symbol === symbol)
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
    .map(transactionView);
}
