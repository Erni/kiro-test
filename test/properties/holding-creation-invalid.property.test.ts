import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { ValidationError } from '../../src/domain/errors';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type { Holding, PortfolioState, Transaction } from '../../src/domain/types';
import type { PortfolioRepository } from '../../src/persistence/portfolioRepository';
import { PortfolioService } from '../../src/service/portfolioService';

/**
 * Property 3: Invalid holding creation input is always rejected without side
 * effects (Requirements 1.3, 1.4, 1.11).
 *
 * For any holding-creation input where the symbol is empty, exceeds 10
 * characters, or contains characters other than uppercase letters and digits, or
 * where the quantity is `<= 0` or `> 1_000_000_000_000`, or where the
 * Current_Price is `< 0` or `> 1_000_000_000_000`, the submission is rejected
 * with a validation error and the Portfolio is left unchanged.
 *
 * The submission goes through a real `PortfolioService`, not just
 * `validateNewHoldingInput`, because "without side effects" is a claim about the
 * System's observable state, not about what a pure validator returns. The
 * service is given a recording repository, so the run can assert the stronger
 * fact that nothing was persisted at all: a rejected creation must not reach
 * `save()`, and the Portfolio the next read is served from must be the one that
 * was there before (Req 5.4's guarantee, relied on here rather than retested).
 *
 * Exactly one to three of the three fields are corrupted per run, with the
 * remaining fields generated inside their valid ranges. That keeps every run
 * attributable: the reported field must be one of the fields deliberately made
 * invalid, so a validator that rejected everything with a fixed message - or
 * rejected a *valid* neighbouring field - would fail rather than pass by
 * accident.
 *
 * Two violation shapes beyond the property's literal wording are generated as
 * well, because the same acceptance criteria define them: a quantity or
 * Current_Price with more than 8 decimal places is outside the ranges Req 1.1
 * establishes and so is rejected under Req 1.3 / 1.4, and a lowercase or
 * punctuated symbol is the "characters other than uppercase letters and digits"
 * case of Req 1.11.
 *
 * Values are generated and compared as decimal *strings*, never routed through a
 * JavaScript number, so a generated "just over the limit" value really is just
 * over the limit rather than a float that rounded onto it.
 */

/** Inclusive upper bound for quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** Characters Req 1.11 excludes: lowercase letters. */
const LOWERCASE_CHARS = 'abcdefghijklmnopqrstuvwxyz'.split('');

/** Characters Req 1.11 excludes: punctuation, whitespace, and symbols. */
const PUNCTUATION_CHARS = ' -_.,:;/\\$#@!*+()[]{}%&?"\'`~^<>|='.split('');

/** How many pre-existing Holdings the Portfolio may already contain. */
const MAX_EXISTING_HOLDINGS = 3;

/** The fields a creation submission carries, any of which may be corrupted. */
type Field = 'symbol' | 'quantity' | 'currentPrice';

const FIELDS: readonly Field[] = ['symbol', 'quantity', 'currentPrice'];

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range. Used for the fields a given run leaves valid,
 * and as the magnitude a negative/oversized value is derived from.
 *
 * `positive` additionally guarantees `> 0`, as a Holding quantity requires
 * (Req 1.1).
 */
function decimalStrings(bound: 'positive' | 'nonNegative'): fc.Arbitrary<string> {
  const whole = fc.oneof(
    fc.bigInt({ min: 0n, max: 1000n }),
    fc.bigInt({ min: 0n, max: MAX_WHOLE }),
    fc.constantFrom(0n, 1n, MAX_WHOLE),
  );
  const fraction = fc.oneof(
    fc.integer({ min: 0, max: MAX_FRACTION }),
    fc.constantFrom(0, 1, MAX_FRACTION),
  );

  return fc.tuple(whole, fraction).map(([units, hundredMillionths]) => {
    // At the upper bound any fraction would push the value over MAX_VALUE.
    const digits = units === MAX_WHOLE ? 0 : hundredMillionths;
    if (units === 0n && digits === 0) {
      return bound === 'positive' ? '0.00000001' : '0';
    }
    if (digits === 0) {
      return units.toString();
    }
    return `${units}.${String(digits).padStart(MAX_DECIMAL_PLACES, '0')}`;
  });
}

/** Symbols matching `[A-Z0-9]{1,10}` (Req 1.11). */
const symbolArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SYMBOL_CHARS), { minLength: 1, maxLength: 10 })
  .map((characters) => characters.join(''));

/** Inserts `character` at `position % (base.length + 1)`, keeping it in range. */
function insertAt(base: readonly string[], character: string, position: number): string {
  const index = position % (base.length + 1);
  return [...base.slice(0, index), character, ...base.slice(index)].join('');
}

/**
 * Symbols Req 1.11 rejects: empty, longer than 10 characters, or containing a
 * lowercase letter or a punctuation/whitespace character somewhere inside an
 * otherwise well-formed symbol.
 *
 * The disallowed character is inserted at a generated position rather than
 * appended, so a validator that only inspected the first or last character would
 * be caught.
 */
const invalidSymbolArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc
    .array(fc.constantFrom(...SYMBOL_CHARS), { minLength: 11, maxLength: 24 })
    .map((characters) => characters.join('')),
  fc
    .tuple(
      fc.array(fc.constantFrom(...SYMBOL_CHARS), { maxLength: 9 }),
      fc.constantFrom(...LOWERCASE_CHARS),
      fc.nat({ max: 9 }),
    )
    .map(([base, character, position]) => insertAt(base, character, position)),
  fc
    .tuple(
      fc.array(fc.constantFrom(...SYMBOL_CHARS), { maxLength: 9 }),
      fc.constantFrom(...PUNCTUATION_CHARS),
      fc.nat({ max: 9 }),
    )
    .map(([base, character, position]) => insertAt(base, character, position)),
);

/** A decimal string with 9 to 18 decimal places, the last digit non-zero. */
const tooManyDecimalPlacesArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.bigInt({ min: 0n, max: 1000n }),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 17 }),
    fc.integer({ min: 1, max: 9 }),
  )
  // The trailing digit must be non-zero: decimal.js normalizes '0.100000000' to
  // one decimal place, which would make the value perfectly valid.
  .map(([units, digits, last]) => `${units}.${digits.join('')}${last}`);

/** A decimal string strictly greater than MAX_VALUE, with at most 8 decimals. */
const aboveMaxArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constant((MAX_WHOLE + 1n).toString()),
  fc.constant(`${MAX_VALUE}.00000001`),
  fc.constant(`${MAX_VALUE}.99999999`),
  fc.bigInt({ min: MAX_WHOLE + 1n, max: MAX_WHOLE * 1000n }).map((units) => units.toString()),
);

/** A decimal string strictly less than zero, never `-0` (which is not `< 0`). */
const negativeArbitrary: fc.Arbitrary<string> = decimalStrings('positive').map(
  (magnitude) => `-${magnitude}`,
);

/**
 * Quantities Req 1.3 rejects: `<= 0` (including zero written with decimals) or
 * `> 1_000_000_000_000`, plus the out-of-model decimal precision case.
 */
const invalidQuantityArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('0', '0.0', '0.00000000', '-0.00000001', '-1'),
  negativeArbitrary,
  aboveMaxArbitrary,
  tooManyDecimalPlacesArbitrary,
);

/**
 * Current_Prices Req 1.4 rejects: `< 0` or `> 1_000_000_000_000`, plus the
 * out-of-model decimal precision case. Zero is *valid* for a price, so it is
 * deliberately absent here.
 */
const invalidPriceArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('-0.00000001', '-1'),
  negativeArbitrary,
  aboveMaxArbitrary,
  tooManyDecimalPlacesArbitrary,
);

/** The submitted Holding plus the fields that were deliberately corrupted. */
interface Submission {
  readonly input: { readonly symbol: string; readonly quantity: string; readonly currentPrice: string };
  readonly invalidFields: readonly Field[];
}

/**
 * A Portfolio to submit against, plus an invalid creation submission.
 *
 * Existing symbols and the submitted symbol are drawn from one unique set, so a
 * run whose symbol is left valid still targets a symbol that is not already
 * held: the rejection is then unambiguously the validation error the property is
 * about, not the duplicate-symbol error of Req 1.2.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, {
      minLength: 1,
      maxLength: MAX_EXISTING_HOLDINGS + 1,
    }),
    values: fc.array(
      fc.record({
        quantity: decimalStrings('positive'),
        currentPrice: decimalStrings('nonNegative'),
      }),
      { minLength: MAX_EXISTING_HOLDINGS, maxLength: MAX_EXISTING_HOLDINGS },
    ),
    corrupt: fc.uniqueArray(fc.constantFrom(...FIELDS), { minLength: 1, maxLength: FIELDS.length }),
    validQuantity: decimalStrings('positive'),
    validPrice: decimalStrings('nonNegative'),
    badSymbol: invalidSymbolArbitrary,
    badQuantity: invalidQuantityArbitrary,
    badPrice: invalidPriceArbitrary,
  })
  .map((generated) => {
    const [newSymbol, ...existingSymbols] = generated.symbols as [string, ...string[]];

    const holdings = new Map<string, Holding>();
    const transactions: Transaction[] = [];
    existingSymbols.forEach((symbol, index) => {
      const value = generated.values[index] as { quantity: string; currentPrice: string };
      holdings.set(symbol, {
        symbol,
        quantity: new Decimal(value.quantity),
        currentPrice: new Decimal(value.currentPrice),
      });
      // One Transaction per existing Holding, so "unchanged" covers the
      // Transaction history as well as the Holdings.
      transactions.push({
        id: `seed-${index}`,
        symbol,
        type: 'Buy',
        quantity: new Decimal(value.quantity),
        pricePerUnit: new Decimal(value.currentPrice),
        timestamp: new Date(Date.UTC(2024, 0, 1) + index * 60_000),
      });
    });

    const invalidFields = generated.corrupt;
    const submission: Submission = {
      input: {
        symbol: invalidFields.includes('symbol') ? generated.badSymbol : newSymbol,
        quantity: invalidFields.includes('quantity')
          ? generated.badQuantity
          : generated.validQuantity,
        currentPrice: invalidFields.includes('currentPrice')
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
 * A rejected submission must never reach persistence, so the recording is the
 * assertion: an empty log is the observable form of "no side effects". `load()`
 * is unreachable here - the service is constructed with its initial state
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

describe('addHolding with invalid input', () => {
  // Feature: crypto-portfolio-core, Property 3: Invalid holding creation input is always rejected without side effects
  it('rejects the submission with a field-level validation error and leaves the Portfolio unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ state, symbols, submission }) => {
        const repository = new RecordingRepository();
        const service = new PortfolioService(repository, state);

        const before = holdingsSnapshot([...state.holdings.values()]);
        const historiesBefore = symbols.map((symbol) => historySnapshot(state, symbol));

        const result = await service.addHolding(submission.input);

        expect(result.ok).toBe(false);
        if (result.ok) {
          return;
        }

        // A validation error, naming one of the fields this run made invalid,
        // with a message the HTTP layer can surface as-is (Req 1.3, 1.4, 1.11).
        const error = result.error;
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.kind).toBe('ValidationError');
        const field = (error as ValidationError).field;
        expect(submission.invalidFields).toContain(field);
        expect(error.message).toMatch(new RegExp(`^${field}: \\S`));

        // Nothing persisted: the rejection happened before the write path.
        expect(repository.saves).toEqual([]);

        // Nothing changed in what the next read would be served, including the
        // symbol the submission targeted.
        const holdings = await service.listHoldings();
        expect(holdingsSnapshot(holdings)).toEqual(before);
        expect(holdings.map((holding) => holding.symbol)).not.toContain(submission.input.symbol);

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
